import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { repair,assertExistingBindings } from '../external-repair.mjs';
import { names,REPOSITORY,ALLOWED_ACCOUNT,STATE_KEY } from '../external-provision.mjs';

function fixture() {
  const domain='example.com',expectedCommit='a'.repeat(40),commit='d'.repeat(40),key='re_test';
  const state={version:1,repository:REPOSITORY,accountId:ALLOWED_ACCOUNT,domain,commit:expectedCommit,...names(domain),
    hostname:`${names(domain).worker}.test-account.workers.dev`,kvId:'b'.repeat(32),databaseId:'11111111-1111-4111-8111-111111111111',
    deploymentId:'c'.repeat(64),resendDomainId:'22222222-2222-4222-8222-222222222222',webhookId:'33333333-3333-4333-8333-333333333333',
    uploaded:true,apiKeyFingerprint:createHash('sha256').update(key).digest('hex'),dns:[{type:'MX',name:domain,content:'receive.provider.test',priority:10}]};
  const settings={bindings:[{name:'db',type:'d1',id:state.databaseId},{name:'kv',type:'kv_namespace',namespace_id:state.kvId},
    {name:'ONECLICK_DEPLOYMENT_ID',type:'plain_text',text:state.deploymentId},
    ...['jwt_secret','EXTERNAL_RESEND_API_KEY','EXTERNAL_WEBHOOK_SECRET'].map(name=>({name,type:'secret_text'}))]};
  const mutations=[];let deployed;
  const options={accountId:ALLOWED_ACCOUNT,domain,customerDomain:domain,repository:REPOSITORY,expectedCommit,commit,
    ownerEmail:'owner@example.net',workerDir:'/workspace/mail-worker',sourceAllowed:async()=>true,
    fetcher:async()=>Response.json({Status:0}),
    cf:{list:async path=>path.includes('/namespaces')?[{title:names(domain).kv,id:state.kvId}]:[{name:state.databaseName,uuid:state.databaseId}],
      value:async()=>state,get:async path=>path.endsWith('/subdomain')?{subdomain:'test-account'}:settings,
      query:async(account,id,sql)=>{assert.equal(id,state.databaseId);assert.match(sql,/^SELECT /);return [{results:[{deployment_id:state.deploymentId,domain,schema_ready:1,activated:1}]}];},
      putValue:async(...args)=>mutations.push(args)},
    resend:{key,request:async(method,path)=>{assert.equal(method,'GET');return path==='/domains'?{data:[{name:domain,id:state.resendDomainId}]}:
      {endpoint:`https://${state.hostname}/_external/resend`,events:['email.received']};}},
    deployWorker:async config=>{deployed=config;},
    probe:async()=>({schemaReady:true,activated:true,deploymentId:state.deploymentId})};
  return {options,state,settings,mutations,deployed:()=>deployed};
}

test('repair only updates the owned Worker and source audit after health succeeds',async()=>{
  const f=fixture();const result=await repair(f.options),config=f.deployed();
  assert.equal(result.status,'inbound_runtime_repaired');assert.equal(config.name,f.state.worker);
  assert.equal(config.keep_vars,true);assert.equal(config.kv_namespaces[0].id,f.state.kvId);
  assert.equal(config.d1_databases[0].database_id,f.state.databaseId);
  assert.deepEqual(f.mutations[0].slice(0,3),[ALLOWED_ACCOUNT,f.state.kvId,STATE_KEY]);
  assert.equal(f.mutations.length,1);assert.equal(f.mutations[0][3].commit,f.options.commit);
  assert.equal(f.mutations[0][3].repairs[0].from,f.options.expectedCommit);
});

test('mismatched customer/source, missing secrets and changed bindings stop before deployment',async()=>{
  for(const kind of ['source','customer','secret','database','unowned-binding','key']) {
    const f=fixture();
    if(kind==='source') f.options.sourceAllowed=async()=>false;
    if(kind==='customer') f.options.customerDomain='other.com';
    if(kind==='secret') f.settings.bindings.pop();
    if(kind==='database') f.settings.bindings[0].id='99999999-9999-4999-8999-999999999999';
    if(kind==='unowned-binding') f.settings.bindings.push({name:'old_project',type:'kv_namespace',namespace_id:'f'.repeat(32)});
    if(kind==='key') f.options.resend.key='re_other';
    await assert.rejects(repair(f.options));assert.equal(f.deployed(),undefined);assert.equal(f.mutations.length,0);
  }
});

test('unhealthy deployment never records successful repair or touches database data',async()=>{
  const f=fixture();f.options.probe=async()=>({schemaReady:true,activated:false});
  await assert.rejects(repair(f.options),/health check/);assert.equal(f.mutations.length,0);
});

test('repair preserves the protected customer environment and cannot run on push',async()=>{
  const workflow=await readFile(new URL('../../.github/workflows/repair-external-inbound.yml',import.meta.url),'utf8');
  assert.ok(workflow.includes('environment: external-'));assert.ok(workflow.includes('expected_deployed_commit:'));
  assert.ok(!/\n\s+push:/.test(workflow));assert.ok(!workflow.includes('secrets: inherit'));
  const f=fixture();assert.doesNotThrow(()=>assertExistingBindings(f.settings,f.state));
});
