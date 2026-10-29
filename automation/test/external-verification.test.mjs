import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname,basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { providerRecords,providerVerificationReady,waitForProviderVerification,runtimeSourceUnchanged,inspect,REPOSITORY,ALLOWED_ACCOUNT,names } from '../external-provision.mjs';
import { repairSourceAllowed } from '../external-repair.mjs';

const domain='example.com';
const records=[
  {type:'TXT',name:'resend._domainkey',value:'p=test',status:'verified'},
  {type:'MX',name:'send',value:'feedback.provider.test',priority:10,status:'verified'},
  {type:'TXT',name:'send',value:'v=spf1 include:provider.test ~all',status:'verified'},
  {type:'MX',name:'',value:'receive.provider.test',priority:10,status:'verified'},
  {type:'CNAME',name:'rsend',value:'optional.provider.test',status:'pending'}
];
const state={domain,resendDomainId:'11111111-1111-4111-8111-111111111111',dns:providerRecords(domain,records)};
const ready={name:domain,status:'partially_verified',capabilities:{sending:'enabled',receiving:'enabled'},records};

test('all required records verified permits legacy mail while optional Forge CNAME is pending',() => {
  assert.equal(providerVerificationReady(state,ready),true);
  for (let index=0;index<4;index++) {
    const changed=structuredClone(ready);changed.records[index].status='pending';
    assert.equal(providerVerificationReady(state,changed),false);
  }
  for (const patch of [{name:'other.example'},{status:'failed'},{capabilities:{sending:'enabled',receiving:'disabled'}}])
    assert.equal(providerVerificationReady(state,{...ready,...patch}),false);
  const wrong=structuredClone(ready);wrong.records[3].value='wrong.provider.test';
  assert.equal(providerVerificationReady(state,wrong),false);
});

test('already verified required records do not restart verification',async () => {
  const calls=[];const resend={request:async (method,path) => {calls.push([method,path]);return ready;}};
  await waitForProviderVerification(resend,state,{wait:async()=>{throw Error('No wait expected');}});
  assert.deepEqual(calls,[['GET',`/domains/${state.resendDomainId}`]]);
});

test('asynchronous verification waits for real record readiness and times out without accepting pending',async () => {
  const pending=structuredClone(ready);pending.status='pending';pending.records[0].status='pending';
  const calls=[];let reads=0,waits=0;
  const resend={request:async(method,path)=>{calls.push([method,path]);return method==='POST'?{}:(++reads>=3?ready:pending);}};
  await waitForProviderVerification(resend,state,{attempts:3,wait:async()=>{waits++;},log:()=>{}});
  assert.equal(waits,1);assert.equal(calls.filter(([method])=>method==='POST').length,1);
  await assert.rejects(waitForProviderVerification({request:async()=>pending},state,{attempts:2,wait:async()=>{},log:()=>{}}),/asynchronous verification/);
});

test('real git comparison allows tooling-only descendants but rejects runtime or schema changes',async () => {
  const root=await mkdtemp(join(tmpdir(),'external-source-'));
  const git=args=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',shell:false});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  try {
    git(['init']);git(['config','user.name','Test Fixture']);git(['config','user.email','fixture@example.test']);git(['config','commit.gpgsign','false']);
    await mkdir(join(root,'mail-worker'));await mkdir(join(root,'mail-vue'));await mkdir(join(root,'automation'));
    await mkdir(join(root,'mail-worker','src','external'),{recursive:true});
    await writeFile(join(root,'mail-worker','src','external','protocol.js'),'original');
    await writeFile(join(root,'mail-worker','runtime.js'),'original');await writeFile(join(root,'mail-vue','app.js'),'original');
    await writeFile(join(root,'automation','schema.mjs'),'original');await writeFile(join(root,'automation','external-provision.mjs'),'original');
    git(['add','.']);git(['commit','-m','base']);const base=git(['rev-parse','HEAD']);
    await writeFile(join(root,'automation','external-provision.mjs'),'tooling fix');git(['add','.']);git(['commit','-m','tooling']);const tooling=git(['rev-parse','HEAD']);
    assert.equal(runtimeSourceUnchanged(base,tooling,root),true);
    assert.equal(repairSourceAllowed(base,tooling,root),false);
    await writeFile(join(root,'mail-worker','src','external','protocol.js'),'manual redirect fix');git(['add','.']);git(['commit','-m','protocol']);
    const protocol=git(['rev-parse','HEAD']);
    assert.equal(repairSourceAllowed(base,protocol,root),true);
    assert.equal(repairSourceAllowed(protocol,base,root),false);
    await writeFile(join(root,'mail-worker','runtime.js'),'changed');git(['add','.']);git(['commit','-m','runtime']);
    assert.equal(runtimeSourceUnchanged(base,git(['rev-parse','HEAD']),root),false);
    assert.equal(repairSourceAllowed(base,git(['rev-parse','HEAD']),root),false);
    assert.equal(runtimeSourceUnchanged(tooling,base,root),false);
    assert.equal(runtimeSourceUnchanged('invalid',tooling,root),false);
    await writeFile(join(root,'mail-worker','runtime.js'),'original');await writeFile(join(root,'automation','schema.mjs'),'changed');git(['add','.']);git(['commit','-m','schema']);
    assert.equal(runtimeSourceUnchanged(base,git(['rev-parse','HEAD']),root),false);
  } finally {
    const target=await realpath(root),parent=await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(),parent.toLowerCase());assert.ok(basename(target).startsWith('external-source-'));
    await rm(target,{recursive:true,force:true});
  }
});

test('cross-version finish keeps ownership checks and cannot use the exception to prepare or change runtime',async () => {
  const previous='a'.repeat(40),current='d'.repeat(40);
  const owned={...state,version:1,repository:REPOSITORY,accountId:ALLOWED_ACCOUNT,commit:previous,...names(domain),
    kvId:'b'.repeat(32),deploymentId:'c'.repeat(64),databaseId:'22222222-2222-4222-8222-222222222222',
    hostname:`${names(domain).worker}.test-account.workers.dev`,uploaded:true,webhookId:'33333333-3333-4333-8333-333333333333',apiKeyFingerprint:'e'.repeat(64)};
  const cf={list:async path=>path.includes('namespaces')?[{title:names(domain).kv,id:owned.kvId}]:[{name:names(domain).databaseName,uuid:owned.databaseId}],
    value:async()=>owned,get:async path=>path.endsWith('/subdomain')?{subdomain:'test-account'}:{bindings:[
      {name:'ONECLICK_DEPLOYMENT_ID',text:owned.deploymentId},{name:'db',id:owned.databaseId},{name:'kv',namespace_id:owned.kvId}]}};
  const options={cf,resend:{request:async()=>({data:[{name:domain,id:owned.resendDomainId}]})},accountId:ALLOWED_ACCOUNT,domain,
    customerDomain:domain,repository:REPOSITORY,commit:current,ownerEmail:'owner@example.net',fetcher:async()=>Response.json({Status:0}),sourceCompatible:async()=>true};
  for (const mode of ['plan','finish']) await assert.doesNotReject(inspect({...options,mode}));
  await assert.rejects(inspect({...options,mode:'prepare'}),/source version mismatch/);
  await assert.rejects(inspect({...options,mode:'finish',sourceCompatible:async()=>false}),/source version mismatch/);
  const original=owned.worker;owned.worker='cloud-mail4';await assert.rejects(inspect({...options,mode:'finish'}),/ownership/);owned.worker=original;
});
