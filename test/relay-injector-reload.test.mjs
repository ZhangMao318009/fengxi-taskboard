import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/codex-injector.mjs', import.meta.url), 'utf8');
test('cold restart ignores the Spotlight auxiliary page and retains the relay main page', () => {
  const start = source.indexOf('function isCodexTarget(');
  const predicate = vm.runInNewContext(`(${source.slice(start, source.indexOf('\nfunction ', start + 1))})`);
  assert.equal(predicate({ type: 'page', url: 'app://-/index.html?initialRoute=%2Fspotlight' }), false);
  assert.equal(predicate({ type: 'page', url: 'app://-/index.html' }), true);
});
const functionSource = source.slice(source.indexOf('async function injectAll('), source.indexOf('\nasync function ', source.indexOf('async function injectAll(') + 1));
for (const entryMounted of [true, false]) {
  test(`connected renderer with entryMounted=${entryMounted} repairs only a missing entry`, async () => {
    const calls = [];
    const connection = { closed: false, hostBridge: { install: async () => calls.push('host') } };
    const injectAll = vm.runInNewContext(`(${functionSource})`, {
      readInjectionStatus: async c => { assert.equal(c, connection); return { entryMounted }; },
      evaluateInjectionSource: async (c, text) => { assert.equal(c, connection); assert.equal(text, 'current'); calls.push('restore'); },
      injectTarget: () => assert.fail('must reuse the existing connection'),
    });
    await injectAll({ targets: async () => [{ id: 'relay' }] }, 'current', 'hash', false, null,
      new Map([['relay', connection]]), true, null, false, null, null, null, null);
    assert.deepEqual(calls, entryMounted ? [] : ['host', 'restore']);
  });
}

test('one runtime attaches both clients and keeps the reachable client when the other closes', async () => {
  const start = source.indexOf('function tcpCdpRuntime(');
  let relayAvailable = true;
  const runtime = vm.runInNewContext(`(${source.slice(start, source.indexOf('\nfunction ', start + 1))})`, {
    process: {env: {CODEX_TASKBOARD_ATTACH_PORTS: '9230'}},
    isReachable: async url => !url.includes(':9229/') || relayAvailable,
    codexTargets: async port => [{id:'same-id', port}],
  })(9229);
  const both = await runtime.targets();
  assert.equal(both.length, 2);
  assert.notEqual(both[0].id, both[1].id);
  relayAvailable = false;
  const official = await runtime.targets();
  assert.equal(official.length, 1);
  assert.equal(official[0].port, 9230);
});
