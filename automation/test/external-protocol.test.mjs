import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhook,recipientList,readLimited,getRawEmail } from '../../mail-worker/src/external/protocol.js';

const timestamp=Math.floor(Date.now()/1000);
const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
async function signed(payload,time=timestamp) {
  const key=await crypto.subtle.importKey('raw',Buffer.alloc(32,7),{ name:'HMAC',hash:'SHA-256' },false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`msg_test.${time}.${payload}`));
  return new Headers({ 'svix-id':'msg_test','svix-timestamp':String(time),'svix-signature':`v1,${Buffer.from(signature).toString('base64')}` });
}
test('signed payload is accepted without reparsing or rewriting before verification',async () => {
  const body='{"type":"email.received","data":{"to":["admin@example.com"]}}';
  assert.equal((await verifyWebhook(body,await signed(body),secret)).type,'email.received');
  await assert.rejects(verifyWebhook(body+' ',await signed(body),secret));
});
test('old signatures, future signatures, missing headers and wrong secrets are rejected',async () => {
  for (const age of [-600,600]) await assert.rejects(verifyWebhook('{}',await signed('{}',timestamp+age),secret));
  await assert.rejects(verifyWebhook('{}',new Headers(),secret));
  await assert.rejects(verifyWebhook('{}',await signed('{}'),'whsec_bad'));
});
test('rotation signatures can be verified without accepting an invalid preceding signature',async () => {
  const headers=await signed('{}');headers.set('svix-signature','v1,invalid '+headers.get('svix-signature'));
  assert.deepEqual(await verifyWebhook('{}',headers,secret),{});
});
test('only provider delivery targets in the current exact domain are routed',() => {
  assert.deepEqual(recipientList({ data:{ to:['ADMIN@example.com','admin@example.com','user@other.example.com','x@evil-example.com','a@else.com'] } },'example.com'),['admin@example.com']);
  assert.throws(() => recipientList({ data:{ received_for:['admin@example.com'] } },'example.com'));
});
test('stream limits reject over-size requests instead of truncating mail',async () => {
  await assert.rejects(readLimited(new Response('12345').body,4));
  assert.equal(new TextDecoder().decode(await readLimited(new Response('1234').body,4)),'1234');
});
test('raw URL comes from authenticated provider API and API key is never sent to downloads',async () => {
  const id='11111111-1111-4111-8111-111111111111';const calls=[];
  const result=await getRawEmail({ data:{ email_id:id,raw:{ download_url:'https://attacker.invalid' } } },'re_test',async (url,options) => {
    calls.push({ url,options });
    return calls.length === 1 ? Response.json({ id,raw:{ download_url:'https://download.resend.com/message' } }) : new Response('From: sender@example.net\r\n\r\nhello');
  });
  assert.equal(calls[0].url,`https://api.resend.com/emails/receiving/${id}`);
  assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[1].options.redirect,'manual');
  assert.equal(calls[1].url,'https://download.resend.com/message');assert.equal(calls[1].options.headers,undefined);
  assert.ok(result.raw.length>10);
});

test('API and raw download redirects fail closed without following Location',async () => {
  const id='11111111-1111-4111-8111-111111111111';
  for(const failAt of [1,2]) {
    let calls=0;
    await assert.rejects(getRawEmail({data:{email_id:id}},'re_test',async(url,options)=>{
      calls++;assert.equal(options.redirect,'manual');
      return calls===failAt ? new Response('',{status:302,headers:{Location:'https://attacker.invalid/'}})
        : Response.json({id,raw:{download_url:'https://download.resend.com/message'}});
    }),/unavailable/);
    assert.equal(calls,failAt);
  }
});
test('provider failures and insecure raw URLs do not acknowledge mail',async () => {
  const event={ data:{ email_id:'11111111-1111-4111-8111-111111111111' } };
  await assert.rejects(getRawEmail(event,'re_test',async () => new Response('',{ status:500 })));
  await assert.rejects(getRawEmail(event,'re_test',async () => Response.json({ id:event.data.email_id,raw:{ download_url:'http://internal/' } })));
});
