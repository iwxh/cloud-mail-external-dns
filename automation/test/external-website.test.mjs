import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {SourceTextModule,SyntheticModule} from 'node:vm';
import {externalHostAllowed,customWebsiteHost} from '../../mail-worker/src/external/hosts.js';
import {setupRequest} from '../../mail-worker/src/oneclick/setup.js';
import {addWebsite,websiteHostname} from '../external-website.mjs';
import {workerConfig,names,REPOSITORY,ALLOWED_ACCOUNT,STATE_KEY} from '../external-provision.mjs';

const env={EXTERNAL_DNS_MODE:'true',EXTERNAL_WEBSITE_HOST:'customer.account.workers.dev',ONECLICK_DOMAIN:'example.com',
  EXTERNAL_CUSTOM_WEBSITE_HOST:'mail.example.com',jwt_secret:'test-only'};

test('website alias is limited to the exact mail domain and keeps the original callback hostname',()=>{
  assert.equal(customWebsiteHost(env),'mail.example.com');
  for(const host of ['mail.example.com','customer.account.workers.dev']) assert.equal(externalHostAllowed(host,env),true);
  for(const host of ['other.example.com','mail.example.com.attacker.invalid','evil.invalid']) assert.equal(externalHostAllowed(host,env),false);
  for(const value of ['https://mail.example.com','mail.other.com','*.example.com','mail.example.com/path','MAIL.example.com']) {
    assert.equal(customWebsiteHost({...env,EXTERNAL_CUSTOM_WEBSITE_HOST:value}),null);
    assert.throws(()=>websiteHostname('example.com',value));
  }
});

test('actual entry serves both website hosts, accepts callbacks only on the original host and blocks legacy init',async()=>{
  let inboundCalls=0,metaCalls=0,appCalls=0;
  const dependencies={
    './index.js':{default:{fetch:async request=>{appCalls++;return new Response(new URL(request.url).hostname);}}},
    './utils/crypto-utils.js':{default:{}},'./service/setting-service.js':{default:{}},
    './oneclick/setup.js':{deploymentMeta:async()=>{metaCalls++;return {schema_ready:1,activated:1};},ensureSettings:async()=>true,
      setupRequest:async()=>new Response('health')},
    './external/inbound.js':{inbound:async()=>{inboundCalls++;return new Response('signed callback');}},
    './external/hosts.js':{externalHostAllowed}
  };
  const module=new SourceTextModule(await readFile(new URL('../../mail-worker/src/external-entry.js',import.meta.url),'utf8'));
  await module.link(specifier=>{const values=dependencies[specifier];assert.ok(values,specifier);
    return new SyntheticModule(Object.keys(values),function(){for(const [name,value] of Object.entries(values))this.setExport(name,value);});});
  await module.evaluate();const app=module.namespace.default;
  for(const hostname of ['mail.example.com','customer.account.workers.dev']) {
    assert.equal(await (await app.fetch(new Request(`https://${hostname}/login`),env,{})).text(),hostname);
    assert.equal((await app.fetch(new Request(`https://${hostname}/api/init/secret`),env,{})).status,404);
  }
  assert.equal((await app.fetch(new Request('https://mail.example.com/_external/resend'),env,{})).status,404);
  assert.equal(await (await app.fetch(new Request('https://customer.account.workers.dev/_external/resend'),env,{})).text(),'signed callback');
  const before=metaCalls;
  assert.equal((await app.fetch(new Request('https://other.example.com/login'),env,{})).status,404);
  assert.equal(metaCalls,before);assert.equal(inboundCalls,1);assert.equal(appCalls,2);
});

test('custom setup and health retain HTTPS and same-origin checks',async()=>{
  const meta={schema_ready:1,activated:0};
  assert.equal((await setupRequest(new Request('https://mail.example.com/_cloudmail/health'),env,meta,()=>{})).status,200);
  assert.equal((await setupRequest(new Request('http://mail.example.com/setup'),env,meta,()=>{})).status,404);
  assert.equal((await setupRequest(new Request('https://other.example.com/setup'),env,meta,()=>{})).status,404);
  const response=await setupRequest(new Request('https://mail.example.com/setup',{method:'POST',headers:{Origin:'https://attacker.invalid'}}),env,meta,()=>{});
  assert.equal(response.status,403);
  assert.equal((await setupRequest(new Request('https://mail.example.com/setup'),env,{...meta,activated:1},()=>{})).status,404);
});

function fixture() {
  const domain='example.com',expectedCommit='a'.repeat(40),commit='d'.repeat(40),key='re_test';
  const state={version:1,repository:REPOSITORY,accountId:ALLOWED_ACCOUNT,domain,commit:expectedCommit,...names(domain),
    hostname:`${names(domain).worker}.test-account.workers.dev`,kvId:'b'.repeat(32),databaseId:'11111111-1111-4111-8111-111111111111',
    deploymentId:'c'.repeat(64),resendDomainId:'22222222-2222-4222-8222-222222222222',webhookId:'33333333-3333-4333-8333-333333333333',
    uploaded:true,apiKeyFingerprint:createHash('sha256').update(key).digest('hex'),dns:[]};
  const settings={bindings:[{name:'db',type:'d1',id:state.databaseId},{name:'kv',type:'kv_namespace',namespace_id:state.kvId},
    {name:'ONECLICK_DEPLOYMENT_ID',type:'plain_text',text:state.deploymentId},
    ...['jwt_secret','EXTERNAL_RESEND_API_KEY','EXTERNAL_WEBHOOK_SECRET'].map(name=>({name,type:'secret_text'}))]};
  const mutations=[];let deployed;
  const options={accountId:ALLOWED_ACCOUNT,domain,customerDomain:domain,repository:REPOSITORY,expectedCommit,commit,websiteHost:'mail.example.com',
    ownerEmail:'owner@example.net',workerDir:'/workspace/mail-worker',sourceAllowed:async()=>true,mode:'prepare',fetcher:async()=>Response.json({Status:0}),
    cf:{list:async path=>path.includes('/namespaces')?[{title:names(domain).kv,id:state.kvId}]:[{name:state.databaseName,uuid:state.databaseId}],
      value:async()=>state,get:async path=>path.endsWith('/subdomain')?{subdomain:'test-account'}:settings,
      query:async(_account,id,sql)=>{assert.equal(id,state.databaseId);assert.match(sql,/^SELECT /);return [{results:[{deployment_id:state.deploymentId,domain,schema_ready:1,activated:1}]}];},
      putValue:async(...args)=>mutations.push(args)},
    resend:{key,request:async(method,path)=>{assert.equal(method,'GET');return path==='/domains'?{data:[{name:domain,id:state.resendDomainId}]}:
      {endpoint:`https://${state.hostname}/_external/resend`,events:['email.received']};}},
    deployWorker:async config=>{deployed=config;if(!settings.bindings.some(b=>b.name==='EXTERNAL_CUSTOM_WEBSITE_HOST'))
      settings.bindings.push({name:'EXTERNAL_CUSTOM_WEBSITE_HOST',type:'plain_text',text:config.vars.EXTERNAL_CUSTOM_WEBSITE_HOST});},
    probe:async(url)=>{assert.equal(new URL(url).hostname,state.hostname);return {schemaReady:true,activated:true,deploymentId:state.deploymentId};}};
  return {options,state,settings,mutations,deployed:()=>deployed};
}

test('website plan is read-only; prepare retains callback, data bindings and secrets',async()=>{
  const f=fixture();assert.equal((await addWebsite({...f.options,mode:'plan'})).status,'read_only_website_plan');
  assert.equal(f.deployed(),undefined);assert.equal(f.mutations.length,0);
  const result=await addWebsite(f.options),config=f.deployed();
  assert.equal(result.status,'website_runtime_ready_dns_tls_pending');assert.equal(config.name,f.state.worker);
  assert.equal(config.vars.EXTERNAL_WEBSITE_HOST,f.state.hostname);assert.equal(config.vars.EXTERNAL_CUSTOM_WEBSITE_HOST,'mail.example.com');
  assert.equal(config.keep_vars,true);assert.equal(config.d1_databases[0].database_id,f.state.databaseId);
  assert.equal(config.kv_namespaces[0].id,f.state.kvId);assert.equal(config.routes,undefined);
  assert.equal(f.mutations.length,1);assert.equal(f.mutations[0][2],STATE_KEY);assert.equal(f.mutations[0][3].hostname,f.state.hostname);
});

test('website migration rejects foreign source/customer/bindings/aliases before deployment',async()=>{
  for(const kind of ['source','customer','binding','alias','key']) {
    const f=fixture();if(kind==='source')f.options.sourceAllowed=async()=>false;
    if(kind==='customer')f.options.customerDomain='other.com';
    if(kind==='binding')f.settings.bindings[0].id='99999999-9999-4999-8999-999999999999';
    if(kind==='alias')f.options.websiteHost='mail.other.com';if(kind==='key')f.options.resend.key='re_other';
    await assert.rejects(addWebsite(f.options));assert.equal(f.deployed(),undefined);assert.equal(f.mutations.length,0);
  }
  assert.throws(()=>workerConfig({...fixture().state,websiteHost:'mail.other.com'},'/workspace'));
});

test('same-host retry after upload preserves ownership; unhealthy original host is not marked complete',async()=>{
  const f=fixture();f.settings.bindings.push({name:'EXTERNAL_CUSTOM_WEBSITE_HOST',type:'plain_text',text:'mail.example.com'});
  await assert.doesNotReject(addWebsite(f.options));
  const broken=fixture();broken.options.probe=async()=>({activated:false,schemaReady:true});
  await assert.rejects(addWebsite(broken.options),/Original customer endpoint/);assert.equal(broken.mutations.length,0);
});

test('website workflow is manual and uses the protected per-customer environment',async()=>{
  const workflow=await readFile(new URL('../../.github/workflows/add-external-website.yml',import.meta.url),'utf8');
  assert.ok(workflow.includes('environment: external-'));assert.ok(!/\n\s+push:/.test(workflow));
  assert.ok(workflow.includes('expected_deployed_commit:'));assert.ok(!workflow.includes('secrets: inherit'));
});
