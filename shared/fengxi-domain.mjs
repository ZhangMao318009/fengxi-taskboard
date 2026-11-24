import os from "node:os";
import path from "node:path";

export const FENGXI_SOURCE_PROJECT_ID = "DEV-BOARD-001";
export const FENGXI_EXCLUDED_PROJECT_ID = "MAIN-001";
export const FENGXI_TASKBOARD_PROJECT_ID = "dev-board-001";
export const DEFAULT_FENGXI_RUNTIME_DIR = process.env.CODEX_TASKBOARD_DATA_DIR || path.join(os.homedir(), ".fengxi-taskboard");
export const DEFAULT_FENGXI_PYTHON =
  process.env.FENGXI_PYTHON || (process.platform === "win32" ? "python" : "python3");
export const DEFAULT_FENGXI_HOST = "127.0.0.1";
export const DEFAULT_FENGXI_PORT = 47823;

export const FENGXI_LANES = ["backlog", "todo", "in_progress", "in_review", "done"];
export const FENGXI_ROUTES = ["direct", "cursor_queue"];
export const FENGXI_SUBSTATES = [
  "queued",
  "preflight",
  "verification",
  "unknown",
  "pending_changes",
  "stop_pending",
];

export const FENGXI_OPEN_ATTEMPT_STATUSES = [
  "reserving",
  "claimed",
  "queued",
  "submitting",
  "submitted",
  "running",
  "returned",
  "submission_unknown",
];

export const FENGXI_TERMINAL_ATTEMPT_STATUSES = [
  "technical_review_pass",
  "technical_review_fail",
  "terminal_failed",
  "accepted",
  "released",
  "superseded",
];

export const GENERIC_BLOCKED_STATUSES = ["in_progress", "in_review", "done"];

export function cardUuid32(taskId) {
  return String(taskId).replace(/-/g, "").toLowerCase();
}

export function buildJobId(taskId, attemptSequence) {
  return `TB-${cardUuid32(taskId)}-A${attemptSequence}`;
}

export function buildRequestId(taskId, requirementRevision, attemptSequence) {
  return `tb-${cardUuid32(taskId)}-r${requirementRevision}-a${attemptSequence}`;
}

export function isOpenAttemptStatus(status) {
  return FENGXI_OPEN_ATTEMPT_STATUSES.includes(status);
}

export function projectLane(status, substate) {
  if (status === "blocked" || substate === "unknown") return "blocked";
  if (FENGXI_LANES.includes(status)) return status;
  return status;
}

export function displaySubstate({ attempt, card }) {
  if (!card) return null;
  if (card.pausedDelivery) return "stop_pending";
  if (card.pendingChanges) return "pending_changes";
  if (!attempt) return null;
  if (attempt.status === "submission_unknown") return "unknown";
  if (attempt.status === "queued" || attempt.status === "submitting") return "queued";
  if (attempt.status === "reserving" || attempt.status === "claimed") return "preflight";
  if (attempt.status === "returned") return "verification";
  if (attempt.status === "submitted" || attempt.status === "running") return null;
  return null;
}
