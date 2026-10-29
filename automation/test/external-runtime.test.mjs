import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule,SyntheticModule } from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter,freshSchema } from '../schema.mjs';
import * as protocol from '../../mail-worker/src/external/protocol.js';
import * as store from '../../mail-worker/src/external/store.js';
const require=createRequire(new URL('../../mail-worker/package.json',import.meta.url));
const mime=require('postal-mime');
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
const id='11111111-1111-4111-8111-111111111111';
async function request(to=['admin@example.com']) {
  const payload=JSON.stringify({ type:'email.received',data:{ email_id:id,to } });
  const stamp=Math.floor(Date.now()/1000);
  const key=await crypto.subtle.importKey('raw',Buffer.alloc(32,7),{ name:'HMAC',hash:'SHA-256' },false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`msg_test.${stamp}.${payload}`))).toString('base64');
  return new Request('https://customer.account.workers.dev/_external/resend',{ method:'POST',body:payload,
    headers:{ 'svix-id':'msg_test','svix-timestamp':String(stamp),'svix-signature':'v1,'+signature } });
}
async function runtime() {
  const db=new DatabaseSync(':memory:');db.exec(await freshSchema(new URL('../../mail-worker/',import.meta.url)));
  db.exec('CREATE UNIQUE INDEX external_inbox_delivery ON email(resend_email_id,to_email) WHERE type=0 AND resend_email_id IS NOT NULL');
  let storageFailure=false;const objects=new Map();
  const dependencies={
    'postal-mime':{ default:mime.default || mime },
    '../service/setting-service':{ default:{ query:async () => ({ receive:0,noRecipient:1,tgBotStatus:1 }) } },
    '../service/account-service':{ default:{ selectByEmailIncludeDel:async (_c,address) => address === 'admin@example.com' ? { userId:1,accountId:1 } : null } },
    '../service/user-service':{ default:{ selectByIdIncludeDel:async () => ({ email:'admin@example.com' }) } },
    '../service/role-service':{ default:{} },
    '../service/email-service':{ default:{ imgReplace:html => html } },
    '../service/ai-service':{ default:{ extractCode:async () => '' } },
    '../service/telegram-service':{ default:{} },
    '../service/r2-service':{ default:{ putObj:async (_c,key,content) => { if(storageFailure)throw Error('storage offline');objects.set(key,content); } } },
    '../utils/file-utils':{ default:{ getBuffHash:async bytes => createHash('sha256').update(bytes).digest('hex'),getExtFileName:() => '.txt' } },
    '../const/constant':{ default:{ ATTACHMENT_PREFIX:'attachments/' } },
    '../email/email':{ checkBlock:() => false },'./protocol.js':protocol,'./store.js':store
  };
  const module=new SourceTextModule(await readFile(new URL('../../mail-worker/src/external/inbound.js',import.meta.url),'utf8'));
  await module.link(specifier => {
    const values=dependencies[specifier];if(!values)throw Error('Unexpected import '+specifier);
    return new SyntheticModule(Object.keys(values),function(){ for(const [key,value] of Object.entries(values))this.setExport(key,value); });
  });await module.evaluate();
  const env={ db:sqliteAdapter(db),ONECLICK_DOMAIN:'example.com',admin:'admin@example.com',EXTERNAL_WEBHOOK_SECRET:secret,EXTERNAL_RESEND_API_KEY:'re_test' };
  const raw='From: Alice <alice@example.net>\r\nTo: admin@example.com\r\nSubject: inbound test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=a.txt\r\nContent-Transfer-Encoding: base64\r\n\r\nYWJj\r\n--x--\r\n';
  let networkCalls=0;
  const fetcher=async url => { networkCalls++;return String(url).startsWith('https://api.resend.com/') ? Response.json({ id,raw:{ download_url:'https://download.resend.com/mail' } }) : new Response(raw); };
  return { db,env,objects,inbound:module.namespace.inbound,fetcher,calls:() => networkCalls,failStorage:() => { storageFailure=true; } };
}
test('actual inbound handler parses MIME, commits body and attachment, then deduplicates provider retry',async () => {
  const app=await runtime();const previous=globalThis.fetch;globalThis.fetch=app.fetcher;
  try {
    assert.equal((await app.inbound(await request(),app.env)).status,200);
    const email=app.db.prepare('SELECT * FROM email').get();assert.match(email.text,/Hello/);assert.equal(email.to_email,'admin@example.com');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n,1);assert.equal(app.objects.size,1);
    assert.equal((await app.inbound(await request(),app.env)).status,200);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM email').get().n,1);
  } finally { globalThis.fetch=previous;app.db.close(); }
});
test('other customer event never reads provider content or writes the inbox',async () => {
  const app=await runtime();const previous=globalThis.fetch;globalThis.fetch=app.fetcher;
  try { assert.equal((await app.inbound(await request(['admin@other.com']),app.env)).status,200);assert.equal(app.calls(),0);assert.equal(app.objects.size,0); }
  finally { globalThis.fetch=previous;app.db.close(); }
});
test('attachment storage failure returns retryable error and creates no visible inbox row',async () => {
  const app=await runtime();const previous=globalThis.fetch;globalThis.fetch=app.fetcher;app.failStorage();
  try { assert.equal((await app.inbound(await request(),app.env)).status,503);assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM email').get().n,0); }
  finally { globalThis.fetch=previous;app.db.close(); }
});
