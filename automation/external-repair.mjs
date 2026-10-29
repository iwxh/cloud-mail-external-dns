import { createHash } from 'node:crypto';
import { writeFile,rm,appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve,join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Cloudflare } from './cloudflare.mjs';
import { ResendAPI,inspect,workerConfig,STATE_KEY } from './external-provision.mjs';

// This is a narrowly scoped repair, not a general upgrade or migration path.
export function repairSourceAllowed(previous,current,root) {
  if(![previous,current].every(value=>/^[a-f0-9]{40}$/.test(value||''))) return false;
  const git=args=>spawnSync('git',args,{cwd:root,encoding:'utf8',shell:false});
  if(git(['merge-base','--is-ancestor',previous,current]).status!==0) return false;
  const diff=git(['diff','--name-only',previous,current,'--','mail-worker','mail-vue','automation/schema.mjs']);
  return diff.status===0 && diff.stdout.trim()==='mail-worker/src/external/protocol.js';
}

export function assertExistingBindings(settings,state) {
  const bindings=settings?.bindings||[];
  const allowed=new Set(['admin','domain','project_link','EXTERNAL_DNS_MODE','EXTERNAL_WEBSITE_HOST','ONECLICK_DOMAIN',
    'ONECLICK_DEPLOYMENT_ID','db','kv','ai','assets','jwt_secret','EXTERNAL_RESEND_API_KEY','EXTERNAL_WEBHOOK_SECRET','EXTERNAL_CUSTOM_WEBSITE_HOST']);
  const custom=bindings.find(item=>item.name==='EXTERNAL_CUSTOM_WEBSITE_HOST');
  if((state.websiteHost && (state.websiteHost!==`mail.${state.domain}` || custom?.type!=='plain_text' || custom.text!==state.websiteHost)) ||
    (!state.websiteHost && custom)) throw Error('Custom website binding does not match customer state.');
  if(bindings.some(item=>!allowed.has(item.name)) || new Set(bindings.map(item=>item.name)).size!==bindings.length ||
    bindings.filter(item=>item.type==='d1').length!==1 || bindings.filter(item=>item.type==='kv_namespace').length!==1 ||
    !bindings.some(item=>item.name==='db' && item.type==='d1' && item.id===state.databaseId) ||
    !bindings.some(item=>item.name==='kv' && item.type==='kv_namespace' && item.namespace_id===state.kvId) ||
    !bindings.some(item=>item.name==='ONECLICK_DEPLOYMENT_ID' && item.text===state.deploymentId) ||
    ['jwt_secret','EXTERNAL_RESEND_API_KEY','EXTERNAL_WEBHOOK_SECRET'].some(name=>!bindings.some(item=>item.name===name && item.type==='secret_text')))
    throw Error('Existing customer bindings or encrypted secrets differ; no repair was deployed.');
}

export async function repair(options) {
  const {cf,resend,accountId,domain,commit,expectedCommit,workerDir,deployWorker,probe,sourceAllowed}=options;
  if(!/^[a-f0-9]{40}$/.test(expectedCommit||'') || !/^[a-f0-9]{40}$/.test(commit||'') ||
    !await sourceAllowed(expectedCommit,commit)) throw Error('Repair must change only the inbound protocol runtime file; no schema or other application changes are allowed.');
  // Reuse all existing ownership checks against the explicitly supplied deployed
  // source. Never relax the original provisioner's cross-version guards.
  const {state,settings}=await inspect({...options,commit:expectedCommit,mode:'plan'});
  if(!state?.uploaded || !state.databaseId || !state.webhookId || !state.resendDomainId ||
    state.apiKeyFingerprint!==createHash('sha256').update(resend.key).digest('hex'))
    throw Error('A complete existing customer and unchanged provider key are required.');
  assertExistingBindings(settings,state);
  const meta=(await cf.query(accountId,state.databaseId,
    'SELECT deployment_id,domain,schema_ready,activated FROM _cloudmail_deployment WHERE id=1'))[0]?.results?.[0];
  if(meta?.deployment_id!==state.deploymentId || meta.domain!==domain || meta.schema_ready!==1 || meta.activated!==1)
    throw Error('Existing activated customer database identity does not match.');
  const hook=await resend.request('GET',`/webhooks/${state.webhookId}`);
  if(hook.endpoint!==`https://${state.hostname}/_external/resend` || !hook.events?.includes('email.received'))
    throw Error('Existing customer webhook does not match.');
  await deployWorker(workerConfig(state,workerDir));
  const after=await cf.get(`/accounts/${accountId}/workers/scripts/${state.worker}/settings`);
  assertExistingBindings(after,state);
  const health=await probe(`https://${state.hostname}/_cloudmail/health`,state.deploymentId);
  if(!health?.schemaReady || !health.activated || health.deploymentId!==state.deploymentId)
    throw Error('Repaired Worker health check failed; existing data was not initialized or modified.');
  const updated={...state,commit,repairs:[...(state.repairs||[]),{from:expectedCommit,to:commit,kind:'workers-manual-redirect',
    at:new Date().toISOString(),runId:options.runId||null}]};
  await cf.putValue(accountId,state.kvId,STATE_KEY,updated);
  return {domain,worker:state.worker,hostname:state.hostname,from:expectedCommit,to:commit,status:'inbound_runtime_repaired'};
}

async function cli() {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const workerDir=join(root,'mail-worker');
  const configPath=join(workerDir,'wrangler.external.repair.generated.json');
  if(process.env.GITHUB_REF!=='refs/heads/main') throw Error('Use the independent repository main branch.');
  try {
    const result=await repair({cf:new Cloudflare(process.env.CLOUDFLARE_API_TOKEN),resend:new ResendAPI(process.env.RESEND_API_KEY),
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,domain:process.env.MAIL_DOMAIN,customerDomain:process.env.CUSTOMER_DOMAIN,
      repository:process.env.GITHUB_REPOSITORY,ownerEmail:process.env.MAIL_OWNER_EMAIL,commit:process.env.GITHUB_SHA,
      expectedCommit:process.env.EXPECTED_DEPLOYED_COMMIT,runId:process.env.GITHUB_RUN_ID,workerDir,
      sourceAllowed:(previous,current)=>repairSourceAllowed(previous,current,root),
      probe:async(url,id)=>{
        for(let i=0;i<12;i++) {
          try {
            const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
            const health=await response.json();if(response.ok && health.deploymentId===id) return health;
          } catch { /* Allow the owned Worker deployment to propagate. */ }
          if(i<11) await new Promise(resolve=>setTimeout(resolve,5000));
        }
        throw Error('Customer website health check unavailable.');
      },
      deployWorker:async config=>{
        await writeFile(configPath,JSON.stringify(config,null,2),{mode:0o600});
        const result=spawnSync(process.execPath,[join(workerDir,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',configPath],
          {cwd:workerDir,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'},shell:false});
        if(result.error || result.status!==0) throw Error('Customer repair deployment failed.');
      }
    });
    console.log(JSON.stringify(result));
    if(process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Existing customer inbound repair\n\nDomain: ${result.domain}\n\nWorker: ${result.worker}\n\nSource: ${result.from} → ${result.to}\n\nWebsite: https://${result.hostname}\n\nStatus: ${result.status}\n\nExisting D1/KV and encrypted secrets preserved. No resource creation, schema initialization, DNS, provider configuration, password or activation changes. Real inbox/attachment acceptance remains pending.\n`);
  } finally { await rm(configPath,{force:true}); }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) cli().catch(error=>{console.error(error.message);process.exitCode=1;});
