import { createHmac, timingSafeEqual } from "node:crypto";

import { ApiError } from "../shared/api-fields.mjs";
import { setIntakeRule } from './fengxi-intake.mjs';
import {
  parseFengxiAccept,
  parseFengxiClaim,
  parseFengxiPause,
  parseFengxiReady,
  parseFengxiReturn,
  parseFengxiReview,
} from "../shared/fengxi-input.mjs";

const CSRF_COOKIE = "fengxi_csrf";

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseCookies(header) {
  const cookies = new Map();
  if (!header) return cookies;
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

function csrfEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function issueCsrfToken(secret) {
  return createHmac("sha256", secret).update("fengxi-csrf-v1").digest("hex");
}

export function csrfCookieHeader(token) {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict`;
}

export function resolveFengxiActor(request, config, actorFromRequest) {
  const rawAuth = requestHeader(request, "authorization");
  const bearer = typeof rawAuth === "string" && /^Bearer\s+\S+/i.test(rawAuth)
    ? rawAuth.replace(/^Bearer\s+/i, "").trim()
    : "";
  const agentToken = requestHeader(request, "x-fengxi-agent-token") || bearer;
  if (agentToken) {
    const expected = Buffer.from(config.agentToken);
    const provided = Buffer.from(agentToken);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new ApiError(401, "INVALID_AGENT_TOKEN", "Fengxi agent credential is invalid");
    }
    return {
      kind: "agent",
      type: "agent",
      id: "fengxi-cli",
      name: "Fengxi CLI",
      avatarUrl: null,
    };
  }
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const cookies = parseCookies(request.headers.cookie);
    const headerToken = requestHeader(request, "x-fengxi-csrf");
    if (!csrfEqual(cookies.get(CSRF_COOKIE), headerToken) || !csrfEqual(headerToken, issueCsrfToken(config.csrfSecret))) {
      throw new ApiError(403, "CSRF_REQUIRED", "Human UI writes require a matching CSRF cookie and header");
    }
  }
  const actor = actorFromRequest(request);
  return { kind: "human", ...actor };
}

export function createFengxiHttp({ adapter, config, sendJson, sendEmpty, readJson, methodNotAllowed, actorFromRequest }) {
  return {
    issueSessionHeaders() {
      const token = issueCsrfToken(config.csrfSecret);
      return {
        token,
        headers: { "set-cookie": csrfCookieHeader(token) },
      };
    },
    async handle(request, response, url) {
      const pathname = url.pathname;
      if (!pathname.startsWith("/api/fengxi")) return false;
      if (pathname === "/api/fengxi/session") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const session = this.issueSessionHeaders();
        const actor = requestHeader(request, "x-fengxi-agent-token")
          ? resolveFengxiActor(request, config, actorFromRequest)
          : { kind: "human" };
        return sendJson(response, 200, {
          csrfToken: session.token,
          actorKind: actor.kind,
          serviceOwner: adapter.serviceOwner,
          liveSubmitEnabled: config.liveSubmitEnabled === true,
        }, session.headers);
      }

      if (pathname === "/api/fengxi/status") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, adapter.status());
      }

      if (pathname === "/api/fengxi/outbox/pump") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const actor = resolveFengxiActor(request, config, actorFromRequest);
        if (actor.kind !== "agent") {
          throw new ApiError(403, "AGENT_ONLY", "Outbox pump is a service command");
        }
        return sendJson(response, 200, { results: await adapter.pumpOutbox(await readJson(request).catch(() => ({}))) });
      }

      const cardRoute = pathname.match(/^\/api\/fengxi\/cards\/([^/]+)(?:\/([^/]+))?$/);
      if (!cardRoute) {
        throw new ApiError(404, "NOT_FOUND", "Fengxi route not found");
      }
      const taskId = decodeURIComponent(cardRoute[1]);
      const action = cardRoute[2] ?? null;
      if (!action) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, { task: adapter.snapshot(taskId) });
      }
      if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
      const actor = resolveFengxiActor(request, config, actorFromRequest);
      const body = await readJson(request);
      if (action === "ready") {
        return sendJson(response, 200, { task: adapter.ready({ taskId, actor, ...parseFengxiReady(body) }) });
      }
      if (action === "claim") {
        return sendJson(response, 200, {
          task: await adapter.claim({ taskId, actor, ...parseFengxiClaim(body) }),
        });
      }
      if (action === "return") {
        return sendJson(response, 200, {
          task: adapter.returnRevision({ taskId, actor, ...parseFengxiReturn(body) }),
        });
      }
      if (action === "review") {
        return sendJson(response, 200, { task: await adapter.review({ taskId, actor, ...parseFengxiReview(body) }) });
      }
      if (action === "accept") {
        return sendJson(response, 200, { task: adapter.accept({ taskId, actor, ...parseFengxiAccept(body) }) });
      }
      if (action === "pause") {
        return sendJson(response, 200, { task: adapter.pause({ taskId, ...parseFengxiPause(body) }) });
      }
      if (action === 'source-research') {
        const {ifVersion,paused}=parseFengxiPause(body);
        return sendJson(response,200,{task:setIntakeRule(adapter,{taskId,ifVersion,enabled:!paused,actor})});
      }
      throw new ApiError(404, "NOT_FOUND", `Unknown Fengxi card action '${action}'`);
    },
  };
}
