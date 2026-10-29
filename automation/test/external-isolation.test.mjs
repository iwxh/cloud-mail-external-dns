import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { domainName,names,assertIdentity,workerConfig,inspect,provision,REPOSITORY,ALLOWED_ACCOUNT,providerRecords } from '../external-provision.mjs';
const domain='example.com',commit='a'.repeat(40),accountId=ALLOWED_ACCOUNT;
const state={ version:1,repository:REPOSITORY,accountId,domain,commit,...names(domain),kvId:'b'.repeat(32),
  databaseId:'11111111-1111-4111-8111-111111111111',deploymentId:'c'.repeat(64) };
function fixture(overrides={}) {
  const calls=[];
  const cf={ list:async path => { calls.push(['GET',path]); return []; },
    get:async path => { calls.push(['GET',path]);return path.endsWith('/subdomain') ? { subdomain:'test-account' } : null; },
    request:async (...args) => { calls.push(args);throw Error('Unexpected mutation'); } };
  const resend={ key:'re_test',request:async (method,path) => { calls.push([method,'resend'+path]);return { data:[] }; } };
  return { cf,resend,accountId,domain,customerDomain:domain,repository:REPOSITORY,commit,ownerEmail:'owner@example.net',
    fetcher:async () => Response.json({ Status:0 }),calls,...overrides };
}
test('domain input rejects hostnames with schemes, uppercase, spaces and shell content',() => {
  for (const value of ['Example.com','https://example.com',' example.com','example.com/path','example.com\nX=x','$(id).com']) assert.throws(() => domainName(value));
  assert.equal(domainName('kinghh.cn'),'kinghh.cn');
});
test('new resource names differ by customer and cannot match old cm/native service names',() => {
  assert.notEqual(names('example.com').worker,names('another.com').worker);
  assert.match(names(domain).worker,/^xm-mail-/);assert.match(names(domain).databaseName,/^xm-db-/);
});
test('foreign account, repository, domain, source or binding ownership is rejected',() => {
  assert.doesNotThrow(() => assertIdentity(state,accountId,domain,commit));
  for (const patch of [{ repository:'iwxh/cloud-mail' },{ accountId:'f'.repeat(32) },{ domain:'other.com' },{ worker:'cloud-mail4' },{ databaseName:'dbpl' },{ commit:'f'.repeat(40) }])
    assert.throws(() => assertIdentity({ ...state,...patch },accountId,domain,commit));
});
test('external config has no CF email binding, DNS route, account token or old project resource',() => {
  const config=workerConfig({ ...state,hostname:'customer.account.workers.dev' },'/workspace/mail-worker');
  assert.equal(config.send_email,undefined);assert.equal(config.routes,undefined);assert.equal(config.vars.CLOUDFLARE_API_TOKEN,undefined);
  assert.equal(config.vars.EXTERNAL_DNS_MODE,'true');assert.equal(config.workers_dev,true);
  assert.equal(config.d1_databases[0].database_id,state.databaseId);
});
test('read-only plan performs no mutation and never queries zone DNS or Email Routing',async () => {
  const options=fixture();const result=await provision({ ...options,mode:'plan' });
  assert.equal(result.status,'read_only_plan');assert.ok(options.calls.every(([method,path]) => method === 'GET' && !path.includes('/zones/') && !path.includes('/email/routing')));
});
test('existing MX blocks provisioning before any resource is created',async () => {
  const options=fixture({ fetcher:async () => Response.json({ Status:0,Answer:[{ type:15,data:'10 old.mail.example.net.' }] }) });
  await assert.rejects(provision({ ...options,mode:'prepare' }),/MX/);
  assert.ok(options.calls.every(([method]) => method === 'GET'));
});
test('wrong customer environment or account stops before any remote access',async () => {
  for (const override of [{ customerDomain:'other.com' },{ accountId:'f'.repeat(32) },{ repository:'iwxh/cloud-mail' }]) {
    const options=fixture(override);await assert.rejects(inspect(options));assert.equal(options.calls.length,0);
  }
});
test('foreign KV, database and Worker are never adopted',async () => {
  for (const kind of ['kv','database','worker']) {
    const options=fixture();
    if (kind === 'kv') { options.cf.list=async path => path.includes('namespaces') ? [{ title:names(domain).kv,id:'b'.repeat(32) }] : [];options.cf.value=async () => null; }
    if (kind === 'database') options.cf.list=async path => path.includes('d1/database') ? [{ name:names(domain).databaseName,uuid:state.databaseId }] : [];
    if (kind === 'worker') options.cf.get=async () => ({ bindings:[] });
    await assert.rejects(inspect(options));
  }
});
test('finish refuses an unprepared customer and cannot create it',async () => {
  const options=fixture();await assert.rejects(provision({ ...options,mode:'finish' }),/prepare/);
  assert.ok(options.calls.every(([method]) => method === 'GET'));
});
test('DNS list uses actual provider values and never invents generic MX targets',() => {
  assert.deepEqual(providerRecords(domain,[{ type:'MX',name:'@',priority:10,value:'inbound.provider.example' },{ type:'TXT',name:'resend._domainkey',value:'p=test' }]),[
    { type:'MX',name:domain,content:'inbound.provider.example',priority:10 },{ type:'TXT',name:'resend._domainkey.example.com',content:'p=test' }
  ]);
});
test('deployment workflow has no push deployment and does not inherit original environment',async () => {
  const workflow=await readFile(new URL('../../.github/workflows/new-external-mail.yml',import.meta.url),'utf8');
  assert.ok(!/\n\s+push:/.test(workflow));assert.ok(!workflow.includes('environment: mail-provisioning'));
  assert.ok(workflow.includes('environment: external-'));assert.ok(!workflow.includes('secrets: inherit'));
});
