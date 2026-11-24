import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskboardServer} from '../server/app.mjs';
import {createMockQueue,createMockProjectsGateway} from '../server/fengxi-queue.mjs';
import {FengxiCodex} from '../server/fengxi-codex.mjs';
import {parseTaskCreate} from '../shared/task-input.mjs';

test('approved cards claim, execute, independently review and release the next dependency once',async()=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'fengxi-chain-'));
 const gateway=createMockProjectsGateway();
 const app=createTaskboardServer({dataDirectory:directory,fengxi:{fileConfig:{},liveSubmitEnabled:true,
   queue:createMockQueue(),projectsGateway:gateway}});
 const actor={type:'agent',kind:'agent',id:'chain-test',name:'链路验收',avatarUrl:null};
 const make=title=>app.database.createTask({...parseTaskCreate({projectId:'dev-board-001',title,status:'todo'},()=>null),actor,assignee:actor});
 const first=make('第一项技术任务');let second=make('依赖第一项的技术任务');const unbound=make('未绑定的大目标');
 second=app.database.addTaskRelation(second.id,second.version,'blocked_by',first.id,undefined,undefined,actor).task;
 // Card-specific bindings do not grant the rest of the overview a writable root.
 const bind=id=>app.fengxi.config.cardBindings[id]={projectId:'dev-board-001',sourceProjectId:'DEV-BOARD-001',
   workspaceRoot:directory,allowedScopes:[directory],completionPolicy:'technical'};
 bind(first.id);bind(second.id);
 for(const task of [second,first]) app.fengxi.ready({taskId:task.id,ifVersion:task.version,route:'direct',
   executionMode:'managed',entry:'official-d',allowedPaths:[directory],acceptanceCriteria:'实际检查结果文件',actor});
 let emit;let next=0;
 const client={subscribe:f=>{emit=f;return()=>{}},close:async()=>{},
   request:async method=>method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:99}}}:{config:{}},
   startThread:async()=>({thread:{id:'thread-'+(++next)}}),startTurn:async()=>({turn:{id:'turn-'+next}})};
 const driver=new FengxiCodex({adapter:app.fengxi,entry:'official-d',settings:{},client});
 const finish=review=>{
   const active=driver.active;const receipt=review?active.receipt.review:active.receipt;
   emit({method:'turn/completed',params:{threadId:receipt.threadId,turn:{id:receipt.turnId,status:'completed',items:
     review?[{type:'commandExecution',exitCode:0},{type:'agentMessage',text:JSON.stringify({verdict:'pass',summary:'已检查实际文件'})}]:[{type:'agentMessage',text:'已执行'}]}}});
 };
 try {
   assert.equal(app.fengxi.executionBlocker(second.id),'waiting_dependency');
   await assert.rejects(app.fengxi.claim({taskId:second.id,ifVersion:app.fengxi.snapshot(second.id).version,
     chatOwner:app.fengxi.serviceOwner,entry:'official-d',actor}),{code:'EXECUTION_BLOCKED'});
   await driver.tick();assert.equal(driver.active.attempt.taskId,first.id);
   writeFileSync(path.join(directory,'result.txt'),'actual result');finish(false);
   await driver.tick();assert.equal(driver.active.reviewing,true);finish(true);
   await driver.tick();
   assert.equal(app.fengxi.snapshot(first.id).status,'done');
   assert.equal(app.fengxi.snapshot(first.id).fengxi.acceptance,null);
   assert.equal(driver.active.attempt.taskId,second.id);
   finish(false);await driver.tick();finish(true);await driver.tick();await driver.tick();
   assert.equal(app.fengxi.snapshot(second.id).status,'done');
   assert.equal(app.fengxi.listAttempts(first.id).length,1);
   assert.equal(app.fengxi.listAttempts(second.id).length,1);
   assert.equal(gateway.calls.filter(c=>c.action==='claim').length,2);
   assert.equal([...gateway.claims.values()].filter(claim=>claim.active).length,0);
   assert.equal(app.fengxi.snapshot(unbound.id).fengxi.approval,null);
   const evidence=app.fengxi.snapshot(first.id).fengxi.attempt.evidence.path;
   writeFileSync(evidence,'changed');
   assert.equal(app.fengxi.executionBlocker(second.id),'dependency_evidence_changed');
 }finally{await driver.close();await app.close();rmSync(directory,{recursive:true,force:true});}
});
