import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTaskboardServer, resolveServerOptions } from '../server/app.mjs';
import { DEFAULT_FENGXI_PYTHON } from '../shared/fengxi-domain.mjs';

test('public defaults use the local user and retain explicit data-directory overrides', () => {
  const defaults = resolveServerOptions({ processEnv: {} });
  assert.equal(defaults.dataDirectory, path.join(os.homedir(), '.fengxi-taskboard'));
  const explicit = path.join(os.tmpdir(), 'fengxi-explicit');
  assert.equal(resolveServerOptions({ processEnv: { CODEX_TASKBOARD_DATA_DIR: explicit } }).dataDirectory, explicit);
  assert.ok(DEFAULT_FENGXI_PYTHON);
});

test('public build serves the Fengxi page and preserves a new task across a server restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fengxi-distribution-'));
  let app;
  try {
    app = createTaskboardServer({ dataDirectory: directory });
    let address = await app.listen({ host: '127.0.0.1', port: 0 });
    let base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Fengxi Taskboard/);
    const config = JSON.parse(await readFile(path.join(directory, 'credentials', 'cli-agent.json'), 'utf8'));
    assert.equal(typeof config.token, 'string');
    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'local', title: 'Fengxi source release smoke', status: 'todo', priority: 'medium' }),
    });
    assert.equal(created.status, 201);
    const task = (await created.json()).task;
    const patched = await fetch(`${base}/api/tasks/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: task.version, title: 'Fengxi saved task' }),
    });
    assert.equal(patched.status, 200);
    await app.close();
    app = createTaskboardServer({ dataDirectory: directory });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${address.port}`;
    const restored = await fetch(`${base}/api/tasks/${task.id}`);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).task.title, 'Fengxi saved task');
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
