import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

const REQUIRED_COUNT_TABLES = ["projects", "tasks", "comments"];
const ATTACHMENT_TABLES = ["attachments", "project_readme_attachments"];
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

export function parseBackupArgs(argv) {
  let source;
  let destination;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--source" || flag === "--destination") {
      if (value === undefined || value.startsWith("--")) {
        throw new BackupError(
          "INVALID_ARGS",
          "Required: --source <absolute SQLite file> --destination <absolute NEW directory>",
        );
      }
      if (flag === "--source") source = value;
      else destination = value;
      index += 1;
      continue;
    }
    throw new BackupError("INVALID_ARGS", `Unexpected argument: ${flag}`);
  }
  if (!source || !destination) {
    throw new BackupError(
      "INVALID_ARGS",
      "Required: --source <absolute SQLite file> --destination <absolute NEW directory>",
    );
  }
  return { source, destination };
}

export async function backupTaskboard({ source, destination }) {
  const sourcePath = assertSafeAbsolutePath(source, "source");
  const destinationPath = assertSafeAbsolutePath(destination, "destination");
  assertNoOverlap(sourcePath, destinationPath);
  await assertSourceDatabase(sourcePath);
  await assertDestinationNew(destinationPath);

  const sourceDir = path.dirname(sourcePath);
  const attachmentsDir = path.join(sourceDir, "attachments");
  let sourceDb;
  let createdDestination = false;
  try {
    sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
    const referencedIds = listReferencedAttachmentIds(sourceDb);
    await assertReferencedAttachments(attachmentsDir, referencedIds);

    await fsp.mkdir(destinationPath);
    createdDestination = true;

    const destDbPath = path.join(destinationPath, path.basename(sourcePath));
    await backup(sourceDb, destDbPath);
    sourceDb.close();
    sourceDb = null;
    await finalizeStandaloneCopy(destDbPath);

    await copyReferencedAttachments(attachmentsDir, destinationPath, referencedIds);
    const verification = verifyIsolatedCopy(destDbPath, referencedIds.length);
    await unlinkIfExists(`${destDbPath}-wal`);
    await unlinkIfExists(`${destDbPath}-shm`);
    await unlinkIfExists(`${destDbPath}-journal`);
    const sha256 = sha256File(destDbPath);
    return {
      destination: destinationPath,
      integrity: verification.integrity,
      counts: verification.counts,
      attachmentCount: verification.attachmentCount,
      sha256,
    };
  } catch (error) {
    if (sourceDb) {
      try {
        sourceDb.close();
      } catch {
        // The destination cleanup below is the only mutation allowed on failure.
      }
    }
    if (createdDestination) {
      await fsp.rm(destinationPath, { recursive: true, force: true });
    }
    throw error;
  }
}

function assertSafeAbsolutePath(input, label) {
  if (typeof input !== "string" || input.length === 0) {
    throw new BackupError("INVALID_ARGS", `${label} path is required`);
  }
  if (input.includes("\0")) {
    throw new BackupError("PATH_ESCAPES", `Refusing NUL in ${label} path`);
  }
  if (!isAbsolutePath(input)) {
    throw new BackupError("PATH_ESCAPES", `${label} must be an absolute path`);
  }
  if (splitPathSegments(input).includes("..")) {
    throw new BackupError("PATH_ESCAPES", `Refusing escaping path in ${label}`);
  }
  return stripTrailingSep(path.normalize(input));
}

function isAbsolutePath(input) {
  if (!path.isAbsolute(input)) return false;
  if (process.platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\");
  }
  return true;
}

function splitPathSegments(input) {
  return input.split(/[\\/]/);
}

function stripTrailingSep(input) {
  const root = path.parse(input).root;
  if (input === root) return input;
  const trimmed = input.replace(/[\\/]+$/, "");
  return trimmed.length < root.length ? root : trimmed;
}

function samePath(left, right) {
  const a = stripTrailingSep(path.normalize(left));
  const b = stripTrailingSep(path.normalize(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isSameOrInside(candidate, root) {
  if (samePath(candidate, root)) return true;
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0] !== "..";
}

function assertNoOverlap(sourcePath, destinationPath) {
  const sourceDir = path.dirname(sourcePath);
  const attachmentsDir = path.join(sourceDir, "attachments");
  if (
    samePath(destinationPath, sourcePath)
    || samePath(destinationPath, sourceDir)
    || samePath(destinationPath, attachmentsDir)
    || isSameOrInside(destinationPath, sourcePath)
    || isSameOrInside(destinationPath, attachmentsDir)
    || isSameOrInside(sourcePath, destinationPath)
  ) {
    throw new BackupError("OVERLAP", "Source and destination paths overlap");
  }
}

async function assertSourceDatabase(sourcePath) {
  await assertExistingChainHasNoSymlinks(sourcePath, "source");
  const stat = await fsp.lstat(sourcePath);
  if (!stat.isFile()) {
    throw new BackupError("INVALID_SOURCE", `Source is not a file: ${sourcePath}`);
  }
}

async function assertDestinationNew(destinationPath) {
  try {
    await fsp.lstat(destinationPath);
    throw new BackupError("DESTINATION_EXISTS", `Destination already exists: ${destinationPath}`);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  const parent = path.dirname(destinationPath);
  await assertExistingChainHasNoSymlinks(parent, "destination parent");
  const parentStat = await fsp.lstat(parent);
  if (!parentStat.isDirectory()) {
    throw new BackupError("INVALID_DESTINATION", `Destination parent is not a directory: ${parent}`);
  }
}

async function assertExistingChainHasNoSymlinks(absolutePath, label) {
  const normalized = stripTrailingSep(path.normalize(absolutePath));
  const parsed = path.parse(normalized);
  let current = parsed.root;
  const parts = path.relative(parsed.root, normalized).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new BackupError("NOT_FOUND", `${label} not found: ${current}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new BackupError("SYMLINK", `Refusing symlink in ${label} path: ${current}`);
    }
  }
}

function tableExists(database, name) {
  return Boolean(
    database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function listReferencedAttachmentIds(database) {
  const ids = [];
  for (const table of ATTACHMENT_TABLES) {
    if (!tableExists(database, table)) continue;
    for (const row of database.prepare(`SELECT id FROM ${table}`).all()) {
      ids.push(String(row.id));
    }
  }
  return [...new Set(ids)];
}

async function assertReferencedAttachments(attachmentsDir, ids) {
  if (ids.length === 0) {
    try {
      const stat = await fsp.lstat(attachmentsDir);
      if (stat.isSymbolicLink()) {
        throw new BackupError("SYMLINK", `Refusing symlink attachments directory: ${attachmentsDir}`);
      }
    } catch (error) {
      if (error instanceof BackupError) throw error;
      if (error.code !== "ENOENT") throw error;
    }
    return;
  }

  await assertExistingChainHasNoSymlinks(attachmentsDir, "attachments");
  const dirStat = await fsp.lstat(attachmentsDir);
  if (!dirStat.isDirectory()) {
    throw new BackupError("MISSING_ATTACHMENT", `Attachments path is not a directory: ${attachmentsDir}`);
  }

  for (const id of ids) {
    assertSafeAttachmentId(id);
    const sourceFile = path.join(attachmentsDir, id);
    if (!isSameOrInside(sourceFile, attachmentsDir) || !samePath(sourceFile, path.join(attachmentsDir, id))) {
      throw new BackupError("PATH_ESCAPES", `Refusing escaping attachment path: ${id}`);
    }
    let stat;
    try {
      stat = await fsp.lstat(sourceFile);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new BackupError("MISSING_ATTACHMENT", `Missing referenced attachment: ${id}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new BackupError("SYMLINK", `Refusing symlink attachment: ${id}`);
    }
    if (!stat.isFile()) {
      throw new BackupError("MISSING_ATTACHMENT", `Referenced attachment is not a file: ${id}`);
    }
  }
}

function assertSafeAttachmentId(id) {
  if (!ATTACHMENT_ID_PATTERN.test(id) || id === "." || id === "..") {
    throw new BackupError("PATH_ESCAPES", `Refusing unsafe attachment id: ${id}`);
  }
}

async function finalizeStandaloneCopy(destDbPath) {
  const copied = new DatabaseSync(destDbPath);
  try {
    copied.exec("PRAGMA journal_mode = DELETE;");
  } finally {
    copied.close();
  }
  await unlinkIfExists(`${destDbPath}-wal`);
  await unlinkIfExists(`${destDbPath}-shm`);
}

async function unlinkIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function copyReferencedAttachments(attachmentsDir, destinationPath, ids) {
  if (ids.length === 0) return;
  const destAttachments = path.join(destinationPath, "attachments");
  await fsp.mkdir(destAttachments);
  for (const id of ids) {
    const from = path.join(attachmentsDir, id);
    const to = path.join(destAttachments, id);
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
}

function verifyIsolatedCopy(destDbPath, expectedAttachmentCount) {
  const restored = new DatabaseSync(destDbPath, { readOnly: true });
  try {
    const integrityRows = restored.prepare("PRAGMA integrity_check").all();
    const integrity = integrityRows.map((row) => row.integrity_check).join("; ");
    if (integrity !== "ok") {
      throw new BackupError("INTEGRITY_FAILED", `Isolated restore integrity_check failed: ${integrity}`);
    }
    const counts = {};
    for (const table of REQUIRED_COUNT_TABLES) {
      if (!tableExists(restored, table)) {
        throw new BackupError("INVALID_SOURCE", `Missing table ${table}`);
      }
      counts[table] = Number(restored.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    }
    const referenced = listReferencedAttachmentIds(restored);
    if (referenced.length !== expectedAttachmentCount) {
      throw new BackupError(
        "INTEGRITY_FAILED",
        "Isolated restore attachment references do not match the backup",
      );
    }
    return {
      integrity,
      counts,
      attachmentCount: referenced.length,
    };
  } finally {
    restored.close();
  }
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function main() {
  try {
    const result = await backupTaskboard(parseBackupArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  void main();
}
