import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFengxiConfig } from '../server/fengxi-config.mjs';
import { createTaskboardServer } from '../server/app.mjs';
import { createMockProjectsGateway, createMockQueue } from '../server/fengxi-queue.mjs';
import { parseTaskCreate } from '../shared/task-input.mjs';

const mainBinding = root => ({
  projectId: 'work-overview',
  sourceProjectId: 'MAIN-001',
  workspaceRoot: root,
  allowedScopes: [root],
  allowMain: true,
});

test('MAIN binding requires an explicit opt-in and keeps the legacy exclusion closed', () => {
  assert.throws(() => resolveFengxiConfig({ bindings: [{
    projectId: 'work-overview', sourceProjectId: 'MAIN-001', workspaceRoot: process.cwd(),
  }] }), /cannot include MAIN-001/);
  const config = resolveFengxiConfig({ bindings: [mainBinding(process.cwd())] });
  assert.equal(config.bindings[0].sourceProjectId, 'MAIN-001');
  assert.equal(config.bindings[0].allowMain, true);
});

test('an explicitly bound MAIN card can pass the same scope gate as other projects', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fengxi-main-binding-'));
  const gateway = createMockProjectsGateway();
  const app = createTaskboardServer({
    dataDirectory: directory,
    fengxi: { fileConfig: { bindings: [mainBinding(directory)] }, liveSubmitEnabled: true,
      queue: createMockQueue(), projectsGateway: gateway },
  });
  const actor = { type: 'agent', kind: 'agent', id: 'main-binding-test', name: '主应用绑定验收', avatarUrl: null };
  try {
    const task = app.database.createTask({
      ...parseTaskCreate({ projectId: 'work-overview', title: '主应用绑定验收', status: 'todo' }, () => null),
      actor, assignee: actor,
    });
    const ready = app.fengxi.ready({ taskId: task.id, ifVersion: task.version, route: 'direct',
      executionMode: 'attached', entry: 'official-d', allowedPaths: [directory],
      acceptanceCriteria: '回读真实范围', actor });
    assert.equal(ready.fengxi.sourceProjectId, 'MAIN-001');
    const claimed = await app.fengxi.claim({ taskId: task.id, ifVersion: ready.version,
      chatOwner: app.fengxi.serviceOwner, entry: 'official-d', actor });
    assert.equal(claimed.status, 'in_progress');
    assert.equal(gateway.calls.at(-1).projectId, 'MAIN-001');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
