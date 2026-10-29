import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter,freshSchema } from '../schema.mjs';
import { setupRequest,sha256 } from '../../mail-worker/src/oneclick/setup.js';
test('activation uses the independent website origin and cannot replay or reset a password',async () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(await freshSchema(new URL('../../mail-worker/',import.meta.url)));
    db.exec('CREATE TABLE _cloudmail_deployment (id INTEGER PRIMARY KEY,activated INTEGER,schema_ready INTEGER,activation_hash TEXT,activation_expires INTEGER)');
    const code='a'.repeat(64),digest=await sha256(code),expiry=Date.now()+3600000;
    db.prepare('INSERT INTO _cloudmail_deployment VALUES (1,0,1,?,?)').run(digest,expiry);
    db.prepare("INSERT INTO user(email,password,salt,type) VALUES ('admin@example.com','before','salt',1)").run();
    const env={ db:sqliteAdapter(db),EXTERNAL_DNS_MODE:'true',EXTERNAL_WEBSITE_HOST:'customer.account.workers.dev',ONECLICK_DOMAIN:'example.com' };
    const meta={ schema_ready:1,activated:0,activation_hash:digest,activation_expires:expiry };
    const form=new URLSearchParams({ code,password:'a-safe-password-123',confirm:'a-safe-password-123' });
    const request=origin => new Request('https://customer.account.workers.dev/setup',{ method:'POST',headers:{ Origin:origin,'Content-Type':'application/x-www-form-urlencoded' },body:form });
    assert.equal((await setupRequest(request('https://evil.invalid'),env,meta,async () => ({ salt:'new',hash:'after' }))).status,403);
    assert.equal((await setupRequest(request('https://customer.account.workers.dev'),env,meta,async () => ({ salt:'new',hash:'after' }))).status,303);
    assert.equal(db.prepare('SELECT password FROM user').get().password,'after');
    assert.equal((await setupRequest(request('https://customer.account.workers.dev'),env,meta,async () => ({ salt:'new2',hash:'changed' }))).status,409);
    assert.equal(db.prepare('SELECT password FROM user').get().password,'after');
  } finally { db.close(); }
});
