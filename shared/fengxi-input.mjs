import { ApiError, assertAllowedKeys, assertPlainObject, stringField } from "./api-fields.mjs";
import { FENGXI_ROUTES } from "./fengxi-domain.mjs";

const MAX_NOTE = 4000;
const MAX_PATH = 4096;
const MAX_EVIDENCE = 64 * 1024;

export function parseIfVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'ifVersion' must be a positive integer");
  }
  return value;
}

export function parseFengxiRoute(value) {
  const route = stringField(value, "route", { required: true, maxLength: 32 });
  if (!FENGXI_ROUTES.includes(route)) {
    throw new ApiError(400, "INVALID_FIELD", "'route' must be direct or cursor_queue");
  }
  return route;
}

function parsePathList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be an array with at most 32 paths`);
  }
  return value.map((entry, index) => {
    const pathValue = stringField(entry, `${name}[${index}]`, { required: true, maxLength: MAX_PATH });
    if (pathValue.includes("\0") || pathValue.includes("*") || /[<>"|]/.test(pathValue)) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}[${index}]' is not an allowed path`);
    }
    return pathValue;
  });
}

export function parseFengxiReady(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["ifVersion", "route", "allowedPaths", "note", "executionMode", "entry", "acceptanceCriteria"]));
  const executionMode = body.executionMode ?? 'attached';
  const entry = body.entry ?? 'official-d';
  if (!['attached', 'managed'].includes(executionMode) || !['official-d', 'relay-d'].includes(entry)) throw new ApiError(400, 'INVALID_EXECUTOR', 'Unknown execution mode or entry');
  const acceptanceCriteria = stringField(body.acceptanceCriteria ?? '', 'acceptanceCriteria', { maxLength: MAX_NOTE }) || '';
  if (executionMode === 'managed' && !acceptanceCriteria.trim()) throw new ApiError(400, 'ACCEPTANCE_REQUIRED', 'Managed execution requires acceptance criteria');
  return {
    executionMode, entry, acceptanceCriteria,
    ifVersion: parseIfVersion(body.ifVersion),
    route: parseFengxiRoute(body.route),
    allowedPaths: parsePathList(body.allowedPaths, "allowedPaths"),
    note: stringField(body.note ?? "", "note", { maxLength: MAX_NOTE }) || "",
  };
}

export function parseFengxiClaim(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["ifVersion", "chatOwner", "entry"]));
  const entry = body.entry ?? 'unknown';
  if (!['official-d','relay-d','claude','doubao','unknown'].includes(entry)) throw new ApiError(400, 'INVALID_ENTRY', 'Unknown agent entry label');
  return {
    ifVersion: parseIfVersion(body.ifVersion),
    chatOwner: stringField(body.chatOwner, "chatOwner", { required: true, maxLength: 128 }),
    entry,
  };
}

export function parseFengxiReturn(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["ifVersion", "commentId", "note"]));
  return {
    ifVersion: parseIfVersion(body.ifVersion),
    commentId: stringField(body.commentId ?? null, "commentId", { nullable: true, maxLength: 128 }),
    note: stringField(body.note, "note", { required: true, maxLength: MAX_NOTE }),
  };
}

export function parseFengxiReview(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["ifVersion", "verdict", "evidence", "summary"]));
  const verdict = stringField(body.verdict, "verdict", { required: true, maxLength: 16 });
  if (verdict !== "pass" && verdict !== "fail") {
    throw new ApiError(400, "INVALID_FIELD", "'verdict' must be pass or fail");
  }
  return {
    ifVersion: parseIfVersion(body.ifVersion),
    verdict,
    evidence: stringField(body.evidence, "evidence", { required: true, maxLength: MAX_EVIDENCE }),
    summary: stringField(body.summary ?? "", "summary", { maxLength: MAX_NOTE }) || "",
  };
}

export function parseFengxiAccept(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["ifVersion", "requirementRevision", "evidenceHash"]));
  const requirementRevision = body.requirementRevision;
  if (!Number.isSafeInteger(requirementRevision) || requirementRevision < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'requirementRevision' must be a positive integer");
  }
  return {
    ifVersion: parseIfVersion(body.ifVersion),
    requirementRevision,
    evidenceHash: stringField(body.evidenceHash, "evidenceHash", { required: true, maxLength: 128 }),
  };
}

export function parseFengxiPause(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["ifVersion", "paused"]));
  if (typeof body.paused !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "'paused' must be a boolean");
  }
  return {
    ifVersion: parseIfVersion(body.ifVersion),
    paused: body.paused,
  };
}
