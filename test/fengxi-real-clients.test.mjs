import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createSpawnQueue } from '../server/fengxi-queue.mjs';

test('queue transport uses actual CLI argv/JSON schema and filters owner-scoped response', async () => {
  const root = path.resolve('.fengxi-work');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'client-'));
  try {
    const script = path.join(directory, 'strict_cli.py');
    await writeFile(script, `import json,sys
assert len(sys.argv)==4 and sys.argv[2]=='--json-file'
payload=json.load(open(sys.argv[3],encoding='utf-8'))
assert payload['owner']=='taskboard-test-owner'
row={'id':'fixture-original-id','state':'queued','sent':'not_sent','job_id':'TB-fixture-A1','project_id':'DEV-BOARD-001'}
if sys.argv[1]=='cursor_queue_submit':
 assert payload['project_id']=='DEV-BOARD-001'
 assert payload['allowed_paths']==['sandbox']
 assert 'approved comment' in payload['prompt']
 assert 'requestId' not in payload and payload['request_id']=='tb-fixture-r1-a1'
 print(json.dumps(row))
elif sys.argv[1]=='cursor_queue_status':
 print(json.dumps({'tasks':[row], 'global_active':[{'private':'not for taskboard'}]}))
else: raise ValueError('unexpected action')
`);
    const queue = createSpawnQueue({ pythonPath: process.env.FENGXI_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), queueClientPath: script, liveSubmitEnabled: true, runtimeDirectory: directory });
    const workspace = path.resolve('.');
    const input = { owner: 'taskboard-test-owner', jobId: 'TB-fixture-A1', requestId: 'tb-fixture-r1-a1', payload: { workspaceRoot: workspace, sourceProjectId: 'DEV-BOARD-001', allowedPaths: [path.join(workspace,'sandbox')], identifier:'DEV-1',title:'fixture',description:'scoped task', requirementRevision:1,comments:['approved comment'] } };
    assert.equal((await queue.submit(input)).taskId,'fixture-original-id');
    const found = await queue.status({ owner:input.owner,jobId:input.jobId });
    assert.equal(found.taskId,'fixture-original-id');
    assert.equal(found.global_active, undefined);
    assert.equal(found.sent,'not_sent');
    await assert.rejects(queue.submit({...input,payload:{...input.payload,allowedPaths:[path.resolve('..')]}}),/Scope outside workspace/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
