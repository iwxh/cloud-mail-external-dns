import { writeFile,rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerConfig,names } from './external-provision.mjs';
const workerDir=fileURLToPath(new URL('../mail-worker/',import.meta.url));
const path=join(workerDir,'wrangler.external.generated.json');
const state={ ...names('example.com'),domain:'example.com',hostname:'ci-only.example.workers.dev',deploymentId:'a'.repeat(64),
  databaseId:'11111111-1111-4111-8111-111111111111',kvId:'1'.repeat(32) };
try {
  await writeFile(path,JSON.stringify(workerConfig(state,workerDir)));
  const result=spawnSync(process.execPath,[join(workerDir,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',path,'--dry-run','--outdir','.wrangler/external-check'],{
    cwd:workerDir,env:{ ...process.env,WRANGLER_SEND_METRICS:'false' },stdio:'inherit',shell:false });
  if (result.error || result.status !== 0) throw new Error('External DNS Worker bundle failed');
} finally { await rm(path,{ force:true }); }
