import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Use Wrangler's own simulator, so unsupported Worker Request options cannot
// pass unnoticed in Node's more permissive fetch implementation.
const require = createRequire(await realpath(fileURLToPath(new URL('../../mail-worker/node_modules/wrangler/package.json',import.meta.url))));
const { Miniflare } = require('miniflare');
const protocol = (await readFile(new URL('../../mail-worker/src/external/protocol.js',import.meta.url),'utf8')).replace(/^export /gm,'');

test('raw MIME retrieval works in workerd and rejects redirects without forwarding credentials',async () => {
  const mf = new Miniflare({ modules:true,compatibilityDate:'2025-06-04',script:protocol+`
    export default { async fetch(request) {
      const stage=new URL(request.url).searchParams.get('redirect');
      const id='11111111-1111-4111-8111-111111111111';
      let calls=0;
      try {
        let unsupported=false;
        try { new Request('https://api.resend.com/test',{redirect:'error'}); }
        catch { unsupported=true; }
        if(!unsupported) throw Error('Expected workerd to reject the legacy redirect option');
        const result=await getRawEmail({data:{email_id:id}},'re_test',async(url,init)=>{
          const outbound=new Request(url,init); // Exercise the actual Worker runtime.
          calls++;
          if(outbound.redirect!=='manual') throw Error('Redirect mode is not fail-closed');
          if(calls===2 && outbound.headers.has('Authorization')) throw Error('Credential leaked');
          if((stage==='api' && calls===1)||(stage==='raw' && calls===2))
            return new Response('',{status:302,headers:{Location:'https://untrusted.invalid/'}});
          return calls===1 ? Response.json({id,raw:{download_url:'https://download.resend.com/test'}})
            : new Response('From: sender@example.net\\r\\n\\r\\nworkerd test');
        });
        return Response.json({ok:true,calls,text:new TextDecoder().decode(result.raw)});
      } catch(error) { return Response.json({ok:false,calls,error:error.message}); }
    }}
  `});
  try {
    const result=await (await mf.dispatchFetch('https://test.invalid/')).json();
    assert.equal(result.ok,true,result.error);assert.equal(result.calls,2);assert.match(result.text,/workerd test/);
    for(const [stage,calls] of [['api',1],['raw',2]]) {
      const rejected=await (await mf.dispatchFetch(`https://test.invalid/?redirect=${stage}`)).json();
      assert.equal(rejected.ok,false);assert.equal(rejected.calls,calls);
      assert.match(rejected.error,/unavailable/);
    }
  } finally { await mf.dispose(); }
});
