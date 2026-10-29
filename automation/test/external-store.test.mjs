import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter,freshSchema } from '../schema.mjs';
import { storeReceived } from '../../mail-worker/src/external/store.js';

async function database() {
  const db=new DatabaseSync(':memory:');db.exec(await freshSchema(new URL('../../mail-worker/',import.meta.url)));
  db.exec('CREATE UNIQUE INDEX external_inbox_delivery ON email(resend_email_id,to_email) WHERE type=0 AND resend_email_id IS NOT NULL');
  return db;
}
const row={ sendEmail:'sender@example.net',name:'sender',userId:1,accountId:1,toEmail:'admin@example.com',status:0,subject:'测试附件',text:'hello' };
const attachment={ key:'attachments/a',filename:'a.txt',mimeType:'text/plain',size:3 };
test('duplicate deliveries create one inbox row and one attachment reference',async () => {
  const db=await database();try {
    assert.equal((await storeReceived(sqliteAdapter(db),'provider-1',row,[attachment])).inserted,true);
    assert.equal((await storeReceived(sqliteAdapter(db),'provider-1',row,[attachment])).inserted,false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n,1);
  } finally { db.close(); }
});
test('one delivery can independently reach two account inboxes',async () => {
  const db=await database();try {
    await storeReceived(sqliteAdapter(db),'provider-1',row,[]);
    await storeReceived(sqliteAdapter(db),'provider-1',{ ...row,toEmail:'sales@example.com',accountId:2 },[]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email').get().n,2);
  } finally { db.close(); }
});
test('failed attachment transaction does not leave an acknowledged inbox row',async () => {
  const db=await database();try {
    db.exec("CREATE TRIGGER reject_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'storage test');END");
    await assert.rejects(storeReceived(sqliteAdapter(db),'provider-1',row,[attachment]));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email').get().n,0);
  } finally { db.close(); }
});
