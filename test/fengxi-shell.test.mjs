import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskboardServer, resolveHost } from '../server/app.mjs';

test('Fengxi defaults to loopback and rejects upstream execution/connectors', async () => {
  assert.equal(resolveHost(), '127.0.0.1');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fengxi-shell-'));
  const app = createTaskboardServer({ dataDirectory: directory });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const route of ['ai/catalog', 'cloud-session', 'jira-connection', 'host-runtime', 'codex-thread-progress']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/local/${route}`);
      assert.equal(response.status, 403, route);
      assert.equal((await response.json()).error.code, 'FENGXI_DISABLED');
    }
    const summary = await fetch(`http://127.0.0.1:${address.port}/api/local/projects/dev-board-001/summary`);
    assert.equal(summary.status, 403);
    assert.equal((await summary.json()).error.code, 'FENGXI_DISABLED');
    const workspaces = await fetch(`http://127.0.0.1:${address.port}/api/device-workspaces`);
    assert.equal(workspaces.status, 403);
    assert.equal((await workspaces.json()).error.code, 'FENGXI_DISABLED');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
