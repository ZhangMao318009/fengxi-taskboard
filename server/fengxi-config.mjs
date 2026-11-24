import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ApiError } from "../shared/api-fields.mjs";
import {
  DEFAULT_FENGXI_PYTHON,
  DEFAULT_FENGXI_RUNTIME_DIR,
  FENGXI_EXCLUDED_PROJECT_ID,
  FENGXI_SOURCE_PROJECT_ID,
  FENGXI_TASKBOARD_PROJECT_ID,
} from "../shared/fengxi-domain.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultWorkspaceRoot() {
  return PROJECT_ROOT;
}

export function resolveFengxiRuntimeDirectory(environment = process.env, options = {}) {
  if (options.dataDirectory) return path.resolve(options.dataDirectory);
  if (environment.CODEX_TASKBOARD_DATA_DIR) return path.resolve(environment.CODEX_TASKBOARD_DATA_DIR);
  return path.resolve(DEFAULT_FENGXI_RUNTIME_DIR);
}

function normalizeBinding(raw, fallbackRoot, { allowMain = false } = {}) {
  const sourceProjectId = String(raw.sourceProjectId ?? FENGXI_SOURCE_PROJECT_ID).trim();
  const mainOptIn = raw.allowMain === true;
  if ((sourceProjectId === FENGXI_EXCLUDED_PROJECT_ID || sourceProjectId.toUpperCase().startsWith("MAIN")) &&
      !(allowMain && mainOptIn && sourceProjectId === FENGXI_EXCLUDED_PROJECT_ID)) {
    throw new Error(`Fengxi project binding cannot include ${sourceProjectId}`);
  }
  const workspaceRoot = path.resolve(raw.workspaceRoot ?? fallbackRoot);
  const allowedScopes = Array.isArray(raw.allowedScopes) && raw.allowedScopes.length > 0
    ? raw.allowedScopes.map((entry) => path.resolve(entry))
    : [workspaceRoot];
  return {
    projectId: String(raw.projectId ?? FENGXI_TASKBOARD_PROJECT_ID).trim(),
    sourceProjectId,
    workspaceRoot,
    stateCardPath: raw.stateCardPath ? path.resolve(raw.stateCardPath) : null,
    allowedScopes,
    paused: Boolean(raw.paused),
    excluded: Boolean(raw.excluded),
    allowMain: mainOptIn,
  };
}

export function loadFengxiFileConfigSync(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function loadFengxiFileConfig(configPath) {
  return loadFengxiFileConfigSync(configPath);
}

function writeCredentialFileSync(credentialsPath, token) {
  mkdirSync(path.dirname(credentialsPath), { recursive: true });
  const temporaryPath = `${credentialsPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ token, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, credentialsPath);
  chmodSync(credentialsPath, 0o600);
  return token;
}

export function ensureAgentCredentialSync(credentialsPath, existingToken) {
  if (existingToken) return existingToken;
  try {
    const current = JSON.parse(readFileSync(credentialsPath, "utf8"));
    if (typeof current.token === "string" && current.token.length >= 32) return current.token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return writeCredentialFileSync(credentialsPath, randomBytes(32).toString("hex"));
}

export async function ensureAgentCredential(credentialsPath, existingToken) {
  return ensureAgentCredentialSync(credentialsPath, existingToken);
}

export function resolveFengxiConfig(options = {}, environment = process.env) {
  const runtimeDirectory = resolveFengxiRuntimeDirectory(environment, options);
  const configPath = options.configPath
    ?? environment.FENGXI_CONFIG_PATH
    ?? path.join(runtimeDirectory, "fengxi.config.json");
  const fileConfig = options.fileConfig ?? loadFengxiFileConfigSync(configPath);
  const workspaceRoot = defaultWorkspaceRoot();
  const bindings = (options.bindings ?? fileConfig.bindings ?? [{
    projectId: FENGXI_TASKBOARD_PROJECT_ID,
    sourceProjectId: FENGXI_SOURCE_PROJECT_ID,
    workspaceRoot,
    allowedScopes: [workspaceRoot],
  }]).map((binding) => normalizeBinding(binding, workspaceRoot, { allowMain: true }));
  if (bindings.some((binding) => binding.sourceProjectId === FENGXI_EXCLUDED_PROJECT_ID && !binding.allowMain)) {
    throw new Error("MAIN-001 is excluded from Fengxi bindings");
  }
  const credentialsPath = options.credentialsPath
    ?? fileConfig.credentialsPath
    ?? path.join(runtimeDirectory, "credentials", "cli-agent.json");
  const agentToken = ensureAgentCredentialSync(credentialsPath, options.agentToken ?? fileConfig.agentToken);
  const csrfSecret = options.csrfSecret ?? fileConfig.csrfSecret ?? randomBytes(32).toString("hex");
  return {
    intakeEnabled: options.intakeEnabled ?? fileConfig.intakeEnabled === true,
    cardBindings: Object.fromEntries(Object.entries(options.cardBindings ?? fileConfig.cardBindings ?? {}).map(([id, binding]) => {
      if (!binding.allowedScopes?.length || !['human', 'technical'].includes(binding.completionPolicy ?? 'human')) throw new Error('Card binding needs explicit scopes and completion policy');
      return [id, {...normalizeBinding(binding, workspaceRoot, { allowMain: true }), completionPolicy: binding.completionPolicy ?? 'human'}];
    })),
    quotaCachePath: options.quotaCachePath ?? fileConfig.quotaCachePath ?? null,
    managedExecutors: options.managedExecutors ?? fileConfig.managedExecutors ?? {},
    runtimeDirectory,
    configPath,
    credentialsPath,
    agentToken,
    csrfSecret,
    liveSubmitEnabled: options.liveSubmitEnabled ?? fileConfig.liveSubmitEnabled === true,
    pythonPath: options.pythonPath
      ?? fileConfig.pythonPath
      ?? environment.FENGXI_PYTHON
      ?? DEFAULT_FENGXI_PYTHON,
    queueClientPath: options.queueClientPath ?? fileConfig.queueClientPath ?? null,
    projectsClientPath: options.projectsClientPath ?? fileConfig.projectsClientPath ?? null,
    bindings,
    queue: options.queue ?? null,
    projectsGateway: options.projectsGateway ?? null,
  };
}

export function createServiceOwner(existing) {
  if (typeof existing === "string" && /^taskboard-[0-9a-f-]{36}$/i.test(existing)) return existing;
  return `taskboard-${randomUUID()}`;
}

export function requireConfiguredPath(value, name) {
  if (!value) {
    throw new ApiError(409, "FENGXI_PATH_UNCONFIGURED", `${name} is not configured`);
  }
  return value;
}
