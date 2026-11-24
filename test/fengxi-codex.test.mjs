import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionEligibility, reviewVerdict, retryDelay, readQuotaCache } from '../server/fengxi-codex.mjs';

test('only confirmed capacity and quota failures can continue, with bounded capacity retries', () => {
  const turn={status:'failed',error:{codexErrorInfo:'serverOverloaded'}};
  assert.equal(retryDelay(turn,[],0),300000);
  assert.equal(retryDelay(turn,[],2),1200000);
  assert.equal(retryDelay(turn,[],3),null);
  assert.equal(retryDelay(turn,[{type:'commandExecution',status:'inProgress'}],0),null);
  assert.equal(retryDelay({...turn,status:'inProgress'},[],0),null);
  assert.equal(retryDelay({status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}},[],4),300000);
  assert.equal(retryDelay({status:'failed',error:{codexErrorInfo:'other'}},[],0),null);
});

test('independent review needs an actual successful check and a valid verdict', () => {
  const review = {turn: {status:'completed'}, items:[{type:'agentMessage',text:'{"verdict":"pass","summary":"checked actual output"}'}]};
  assert.equal(reviewVerdict(review).verdict, 'fail');
  review.items.unshift({type:'commandExecution',exitCode:0});
  assert.equal(reviewVerdict(review).verdict, 'pass');
  review.items[0].exitCode = 1;
  assert.equal(reviewVerdict(review).verdict, 'fail');
  review.items.at(-1).text = 'Everything passed';
  assert.equal(reviewVerdict(review).verdict, 'fail');
});

test('paginated history is bound to the original turn and keeps actual checks', async () => {
 const calls=[];
 const driver=new FengxiCodex({adapter:{executorStatus:{}},entry:'official-d',settings:{},client:{
   subscribe:()=>()=>{},close:async()=>{},request:async (method,input)=>{
     calls.push({method,input});
     return input.cursor ? {data:[{turnId:'turn',item:{id:'final',type:'agentMessage',text:'done'}}]} :
       {data:[{turnId:'turn',item:{id:'check',type:'commandExecution',exitCode:0}}],nextCursor:'next'};
   }}});
 try {
   const execution={threadId:'thread',turnId:'turn',turn:{itemsView:'summary'},items:[]};
   await driver.hydrate(execution);
   assert.equal(execution.items.length,2);
   assert.equal(execution.items[0].type,'commandExecution');
   assert.equal(calls[1].input.cursor,'next');
   await driver.hydrate(execution);
   assert.equal(calls.length,2);
 } finally {await driver.close();}
});

test('paid admission requires both fresh subscriptions exhausted and fresh paid balance', () => {
  const at = Date.now();
  const item = remaining => ({status:'ok',remaining,observedAt:at});
  const snapshot = {official:item(10),cursor:item(10),relay:{available:true,observedAt:at}};
  for (const [official,cursor] of [[10,10],[0.01,0],[0,0.01],[0,0],[1,0],[0,1]]) {
    snapshot.official.remaining=official;snapshot.cursor.remaining=cursor;
    assert.equal(executionEligibility('relay-d',snapshot,at),official===0 && cursor===0);
    assert.equal(executionEligibility('official-d',snapshot,at),official>0);
    assert.equal(executionEligibility('cursor-subscription',snapshot,at),cursor>0);
  }
  snapshot.official.remaining=0;snapshot.cursor.remaining=0;
  assert.equal(executionEligibility('unknown-entry',snapshot,at),false);
  assert.equal(executionEligibility('relay-d',snapshot,at+120001),false);
  snapshot.cursor.status='unknown';
  assert.equal(executionEligibility('relay-d',snapshot,at),false);
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FengxiCodex } from '../server/fengxi-codex.mjs';

test('cache respects all official windows, stale observations and Cursor billing cycle', () => {
 const folder=mkdtempSync(path.join(os.tmpdir(),'taskboard-quota-'));
 const file=path.join(folder,'quota.json');
 const at=Date.now();
 const channels={codex:{status:'ok',last_success_at:new Date(at).toISOString(),primary:{remaining_percent:50},secondary:{remaining_percent:0}},
   cursor:{status:'ok',last_success_at:new Date(at).toISOString(),plan_usage:{auto_percent_used:99,billing_cycle_end_ms:at+3600000}},
   shanzhu:{status:'ok',last_success_at:new Date(at).toISOString(),site_balance:{currency:'USD',balance:'1'}}};
 const read=()=>{writeFileSync(file,JSON.stringify({channels}));return readQuotaCache(file);};
 try {
   assert.equal(read().official.remaining,0);
   assert.equal(executionEligibility('official-d',read(),at),false);
   assert.equal(executionEligibility('cursor-subscription',read(),at),true);
   channels.cursor.plan_usage.auto_percent_used=100;
   assert.equal(executionEligibility('relay-d',read(),at),true);
   channels.codex.secondary.remaining_percent=1;
   assert.equal(executionEligibility('relay-d',read(),at),false);
   assert.equal(executionEligibility('official-d',read(),at),true);
   channels.codex.secondary.remaining_percent='bad';
   assert.equal(read().official.remaining,null);
   channels.codex.secondary.remaining_percent=0;
   for (const reset of [at/1000-1, at/1000, true, 'NaN']) {
     channels.codex.secondary.resets_at=reset;
     assert.equal(executionEligibility('relay-d',read(),at),false);
   }
   channels.codex.secondary.resets_at=at/1000+60;
   assert.equal(executionEligibility('relay-d',read(),at),true);
   channels.codex.stale=true;
   assert.equal(executionEligibility('relay-d',read(),at),false);
   channels.codex.stale=false;
   channels.cursor.plan_usage.billing_cycle_end_ms=at-1;
   assert.equal(executionEligibility('relay-d',read(),at),false);
   channels.cursor.plan_usage.billing_cycle_end_ms=at+3600000;
   channels.shanzhu.site_balance.balance='Infinity';
   assert.equal(executionEligibility('relay-d',read(),at),false);
 } finally {rmSync(folder,{recursive:true,force:true});}
});

test('official quota takes its limiting window and retries low usable capacity within freshness', async () => {
 const at=Date.now();
 const driver=new FengxiCodex({adapter:{executorStatus:{}},entry:'official-d',settings:{},client:{
   subscribe:()=>()=>{},close:async()=>{},request:async()=>({rateLimits:{primary:{usedPercent:50},secondary:{usedPercent:99}}})}});
 try {
   assert.equal(executionEligibility('official-d',await driver.quota()),true);
   assert.ok(driver.nextQuotaReadAt<=at+61000);
 } finally {await driver.close();}
});

test('live official execution and independent review preserve the original resource and card', {
 skip: !process.env.FENGXI_LIVE_REVIEW_DIR, timeout: 900000,
}, async () => {
 const {readFileSync,existsSync,mkdirSync,writeFileSync}=await import('node:fs');
 const {createTaskboardServer}=await import('../server/app.mjs');
 const {parseTaskCreate}=await import('../shared/task-input.mjs');
 const root=path.resolve(import.meta.dirname,'..');
 const directory=path.resolve(process.env.FENGXI_LIVE_REVIEW_DIR);
 const reworking=process.env.FENGXI_LIVE_REWORK === '1';
 const continuing=process.env.FENGXI_LIVE_CONTINUE === '1' || reworking;
 assert.ok(!existsSync(directory) || continuing,'Never silently repeat a live run; reconcile its saved attempt first');
 mkdirSync(directory,{recursive:true});
 assert.ok(process.env.FENGXI_CONFIG_PATH, 'Live execution requires an explicitly authorized FENGXI_CONFIG_PATH');
 const config=JSON.parse(readFileSync(process.env.FENGXI_CONFIG_PATH,'utf8'));
 const scope=path.join(root,'sandbox','tb-loop-20261030');
 mkdirSync(scope,{recursive:true});
 const app=createTaskboardServer({dataDirectory:directory,fengxi:{fileConfig:{},
   liveSubmitEnabled:true,projectsClientPath:config.projectsClientPath,pythonPath:config.pythonPath,
   bindings:[{projectId:'dev-board-001',sourceProjectId:'DEV-BOARD-001',workspaceRoot:root,allowedScopes:[scope]}]}});
 const driver=new FengxiCodex({adapter:app.fengxi,entry:'official-d',settings:config.managedExecutors['official-d']});
 let task;
 try {
   const quota=await driver.quota();
   assert.equal(executionEligibility('official-d',quota),true,'Fresh subscription eligibility required');
   const actor={id:'tb-loop-authorized-verification',type:'agent',kind:'agent',name:'Integration verification',avatarUrl:null};
   if(continuing) {
     const saved=JSON.parse(readFileSync(path.join(directory,'latest-card.json'),'utf8'));
     task=app.fengxi.snapshot(saved.id);
     const original=task.fengxi.attempt;
     assert.equal(original.status,'technical_review_fail');
   if(reworking) {
     task=app.fengxi.returnRevision({taskId:task.id,ifVersion:task.version,
       note:'Recheck the same output after the driver history recovery fix. The exact required text is "Taskboard loop verification: 42" with no period; one trailing newline is allowed. Use Get-Content -Raw for the check; .NET construction is unsupported in this Windows sandbox.',actor});
     task=app.fengxi.ready({taskId:task.id,ifVersion:task.version,route:'direct',executionMode:'managed',entry:'official-d',
       allowedPaths:[scope],acceptanceCriteria:'The exact content must be "Taskboard loop verification: 42" without a period. Only a single trailing newline is allowed. Read the actual file with Get-Content -Raw and assert the exact text.',
       note:'Use the explicit rework note to resolve the earlier punctuation ambiguity. Preserve the original failure history.',actor});
   } else {
     const delay=retryDelay(original.managed.turn,original.managed.items,original.managed.retryCount ?? 0);
     assert.ok(delay,'Only an explicit retryable terminal failure may continue');
     original.managed.retryAt=new Date(Date.parse(original.managed.finishedAt)+delay).toISOString();
     assert.ok(Date.parse(original.managed.retryAt)<=Date.now(),'Wait for the original backoff');
     driver.save(original.id,original.managed);
     assert.equal(app.fengxi.continueManaged(task.id,original.id),true);
   }
   } else {
   task=app.database.createTask({...parseTaskCreate({projectId:'dev-board-001',title:'Taskboard live review verification',status:'todo',
     description:`Only create ${path.join(scope,'result.md')}. Its complete text must be "Taskboard loop verification: 42" without a period. Do not modify any other file. Verify by reading the actual file. This is a taskboard integration check, no deployment.`},()=>null),actor,assignee:actor});
   task=app.fengxi.ready({taskId:task.id,ifVersion:task.version,route:'direct',executionMode:'managed',entry:'official-d',
     allowedPaths:[scope],acceptanceCriteria:'result.md must contain exactly "Taskboard loop verification: 42" without a period (trailing newline allowed). Read the file using a real command and assert its text.',actor});
   }
   let last='';
   for(let index=0;index<150;index++) {
     await driver.tick();
     task=app.fengxi.snapshot(task.id);
     const status=[task.status,task.fengxi.attempt?.status,task.fengxi.attempt?.managed?.review?.phase,driver.waitingReason].join(' / ');
     if(status!==last){console.log(status);last=status;}
     writeFileSync(path.join(directory,'latest-card.json'),JSON.stringify(task,null,2));
     if(['technical_review_pass','technical_review_fail'].includes(task.fengxi.attempt?.status)) break;
     assert.ok(!/unknown|unresolved|unavailable/.test(driver.waitingReason ?? ''),'Reconcile persisted original execution before another live action');
     await new Promise(resolve=>setTimeout(resolve,5000));
   }
   assert.equal(task.fengxi.attempt?.status,'technical_review_pass');
   assert.equal(task.status,'in_review');
   assert.equal(task.fengxi.acceptance,null);
   assert.equal(readFileSync(path.join(scope,'result.md'),'utf8').trim(),'Taskboard loop verification: 42');
   const resource=await app.fengxi.projectsGateway.status({jobId:task.fengxi.attempt.jobId,owner:app.fengxi.serviceOwner});
   assert.equal(resource.active,false);
   writeFileSync(path.join(directory,'verified.json'),JSON.stringify({taskId:task.id,attempt:task.fengxi.attempt.id,
     threadId:task.fengxi.attempt.managed.threadId,reviewThreadId:task.fengxi.attempt.managed.review.threadId,resource,humanAccepted:false},null,2));
 } finally {
   if(task)writeFileSync(path.join(directory,'latest-card.json'),JSON.stringify(app.fengxi.snapshot(task.id),null,2));
   await driver.close();await app.close();
 }
});

test('managed launch persists identity, resumes exact parent, and preserves early completion', async () => {
 const directory=mkdtempSync(path.join(os.tmpdir(),'tb08-driver-'));
 const writes=[]; let listener; let resumed=0;
 const parent={id:'parent',payload:{entry:'official-d'},managed:{threadId:'original-thread'}};
 const adapter={serviceOwner:'service',config:{runtimeDirectory:directory},listAttempts:()=>[parent],
  sqlite:{prepare:sql=>({run:(...args)=>writes.push({sql,args})})}};
 const client={subscribe:fn=>{listener=fn;return()=>{}},request:async()=>({config:{mcp_servers:{cursor_queue:{}}}}),
  startThread:async()=>{throw Error('must resume exact original')},
  resumeThread:async input=>{assert.equal(input.threadId,'original-thread');assert.equal(input.config['mcp_servers.cursor_queue.enabled'],false);resumed++;return{thread:{id:input.threadId}}},
  startTurn:async()=>{listener({method:'turn/completed',params:{threadId:'original-thread',turn:{id:'real-turn',status:'completed'}}});return{turn:{id:'real-turn'}}},close:async()=>{}};
 try {
  const driver=new FengxiCodex({adapter,entry:'official-d',settings:{},client});
  await driver.launch({id:'attempt',taskId:'card',parentAttemptId:'parent',payload:{workspaceRoot:directory,entry:'official-d'}});
  assert.equal(resumed,1);assert.equal(driver.active,null);
  assert.ok(writes.some(w=>w.sql.includes('status=?,evidence_json') && w.args[0]==='returned'));
  assert.ok(!writes.some(w=>w.sql.includes("status='running'")));
  await driver.close();
 } finally {rmSync(directory,{recursive:true,force:true})}
});
