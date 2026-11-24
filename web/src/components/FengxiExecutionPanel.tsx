import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ApiError,
  fengxiAccept,
  fengxiPause,
  fengxiReady,
  fengxiReturn,
  fengxiReview,
  fengxiSourceResearch,
  getFengxiStatus,
  listComments,
  moveTask,
} from "../api";
import type {
  Comment,
  FengxiAttempt,
  FengxiCardState,
  FengxiEntry,
  FengxiExecutionMode,
  FengxiRoute,
  Task,
} from "../types";
import { useTaskboardI18n } from "../i18n";
import { MarkdownDocument } from "./MarkdownDocument";

interface FengxiExecutionPanelProps {
  task: Task;
  onTask: (task: Task) => void;
  onError: (message: string | readonly [string, string] | null) => void;
}

const OPEN_ATTEMPT_STATUSES = [
  "reserving",
  "claimed",
  "queued",
  "submitting",
  "submitted",
  "running",
  "returned",
  "submission_unknown",
];

function substateLabel(
  substate: string | null | undefined,
  text: (zh: string, en: string) => string,
) {
  if (substate === "queued") return text("排队/准备中", "Queued / preparing");
  if (substate === "preflight") return text("预检/认领中", "Preflight / claiming");
  if (substate === "verification") return text("待技术核验", "Awaiting technical evidence");
  if (substate === "unknown") return text("待核验/未知", "Unknown / needs recovery");
  if (substate === "pending_changes") return text("有待处理修改", "Pending requirement changes");
  if (substate === "stop_pending") return text("停止待确认", "Stop pending");
  return null;
}

function parsePathLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function formatUnknown(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function attemptIdentity(attempt: FengxiAttempt) {
  const payload = attempt.payload ?? {};
  const evidence = attempt.evidence ?? {};
  return {
    executionMode: readText(payload.executionMode),
    entry: readText(payload.entry),
    executorOwner: readText(attempt.managed?.executorOwner) ?? readText(payload.executorOwner),
    hostEntry: readText(payload.hostEntry),
    chatOwner: payload.executionMode === "managed" ? null : attempt.chatOwner,
    queueOwner: attempt.queueOwner,
    threadId: readText(attempt.managed?.threadId) ?? readText(payload.threadId) ?? readText(evidence.threadId),
    turnId: readText(attempt.managed?.turnId) ?? readText(payload.turnId) ?? readText(evidence.turnId),
  };
}

function statusLine(
  task: Task,
  fengxi: FengxiCardState,
  text: (zh: string, en: string) => string,
) {
  const attempt = fengxi.attempt;
  if (fengxi.paused || fengxi.pausedDelivery) {
    return text("已暂停，禁止新的执行请求。", "Paused: new requests are blocked.");
  }
  if (fengxi.substate === "unknown" || attempt?.status === "submission_unknown") {
    return text(
      "发送结果未知，保留原 attempt 与范围，不自动重发。",
      "Submission is unknown. Keep the original attempt and scope; do not resend.",
    );
  }
  if (task.status === "backlog") {
    return text("积压想法，未批准，不执行。", "Backlog idea. Not approved, will not execute.");
  }
  if (!fengxi.approval && task.status !== "done" && task.status !== "canceled") {
    return text("缺批准记录，待确认；不会批量补授权。", "Missing approval. Needs confirmation; historical cards are not backfilled.");
  }
  if (task.status === "in_review" && attempt?.status === "technical_review_pass") {
    return text("技术审查已通过，待人类审核；普通评论不执行。", "Technical review passed. Awaiting human review; comments do not dispatch.");
  }
  if (fengxi.substate === "verification" || attempt?.status === "returned") {
    return text("执行已返回，尚未技术审核。", "Execution returned and is still unreviewed.");
  }
  if (attempt?.status === "technical_review_fail" || attempt?.status === "terminal_failed") {
    return text("检查未通过，请查看结果并提交返工。", "Verification failed. Review the result and request rework.");
  }
  if (task.status === "todo" && fengxi.approval) {
    return text("已批准待办。确认一次后按冻结范围执行。", "Approved todo. One confirmation runs the frozen scope.");
  }
  return text(
    "官方小D与中转小D共用此页。直接开发由认领入口执行；Cursor 队列由原 18793 执行。",
    "Official and relay share this page. Direct work uses the claiming entry; Cursor queue uses the original 18793 route.",
  );
}

export function FengxiExecutionPanel({ task, onTask, onError }: FengxiExecutionPanelProps) {
  const { text } = useTaskboardI18n();
  const fengxi = task.fengxi;
  const bound = Boolean(fengxi?.bound);
  const [route, setRoute] = useState<FengxiRoute>(fengxi?.route === "cursor_queue" ? "cursor_queue" : "direct");
  const [executionMode, setExecutionMode] = useState<FengxiExecutionMode>(
    fengxi?.approval?.executionMode === "attached" ? "attached" : "managed",
  );
  const [entry, setEntry] = useState<FengxiEntry>(
    fengxi?.approval?.entry === "relay-d" ? "relay-d" : "official-d",
  );
  const [allowedPathsText, setAllowedPathsText] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(fengxi?.approval?.acceptanceCriteria ?? "");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [bindingScopes, setBindingScopes] = useState<string[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);

  useEffect(() => {
    if (task.fengxi?.attempt?.evidence?.path) setEvidence(task.fengxi.attempt.evidence.path);
  }, [task.fengxi?.attempt?.evidence?.path]);

  useEffect(() => {
    setRoute(fengxi?.route === "cursor_queue" ? "cursor_queue" : "direct");
    setExecutionMode(fengxi?.approval?.executionMode === "attached" ? "attached" : "managed");
    setEntry(fengxi?.approval?.entry === "relay-d" ? "relay-d" : "official-d");
    setAllowedPathsText("");
    setAcceptanceCriteria(fengxi?.approval?.acceptanceCriteria ?? "");
    setNote("");
    setEvidence("");
    setSummary("");
  }, [task.id]);

  useEffect(() => {
    if (!bound) return;
    const controller = new AbortController();
    void getFengxiStatus(controller.signal)
      .then((status) => {
        const binding = status.bindings.find((item) => item.projectId === task.projectId);
        setBindingScopes(binding?.allowedScopes ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBindingScopes([]);
      });
    return () => controller.abort();
  }, [bound, task.projectId]);

  useEffect(() => {
    if (!bound) return;
    const controller = new AbortController();
    void listComments(task.id, controller.signal)
      .then((items) => setComments(items))
      .catch(() => {
        if (!controller.signal.aborted) setComments([]);
      });
    return () => controller.abort();
  }, [bound, task.id, task.version, fengxi?.pendingChanges, fengxi?.requirementRevision]);

  if (!fengxi || !fengxi.bound) return null;

  async function run(action: string, work: () => Promise<Task>) {
    if (busy) return;
    setBusy(action);
    onError(null);
    try {
      onTask(await work());
      setNote("");
      setEvidence("");
      setSummary("");
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        onError([
          "该卡片已被其他入口更新，请刷新后重试。",
          "This card changed elsewhere. Refresh and retry.",
        ]);
      } else if (error instanceof ApiError && error.code === "FENGXI_GUARD") {
        onError([
          "不能用一般改状态绕过批准就绪或人类验收。",
          "A generic status change cannot skip ready or human accept.",
        ]);
      } else {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(null);
    }
  }

  function onFormKey(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onError(null);
    }
  }

  const attempt = fengxi.attempt;
  const approval = fengxi.approval ?? null;
  const identity = attempt ? attemptIdentity(attempt) : null;
  const displayedMode = identity?.executionMode ?? approval?.executionMode ?? fengxi.executionMode ?? null;
  const displayedEntry = identity?.entry ?? approval?.entry ?? fengxi.entry ?? null;
  const defaultScopes = approval?.allowedPaths?.length ? approval.allowedPaths : bindingScopes;
  const canReady = (task.status === "todo" || task.status === "backlog")
    && (!attempt || !OPEN_ATTEMPT_STATUSES.includes(attempt.status))
    && !approval;
  const canReview = Boolean(attempt) && ["claimed", "returned", "terminal_failed"].includes(attempt?.status ?? "");
  const canAccept = attempt?.status === "technical_review_pass" && Boolean(attempt.evidenceHash);
  const canReturn = Boolean(note.trim());
  const label = substateLabel(fengxi.substate, text);
  const missingApproval = !approval && task.status !== "backlog" && task.status !== "done" && task.status !== "canceled";
  const unreviewed = fengxi.substate === "verification" || attempt?.status === "returned";
  const unknownState = fengxi.substate === "unknown" || attempt?.status === "submission_unknown";
  const sessionGap = Boolean(attempt) && !identity?.threadId && !identity?.turnId;
  const reworkLabel = attempt && OPEN_ATTEMPT_STATUSES.includes(attempt.status)
    ? text("记录返工意见", "Record rework request")
    : approval ? text("按此意见返工并执行", "Approve rework from this comment")
      : text("提交返工，待批准", "Return for approval");

  async function submitReady() {
    if (executionMode === "managed" && !acceptanceCriteria.trim()) {
      throw new Error(text("受管执行需要验收标准。", "Managed execution requires acceptance criteria."));
    }
    let current = task;
    if (current.status === "backlog") {
      current = await moveTask(current, "todo");
      onTask(current);
    }
    return fengxiReady(current.id, {
      ifVersion: current.version,
      route,
      executionMode,
      entry,
      allowedPaths: parsePathLines(allowedPathsText),
      note,
      acceptanceCriteria,
    });
  }

  async function submitReturn(comment?: Comment) {
    const returnNote = note.trim() || comment?.body.trim() || text("按此意见返工", "Rework from this comment");
    const returned = await fengxiReturn(task.id, {
      ifVersion: task.version,
      note: returnNote,
      ...(comment ? { commentId: comment.id } : {}),
    });
    onTask(returned);
    if (returned.fengxi?.requirementRevision !== fengxi!.requirementRevision && approval && fengxi!.route && !returned.fengxi?.paused) {
      return fengxiReady(returned.id, {
        ifVersion: returned.version, route: fengxi!.route,
        executionMode: approval.executionMode as FengxiExecutionMode,
        entry: approval.entry as FengxiEntry, allowedPaths: approval.allowedPaths,
        acceptanceCriteria: approval.acceptanceCriteria, note: returnNote,
      });
    }
    return returned;
  }

  return (
    <section className="fengxi-execution-panel" aria-label={text("执行与验收", "Execution and acceptance")}>
      <h2>{text("执行与验收", "Execution and acceptance")}</h2>
      <p className="fengxi-status-line">{statusLine(task, fengxi, text)}</p>
      {fengxi.localSource && approval?.executionMode === 'managed' && fengxi.route === 'direct' && (
        <label><input type="checkbox" checked={Boolean(fengxi.researchRuleEnabled)} disabled={busy !== null}
          onChange={event => void run('source-research', () => fengxiSourceResearch(task.id, {ifVersion:task.version,paused:!event.target.checked}))} />
          {text("每五分钟按本卡范围与验收标准研究收件箱中的新资料", "Research new inbox sources every five minutes using this card's approved scope and criteria")}
        </label>
      )}
      {fengxi.parentArtifactStale && <p role="status">{text("父任务成果已更新，此分支需要重新核对并批准。", "The parent artifact changed. Review and approve this branch again.")}</p>}
      {fengxi.waitingReason && task.status !== "done" && (
        <p role="status">{text("等待原因", "Waiting reason")}: {({waiting_quota: "等待可用额度", waiting_review_quota: "等待技术复核额度", waiting_retry: "执行端繁忙，等待原任务续接", paused_review: "复核已暂停", delivery_disabled: "自动投递未启用", unknown_review: "复核发送结果待核对", original_review_unresolved: "等待原复核结束", original_execution_unresolved: "等待原执行状态确认", unknown_launch: "启动结果待核对", executor_unavailable: "执行端暂不可用"} as Record<string,string>)[fengxi.waitingReason] ?? fengxi.waitingReason}</p>
      )}
      <details><summary>{text("执行信息", "Execution details")}</summary><dl className="fengxi-meta">
        <div>
          <dt>{text("服务身份", "Service owner")}</dt>
          <dd><code>{fengxi.serviceOwner}</code></dd>
        </div>
        <div>
          <dt>{text("需求版本", "Requirement revision")}</dt>
          <dd>{fengxi.requirementRevision}</dd>
        </div>
        <div>
          <dt>{text("路线", "Route")}</dt>
          <dd>{fengxi.route ?? text("未选定", "Unset")}</dd>
        </div>
        <div>
          <dt>{text("执行模式", "Execution mode")}</dt>
          <dd>{displayedMode ?? text("未批准", "Unapproved")}</dd>
        </div>
        <div>
          <dt>{text("入口", "Entry")}</dt>
          <dd>{displayedEntry ?? text("未选定", "Unset")}</dd>
        </div>
        <div>
          <dt>{text("子状态", "Substate")}</dt>
          <dd>{label ?? text("无", "None")}</dd>
        </div>
      </dl></details>
      {fengxi.paused && (
        <p className="fengxi-banner fengxi-banner-warning" role="status">
          {text("已暂停，禁止新的执行请求。", "Paused: new requests are blocked.")}
        </p>
      )}
      {unknownState && (
        <p className="fengxi-banner fengxi-banner-warning" role="status">
          {text("未知发送，保留原 ID 与范围。", "Unknown submission. Original IDs and scope are kept.")}
        </p>
      )}
      {missingApproval && (
        <p className="fengxi-banner fengxi-banner-warning" role="status">
          {text("缺批准记录，待确认。", "Missing approval; awaiting confirmation.")}
        </p>
      )}
      {unreviewed && (
        <p className="fengxi-banner" role="status">
          {text("尚未技术审核。", "Not yet technically reviewed.")}
        </p>
      )}
      {fengxi.pendingChanges && (
        <p className="fengxi-banner" role="status">
          {text("有新评论待核对；需要修改时请提交返工，不会自动二次派工。", "New comments need review; explicitly return work for changes. Comments do not dispatch.")}
        </p>
      )}
      {approval && (
        <div className="fengxi-attempt">
          <h3>{text("已冻结批准", "Frozen approval")}</h3>
          <p>{text("模式", "Mode")}: {approval.executionMode ?? displayedMode ?? text("无", "None")}</p>
          <p>{text("入口", "Entry")}: {approval.entry ?? displayedEntry ?? text("无", "None")}</p>
          {approval.acceptanceCriteria ? <p>{text("验收标准", "Acceptance")}: {approval.acceptanceCriteria}</p> : null}
          {approval.note ? <p>{text("说明", "Note")}: {approval.note}</p> : null}
          <p>{text("允许路径", "Allowed paths")}</p>
          <ul className="fengxi-scope-list">
            {(approval.allowedPaths ?? []).map((pathValue) => (
              <li key={pathValue}><code>{pathValue}</code></li>
            ))}
            {(approval.allowedPaths ?? []).length === 0 && (
              <li>{text("沿绑定默认范围", "Using the binding default scope")}</li>
            )}
          </ul>
        </div>
      )}
      {attempt && identity && (
        <div className="fengxi-attempt">
          {attempt.managed?.items?.filter(item => item.type === "agentMessage" && item.phase !== "commentary").map((item, index) => (
            <div key={`result-${index}`}><h3>{text("交付结果", "Delivery")}</h3><MarkdownDocument value={item.text ?? ""} /></div>
          ))}
          {attempt.managed?.items?.filter(item => item.type === "commandExecution").map((item, index) => (
            <details key={`check-${index}`}><summary>{text("实际终端检查", "Actual terminal check")} · {text("退出码", "Exit code")} {item.exitCode}</summary><pre style={{ whiteSpace: "pre-wrap" }}>{item.command}</pre></details>
          ))}
          <details><summary>{text("执行与复核记录", "Execution and review records")}</summary>
          <h3>{text("当前执行", "Current execution")}</h3>
          <p>{text("状态", "Status")}: {attempt.status}</p>
          <p>{text("attempt 模式", "Attempt mode")}: {identity.executionMode ?? text("未写入", "Not recorded")}</p>
          <p>{text("attempt 入口", "Attempt entry")}: {identity.entry ?? text("未写入", "Not recorded")}</p>
          {identity.executorOwner && (
            <p>{text("受管执行身份", "Managed executor")}: <code>{identity.executorOwner}</code></p>
          )}
          {identity.hostEntry && (
            <p>{text("宿主入口", "Host entry")}: <code>{identity.hostEntry}</code></p>
          )}
          {identity.chatOwner && (
            <p>{text("真实聊天 owner", "Chat owner")}: <code>{identity.chatOwner}</code></p>
          )}
          {identity.queueOwner && (
            <p>{text("原队列 owner", "Queue owner")}: <code>{identity.queueOwner}</code></p>
          )}
          <p>job_id: <code>{attempt.jobId}</code></p>
          <p>request_id: <code>{attempt.requestId}</code></p>
          {attempt.queueTaskId && <p>queue task: <code>{attempt.queueTaskId}</code></p>}
          {attempt.queueSent && <p>sent: {attempt.queueSent}</p>}
          {identity.threadId && <p>threadId: <code>{identity.threadId}</code></p>}
          {identity.turnId && <p>turnId: <code>{identity.turnId}</code></p>}
          {attempt.managed?.review?.threadId && <p>{text("复核会话", "Review thread")}: <code>{attempt.managed.review.threadId}</code></p>}
          {sessionGap && (
            <p>
              {text(
                "宿主没有可用对话链接；以上为本卡执行记录与缺口。",
                "No verified host conversation link. Records and gaps above are from this card.",
              )}
            </p>
          )}
          {attempt.evidenceHash && <p>evidence: <code>{attempt.evidenceHash.slice(0, 16)}…</code></p>}
          {attempt.evidence?.path && <p>{text("证据文件", "Evidence file")}: <code>{attempt.evidence.path}</code></p>}
          {attempt.evidence?.summary && <p>{text("测试摘要", "Test summary")}: {attempt.evidence.summary}</p>}
          {formatUnknown(attempt.evidence?.tests) && (
            <p>{text("测试结果", "Tests")}: {formatUnknown(attempt.evidence?.tests)}</p>
          )}
          {attempt.errorCode && <p>{text("错误码", "Error")}: <code>{attempt.errorCode}</code></p>}
          {attempt.parentAttemptId && <p>parent: <code>{attempt.parentAttemptId}</code></p>}
          </details>
          {attempt.evidence?.summary && <p>{attempt.evidence.summary}</p>}
        </div>
      )}
      {fengxi.attempts.length > 1 && (
        <ol className="fengxi-attempt-list">
          {fengxi.attempts.map((item) => (
            <li key={item.id}>
              A{item.attemptSequence} r{item.requirementRevision} {item.status}
              {item.evidenceHash ? ` ${item.evidenceHash.slice(0, 8)}` : ""}
            </li>
          ))}
        </ol>
      )}
      {fengxi.acceptance && (
        <p className="fengxi-banner fengxi-banner-success">
          {text("人类已验收", "Human accepted")} {fengxi.acceptance.createdAt}
        </p>
      )}
      {(task.status === "in_review" || fengxi.pendingChanges) && (
        <div className="fengxi-attempt">
          <h3>{text("同卡评论与返工", "Same-card comments and rework")}</h3>
          {comments.length === 0 ? (
            <p>{text("暂无评论。普通评论不会派工。", "No comments yet. Ordinary comments do not dispatch.")}</p>
          ) : (
            <ul className="fengxi-comment-list">
              {comments.map((comment) => (
                <li key={comment.id} className="fengxi-comment">
                  <p><strong>{comment.authorName}</strong>: {comment.body}</p>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run(`return-${comment.id}`, () => submitReturn(comment))}
                  >
                    {reworkLabel}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form
        className="fengxi-actions"
        onKeyDown={onFormKey}
        onSubmit={(event: FormEvent) => event.preventDefault()}
      >
        {canReady && (
          <>
            <label>
              {text("执行路线", "Execution route")}
              <select
                value={route}
                onChange={(event) => setRoute(event.target.value as FengxiRoute)}
                disabled={Boolean(fengxi.route)}
                aria-label={text("执行路线", "Execution route")}
              >
                <option value="cursor_queue">{text("Cursor 队列", "Cursor queue")}</option>
                <option value="direct">{text("Codex 开发", "Codex development")}</option>
              </select>
            </label>
            <label>
              {text("执行模式", "Execution mode")}
              <select
                value={executionMode}
                onChange={(event) => setExecutionMode(event.target.value as FengxiExecutionMode)}
                aria-label={text("执行模式", "Execution mode")}
              >
                <option value="attached">{text("当前智能体接单", "Active agent")}</option>
                <option value="managed">{text("后台自动执行", "Automatic execution")}</option>
              </select>
            </label>
            <label>
              {text("执行端", "Executor")}
              <select
                value={entry}
                onChange={(event) => setEntry(event.target.value as FengxiEntry)}
                aria-label={text("入口", "Entry")}
              >
                <option value="official-d">{text("官方小D（订阅）", "Official Codex subscription")}</option>
                <option value="relay-d">{text("中转小D（中转阶段）", "Relay Codex (paid phase)")}</option>
              </select>
            </label>
            <div>
              <p>{text("绑定范围（留空路径则沿此默认）", "Binding scope (empty paths keep this default)")}</p>
              <ul className="fengxi-scope-list">
                {defaultScopes.map((pathValue) => (
                  <li key={pathValue}><code>{pathValue}</code></li>
                ))}
                {defaultScopes.length === 0 && (
                  <li>{text("将沿服务端绑定默认范围发送空 allowedPaths", "Empty allowedPaths will use the server binding default")}</li>
                )}
              </ul>
            </div>
            <label>
              {text("覆盖允许路径（每行一条，可空）", "Override allowed paths (one per line, optional)")}
              <textarea
                value={allowedPathsText}
                onChange={(event) => setAllowedPathsText(event.target.value)}
                rows={3}
                aria-label={text("允许路径", "Allowed paths")}
              />
            </label>
            <label>
              {text("验收标准", "Acceptance criteria")}
              <textarea
                value={acceptanceCriteria}
                onChange={(event) => setAcceptanceCriteria(event.target.value)}
                rows={3}
                aria-label={text("验收标准", "Acceptance criteria")}
              />
            </label>
          </>
        )}
        <label>
          {text("说明 / 返工说明", "Note / rework note")}
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            aria-label={text("说明", "Note")}
          />
        </label>
        {canReview && (
          <>
            <label>
              {text("技术核验证据文件绝对路径", "Absolute evidence file path for technical review")}
              <textarea
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                rows={2}
                aria-label={text("证据路径", "Evidence path")}
              />
            </label>
            <label>
              {text("测试摘要", "Test summary")}
              <textarea
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                rows={2}
                aria-label={text("测试摘要", "Test summary")}
              />
            </label>
          </>
        )}
        <div className="fengxi-action-buttons">
          <button
            type="button"
            disabled={!canReady || busy !== null || fengxi.paused}
            onClick={() => void run("ready", () => submitReady())}
          >
            {text("批准并就绪", "Ready")}
          </button>
          <button
            type="button"
            disabled={busy !== null || !canReturn}
            onClick={() => void run("return", () => submitReturn())}
          >
            {reworkLabel}
          </button>
          <button
            type="button"
            disabled={!canReview || busy !== null || !evidence.trim()}
            onClick={() => void run("review", () => fengxiReview(task.id, {
              ifVersion: task.version,
              verdict: "pass",
              evidence,
              summary,
            }))}
          >
            {text("技术审查通过", "Technical review pass")}
          </button>
          <button
            type="button"
            className="fengxi-accept"
            disabled={!canAccept || busy !== null || !attempt?.evidenceHash}
            onClick={() => void run("accept", () => fengxiAccept(task.id, {
              ifVersion: task.version,
              requirementRevision: fengxi.requirementRevision,
              evidenceHash: attempt!.evidenceHash!,
            }))}
          >
            {text("确认验收", "Human accept")}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("pause", () => fengxiPause(task.id, {
              ifVersion: task.version,
              paused: !fengxi.pausedDelivery,
            }))}
          >
            {fengxi.pausedDelivery ? text("恢复投递", "Resume") : text("暂停投递", "Pause")}
          </button>
        </div>
      </form>
    </section>
  );
}
