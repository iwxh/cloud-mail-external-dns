import { createHash,randomBytes } from 'node:crypto';
import { domainToASCII,fileURLToPath } from 'node:url';
import { resolve,join } from 'node:path';
import { writeFile,rm,appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Cloudflare } from './cloudflare.mjs';
import { verifyPublicDNS } from './public-dns.mjs';
import { txtValue } from './dns-content.mjs';

export const REPOSITORY = 'iwxh/cloud-mail-external-dns';
export const ALLOWED_ACCOUNT = '9ff805928769c3c771d772113fba0c45';
export const STATE_KEY = '_external_mail_provisioner_v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
const accountPattern = /^[a-f0-9]{32}$/;
const uuid = /^[a-f0-9-]{36}$/;
const tablesSQL = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'";

export function domainName(value) {
  if (typeof value !== 'string' || value !== value.toLowerCase() || value !== domainToASCII(value) || value.length > 200 ||
      value.split('.').length < 2 || !/[a-z]/.test(value.split('.').at(-1)) ||
      value.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Enter a lowercase domain only.');
  return value;
}

export function names(domain) {
  const id = hash(`${REPOSITORY}\n${domainName(domain)}`).slice(0,20);
  return { worker:`xm-mail-${id}`,kv:`xm-kv-${id}`,databaseName:`xm-db-${id}` };
}

export function assertIdentity(state,accountId,domain,commit) {
  const expected = names(domain);
  if (state?.version !== 1 || state.repository !== REPOSITORY || state.accountId !== accountId || state.domain !== domain ||
      state.worker !== expected.worker || state.databaseName !== expected.databaseName || !accountPattern.test(state.kvId || '') ||
      !/^[a-f0-9]{64}$/.test(state.deploymentId || '') || state.commit !== commit ||
      (state.databaseId && !uuid.test(state.databaseId))) throw new Error('Customer ownership or source version mismatch. No existing project will be updated.');
}

export function workerConfig(state,workerDir) {
  return {
    name:state.worker,main:join(workerDir,'src/external-entry.js'),compatibility_date:'2025-06-04',keep_vars:true,workers_dev:true,
    observability:{ enabled:true },vars:{ admin:`admin@${state.domain}`,domain:[state.domain],project_link:false,
      EXTERNAL_DNS_MODE:'true',EXTERNAL_WEBSITE_HOST:state.hostname,ONECLICK_DOMAIN:state.domain,ONECLICK_DEPLOYMENT_ID:state.deploymentId },
    d1_databases:[{ binding:'db',database_name:state.databaseName,database_id:state.databaseId }],
    kv_namespaces:[{ binding:'kv',id:state.kvId }],
    ai:{ binding:'ai' },assets:{ binding:'assets',directory:join(workerDir,'dist'),not_found_handling:'single-page-application',run_worker_first:true },
    triggers:{ crons:['0 16 * * *'] }
  };
}

export class ResendAPI {
  constructor(key,fetcher = fetch) { if (!key?.startsWith('re_')) throw new Error('Set this customer\'s RESEND_API_KEY.'); this.key=key;this.fetcher=fetcher; }
  async request(method,path,body) {
    let response;
    try { response=await this.fetcher(`https://api.resend.com${path}`,{
      method,headers:{ Authorization:`Bearer ${this.key}`,'Content-Type':'application/json' },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),redirect:'error',signal:AbortSignal.timeout(30000)
    }); } catch { throw new Error('Resend request unavailable. Retry the same run.'); }
    if (!response.ok) throw new Error(`Resend ${method} ${path} failed (HTTP ${response.status}); check permissions, limits, and dashboard.`);
    return response.json();
  }
}

export function providerRecords(domain,records) {
  return records.filter(item => ['MX','TXT'].includes(item.type)).map(item => {
    let name=(item.name || '@').replace(/\.$/,'');
    if (name === '@') name=domain;
    else if (name !== domain && !name.endsWith(`.${domain}`)) name=`${name}.${domain}`;
    if (name !== domain && !name.endsWith(`.${domain}`)) throw new Error('Provider returned a foreign DNS record');
    return { type:item.type,name,content:item.value,...(item.type === 'MX' ? { priority:Number(item.priority) } : {}) };
  });
}

export function providerVerificationReady(state,info) {
  if (info.name !== state.domain || !['verified','partially_verified'].includes(info.status) ||
      info.capabilities?.sending !== 'enabled' || info.capabilities?.receiving !== 'enabled' || !state.dns.length) return false;
  const key = record => JSON.stringify([record.type,record.name.toLowerCase().replace(/\.$/,''),
    record.type === 'TXT' ? txtValue(record.content) : record.content.toLowerCase().replace(/\.$/,''),record.priority ?? null]);
  const verified = new Set((info.records || []).filter(record => record.status === 'verified')
    .flatMap(record => providerRecords(state.domain,[record])).map(key));
  // Legacy sending and receiving can be ready while the optional Forge CNAME is still pending.
  return state.dns.every(record => verified.has(key(record)));
}

export async function waitForProviderVerification(resend,state,{
  attempts=120,wait=() => new Promise(resolve => setTimeout(resolve,10000)),log=console.log
}={}) {
  const path=`/domains/${state.resendDomainId}`;
  let info=await resend.request('GET',path);
  if (providerVerificationReady(state,info)) return info;
  await resend.request('POST',`${path}/verify`);
  for (let attempt=0;attempt<attempts;attempt++) {
    if (attempt) await wait();
    info=await resend.request('GET',path);
    if (providerVerificationReady(state,info)) return info;
    if (attempt % 6 === 0) log('Public DNS is ready; waiting for Resend to verify the required sending and receiving records.');
  }
  throw new Error('Required Resend records are still awaiting asynchronous verification. The existing website and data are preserved; retry finish later.');
}

export function runtimeSourceUnchanged(previous,current,root) {
  if (![previous,current].every(value => /^[a-f0-9]{40}$/.test(value || ''))) return false;
  const git=args => spawnSync('git',args,{ cwd:root,stdio:'ignore',shell:false });
  if (git(['merge-base','--is-ancestor',previous,current]).status !== 0) return false;
  return git(['diff','--quiet',previous,current,'--','mail-worker','mail-vue','automation/schema.mjs']).status === 0;
}

export async function publicMX(domain,fetcher = fetch) {
  const result=[];
  for (const base of ['https://cloudflare-dns.com/dns-query','https://dns.google/resolve']) {
    const url=new URL(base);url.searchParams.set('name',domain);url.searchParams.set('type','MX');
    const response=await fetcher(url,{ headers:{ Accept:'application/dns-json' },redirect:'error',signal:AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Public DNS lookup unavailable; no changes made.');
    const data=await response.json();
    if (data.Status !== 0 && data.Status !== 3) throw new Error('Public DNS returned an error; manual review required.');
    result.push((data.Answer || []).filter(item => item.type === 15).map(item => item.data.toLowerCase().replace(/\.$/,'')));
  }
  return result;
}

export async function inspect({ cf,resend,accountId,domain,commit,customerDomain,repository,ownerEmail,fetcher=fetch,
  mode='plan',sourceCompatible=async () => false }) {
  domainName(domain);
  if (repository !== REPOSITORY || customerDomain !== domain || accountId !== ALLOWED_ACCOUNT ||
      !/^[a-f0-9]{40}$/.test(commit || '') || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(ownerEmail || '')) throw new Error('Repository, customer environment, account, owner email, or source is not configured correctly.');
  const named=names(domain);
  const base=`/accounts/${accountId}`;
  const matches=(await cf.list(`${base}/storage/kv/namespaces`)).filter(item => item.title === named.kv);
  if (matches.length > 1) throw new Error('Duplicate customer KV; manual review required.');
  const state=matches.length ? await cf.value(accountId,matches[0].id,STATE_KEY) : null;
  if (matches.length && !state) throw new Error('Existing KV is not owned by this customer deployment.');
  if (state) {
    let identityCommit=commit;
    // A tooling-only fix may finish an already uploaded customer. Runtime changes still require a separate migration.
    if (state.commit !== commit && ['plan','finish'].includes(mode) && state.uploaded === true && state.databaseId &&
        state.resendDomainId && state.webhookId && state.apiKeyFingerprint && await sourceCompatible(state.commit,commit)) identityCommit=state.commit;
    assertIdentity(state,accountId,domain,identityCommit);
    if (state.kvId !== matches[0].id) throw new Error('KV binding mismatch');
  }
  const settings=await cf.get(`${base}/workers/scripts/${named.worker}/settings`,true);
  if (settings && (!state || !settings.bindings?.some(item => item.name === 'ONECLICK_DEPLOYMENT_ID' && item.text === state.deploymentId) ||
      !settings.bindings.some(item => item.name === 'db' && item.id === state.databaseId) ||
      !settings.bindings.some(item => item.name === 'kv' && item.namespace_id === state.kvId) ||
      settings.bindings.some(item => item.type === 'send_email'))) throw new Error('Worker or bindings do not belong to this external DNS customer.');
  const databases=(await cf.list(`${base}/d1/database`)).filter(item => item.name === named.databaseName);
  if (databases.some(item => !state?.databaseId || item.uuid !== state.databaseId)) throw new Error('Existing D1 is not owned by this deployment.');
  if (state?.databaseId && (databases.length !== 1 || databases[0].uuid !== state.databaseId)) throw new Error('Customer D1 identity is missing or changed.');
  const domainList=await resend.request('GET','/domains');
  if (domainList.has_more) throw new Error('Provider domain inventory is paginated; manual review required before creating resources.');
  const domains=domainList.data || [];
  if (domains.filter(item => item.name === domain).some(item => !state?.resendDomainId || item.id !== state.resendDomainId)) throw new Error('Domain already exists in Resend outside this deployment; manual review required.');
  const mx=await publicMX(domain,fetcher);
  const expected=new Set((state?.dns || []).filter(item => item.type === 'MX' && item.name === domain)
    .map(item => `${item.priority} ${item.content.toLowerCase().replace(/\.$/,'')}`));
  if (mx.some(records => records.some(item => !expected.has(item)))) throw new Error('Existing receiving MX needs manual migration review. No DNS will be modified.');
  const subdomain=await cf.get(`${base}/workers/subdomain`);
  if (!/^[a-z0-9-]+$/.test(subdomain?.subdomain || '')) throw new Error('Enable the account workers.dev subdomain first.');
  const hostname=`${named.worker}.${subdomain.subdomain}.workers.dev`;
  if (state && state.hostname !== hostname) throw new Error('Customer website identity changed; manual review required.');
  return { named,state,settings,hostname };
}

export async function initialize(cf,state,schema) {
  const query=(sql,params=[]) => cf.query(state.accountId,state.databaseId,sql,params);
  const tables=(await query(tablesSQL))[0].results.map(item => item.name);
  if (!tables.includes('_cloudmail_deployment') && tables.length) throw new Error('Database contains foreign application data.');
  if (!tables.includes('_cloudmail_deployment')) {
    await query('CREATE TABLE _cloudmail_deployment (id INTEGER PRIMARY KEY CHECK(id=1),deployment_id TEXT NOT NULL,domain TEXT NOT NULL,schema_ready INTEGER NOT NULL DEFAULT 0,activated INTEGER NOT NULL DEFAULT 0,activation_hash TEXT,activation_expires INTEGER)');
    await query('INSERT INTO _cloudmail_deployment (id,deployment_id,domain) VALUES (1,?,?)',[state.deploymentId,state.domain]);
  }
  let meta=(await query('SELECT * FROM _cloudmail_deployment WHERE id=1'))[0].results[0];
  if (meta?.deployment_id !== state.deploymentId || meta.domain !== state.domain) throw new Error('D1 ownership mismatch.');
  if (!meta.schema_ready) {
    // No schema migration/reinitialization of an existing application is attempted.
    if (tables.includes('user')) throw new Error('Interrupted schema setup requires manual review. Database is preserved.');
    await query(schema);
    await query('INSERT INTO user (email,password,salt,type) VALUES (?,?,?,1)',[`admin@${state.domain}`,random(),random()]);
    await query("INSERT INTO account (email,user_id,name) SELECT email,user_id,'admin' FROM user WHERE email=?",[`admin@${state.domain}`]);
    await query('UPDATE setting SET register=1,notice=1,title=?,forward_status=1,forward_email=?',[state.domain,'']);
    await query('CREATE UNIQUE INDEX external_inbox_delivery ON email(resend_email_id,to_email) WHERE type=0 AND resend_email_id IS NOT NULL');
    await query('UPDATE _cloudmail_deployment SET schema_ready=1 WHERE id=1');
    meta={ ...meta,schema_ready:1 };
  }
  return meta;
}

export async function provision(options) {
  const { cf,resend,accountId,domain,commit,ownerEmail,workerDir,schema,deployWorker,mode='plan',verifyDNS=verifyPublicDNS }=options;
  if (!['plan','prepare','finish'].includes(mode)) throw new Error('Unknown deployment mode');
  const check=await inspect(options);
  if (mode === 'plan') return { domain,hostname:check.hostname,status:'read_only_plan',dns:check.state?.dns || [],tests:'pending' };
  if (mode === 'finish' && !check.state) throw new Error('Run prepare first; finish never creates an unprepared customer.');
  const base=`/accounts/${accountId}`;
  let state=check.state;
  if (!state) {
    const kv=(await cf.request('POST',`${base}/storage/kv/namespaces`,{ title:check.named.kv })).result;
    state={ version:1,repository:REPOSITORY,accountId,domain,commit,...check.named,hostname:check.hostname,kvId:kv.id,deploymentId:random() };
    await cf.putValue(accountId,state.kvId,STATE_KEY,state);
  }
  const save=() => cf.putValue(accountId,state.kvId,STATE_KEY,state);
  if (!state.databaseId) {
    const database=(await cf.request('POST',`${base}/d1/database`,{ name:state.databaseName })).result;
    state.databaseId=database.uuid;await save();
  }
  const meta=await initialize(cf,state,schema);
  if (!state.resendDomainId) {
    const result=await resend.request('POST','/domains',{ name:domain,capabilities:{ sending:'enabled',receiving:'enabled' } });
    if (!uuid.test(result.id || '')) throw new Error('Unexpected provider domain response');
    state.resendDomainId=result.id;state.dns=providerRecords(domain,result.records || []);await save();
  }
  const domainInfo=await resend.request('GET',`/domains/${state.resendDomainId}`);
  if (domainInfo.name !== domain || domainInfo.capabilities?.receiving !== 'enabled') throw new Error('Provider domain or receiving capability mismatch.');
  state.dns=providerRecords(domain,domainInfo.records || []);
  if (!state.dns.some(item => item.type === 'MX' && item.name === domain) || !state.dns.some(item => item.type === 'TXT')) throw new Error('Provider has not returned receiving/authentication records.');
  await save();
  if (!state.uploaded) { await deployWorker(workerConfig(state,workerDir));state.uploaded=true;await save(); }
  const settings=await cf.get(`${base}/workers/scripts/${state.worker}/settings`);
  const hasSecret=name => settings.bindings?.some(item => item.name === name && item.type === 'secret_text');
  const secret=async (name,text) => { if (!hasSecret(name)) await cf.request('PUT',`${base}/workers/scripts/${state.worker}/secrets`,{ name,text,type:'secret_text' }); };
  const fingerprint=hash(resend.key);
  if (state.apiKeyFingerprint && state.apiKeyFingerprint !== fingerprint) throw new Error('Customer API key changed; explicit credential migration is required.');
  await secret('jwt_secret',random());
  await secret('EXTERNAL_RESEND_API_KEY',resend.key);
  state.apiKeyFingerprint=fingerprint;await save();
  const endpoint=`https://${state.hostname}/_external/resend`;
  if (!state.webhookId) {
    const hookList=await resend.request('GET','/webhooks');
    if (hookList.has_more) throw new Error('Provider webhook inventory is paginated; manual review required.');
    const hooks=hookList.data || [];
    if (hooks.some(item => item.endpoint === endpoint)) throw new Error('Unowned provider webhook already exists.');
    const hook=await resend.request('POST','/webhooks',{ endpoint,events:['email.received','email.delivered','email.bounced','email.failed','email.complained','email.delivery_delayed'] });
    if (!uuid.test(hook.id || '') || !hook.signing_secret?.startsWith('whsec_')) throw new Error('Provider webhook creation incomplete; manual review required.');
    // Store provider secrets only in CF Secret bindings, never in public output or KV state.
    await secret('EXTERNAL_WEBHOOK_SECRET',hook.signing_secret);
    state.webhookId=hook.id;await save();
  }
  const ownedHook=await resend.request('GET',`/webhooks/${state.webhookId}`);
  if (ownedHook.endpoint !== endpoint || !ownedHook.events?.includes('email.received')) throw new Error('Customer webhook was changed; manual review required.');
  const health=await options.probe(`https://${state.hostname}/_cloudmail/health`,state.deploymentId);
  if (mode === 'finish') {
    await verifyDNS(state.dns);
    await waitForProviderVerification(resend,state);
    if (!meta.activated) {
      const code=random();console.log(`::add-mask::${code}`);
      await cf.query(accountId,state.databaseId,'UPDATE _cloudmail_deployment SET activation_hash=?,activation_expires=? WHERE id=1 AND activated=0',[hash(code),Date.now()+86400000]);
      const sent=await resend.request('POST','/emails',{ from:`admin@${domain}`,to:[ownerEmail],headers:{ Sender:`admin@${domain}` },
        subject:`Cloud Mail activation: ${domain}`,text:`Website: https://${state.hostname}/setup\nAdmin: admin@${domain}\nActivation code (24 hours):\n${code}\nSet your own password on the setup page. Never share this code.` });
      if (!uuid.test(sent.id || '')) throw new Error('Activation message was not accepted by the provider');
      state.activationEmailId=sent.id;await save();
    }
  }
  return { domain,hostname:state.hostname,worker:state.worker,databaseId:state.databaseId,kvId:state.kvId,
    status:mode === 'finish' ? (health.activated ? 'already_active' : 'activation_email_accepted') : 'waiting_for_customer_dns',
    dns:state.dns,tests:'real_inbound_and_outbound_tests_pending' };
}

async function probe(url,id) {
  for (let i=0;i<15;i++) {
    try { const response=await fetch(url,{ redirect:'error',signal:AbortSignal.timeout(10000) });const data=await response.json();
      if (response.ok && data.deploymentId === id && data.schemaReady) return data;
    } catch { /* Wait for the new Worker and its independent KV cache. */ }
    if (i<14) await new Promise(resolve => setTimeout(resolve,5000));
  }
  throw new Error('New customer website is not healthy yet. Retry the same source version.');
}

async function cli() {
  const mode=process.argv[2]?.replace(/^--/,'') || 'plan';
  if (process.argv.length > 3) throw new Error('Use --plan, --prepare, or --finish');
  const workerDir=fileURLToPath(new URL('../mail-worker/',import.meta.url));
  const configPath=join(workerDir,'wrangler.external.generated.json');
  const cf=new Cloudflare(process.env.CLOUDFLARE_API_TOKEN);
  const resend=new ResendAPI(process.env.RESEND_API_KEY);
  try {
    const result=await provision({ cf,resend,domain:process.env.MAIL_DOMAIN,customerDomain:process.env.CUSTOMER_DOMAIN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,repository:process.env.GITHUB_REPOSITORY,commit:process.env.GITHUB_SHA,
      ownerEmail:process.env.MAIL_OWNER_EMAIL,workerDir,mode,probe,
      sourceCompatible:(previous,current) => runtimeSourceUnchanged(previous,current,fileURLToPath(new URL('../',import.meta.url))),
      schema:mode === 'plan' ? '' : await (await import('./schema.mjs')).freshSchema(new URL('../mail-worker/',import.meta.url)),
      deployWorker:async config => {
        await writeFile(configPath,JSON.stringify(config,null,2),{ mode:0o600 });
        const command=spawnSync(process.execPath,[join(workerDir,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',configPath],{
          cwd:workerDir,stdio:'inherit',env:{ ...process.env,WRANGLER_SEND_METRICS:'false' },shell:false });
        if (command.error || command.status !== 0) throw new Error('Customer Worker deployment failed.');
      }
    });
    const records=result.dns.map(item => `| ${item.type} | ${item.name} | ${item.content} | ${item.priority ?? ''} |`).join('\n');
    const summary=`## External DNS customer deployment\n\nDomain: ${result.domain}\n\nWebsite: https://${result.hostname}\n\nAdmin: admin@${result.domain}\n\nStatus: ${result.status}\n\nNo DNS, NS, Cloudflare Email Routing, or existing project was changed.\n\n| Type | Name | Value | Priority |\n|---|---|---|---|\n${records}\n\nPublish these records at the customer's current DNS provider. Preserve existing SPF/DMARC policies. If there is no DMARC record, add a reviewed monitoring policy first. Real mail delivery tests remain pending.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
    await writeFile(join(workerDir,'external-dns-records.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({ domain:result.domain,status:result.status,website:`https://${result.hostname}` }));
  } finally { await rm(configPath,{ force:true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { console.error(error.message);process.exitCode=1; });
