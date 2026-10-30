import {createHash} from 'node:crypto';
import {writeFile,rm,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Cloudflare} from './cloudflare.mjs';
import {domainName,ResendAPI,inspect,workerConfig,STATE_KEY} from './external-provision.mjs';
import {assertExistingBindings} from './external-repair.mjs';

export function websiteHostname(domain,value) {
  domainName(domain);
  if(value!==`mail.${domain}`) throw Error('Website hostname must be exactly mail.customer-domain.');
  return value;
}

export function websiteSourceAllowed(previous,current,root) {
  if(![previous,current].every(value=>/^[a-f0-9]{40}$/.test(value||''))) return false;
  const git=args=>spawnSync('git',args,{cwd:root,encoding:'utf8',shell:false});
  if(git(['merge-base','--is-ancestor',previous,current]).status!==0) return false;
  const result=git(['diff','--name-only',previous,current,'--','mail-worker','mail-vue','automation/schema.mjs']);
  const files=result.stdout.trim().split('\n').filter(Boolean);
  const allowed=new Set(['mail-worker/src/external-entry.js','mail-worker/src/external/hosts.js','mail-worker/src/oneclick/setup.js']);
  // Fresh customers may already run hostname-capable code. A config-only add
  // (or retry) must work at the same SHA or a tooling-only descendant as well.
  return result.status===0 && (files.length===0 || files.length===allowed.size) && files.every(file=>allowed.has(file));
}

export async function addWebsite(options) {
  const {cf,resend,accountId,domain,commit,expectedCommit,workerDir,deployWorker,probe,sourceAllowed,mode='plan'}=options;
  const hostname=websiteHostname(domain,options.websiteHost);
  if(!['plan','prepare'].includes(mode) || !/^[a-f0-9]{40}$/.test(expectedCommit||'') || !/^[a-f0-9]{40}$/.test(commit||'') ||
    !await sourceAllowed(expectedCommit,commit)) throw Error('Website migration source is not limited to hostname support.');
  const {state,settings}=await inspect({...options,commit:expectedCommit,mode:'plan'});
  if(!state?.uploaded || !state.databaseId || !state.webhookId || !state.resendDomainId ||
    (state.websiteHost && state.websiteHost!==hostname) ||
    state.apiKeyFingerprint!==createHash('sha256').update(resend.key).digest('hex'))
    throw Error('A complete owned customer with an unchanged provider key is required.');
  // A retry may find the same hostname deployed before the audit write completed.
  // Never accept any other hostname or adopt another customer's resources.
  const existingCustom=settings.bindings?.find(item=>item.name==='EXTERNAL_CUSTOM_WEBSITE_HOST');
  assertExistingBindings(settings,existingCustom ? {...state,websiteHost:hostname} : state);
  const meta=(await cf.query(accountId,state.databaseId,
    'SELECT deployment_id,domain,schema_ready,activated FROM _cloudmail_deployment WHERE id=1'))[0]?.results?.[0];
  if(meta?.deployment_id!==state.deploymentId || meta.domain!==domain || meta.schema_ready!==1 || meta.activated!==1)
    throw Error('Existing activated database identity differs. No initialization will be attempted.');
  const endpoint=`https://${state.hostname}/_external/resend`;
  const hook=await resend.request('GET',`/webhooks/${state.webhookId}`);
  if(hook.endpoint!==endpoint || !hook.events?.includes('email.received')) throw Error('Existing provider callback was changed.');
  if(mode==='plan') return {domain,hostname,worker:state.worker,callback:endpoint,status:'read_only_website_plan'};
  const updated={...state,websiteHost:hostname,commit};
  await deployWorker(workerConfig(updated,workerDir));
  assertExistingBindings(await cf.get(`/accounts/${accountId}/workers/scripts/${state.worker}/settings`),updated);
  // Keep checking the old hostname: external DNS and TLS can be completed later,
  // and the signed inbound endpoint must remain usable throughout the change.
  const health=await probe(`https://${state.hostname}/_cloudmail/health`,state.deploymentId);
  if(!health?.schemaReady || !health.activated || health.deploymentId!==state.deploymentId)
    throw Error('Original customer endpoint is not healthy; migration was not recorded as complete.');
  const afterHook=await resend.request('GET',`/webhooks/${state.webhookId}`);
  if(afterHook.endpoint!==endpoint) throw Error('Provider callback identity changed during website deployment.');
  updated.websiteMigrations=[...(state.websiteMigrations||[]),{from:expectedCommit,to:commit,hostname,
    at:new Date().toISOString(),runId:options.runId||null}];
  await cf.putValue(accountId,state.kvId,STATE_KEY,updated);
  return {domain,hostname,worker:state.worker,callback:endpoint,status:'website_runtime_ready_dns_tls_pending'};
}

async function cli() {
  const mode=process.argv[2]?.replace(/^--/,'')||'plan';
  const root=fileURLToPath(new URL('../',import.meta.url)),workerDir=join(root,'mail-worker');
  const configPath=join(workerDir,'wrangler.external.website.generated.json');
  if(process.env.GITHUB_REF!=='refs/heads/main') throw Error('Use the independent repository main branch.');
  try {
    const result=await addWebsite({mode,cf:new Cloudflare(process.env.CLOUDFLARE_API_TOKEN),resend:new ResendAPI(process.env.RESEND_API_KEY),
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,domain:process.env.MAIL_DOMAIN,customerDomain:process.env.CUSTOMER_DOMAIN,
      websiteHost:process.env.WEBSITE_HOSTNAME,repository:process.env.GITHUB_REPOSITORY,ownerEmail:process.env.MAIL_OWNER_EMAIL,
      commit:process.env.GITHUB_SHA,expectedCommit:process.env.EXPECTED_DEPLOYED_COMMIT,runId:process.env.GITHUB_RUN_ID,workerDir,
      sourceAllowed:(previous,current)=>websiteSourceAllowed(previous,current,root),
      probe:async(url,id)=>{
        for(let i=0;i<12;i++) {
          try {const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});const health=await response.json();
            if(response.ok && health.deploymentId===id) return health;
          } catch { /* Wait for propagation while retaining the original host. */ }
          if(i<11) await new Promise(resolve=>setTimeout(resolve,5000));
        }
        throw Error('Original customer endpoint is unavailable.');
      },
      deployWorker:async config=>{
        await writeFile(configPath,JSON.stringify(config,null,2),{mode:0o600});
        const run=spawnSync(process.execPath,[join(workerDir,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',configPath],
          {cwd:workerDir,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'},shell:false});
        if(run.error || run.status!==0) throw Error('Existing customer website deployment failed.');
      }
    });
    console.log(JSON.stringify(result));
    if(process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## External customer website hostname\n\nDomain: ${result.domain}\n\nWebsite: https://${result.hostname}\n\nStatus: ${result.status}\n\nOriginal signed callback preserved: ${result.callback}\n\nOnly the owned Worker and deployment audit are updated. Existing database, accounts, passwords, mail, encrypted secrets and mail DNS are preserved. Custom-hostname routing, certificate and external website DNS must be verified separately.\n`);
  } finally {await rm(configPath,{force:true});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) cli().catch(error=>{console.error(error.message);process.exitCode=1;});
