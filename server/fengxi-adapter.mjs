import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { readFileSync, realpathSync, statSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';

import { ApiError } from "../shared/api-fields.mjs";
import {
  FENGXI_EXCLUDED_PROJECT_ID,
  FENGXI_SOURCE_PROJECT_ID,
  FENGXI_TASKBOARD_PROJECT_ID,
  GENERIC_BLOCKED_STATUSES,
  buildJobId,
  buildRequestId,
  displaySubstate,
} from "../shared/fengxi-domain.mjs";
import { createServiceOwner } from "./fengxi-config.mjs";
import { migrateFengxiSchema } from "./fengxi-schema.mjs";
import { freezeQueueRequest } from './fengxi-queue.mjs';
import { freezeWorkOrder } from '../shared/fengxi-work-order.mjs';
import { readQuotaCache, executionEligibility } from './fengxi-codex.mjs';
import { initializeIntake, intakeRule } from './fengxi-intake.mjs';

function now() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  return JSON.parse(value);
}

function isSqliteConstraint(error) {
  return error?.code === "ERR_SQLITE_CONSTRAINT"
    || error?.code === "SQLITE_CONSTRAINT"
    || /UNIQUE constraint failed/i.test(String(error?.message ?? ""));
}

function attemptFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    requirementRevision: row.requirement_revision,
    attemptSequence: row.attempt_sequence,
    parentAttemptId: row.parent_attempt_id,
    route: row.route,
    status: row.status,
    jobId: row.job_id,
    requestId: row.request_id,
    payload: parseJson(row.payload_json, {}),
    payloadHash: row.payload_hash,
    queueTaskId: row.queue_task_id,
    queueSent: row.queue_sent,
    queueOwner: row.queue_owner,
    chatOwner: row.chat_owner,
    managed: parseJson(row.managed_json, null),
    evidence: parseJson(row.evidence_json, null),
    evidenceHash: row.evidence_hash,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cardFromRow(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    requirementRevision: row.requirement_revision,
    route: row.route,
    pendingChanges: row.pending_changes === 1,
    pausedDelivery: row.paused_delivery === 1,
    approvedScope: parseJson(row.approved_scope_json, null),
    approval: parseJson(row.approval_json, null),
    currentAttemptId: row.current_attempt_id,
    updatedAt: row.updated_at,
  };
}

function bindingFromRow(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    sourceProjectId: row.source_project_id,
    workspaceRoot: row.workspace_root,
    stateCardPath: row.state_card_path,
    allowedScopes: parseJson(row.allowed_scopes, []),
    paused: row.paused === 1,
    excluded: row.excluded === 1,
    allowMain: row.allow_main === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pathsAllowed(requested, allowed) {
  const physical = entry => {
    let parent = path.resolve(entry);
    const suffix = [];
    while (!existsSync(parent) && path.dirname(parent) !== parent) {
      suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
    }
    return path.join(realpathSync(parent), ...suffix).toLowerCase();
  };
  try {
    const roots = allowed.map(physical);
    return requested.every(entry => {
      const resolved = physical(entry);
      return roots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`));
    });
  } catch { return false; }
}

export class FengxiAdapter {
  constructor({ database, config, queue, projectsGateway }) {
    this.database = database;
    this.sqlite = database.database;
    this.config = config;
    this.queue = queue;
    this.projectsGateway = projectsGateway;
    this.reviewing = new Set();
    migrateFengxiSchema(this.sqlite);
    initializeIntake(this.sqlite);
    this.serviceOwner = this.#ensureServiceOwner();
    this.#ensureBindings();
    database.fengxiGuard = (task, changes) => this.assertGenericMutation(task, changes);
  }

  #ensureServiceOwner() {
    const existing = this.sqlite.prepare("SELECT service_owner FROM fengxi_instance WHERE id = 1").get();
    if (existing?.service_owner) return existing.service_owner;
    const owner = createServiceOwner();
    this.sqlite.prepare(`
      INSERT INTO fengxi_instance (id, service_owner, created_at) VALUES (1, ?, ?)
    `).run(owner, now());
    return owner;
  }

  #ensureBindings() {
    const timestamp = now();
    for (const binding of this.config.bindings) {
      if (binding.sourceProjectId === FENGXI_EXCLUDED_PROJECT_ID && !binding.allowMain) continue;
      const project = this.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(binding.projectId);
      if (!project) {
        this.sqlite.prepare(`
          INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)
        `).run(
          binding.projectId,
          binding.sourceProjectId,
          binding.workspaceRoot,
          timestamp,
          timestamp,
        );
      }
      this.sqlite.prepare(`
        INSERT INTO fengxi_project_bindings (
          project_id, source_project_id, workspace_root, state_card_path, allowed_scopes,
          paused, excluded, allow_main, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          workspace_root = excluded.workspace_root,
          state_card_path = excluded.state_card_path,
          allowed_scopes = excluded.allowed_scopes,
          paused = excluded.paused,
          excluded = excluded.excluded,
          allow_main = excluded.allow_main,
          updated_at = excluded.updated_at
      `).run(
        binding.projectId,
        binding.sourceProjectId,
        binding.workspaceRoot,
        binding.stateCardPath,
        JSON.stringify(binding.allowedScopes),
        binding.paused ? 1 : 0,
        binding.excluded ? 1 : 0,
        binding.allowMain ? 1 : 0,
        timestamp,
        timestamp,
      );
    }
  }

  #taskRow(taskId) {
    return this.sqlite.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(taskId, taskId);
  }

  #requireTaskRow(taskId) {
    const row = this.#taskRow(taskId);
    if (!row) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    return row;
  }

  #requireVersion(row, ifVersion) {
    if (row.version !== ifVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion: ifVersion,
        actualVersion: row.version,
      });
    }
  }

  #bindingForProject(projectId, taskId) {
    const configured = this.config.cardBindings?.[taskId];
    if (configured) {
      if (configured.projectId !== projectId) throw new ApiError(403, 'INVALID_BINDING', 'Card moved outside its approved project');
      return configured;
    }
    return bindingFromRow(this.sqlite.prepare(`
      SELECT * FROM fengxi_project_bindings WHERE project_id = ?
    `).get(projectId));
  }

  #requireBinding(projectId, taskId) {
    const binding = this.#bindingForProject(projectId, taskId);
    if (!binding) {
      throw new ApiError(403, "PROJECT_NOT_BOUND", "Only explicitly configured project bindings can execute");
    }
    if (binding.excluded || (binding.sourceProjectId === FENGXI_EXCLUDED_PROJECT_ID && !binding.allowMain)) {
      throw new ApiError(403, "PROJECT_EXCLUDED", "This source project is excluded from Fengxi execution");
    }
    return binding;
  }

  #cardState(taskId) {
    return cardFromRow(this.sqlite.prepare("SELECT * FROM fengxi_card_state WHERE task_id = ?").get(taskId));
  }

  #openAttempt(taskId) {
    return attemptFromRow(this.sqlite.prepare(`
      SELECT * FROM fengxi_execution_attempts
      WHERE task_id = ? AND status IN (
        'reserving', 'claimed', 'queued', 'submitting', 'submitted',
        'running', 'returned', 'submission_unknown'
      )
      LIMIT 1
    `).get(taskId));
  }

  #attemptById(id) {
    return attemptFromRow(this.sqlite.prepare("SELECT * FROM fengxi_execution_attempts WHERE id = ?").get(id));
  }

  #currentAttempt(taskId) {
    const card = this.#cardState(taskId);
    if (card?.currentAttemptId) return this.#attemptById(card.currentAttemptId);
    return this.sqlite.prepare(`
      SELECT * FROM fengxi_execution_attempts
      WHERE task_id = ?
      ORDER BY attempt_sequence DESC
      LIMIT 1
    `).get(taskId) ? attemptFromRow(this.sqlite.prepare(`
      SELECT * FROM fengxi_execution_attempts
      WHERE task_id = ?
      ORDER BY attempt_sequence DESC
      LIMIT 1
    `).get(taskId)) : null;
  }

  #acceptance(taskId) {
    const row = this.sqlite.prepare(`
      SELECT * FROM fengxi_acceptances WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(taskId);
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      requirementRevision: row.requirement_revision,
      evidenceHash: row.evidence_hash,
      actorId: row.actor_id,
      actorName: row.actor_name,
      createdAt: row.created_at,
    };
  }

  decorateTask(task) {
    if (!task) return task;
    const card = this.#cardState(task.id);
    const attempt = this.#currentAttempt(task.id);
    const binding = this.#bindingForProject(task.projectId, task.id);
    const substate = displaySubstate({ attempt, card });
    const parentArtifact = card?.approval?.parentArtifact;
    const currentParent = parentArtifact && this.#currentAttempt(parentArtifact.taskId);
    return {
      ...task,
      fengxi: {
        serviceOwner: this.serviceOwner,
        bound: Boolean(binding),
        sourceProjectId: binding?.sourceProjectId ?? null,
        paused: Boolean(binding?.paused || card?.pausedDelivery),
        requirementRevision: card?.requirementRevision ?? 1,
        route: card?.route ?? null,
        substate,
        pendingChanges: Boolean(card?.pendingChanges),
        pausedDelivery: Boolean(card?.pausedDelivery),
        attempt,
        attempts: this.listAttempts(task.id),
        acceptance: this.#acceptance(task.id),
        approval: card?.approval ?? null,
        executionMode: card?.approval?.executionMode ?? 'attached',
        entry: card?.approval?.entry ?? null,
        waitingReason: this.executorStatus?.[card?.approval?.entry]?.waitingReason ?? null,
        parentArtifactStale: Boolean(parentArtifact && (currentParent?.evidenceHash !== parentArtifact.evidenceHash ||
          this.#cardState(parentArtifact.taskId)?.requirementRevision !== parentArtifact.requirementRevision)),
        localSource: Boolean(this.sqlite.prepare('SELECT 1 FROM fengxi_intake_sources WHERE task_id=?').get(task.id)),
        researchRuleEnabled: intakeRule(this)?.task_id === task.id && intakeRule(this)?.enabled === 1,
      },
    };
  }

  listAttempts(taskId) {
    return this.sqlite.prepare(`
      SELECT * FROM fengxi_execution_attempts
      WHERE task_id = ?
      ORDER BY attempt_sequence
    `).all(taskId).map(attemptFromRow);
  }

  snapshot(taskId) {
    const task = this.database.getTask(taskId);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    return this.decorateTask(task);
  }

  executionBlocker(taskId) {
    const task = this.snapshot(taskId);
    if (task.archivedAt || task.fengxi.paused || task.fengxi.pendingChanges) return 'paused_or_changed';
    for (const dependency of task.relations?.blockedBy ?? []) {
      const upstream = this.snapshot(dependency.id);
      if (upstream.status !== 'done' || upstream.fengxi.pendingChanges || upstream.fengxi.paused) return 'waiting_dependency';
      const attempt = upstream.fengxi.attempt;
      if (attempt && (attempt.requirementRevision !== upstream.fengxi.requirementRevision || !attempt.evidenceHash)) return 'waiting_dependency';
      if (attempt) {
        try { if (sha256(readFileSync(attempt.evidence.path)) !== attempt.evidence.fileSha256) return 'dependency_evidence_changed'; }
        catch { return 'dependency_evidence_changed'; }
      }
    }
    return null;
  }

  status() {
    const mainEnabled = this.config.bindings.some(binding => binding.sourceProjectId === FENGXI_EXCLUDED_PROJECT_ID && binding.allowMain)
      || Object.values(this.config.cardBindings ?? {}).some(binding => binding.sourceProjectId === FENGXI_EXCLUDED_PROJECT_ID && binding.allowMain);
    return {
      serviceOwner: this.serviceOwner,
      liveSubmitEnabled: this.config.liveSubmitEnabled === true,
      bindings: this.sqlite.prepare("SELECT * FROM fengxi_project_bindings").all().map(bindingFromRow),
      sourceProjectId: FENGXI_SOURCE_PROJECT_ID,
      excluded: mainEnabled ? [] : [FENGXI_EXCLUDED_PROJECT_ID],
      mainEnabled,
      queueMode: this.queue?.mode ?? "unconfigured",
    };
  }

  #ensureCard(taskId, timestamp) {
    this.sqlite.prepare(`
      INSERT INTO fengxi_card_state (
        task_id, requirement_revision, route, pending_changes, paused_delivery, approved_scope_json,
        current_attempt_id, updated_at
      ) VALUES (?, 1, NULL, 0, 0, NULL, NULL, ?)
      ON CONFLICT(task_id) DO NOTHING
    `).run(taskId, timestamp);
    return this.#cardState(taskId);
  }

  #touchTaskStatus(taskId, ifVersion, status, timestamp) {
    const result = this.sqlite.prepare(`
      UPDATE tasks SET status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(status, timestamp, taskId, ifVersion);
    if (result.changes !== 1) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion: ifVersion,
      });
    }
    return ifVersion + 1;
  }

  #nextAttemptSequence(taskId) {
    const row = this.sqlite.prepare(`
      SELECT COALESCE(MAX(attempt_sequence), 0) AS maximum
      FROM fengxi_execution_attempts
      WHERE task_id = ?
    `).get(taskId);
    return row.maximum + 1;
  }

  ready({ taskId, ifVersion, route, allowedPaths = [], note = '', executionMode = 'attached', entry = 'official-d', acceptanceCriteria = '', actor }) {
    const timestamp = now();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTaskRow(taskId);
      this.#requireVersion(task, ifVersion);
      if (task.status === "backlog") {
        throw new ApiError(409, "BACKLOG_NO_EXECUTION", "Backlog cards cannot start execution");
      }
      if (task.status !== 'todo') throw new ApiError(409, 'EXECUTION_NOT_READY', 'Only approved todo cards can start; return reviewed work explicitly');
      const binding = this.#requireBinding(task.project_id, task.id);
      if (binding.paused) {
        throw new ApiError(409, "PROJECT_PAUSED", "Paused projects cannot start new requests");
      }
      const card = this.#ensureCard(task.id, timestamp);
      if (card.pausedDelivery) {
        throw new ApiError(409, "CARD_PAUSED", "Paused cards cannot start new requests");
      }
      if (this.#openAttempt(task.id)) {
        throw new ApiError(409, "ATTEMPT_IN_FLIGHT", "This card already has a nonterminal attempt");
      }
      const requestedPaths = allowedPaths.length > 0 ? allowedPaths : binding.allowedScopes;
      if (!pathsAllowed(requestedPaths, binding.allowedScopes)) {
        throw new ApiError(403, "PATH_NOT_ALLOWED", "Requested paths are outside the bound project scopes");
      }
      const requirementRevision = card.requirementRevision;
      const approval = freezeWorkOrder({ task, binding, comments: this.database.listComments(task.id), requirementRevision,
        allowedPaths: requestedPaths, note, executionMode, entry, acceptanceCriteria, actorId: actor.id });
      const parent = this.database.getTask(task.id).relations?.parent;
      if (parent && this.#currentAttempt(parent.id)) {
        const parentAttempt = this.#currentAttempt(parent.id);
        if (!parentAttempt || !['technical_review_pass', 'accepted'].includes(parentAttempt.status) || !parentAttempt.evidenceHash) {
          throw new ApiError(409, 'PARENT_NOT_READY', 'Review the parent artifact before approving this branch');
        }
        approval.parentArtifact = { taskId: parent.id, requirementRevision: parentAttempt.requirementRevision,
          evidenceHash: parentAttempt.evidenceHash, evidence: parentAttempt.evidence };
      }
      this.sqlite.prepare(`
        UPDATE fengxi_card_state
        SET route = ?, approved_scope_json = ?, approval_json = ?, pending_changes = 0, updated_at = ?
        WHERE task_id = ?
      `).run(route, JSON.stringify(requestedPaths), JSON.stringify(approval), timestamp, task.id);

      let attempt = null;
      if (route === "cursor_queue") {
        const sequence = this.#nextAttemptSequence(task.id);
        const parentAttempt = this.#currentAttempt(task.id);
        const payload = {
          boardInstance: "fengxi-taskboard",
          serviceOwner: this.serviceOwner,
          sourceProjectId: binding.sourceProjectId,
          workspaceRoot: binding.workspaceRoot,
          comments: this.database.listComments(task.id),
          projectId: task.project_id,
          taskId: task.id,
          identifier: task.identifier,
          title: task.title,
          description: task.description,
          requirementRevision,
          attemptSequence: sequence,
          allowedPaths: requestedPaths,
          note,
          actorId: actor.id,
          ...approval,
        };
        payload.queueWorkOrder = freezeQueueRequest({ owner: this.serviceOwner,
          requestId: buildRequestId(task.id, requirementRevision, sequence), jobId: buildJobId(task.id, sequence), payload });
        const payloadJson = JSON.stringify(payload);
        const payloadHash = sha256(payloadJson);
        const attemptId = randomUUID();
        const jobId = buildJobId(task.id, sequence);
        const requestId = buildRequestId(task.id, requirementRevision, sequence);
        this.sqlite.prepare(`
          INSERT INTO fengxi_execution_attempts (
            id, task_id, requirement_revision, attempt_sequence, parent_attempt_id, route, status,
            job_id, request_id, payload_json, payload_hash, queue_owner, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'cursor_queue', 'queued', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attemptId,
          task.id,
          requirementRevision,
          sequence,
          parentAttempt?.id ?? null,
          jobId,
          requestId,
          payloadJson,
          payloadHash,
          this.serviceOwner,
          timestamp,
          timestamp,
        );
        this.sqlite.prepare(`
          INSERT INTO fengxi_execution_outbox (
            id, attempt_id, action, payload_json, payload_hash, state, created_at, updated_at
          ) VALUES (?, ?, 'submit', ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          attemptId,
          payloadJson,
          payloadHash,
          this.config.liveSubmitEnabled ? "pending" : "held",
          timestamp,
          timestamp,
        );
        this.sqlite.prepare(`
          UPDATE fengxi_card_state SET current_attempt_id = ?, updated_at = ? WHERE task_id = ?
        `).run(attemptId, timestamp, task.id);
        attempt = this.#attemptById(attemptId);
      }

      const nextStatus = task.status === "todo" ? "todo" : "todo";
      this.#touchTaskStatus(task.id, ifVersion, nextStatus, timestamp);
      this.sqlite.exec("COMMIT");
      return this.snapshot(task.id);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      if (isSqliteConstraint(error)) {
        throw new ApiError(409, "ATTEMPT_IN_FLIGHT", "This card already has a nonterminal attempt");
      }
      throw error;
    }
  }

  async claim({ taskId, ifVersion, chatOwner, entry = 'unknown', actor, crashAfterReserve = false }) {
    const blocker = this.executionBlocker(taskId);
    if (blocker) throw new ApiError(409, 'EXECUTION_BLOCKED', blocker);
    const timestamp = now();
    let reserved;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTaskRow(taskId);
      this.#requireVersion(task, ifVersion);
      const binding = this.#requireBinding(task.project_id, task.id);
      if (binding.paused) {
        throw new ApiError(409, "PROJECT_PAUSED", "Paused projects cannot start new requests");
      }
      const card = this.#ensureCard(task.id, timestamp);
      if (card.pausedDelivery) {
        throw new ApiError(409, "CARD_PAUSED", "Paused cards cannot start new requests");
      }
      if (card.route && card.route !== "direct") {
        throw new ApiError(409, "ROUTE_LOCKED", "This card is already bound to another execution route");
      }
      if (this.#openAttempt(task.id)) {
        throw new ApiError(409, "ATTEMPT_IN_FLIGHT", "This card already has a nonterminal attempt");
      }
      if (task.status === "backlog") {
        throw new ApiError(409, "BACKLOG_NO_EXECUTION", "Backlog cards cannot start execution");
      }
      if (task.status !== 'todo') throw new ApiError(409, 'EXECUTION_NOT_READY', 'Only todo cards can be claimed');
      const approval = card.approval;
      if (!approval || approval.requirementRevision !== card.requirementRevision || approval.title !== task.title || approval.description !== task.description) {
        throw new ApiError(409, 'APPROVAL_REQUIRED', 'Approve the current revision before claiming');
      }
      if (approval.executionMode === 'managed' && (chatOwner !== this.serviceOwner || entry !== approval.entry)) {
        throw new ApiError(403, 'MANAGED_OWNER_REQUIRED', 'Managed work must keep its approved executor and service identity');
      }
      if (this.snapshot(task.id).fengxi.parentArtifactStale) {
        throw new ApiError(409, 'PARENT_ARTIFACT_CHANGED', 'Reapprove this branch against the current parent artifact');
      }
      const sequence = this.#nextAttemptSequence(task.id);
      const requirementRevision = card.requirementRevision;
      const payload = {
        ...approval,
        boardInstance: "fengxi-taskboard",
        route: "direct",
        sourceProjectId: binding.sourceProjectId,
        workspaceRoot: binding.workspaceRoot,
        projectId: task.project_id,
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        requirementRevision,
        attemptSequence: sequence,
        chatOwner,
        actorId: actor.id,
        entry,
        allowedPaths: card.approvedScope ?? binding.allowedScopes,
      };
      const payloadJson = JSON.stringify(payload);
      const attemptId = randomUUID();
      const previousAttempt = this.#currentAttempt(task.id);
      this.sqlite.prepare(`
        INSERT INTO fengxi_execution_attempts (
          id, task_id, requirement_revision, attempt_sequence, parent_attempt_id, route, status,
          job_id, request_id, payload_json, payload_hash, chat_owner, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'direct', 'reserving', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId,
        task.id,
        requirementRevision,
        sequence,
        previousAttempt?.id ?? null,
        buildJobId(task.id, sequence),
        buildRequestId(task.id, requirementRevision, sequence),
        payloadJson,
        sha256(payloadJson),
        chatOwner,
        timestamp,
        timestamp,
      );
      this.sqlite.prepare(`
        UPDATE fengxi_card_state
        SET route = 'direct', current_attempt_id = ?, updated_at = ?
        WHERE task_id = ?
      `).run(attemptId, timestamp, task.id);
      this.#touchTaskStatus(task.id, ifVersion, "todo", timestamp);
      this.sqlite.exec("COMMIT");
      reserved = this.#attemptById(attemptId);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      if (isSqliteConstraint(error)) {
        throw new ApiError(409, "ATTEMPT_IN_FLIGHT", "This card already has a nonterminal attempt");
      }
      throw error;
    }

    if (crashAfterReserve) return this.snapshot(taskId);

    return this.reconcileDirectClaim(reserved.id);
  }

  async reconcileDirectClaim(attemptId) {
    const attempt = this.#attemptById(attemptId);
    if (!attempt || attempt.route !== "direct") {
      throw new ApiError(404, "ATTEMPT_NOT_FOUND", "Direct claim attempt was not found");
    }
    if (attempt.status === "claimed") return this.snapshot(attempt.taskId);
    if (attempt.status !== "reserving") return this.snapshot(attempt.taskId);
    const task = this.#requireTaskRow(attempt.taskId);
    const binding = this.#requireBinding(task.project_id, task.id);
    try {
      const claimed = await this.projectsGateway.claim({
        projectId: binding.sourceProjectId,
        jobId: attempt.jobId,
        owner: attempt.chatOwner,
        allowedPaths: attempt.payload.allowedPaths,
        workspaceRoot: binding.workspaceRoot,
      });
      const timestamp = now();
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.sqlite.prepare(`
          UPDATE fengxi_execution_attempts
          SET status = 'claimed', updated_at = ?
          WHERE id = ? AND status = 'reserving'
        `).run(timestamp, attempt.id);
        this.sqlite.prepare(`
          UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ?, assignee_type='agent', assignee_id=?, assignee_name=?, assignee_avatar_url=NULL
          WHERE id = ?
        `).run(timestamp, attempt.chatOwner, ({'official-d':'官方小D','relay-d':'中转小D','claude':'小C','doubao':'小豆包'})[attempt.payload.entry] ?? '智能体', attempt.taskId);
        this.sqlite.exec("COMMIT");
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
      return this.snapshot(attempt.taskId);
    } catch (error) {
      const timestamp = now();
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.sqlite.prepare(`
          UPDATE fengxi_execution_attempts
          SET status = 'released', error_code = ?, updated_at = ?
          WHERE id = ? AND status = 'reserving'
        `).run(error.code ?? "PROJECTS_CLAIM_FAILED", timestamp, attempt.id);
        this.sqlite.exec("COMMIT");
      } catch (rollbackError) {
        this.sqlite.exec("ROLLBACK");
        throw rollbackError;
      }
      throw error;
    }
  }

  markComment(taskId) {
    taskId = this.#requireTaskRow(taskId).id;
    const timestamp = now();
    const latest = this.#currentAttempt(taskId);
    const open = this.#openAttempt(taskId) ?? (latest?.status === 'technical_review_pass' ? latest : null);
    if (!open) return this.database.getTask(taskId);
    this.sqlite.prepare(`
      INSERT INTO fengxi_card_state (
        task_id, requirement_revision, route, pending_changes, paused_delivery, approved_scope_json,
        current_attempt_id, updated_at
      ) VALUES (?, 1, NULL, 1, 0, NULL, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET pending_changes = 1, updated_at = excluded.updated_at
    `).run(taskId, open.id, timestamp);
    this.sqlite.prepare('UPDATE tasks SET version=version+1,updated_at=? WHERE id=?').run(timestamp,taskId);
    return this.snapshot(taskId);
  }

  returnRevision({ taskId, ifVersion, commentId, note, actor }) {
    const original = this.#requireTaskRow(taskId);
    this.#requireVersion(original, ifVersion);
    const timestamp = now();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTaskRow(taskId);
      this.#requireVersion(task, ifVersion);
      this.#requireBinding(task.project_id, task.id);
      const card = this.#ensureCard(task.id, timestamp);
      if (this.#currentAttempt(task.id)?.evidence?.reviewIntent) {
        throw new ApiError(409, 'REVIEW_IN_PROGRESS', 'Finish the original technical review before rework');
      }
      this.database.createComment(original.id, { body: note, actor });
      const open = this.#openAttempt(task.id);
      if (open) {
        this.sqlite.prepare(`
          UPDATE fengxi_card_state
          SET pending_changes = 1, updated_at = ?
          WHERE task_id = ?
        `).run(timestamp, task.id);
        this.#touchTaskStatus(task.id, ifVersion, task.status, timestamp);
        this.sqlite.exec("COMMIT");
        return this.snapshot(task.id);
      }
      const previous = this.#currentAttempt(task.id);
      const nextRevision = card.requirementRevision + 1;
      this.sqlite.prepare(`
        UPDATE fengxi_card_state
        SET requirement_revision = ?, pending_changes = 0, approval_json = NULL, current_attempt_id = NULL, updated_at = ?
        WHERE task_id = ?
      `).run(nextRevision, timestamp, task.id);
      if (previous && previous.status === "technical_review_pass") {
        this.sqlite.prepare(`
          UPDATE fengxi_execution_attempts
          SET status = 'superseded', updated_at = ?
          WHERE id = ?
        `).run(timestamp, previous.id);
      }
      this.#touchTaskStatus(task.id, ifVersion, "todo", timestamp);
      this.sqlite.exec("COMMIT");
      const snapshot = this.snapshot(task.id);
      snapshot.fengxi.returnNote = note;
      snapshot.fengxi.returnCommentId = commentId;
      snapshot.fengxi.returnActorId = actor.id;
      snapshot.fengxi.parentAttemptId = previous?.id ?? null;
      return snapshot;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async review({ taskId, ifVersion, verdict, evidence, summary, actor }) {
    const currentTask = this.#requireTaskRow(taskId);
    this.#requireVersion(currentTask, ifVersion);
    const current = this.#currentAttempt(currentTask.id);
    if (current?.status === 'technical_review_pass' && verdict === 'pass'
        && current.payload.executionMode === 'attached' && current.payload.completionPolicy === 'technical') {
      const binding = this.#requireBinding(currentTask.project_id, currentTask.id);
      const state = this.#cardState(currentTask.id);
      if (binding.completionPolicy !== 'technical' || binding.paused || currentTask.archived_at
          || state.pendingChanges || state.pausedDelivery
          || state.requirementRevision !== current.requirementRevision
          || currentTask.title !== current.payload.title || currentTask.description !== current.payload.description
          || this.executionBlocker(currentTask.id)) {
        throw new ApiError(409, 'TECHNICAL_COMPLETION_BLOCKED', 'Current approval and dependencies must still match the reviewed work');
      }
      try {
        const resolved = realpathSync(evidence);
        if (!path.isAbsolute(evidence) || resolved !== current.evidence?.path
            || !pathsAllowed([resolved], [binding.workspaceRoot, this.config.runtimeDirectory])
            || !current.evidenceHash || sha256(readFileSync(resolved)) !== current.evidence.fileSha256) {
          throw new Error('Evidence changed');
        }
      } catch {
        throw new ApiError(409, 'EVIDENCE_CHANGED', 'Reuse the original unchanged technical review evidence');
      }
      // A passed attempt already released its resource; only reconcile the technical card status.
      if (currentTask.status !== 'done') this.#touchTaskStatus(currentTask.id, ifVersion, 'done', now());
      return this.snapshot(currentTask.id);
    }
    const interruptedReviewRecovery = current?.status === 'technical_review_fail'
      && current.managed?.review?.turn?.status === 'interrupted'
      && !current.managed?.retryAt;
    if (!current || (!['claimed', 'returned', 'terminal_failed'].includes(current.status) && !interruptedReviewRecovery)) {
      throw new ApiError(409, 'EXECUTION_NOT_RETURNED', 'Execution must finish before technical review');
    }
    if (current.payload.executionMode === 'managed' && current.route === 'direct' && !current.managed?.turn) {
      throw new ApiError(409, 'EXECUTION_NOT_RETURNED', 'Managed execution must reach a confirmed terminal turn');
    }
    if (current.managed?.review && !current.managed.review.turn) {
      throw new ApiError(409, 'REVIEW_IN_PROGRESS', 'Wait for the original independent review to finish');
    }
    const binding = this.#requireBinding(currentTask.project_id, currentTask.id);
    let evidencePath;
    let content;
    try {
      evidencePath = realpathSync(evidence);
      if (!path.isAbsolute(evidence) || !pathsAllowed([evidencePath], [binding.workspaceRoot, this.config.runtimeDirectory]) ||
          !statSync(evidencePath).isFile() || statSync(evidencePath).size > 5 * 1024 * 1024) throw new Error('Invalid evidence path');
      content = readFileSync(evidencePath);
    } catch {
      throw new ApiError(400, 'INVALID_EVIDENCE_FILE', 'Provide an existing evidence file within this project or taskboard runtime');
    }
    if (this.reviewing.has(current.id)) throw new ApiError(409, 'REVIEW_IN_PROGRESS', 'This attempt is already being reviewed');
    const intent = current.evidence?.reviewIntent;
    const fileSha256 = sha256(content);
    if (intent && (intent.path !== evidencePath || intent.fileSha256 !== fileSha256
      || (intent.verdict !== verdict && !interruptedReviewRecovery))) {
      throw new ApiError(409, 'REVIEW_IN_PROGRESS', 'Recover the original review before changing its verdict or evidence');
    }
    this.sqlite.prepare('UPDATE fengxi_execution_attempts SET evidence_json=? WHERE id=?').run(JSON.stringify({
      ...current.evidence, reviewIntent: intent ?? { path: evidencePath, fileSha256, verdict, summary, actorId: actor.id },
    }), current.id);
    this.reviewing.add(current.id);
    try {
    if (!interruptedReviewRecovery) {
      if (current.route === 'direct') {
        await this.projectsGateway.release({ claimId: current.jobId, jobId: current.jobId,
          owner: current.chatOwner, evidence: evidencePath, accepted: verdict === 'pass' });
      } else {
        await this.queue.review({ taskId: current.queueTaskId, owner: current.queueOwner,
          evidence: evidencePath, accepted: verdict === 'pass' });
      }
    }
    const timestamp = now();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTaskRow(taskId);
      const attempt = this.#openAttempt(task.id) ?? this.#currentAttempt(task.id);
      if (attempt?.id !== current.id || this.#cardState(task.id).requirementRevision !== current.requirementRevision) {
        throw new ApiError(409, "VERSION_CONFLICT", "The reviewed attempt changed");
      }
      const evidenceJson = JSON.stringify({
        path: evidencePath,
        fileSha256,
        summary: intent?.summary ?? summary,
        actorId: intent?.actorId ?? actor.id,
        at: timestamp,
      });
      const evidenceHash = sha256(evidenceJson);
      const nextStatus = verdict === "pass" ? "technical_review_pass" : "technical_review_fail";
      this.sqlite.prepare(`
        UPDATE fengxi_execution_attempts
        SET status = ?, evidence_json = ?, evidence_hash = ?, updated_at = ?
        WHERE id = ?
      `).run(nextStatus, evidenceJson, evidenceHash, timestamp, attempt.id);
      const state = this.#cardState(task.id);
      const technicalDone = verdict === 'pass' && current.payload.completionPolicy === 'technical'
        && binding.completionPolicy === 'technical' && !binding.paused
        && (current.payload.executionMode === 'attached'
          || (current.payload.executionMode === 'managed'
            && (current.managed?.review?.turn?.status === 'completed' || interruptedReviewRecovery)))
        && !state.pendingChanges && !state.pausedDelivery
        && task.title === current.payload.title && task.description === current.payload.description
        && !this.executionBlocker(task.id);
      const cardStatus = technicalDone ? 'done' : verdict === "pass" ? "in_review" : task.status === "in_progress" ? "in_progress" : "todo";
      // Comments may arrive during release; retain them and finish only the reserved attempt.
      this.#touchTaskStatus(task.id, task.version, cardStatus, timestamp);
      this.sqlite.exec("COMMIT");
      return this.snapshot(task.id);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    } finally { this.reviewing.delete(current.id); }
  }

  continueManaged(taskId, attemptId) {
    const task = this.#requireTaskRow(taskId);
    const card = this.#cardState(task.id);
    const attempt = this.#currentAttempt(task.id);
    if (attempt?.id !== attemptId || attempt.status !== 'technical_review_fail' || !attempt.managed?.retryAt ||
        Date.parse(attempt.managed.retryAt) > Date.now() || card.pendingChanges || card.pausedDelivery ||
        !card.approval || card.requirementRevision !== attempt.requirementRevision) return false;
    this.#requireBinding(task.project_id, task.id);
    this.#touchTaskStatus(task.id, task.version, 'todo', now());
    return true;
  }

  accept({ taskId, ifVersion, requirementRevision, evidenceHash, actor }) {
    if (actor.kind === "agent" || actor.type === "agent") {
      throw new ApiError(403, "AGENT_ACCEPT_DENIED", "Agent CLI credentials cannot human-accept a card");
    }
    const timestamp = now();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTaskRow(taskId);
      this.#requireVersion(task, ifVersion);
      const card = this.#ensureCard(task.id, timestamp);
      if (card.requirementRevision !== requirementRevision) {
        throw new ApiError(409, "REVISION_MISMATCH", "Acceptance must name the current requirement revision");
      }
      if (card.pausedDelivery) throw new ApiError(409, 'CHANGES_PENDING', 'Resolve pause before accepting');
      const attempt = this.#currentAttempt(task.id);
      if (!attempt || attempt.status !== "technical_review_pass") {
        throw new ApiError(409, "EVIDENCE_REQUIRED", "Human acceptance requires current technical evidence");
      }
      if (attempt.evidenceHash !== evidenceHash) {
        throw new ApiError(409, "EVIDENCE_HASH_MISMATCH", "Acceptance must name the current evidence hash");
      }
      try {
        if (sha256(readFileSync(attempt.evidence.path)) !== attempt.evidence.fileSha256) throw new Error('Evidence changed');
      } catch { throw new ApiError(409, 'EVIDENCE_CHANGED', 'Evidence must still match the reviewed file'); }
      this.sqlite.prepare(`
        INSERT INTO fengxi_acceptances (
          id, task_id, attempt_id, requirement_revision, evidence_hash, actor_id, actor_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        task.id,
        attempt.id,
        requirementRevision,
        evidenceHash,
        actor.id,
        actor.name,
        timestamp,
      );
      this.sqlite.prepare(`
        UPDATE fengxi_execution_attempts
        SET status = 'accepted', updated_at = ?
        WHERE id = ?
      `).run(timestamp, attempt.id);
      this.#touchTaskStatus(task.id, ifVersion, "done", timestamp);
      this.sqlite.prepare('UPDATE fengxi_card_state SET pending_changes=0 WHERE task_id=?').run(task.id);
      this.sqlite.exec("COMMIT");
      return this.snapshot(task.id);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  pause({ taskId, ifVersion, paused }) {
    const timestamp = now();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTaskRow(taskId);
      this.#requireVersion(task, ifVersion);
      this.#ensureCard(task.id, timestamp);
      this.sqlite.prepare(`
        UPDATE fengxi_card_state SET paused_delivery = ?, updated_at = ? WHERE task_id = ?
      `).run(paused ? 1 : 0, timestamp, task.id);
      this.sqlite.prepare(`
        UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?
      `).run(timestamp, task.id, ifVersion);
      this.sqlite.exec("COMMIT");
      return this.snapshot(task.id);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  assertGenericMutation(task, changes) {
    const previous = this.#currentAttempt(task.id);
    if (previous && (Object.hasOwn(changes, 'projectId') || changes.delete)) throw new ApiError(409, 'FENGXI_GUARD', 'Execution history must remain with its original card');
    if (changes.archivedAt && this.#openAttempt(task.id)) throw new ApiError(409, 'FENGXI_GUARD', 'Cannot archive an active execution');
    if (this.#openAttempt(task.id) && ['description', 'title', 'projectId'].some(key => Object.hasOwn(changes, key) && changes[key] !== task[key])) {
      throw new ApiError(409, 'REVISION_IN_FLIGHT', 'Use comments and explicit return for changes during execution');
    }
    const nextStatus = Object.hasOwn(changes, "status") ? changes.status : undefined;
    if (nextStatus === undefined || nextStatus === task.status) return;
    const binding = this.#bindingForProject(task.projectId, task.id);
    if (!binding) return;
    const open = this.#openAttempt(task.id);
    if (open) {
      throw new ApiError(
        409,
        "FENGXI_GUARD",
        "Generic task updates cannot change status while an execution attempt is in flight",
      );
    }
    if (GENERIC_BLOCKED_STATUSES.includes(nextStatus)) {
      throw new ApiError(
        409,
        "FENGXI_GUARD",
        "in_progress, in_review, and done require Fengxi claim, review, or human accept",
      );
    }
    if (task.status === "backlog" && nextStatus !== "todo" && nextStatus !== "canceled") {
      throw new ApiError(409, "BACKLOG_NO_EXECUTION", "Backlog cards cannot start execution");
    }
  }

  async pumpOutbox({ attemptId } = {}) {
    if (this.pumping) return [];
    this.pumping = true;
    try { return await this.pumpPending({ attemptId }); }
    finally { this.pumping = false; }
  }

  async pumpPending({ attemptId } = {}) {
    const rows = this.sqlite.prepare(`
      SELECT outbox.*, attempts.request_id, attempts.job_id, attempts.queue_owner, attempts.payload_json,
             attempts.payload_hash, attempts.task_id, attempts.status AS attempt_status
      FROM fengxi_execution_outbox outbox
      JOIN fengxi_execution_attempts attempts ON attempts.id = outbox.attempt_id
      WHERE outbox.action = 'submit'
        AND outbox.state IN ('pending', 'in_flight', 'unknown')
        ${attemptId ? "AND outbox.attempt_id = ?" : ""}
      ORDER BY outbox.created_at
    `).all(...(attemptId ? [attemptId] : []));

    const results = [];
    for (const row of rows) {
      results.push(await this.#pumpRow(row));
    }
    return results;
  }

  async #pumpRow(row) {
    const task = this.#requireTaskRow(row.task_id);
    const binding = this.#requireBinding(task.project_id, task.id);
    const card = this.#cardState(row.task_id);
    if (binding.paused || card?.pausedDelivery) return { id: row.id, state: 'paused' };
    if (row.state === 'unknown' || row.state === 'in_flight') return this.recoverAttempt(row.attempt_id);
    if (this.snapshot(row.task_id).fengxi.parentArtifactStale) return {id:row.id,state:'parent_artifact_changed'};
    if (this.config.quotaCachePath) {
      if (!executionEligibility('cursor-subscription', readQuotaCache(this.config.quotaCachePath))) {
        return {id:row.id,state:'waiting_quota'};
      }
    }
    const timestamp = now();
    if (!this.config.liveSubmitEnabled) {
      this.sqlite.prepare(`
        UPDATE fengxi_execution_outbox SET state = 'held', updated_at = ? WHERE id = ?
      `).run(timestamp, row.id);
      return { id: row.id, state: "held" };
    }
    this.sqlite.prepare(`
      UPDATE fengxi_execution_outbox SET state = 'in_flight', updated_at = ? WHERE id = ?
    `).run(timestamp, row.id);
    const payload = parseJson(row.payload_json, {});
    try {
      const submitted = await this.queue.submit({
        owner: row.queue_owner,
        requestId: row.request_id,
        jobId: row.job_id,
        payload,
        payloadHash: row.payload_hash,
      });
      this.#bindQueueIdentity(row.attempt_id, submitted, "acked");
      return { id: row.id, state: "acked", queueTaskId: submitted.taskId };
    } catch (error) {
      if (error.code === "QUEUE_RESPONSE_DROPPED") {
        return this.recoverAttempt(row.attempt_id);
      }
      return this.recoverAttempt(row.attempt_id, error);
    }
  }

  #bindQueueIdentity(attemptId, submitted, outboxState) {
    const timestamp = now();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        UPDATE fengxi_execution_attempts
        SET status = 'submitted', queue_task_id = ?, queue_sent = ?, queue_owner = ?, updated_at = ?
        WHERE id = ?
      `).run(submitted.taskId, submitted.sent ?? timestamp, submitted.owner, timestamp, attemptId);
      this.sqlite.prepare(`
        UPDATE fengxi_execution_outbox
        SET state = ?, updated_at = ?
        WHERE attempt_id = ? AND action = 'submit'
      `).run(outboxState, timestamp, attemptId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async recoverAttempt(attemptId, previousError) {
    const attempt = this.#attemptById(attemptId);
    if (!attempt) return { id: attemptId, state: "missing" };
    const lookup = await this.queue.status({
      owner: attempt.queueOwner ?? this.serviceOwner,
      requestId: attempt.requestId,
      jobId: attempt.jobId,
    });
    const timestamp = now();
    if (lookup.found) {
      this.#bindQueueIdentity(attempt.id, lookup, "acked");
      return { id: attempt.id, state: "acked", recovered: true, queueTaskId: lookup.taskId };
    }
    if (lookup.continuity === true && this.config.liveSubmitEnabled) {
      try {
        const submitted = await this.queue.submit({
          owner: attempt.queueOwner ?? this.serviceOwner,
          requestId: attempt.requestId,
          jobId: attempt.jobId,
          payload: attempt.payload,
          payloadHash: attempt.payloadHash,
        });
        this.#bindQueueIdentity(attempt.id, submitted, "acked");
        return { id: attempt.id, state: "acked", retried: true, queueTaskId: submitted.taskId };
      } catch (error) {
        this.#markUnknown(attempt.id, error.code ?? previousError?.code ?? "QUEUE_UNAVAILABLE");
        return { id: attempt.id, state: "unknown" };
      }
    }
    this.#markUnknown(attempt.id, previousError?.code ?? "QUEUE_UNKNOWN");
    return { id: attempt.id, state: "unknown", continuity: lookup.continuity === false };
  }

  #markUnknown(attemptId, errorCode) {
    const timestamp = now();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        UPDATE fengxi_execution_attempts
        SET status = 'submission_unknown', error_code = ?, updated_at = ?
        WHERE id = ?
      `).run(errorCode, timestamp, attemptId);
      this.sqlite.prepare(`
        UPDATE fengxi_execution_outbox
        SET state = 'unknown', last_error = ?, updated_at = ?
        WHERE attempt_id = ? AND action = 'submit'
      `).run(errorCode, timestamp, attemptId);
      const attempt = this.#attemptById(attemptId);
      this.sqlite.prepare(`
        UPDATE tasks SET status = 'blocked', version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(timestamp, attempt.taskId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async recoverOpenAttempts() {
    const rows = this.sqlite.prepare(`
      SELECT id FROM fengxi_execution_attempts
      WHERE status IN ('submitting', 'submission_unknown', 'reserving')
    `).all();
    const recovered = [];
    for (const row of rows) {
      const attempt = this.#attemptById(row.id);
      if (attempt.route === 'direct' && attempt.payload.executionMode === 'managed' && attempt.status !== 'reserving') continue;
      if (attempt.route === "direct" && attempt.status === "reserving") {
        recovered.push(await this.reconcileDirectClaim(attempt.id).catch((error) => ({
          id: attempt.id,
          state: "released",
          error: error.code,
        })));
        continue;
      }
      recovered.push(await this.recoverAttempt(attempt.id));
    }
    return recovered;
  }

  async refreshExecutions() {
    const rows = this.sqlite.prepare("SELECT * FROM fengxi_execution_attempts WHERE route = 'cursor_queue' AND queue_task_id IS NOT NULL AND (status IN ('submitted','running','submission_unknown') OR (status='returned' AND evidence_json IS NULL))").all();
    for (const row of rows) {
      try {
        const live = await this.queue.status({ owner: row.queue_owner, taskId: row.queue_task_id });
        if (!live.found) { this.#markUnknown(row.id, 'ORIGINAL_QUEUE_TASK_MISSING'); continue; }
        if (live.taskId !== row.queue_task_id || live.owner !== row.queue_owner) throw new Error('Queue identity changed');
        let status = ['awaiting_review', 'completed', 'needs_changes'].includes(live.status) ? 'returned' :
          live.status === 'running' ? 'running' : live.status === 'unknown' ? 'submission_unknown' :
          ['failed','cancelled'].includes(live.status) ? 'terminal_failed' : 'submitted';
        if (status === 'returned') {
          const receipt = await this.queue.result({ owner: row.queue_owner, taskId: row.queue_task_id });
          if (!receipt.result) { this.#markUnknown(row.id, 'RESULT_BODY_MISSING'); continue; }
          const directory = path.join(this.config.runtimeDirectory, 'execution-results');
          mkdirSync(directory, { recursive: true });
          const resultPath = path.join(directory, sha256(row.queue_task_id) + '.json');
          writeFileSync(resultPath + '.tmp', JSON.stringify(receipt, null, 2), {mode:0o600});
          renameSync(resultPath + '.tmp', resultPath);
          if (!row.evidence_json) {
            const reply = typeof receipt.result.reply === 'string' ? receipt.result.reply : JSON.stringify(receipt.result.reply ?? {});
            this.database.createComment(row.task_id, { body: '执行结果（待独立技术核验）\n\n' + reply.slice(0,16000) + '\n\n原始回执：' + resultPath,
              actor: {type:'agent',id:'taskboard-service',name:'看板服务',avatarUrl:null} });
            this.sqlite.prepare('UPDATE fengxi_execution_attempts SET evidence_json=? WHERE id=?').run(JSON.stringify({resultPath}), row.id);
          }
        }
        const lane = status === 'submission_unknown' ? 'blocked' : ['running','returned','terminal_failed'].includes(status) ? 'in_progress' : 'todo';
        this.sqlite.exec('BEGIN IMMEDIATE');
        try {
          this.sqlite.prepare('UPDATE fengxi_execution_attempts SET status=?,queue_sent=?,error_code=NULL,updated_at=? WHERE id=?').run(status, live.sent, now(), row.id);
          this.sqlite.prepare('UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=? AND status<>?').run(lane,now(),row.task_id,lane);
          this.sqlite.exec('COMMIT');
        } catch(e) { this.sqlite.exec('ROLLBACK'); throw e; }
      } catch(error) {
        this.sqlite.prepare('UPDATE fengxi_execution_attempts SET error_code=? WHERE id=?').run(error.code ?? 'QUEUE_OBSERVATION_FAILED',row.id);
      }
    }
  }
}

export function createFengxiAdapter(options) {
  return new FengxiAdapter(options);
}
