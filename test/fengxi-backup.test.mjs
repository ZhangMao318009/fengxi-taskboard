import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BackupError, backupTaskboard } from "../scripts/fengxi-backup.mjs";

const SANDBOX_DIR = path.resolve(import.meta.dirname, '../.fengxi-work');
const RUNTIME = path.resolve(import.meta.dirname, '../scripts/fengxi-backup.mjs');
const ATTACHMENT_ID = "att-text-1";
const ATTACHMENT_BODY = "isolated-restore-ok";

async function withFixture(name, fn) {
  const root = path.join(SANDBOX_DIR, `.backup-test-${name}-${process.pid}-${randomUUID()}`);
  await fsp.mkdir(root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function snapshotTree(filePath) {
  const stat = fs.lstatSync(filePath);
  return {
    size: stat.size,
    hash: stat.isFile() ? sha256(filePath) : null,
  };
}

function listRelativeFiles(directory) {
  const files = [];
  function walk(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(nextPath, nextRelative);
      else files.push(nextRelative);
    }
  }
  if (fs.existsSync(directory)) walk(directory, "");
  return files.sort();
}

async function createSource(root, options = {}) {
  const sourceDir = path.join(root, "source");
  const attachmentsDir = path.join(sourceDir, "attachments");
  const sourceDbPath = path.join(sourceDir, "taskboard.sqlite");
  const destination = path.join(root, "backup-out");
  await fsp.mkdir(attachmentsDir, { recursive: true });

  const database = new DatabaseSync(sourceDbPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_path TEXT,
      labels TEXT NOT NULL DEFAULT '[]',
      next_task_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'none',
      labels TEXT NOT NULL DEFAULT '[]',
      sort_order REAL NOT NULL DEFAULT 1000,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      body TEXT NOT NULL,
      author_id TEXT NOT NULL DEFAULT 'local-user',
      author_name TEXT NOT NULL DEFAULT 'local',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      comment_id TEXT,
      kind TEXT NOT NULL DEFAULT 'attachment',
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE project_readme_attachments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES (
      'proj-1', 'Board', NULL, '[]', 2, '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z'
    );
    INSERT INTO tasks VALUES (
      'task-1', 'BOARD-1', 'proj-1', 'Backup target', 'Need a restore copy', 'todo', 'none', '[]', 1000,
      '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z'
    );
    INSERT INTO comments VALUES (
      'comment-1', 'task-1', 'Need restore proof', 'local-user', 'local', 1,
      '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z'
    );
    INSERT INTO attachments VALUES (
      '${ATTACHMENT_ID}', 'task-1', 'comment-1', 'attachment', 'note.txt', 'text/plain', ${ATTACHMENT_BODY.length},
      '2026-10-29T00:00:00.000Z'
    );
  `);
  database.close();

  if (options.attachment !== "missing" && options.attachment !== "skip") {
    await fsp.writeFile(path.join(attachmentsDir, ATTACHMENT_ID), ATTACHMENT_BODY);
  }
  await fsp.writeFile(path.join(sourceDir, "credentials.json"), "{\"token\":\"secret\"}\n");
  await fsp.writeFile(path.join(sourceDir, "cli-token"), "cli-token-value\n");
  await fsp.writeFile(path.join(sourceDir, "server.log"), "log-line\n");
  await fsp.writeFile(path.join(attachmentsDir, "unreferenced.txt"), "do-not-copy\n");

  return { sourceDir, sourceDbPath, attachmentsDir, destination };
}

async function expectBackupFailure(input, code) {
  await assert.rejects(
    () => backupTaskboard(input),
    (error) => {
      assert.equal(error instanceof BackupError, true);
      assert.equal(error.code, code);
      return true;
    },
  );
}

test("backup copies counts, attachment content, hash, and isolated restore integrity", async () => {
  await withFixture("happy", async (root) => {
    const { sourceDbPath, destination } = await createSource(root);
    const sourceBefore = snapshotTree(sourceDbPath);
    const result = await backupTaskboard({ source: sourceDbPath, destination });

    assert.equal(result.destination, destination);
    assert.equal(result.integrity, "ok");
    assert.deepEqual(result.counts, { projects: 1, tasks: 1, comments: 1 });
    assert.equal(result.attachmentCount, 1);
    assert.equal(result.sha256, sha256(path.join(destination, "taskboard.sqlite")));
    assert.deepEqual(listRelativeFiles(destination), [
      "attachments/att-text-1",
      "taskboard.sqlite",
    ]);
    assert.equal(
      fs.readFileSync(path.join(destination, "attachments", ATTACHMENT_ID), "utf8"),
      ATTACHMENT_BODY,
    );

    const restored = new DatabaseSync(path.join(destination, "taskboard.sqlite"), { readOnly: true });
    try {
      assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(restored.prepare("SELECT name FROM projects").get().name, "Board");
      assert.equal(restored.prepare("SELECT title FROM tasks").get().title, "Backup target");
      assert.equal(restored.prepare("SELECT body FROM comments").get().body, "Need restore proof");
    } finally {
      restored.close();
    }

    assert.deepEqual(snapshotTree(sourceDbPath), sourceBefore);

    const cliDestination = path.join(root, "backup-cli");
    const spawned = spawnSync(process.execPath, [
      RUNTIME,
      "--source",
      sourceDbPath,
      "--destination",
      cliDestination,
    ], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(spawned.status, 0, spawned.stderr);
    const cli = JSON.parse(spawned.stdout.trim());
    assert.equal(cli.destination, cliDestination);
    assert.equal(cli.integrity, "ok");
    assert.deepEqual(cli.counts, { projects: 1, tasks: 1, comments: 1 });
    assert.equal(cli.attachmentCount, 1);
    assert.equal(cli.sha256, sha256(path.join(cliDestination, "taskboard.sqlite")));
  });
});

test("existing destination and source stay untouched on invalid backup", async () => {
  await withFixture("existing-dest", async (root) => {
    const { sourceDbPath, destination } = await createSource(root);
    const marker = path.join(destination, "keep-me.txt");
    await fsp.mkdir(destination);
    await fsp.writeFile(marker, "prior-backup\n");
    const sourceBefore = snapshotTree(sourceDbPath);
    const destBefore = snapshotTree(marker);

    await expectBackupFailure({ source: sourceDbPath, destination }, "DESTINATION_EXISTS");

    assert.equal(fs.readFileSync(marker, "utf8"), "prior-backup\n");
    assert.deepEqual(snapshotTree(sourceDbPath), sourceBefore);
    assert.deepEqual(snapshotTree(marker), destBefore);
  });
});

test("missing referenced attachment refuses and does not create destination", async () => {
  await withFixture("missing-attachment", async (root) => {
    const { sourceDbPath, destination } = await createSource(root, { attachment: "missing" });
    const sourceBefore = snapshotTree(sourceDbPath);

    await expectBackupFailure({ source: sourceDbPath, destination }, "MISSING_ATTACHMENT");

    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(snapshotTree(sourceDbPath), sourceBefore);
  });
});

test("escaping destination path is refused without creating sibling paths", async () => {
  await withFixture("traversal", async (root) => {
    const { sourceDbPath } = await createSource(root);
    const sourceBefore = snapshotTree(sourceDbPath);
    const escaped = `${path.join(root, "backup-out")}${path.sep}..${path.sep}escaped`;
    const escapedNormalized = path.join(root, "escaped");

    await expectBackupFailure({ source: sourceDbPath, destination: escaped }, "PATH_ESCAPES");

    assert.equal(fs.existsSync(escapedNormalized), false);
    assert.equal(fs.existsSync(path.join(root, "backup-out")), false);
    assert.deepEqual(snapshotTree(sourceDbPath), sourceBefore);
  });
});

test("unsafe attachment id traversal is refused", async () => {
  await withFixture("attachment-escape", async (root) => {
    const { sourceDbPath, destination } = await createSource(root);
    const database = new DatabaseSync(sourceDbPath);
    database.exec("DELETE FROM attachments");
    database.prepare(`
      INSERT INTO attachments VALUES (
        ?, 'task-1', 'comment-1', 'attachment', 'note.txt', 'text/plain', 4, '2026-10-29T00:00:00.000Z'
      )
    `).run("..\\secret");
    database.close();
    const sourceBefore = snapshotTree(sourceDbPath);

    await expectBackupFailure({ source: sourceDbPath, destination }, "PATH_ESCAPES");

    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(snapshotTree(sourceDbPath), sourceBefore);
  });
});

test("symlink attachment path is refused and source is preserved", async () => {
  await withFixture("symlink", async (root) => {
    const { sourceDir, sourceDbPath, attachmentsDir, destination } = await createSource(root, {
      attachment: "skip",
    });
    const realDir = path.join(root, "real-attachments");
    await fsp.mkdir(realDir);
    await fsp.writeFile(path.join(realDir, ATTACHMENT_ID), ATTACHMENT_BODY);
    await fsp.rm(attachmentsDir, { recursive: true, force: true });
    try {
      await fsp.symlink(realDir, attachmentsDir, "junction");
    } catch (error) {
      try {
        await fsp.symlink(realDir, attachmentsDir, "dir");
      } catch (inner) {
        inner.cause = error;
        throw inner;
      }
    }
    const sourceBefore = snapshotTree(sourceDbPath);
    const credentialsBefore = snapshotTree(path.join(sourceDir, "credentials.json"));

    await expectBackupFailure({ source: sourceDbPath, destination }, "SYMLINK");

    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(snapshotTree(sourceDbPath), sourceBefore);
    assert.deepEqual(snapshotTree(path.join(sourceDir, "credentials.json")), credentialsBefore);
  });
});

test("source/destination overlap is refused", async () => {
  await withFixture("overlap", async (root) => {
    const { sourceDbPath, attachmentsDir } = await createSource(root);
    const nested = path.join(attachmentsDir, "nested-backup");
    const sourceBefore = snapshotTree(sourceDbPath);

    await expectBackupFailure({ source: sourceDbPath, destination: nested }, "OVERLAP");
    await expectBackupFailure({ source: sourceDbPath, destination: sourceDbPath }, "OVERLAP");

    assert.equal(fs.existsSync(nested), false);
    assert.deepEqual(snapshotTree(sourceDbPath), sourceBefore);
  });
});
