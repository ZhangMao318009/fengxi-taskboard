import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from "node:crypto";

import { ApiError } from "../shared/api-fields.mjs";

function now() {
  return new Date().toISOString();
}

export function createMockQueue(options = {}) {
  const tasks = options.tasks ?? new Map();
  const calls = [];
  let continuity = options.continuity ?? true;
  let dropNextSubmit = false;
  let failNextSubmit = null;

  return {
    mode: "mock",
    calls,
    tasks,
    setContinuity(value) {
      continuity = Boolean(value);
    },
    dropNextSubmitOnce() {
      dropNextSubmit = true;
    },
    failNextSubmit(code) {
      failNextSubmit = code ?? "QUEUE_UNAVAILABLE";
    },
    async submit({ owner, requestId, jobId, payload, payloadHash }) {
      calls.push({ action: "submit", owner, requestId, jobId, payloadHash });
      if (failNextSubmit) {
        const code = failNextSubmit;
        failNextSubmit = null;
        throw new ApiError(503, code, "Mock queue submit failed");
      }
      const existing = [...tasks.values()].find((entry) => (
        entry.owner === owner && entry.requestId === requestId
      ));
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new ApiError(409, "QUEUE_PAYLOAD_MISMATCH", "Existing queue request used a different payload");
        }
        return existing;
      }
      if (dropNextSubmit) {
        dropNextSubmit = false;
        const hidden = {
          taskId: `mock-${randomUUID()}`,
          owner,
          requestId,
          jobId,
          payload,
          payloadHash,
          sent: now(),
          project: payload.projectId,
          status: "queued",
          hidden: true,
        };
        tasks.set(hidden.taskId, hidden);
        throw new ApiError(503, "QUEUE_RESPONSE_DROPPED", "Mock submit dropped the response");
      }
      const record = {
        taskId: `mock-${randomUUID()}`,
        owner,
        requestId,
        jobId,
        payload,
        payloadHash,
        sent: now(),
        project: payload.projectId,
        status: "queued",
      };
      tasks.set(record.taskId, record);
      return record;
    },
    async status({ owner, requestId, jobId, taskId }) {
      calls.push({ action: "status", owner, requestId, jobId });
      if (!continuity) return { found: false, continuity: false };
      const record = [...tasks.values()].find((entry) => (
        entry.owner === owner && (entry.taskId === taskId || entry.requestId === requestId || entry.jobId === jobId)
      ));
      if (!record) return { found: false, continuity: true };
      return { found: true, continuity: true, ...record };
    },
    async result(query) {
      const lookup = await this.status(query);
      calls.push({ action: "result", ...query });
      return lookup;
    },
    async review() {
      throw new ApiError(409, "FENGXI_LIVE_REVIEW_DISABLED", "Live queue review is reserved for later acceptance");
    },
    async cancel() {
      throw new ApiError(409, "FENGXI_LIVE_CANCEL_DISABLED", "Live queue cancel is reserved for later acceptance");
    },
  };
}

export function createMockProjectsGateway(options = {}) {
  const claims = options.claims ?? new Map();
  const calls = [];
  let failNext = null;
  const forbiddenOwners = new Set(options.forbiddenOwners ?? []);

  return {
    mode: "mock",
    calls,
    claims,
    failNext(code) {
      failNext = code ?? "PROJECTS_CLAIM_FAILED";
    },
    async claim({ projectId, jobId, owner, allowedPaths }) {
      calls.push({ action: "claim", projectId, jobId, owner, allowedPaths });
      if (failNext) {
        const code = failNext;
        failNext = null;
        throw new ApiError(409, code, "Mock projects claim failed");
      }
      if (forbiddenOwners.has(owner)) {
        throw new ApiError(403, "PROJECTS_OWNER_DENIED", "Chat owner is outside the source project scope");
      }
      const existing = [...claims.values()].find((entry) => entry.jobId === jobId && entry.active);
      if (existing && existing.owner !== owner) {
        throw new ApiError(409, "PROJECTS_OWNED_ELSEWHERE", "Job is already claimed by another owner");
      }
      if (existing) return existing;
      const record = {
        claimId: `claim-${randomUUID()}`,
        projectId,
        jobId,
        owner,
        allowedPaths,
        active: true,
        createdAt: now(),
      };
      claims.set(record.claimId, record);
      return record;
    },
    async status({ jobId, owner }) {
      calls.push({ action: "status", jobId, owner });
      const record = [...claims.values()].find((entry) => entry.jobId === jobId);
      if (!record) return { found: false };
      return { found: true, ...record, sameOwner: record.owner === owner };
    },
    async release({ claimId, jobId, owner }) {
      calls.push({ action: "release", claimId, owner });
      const record = claims.get(claimId) ?? [...claims.values()].find(r => r.jobId === jobId);
      if (!record) return { released: false };
      if (record.owner !== owner) {
        throw new ApiError(403, "PROJECTS_OWNER_DENIED", "Cannot release another owner's claim");
      }
      record.active = false;
      return { released: true, ...record };
    },
  };
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

export function spawnPythonJson({ pythonPath, scriptPath, args, payload, timeoutMs = 15_000 }) {
  if (!pythonPath || !scriptPath) {
    throw new ApiError(409, "FENGXI_PATH_UNCONFIGURED", "Python queue/projects path is not configured");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new ApiError(504, "FENGXI_SPAWN_TIMEOUT", "Configured Python helper timed out"));
    }, timeoutMs);
    const stdout = collectStream(child.stdout);
    const stderr = collectStream(child.stderr);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const output = await stdout;
      const errorOutput = await stderr;
      if (code !== 0) {
        reject(new ApiError(502, "FENGXI_SPAWN_FAILED", errorOutput || `Python helper exited ${code}`));
        return;
      }
      try {
        resolve(output ? JSON.parse(output) : {});
      } catch {
        reject(new ApiError(502, "FENGXI_SPAWN_INVALID_JSON", "Python helper returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(payload ?? {}));
  });
}

export function freezeQueueRequest({ owner, requestId, jobId, payload }) {
  const root = payload.workspaceRoot;
  if (!root || payload.sourceProjectId === 'MAIN-001') throw new ApiError(403, 'INVALID_BINDING', 'Frozen workspace required');
  const allowed = payload.allowedPaths.map(p => {
    const relative = path.relative(root, p);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ApiError(403, 'PATH_NOT_ALLOWED', 'Scope outside workspace');
    return relative || '.';
  });
  return { project_id:payload.sourceProjectId, workspace:root, owner, request_id:requestId, job_id:jobId,
    prompt:['Card: '+payload.identifier,'Title: '+payload.title,payload.description,
      'Approved revision: '+payload.requirementRevision,'Approved notes: '+(payload.note ?? ''),
      'Comments: '+JSON.stringify(payload.comments ?? []),
      'Implement only the approved scope. Report actual files, tests, evidence, and remaining limitations.',
      'Do not use Taskboard control APIs, start new agents, change credentials, or access other projects.'].join('\n\n'),
    allowed_paths:allowed, resource_kind:'coding',
    model_route:{requested_model:'Auto',billing_route:'subscription',reason:'DEV-BOARD-001 subscription-only authorization'} };
}

export function createSpawnQueue({ pythonPath, queueClientPath, liveSubmitEnabled, runtimeDirectory }) {
  async function invoke(action, input) {
    if (!liveSubmitEnabled && !['status', 'result'].includes(action)) {
      throw new ApiError(409, 'FENGXI_LIVE_QUEUE_DISABLED', 'Live queue writes are disabled');
    }
    const folder = await mkdtemp(path.join(runtimeDirectory ?? os.tmpdir(), 'queue-call-'));
    try {
      const file = path.join(folder, 'request.json');
      await writeFile(file, JSON.stringify(input), { mode: 0o600 });
      return await spawnPythonJson({ pythonPath, scriptPath: queueClientPath,
        args: ['cursor_queue_' + action, '--json-file', file], timeoutMs: 30000 });
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
  function view(row, owner) {
    return { found: true, taskId: row.id, owner, status: row.state, sent: row.sent,
      jobId: row.job_id, project: row.project_id, backendAgent: row.backend_agent };
  }
  return {
    mode: 'spawn',
    async submit({ owner, requestId, jobId, payload }) {
      const wire = payload.queueWorkOrder ?? freezeQueueRequest({ owner, requestId, jobId, payload });
      if (wire.owner !== owner || wire.request_id !== requestId || wire.job_id !== jobId) throw new ApiError(409, 'QUEUE_IDENTITY_CONFLICT', 'Frozen request identity mismatch');
      return view(await invoke('submit', wire), owner);
    },
    async status({ owner, jobId, taskId }) {
      const response = await invoke('status', { owner, ...(taskId ? { task_id: taskId } : {}) });
      const rows = (response.tasks ?? []).filter(r => taskId ? r.id === taskId : r.job_id === jobId);
      if (rows.length > 1) throw new ApiError(409, 'QUEUE_IDENTITY_CONFLICT', 'Multiple matching tasks');
      return rows.length ? view(rows[0], owner) : { found: false, continuity: false };
    },
    async result({ owner, taskId }) { return invoke('result', { owner, task_id: taskId }); },
    async review({ owner, taskId, evidence, accepted }) { return invoke('review', { owner, task_id: taskId, evidence, accepted }); },
    async cancel({ owner, taskId }) { return invoke('cancel', { owner, task_id: taskId }); },
  };
}

export function createSpawnProjectsGateway({ pythonPath, projectsClientPath }) {
  const invoke = args => spawnPythonJson({ pythonPath, scriptPath: projectsClientPath, args });
  async function status({ jobId, owner }) {
    const data = await invoke(['status']);
    const row = data.jobs.find(r => r.id === jobId);
    return row ? { found: true, ...row, sameOwner: row.owner === owner, active: row.state === 'active' } : { found: false };
  }
  return {
    mode: 'spawn', status,
    async claim({ projectId, jobId, owner, allowedPaths, workspaceRoot }) {
      const data = await invoke(['status']);
      const project = data.projects.find(r => r.id === projectId);
      if (!project || path.resolve(project.workspace).toLowerCase() !== path.resolve(workspaceRoot).toLowerCase()) {
        throw new ApiError(409, 'PROJECT_BINDING_CHANGED', 'Registered workspace identity changed');
      }
      const existing = data.jobs.find(r => r.id === jobId);
      if (existing) {
        if (existing.owner === owner && existing.project === projectId && existing.state === 'active') return { claimId: jobId };
        throw new ApiError(409, 'PROJECTS_OWNED_ELSEWHERE', 'Original job cannot be reclaimed');
      }
      const scopes = allowedPaths.flatMap(p => {
        const rel = path.relative(project.workspace, p);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ApiError(403, 'PATH_NOT_ALLOWED', 'Scope outside workspace');
        return ['--path', rel || '.'];
      });
      await invoke(['claim', projectId, jobId, owner, ...scopes]);
      return { claimId: jobId };
    },
    async release({ jobId, owner, evidence, accepted }) {
      const current = await status({ jobId, owner });
      if (!current.found || !current.sameOwner) throw new ApiError(403, 'PROJECTS_OWNER_DENIED', 'Original owner required');
      if (!current.active) {
        if (current.evidence === evidence) return { released: true };
        throw new ApiError(409, 'PROJECTS_FINISHED', 'Job already finished with different evidence');
      }
      await invoke(['finish', jobId, owner, evidence, '--state', accepted ? 'completed' : 'blocked']);
      return { released: true };
    },
  };
}
