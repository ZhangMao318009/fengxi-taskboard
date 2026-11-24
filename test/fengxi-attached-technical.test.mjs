import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskboardServer } from '../server/app.mjs';
import { createMockProjectsGateway, createMockQueue } from '../server/fengxi-queue.mjs';
import { parseTaskCreate } from '../shared/task-input.mjs';

async function fixture(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'attached-technical-'));
  const gateway = createMockProjectsGateway();
  const app = createTaskboardServer({ dataDirectory: directory,
    fengxi: { fileConfig: {}, liveSubmitEnabled: true, queue: createMockQueue(), projectsGateway: gateway } });
  const actor = { type: 'agent', kind: 'agent', id: 'technical-reviewer', name: 'Reviewer', avatarUrl: null };
  const evidence = path.join(directory, 'result.json');
  writeFileSync(evidence, '{"passed":true}');
  async function reviewed(policy = 'technical') {
    const task = app.database.createTask({ ...parseTaskCreate({
      projectId: 'dev-board-001', title: 'Attached task', status: 'todo',
    }, () => null), actor, assignee: actor });
    app.fengxi.config.cardBindings[task.id] = { projectId: 'dev-board-001',
      sourceProjectId: 'DEV-BOARD-001', workspaceRoot: directory,
      allowedScopes: [directory], completionPolicy: policy };
    const ready = app.fengxi.ready({ taskId: task.id, ifVersion: task.version, route: 'direct',
      executionMode: 'attached', allowedPaths: [directory], actor });
    const claimed = await app.fengxi.claim({ taskId: task.id, ifVersion: ready.version, chatOwner: actor.id, actor });
    return app.fengxi.review({ taskId: task.id, ifVersion: claimed.version, verdict: 'pass', evidence, actor });
  }
  try { await run({ app, gateway, directory, evidence, actor, reviewed }); }
  finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('attached technical review completes the card, not human acceptance', async () => {
  await fixture(async ({ app, gateway, reviewed }) => {
    const task = await reviewed();
    assert.equal(task.status, 'done');
    assert.equal(task.fengxi.attempt.status, 'technical_review_pass');
    assert.equal(task.fengxi.acceptance, null);
    assert.equal(gateway.calls.filter(call => call.action === 'release').length, 1);
    assert.equal(app.fengxi.executionBlocker(task.id), null);
  });
});

test('original review endpoint reconciles legacy attached passes without releasing or replacing evidence', async () => {
  await fixture(async ({ app, gateway, evidence, actor, reviewed }) => {
    const passed = await reviewed();
    app.fengxi.sqlite.prepare("UPDATE tasks SET status='in_review' WHERE id=?").run(passed.id);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${address.port}/api/fengxi/cards/${passed.id}/review`;
    const response = await fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fengxi-agent-token': app.fengxi.config.agentToken },
      body: JSON.stringify({ ifVersion: passed.version, verdict: 'pass', evidence }) });
    assert.equal(response.status, 200);
    const result = (await response.json()).task;
    assert.equal(result.status, 'done');
    assert.equal(result.fengxi.attempt.id, passed.fengxi.attempt.id);
    assert.deepEqual(result.fengxi.attempt.evidence, passed.fengxi.attempt.evidence);
    assert.equal(result.fengxi.attempt.evidenceHash, passed.fengxi.attempt.evidenceHash);
    assert.equal(result.fengxi.acceptance, null);
    const repeated = await app.fengxi.review({
      taskId: result.id, ifVersion: result.version, verdict: 'pass', evidence, actor });
    assert.equal(repeated.version, result.version);
    assert.equal(gateway.calls.filter(call => call.action === 'release').length, 1);
  });
});

test('human policy, changed evidence, stale revision and pending changes do not auto-complete', async () => {
  await fixture(async ({ app, evidence, actor, reviewed }) => {
    const human = await reviewed('human');
    assert.equal(human.status, 'in_review');
    await assert.rejects(app.fengxi.review({
      taskId: human.id, ifVersion: human.version, verdict: 'pass', evidence, actor }),
    { code: 'EXECUTION_NOT_RETURNED' });
    assert.throws(() => app.fengxi.accept({ taskId: human.id, ifVersion: human.version, actor }),
      { code: 'AGENT_ACCEPT_DENIED' });
    const task = await reviewed();
    app.fengxi.sqlite.prepare("UPDATE tasks SET status='in_review' WHERE id=?").run(task.id);
    const review = () => app.fengxi.review({
      taskId: task.id, ifVersion: task.version, verdict: 'pass', evidence, actor });
    writeFileSync(evidence, '{"passed":false}');
    await assert.rejects(review(), { code: 'EVIDENCE_CHANGED' });
    writeFileSync(evidence, '{"passed":true}');
    app.fengxi.sqlite.prepare('UPDATE fengxi_card_state SET requirement_revision=requirement_revision+1 WHERE task_id=?').run(task.id);
    await assert.rejects(review(), { code: 'TECHNICAL_COMPLETION_BLOCKED' });
    app.fengxi.sqlite.prepare('UPDATE fengxi_card_state SET requirement_revision=requirement_revision-1,pending_changes=1 WHERE task_id=?').run(task.id);
    await assert.rejects(review(), { code: 'TECHNICAL_COMPLETION_BLOCKED' });
    assert.equal(app.fengxi.snapshot(task.id).status, 'in_review');
  });
});

test('technical completion unlocks an unchanged dependency, but does not bypass a new blocked dependency', async () => {
  await fixture(async ({ app, evidence, actor, reviewed }) => {
    const upstream = await reviewed();
    app.fengxi.sqlite.prepare("UPDATE tasks SET status='in_review' WHERE id=?").run(upstream.id);
    let downstream = app.database.createTask({ ...parseTaskCreate({
      projectId: 'dev-board-001', title: 'Dependent task', status: 'todo',
    }, () => null), actor, assignee: actor });
    downstream = app.database.addTaskRelation(downstream.id, downstream.version, 'blocked_by',
      upstream.id, undefined, undefined, actor).task;
    assert.equal(app.fengxi.executionBlocker(downstream.id), 'waiting_dependency');
    await app.fengxi.review({ taskId: upstream.id, ifVersion: upstream.version, verdict: 'pass', evidence, actor });
    assert.equal(app.fengxi.executionBlocker(downstream.id), null);
    const blocked = await reviewed();
    app.fengxi.sqlite.prepare("UPDATE tasks SET status='in_review' WHERE id=?").run(blocked.id);
    app.database.addTaskRelation(blocked.id, blocked.version, 'blocked_by',
      downstream.id, undefined, undefined, actor);
    const snapshot = app.fengxi.snapshot(blocked.id);
    await assert.rejects(app.fengxi.review({
      taskId: blocked.id, ifVersion: snapshot.version, verdict: 'pass', evidence, actor }),
    { code: 'TECHNICAL_COMPLETION_BLOCKED' });
  });
});
