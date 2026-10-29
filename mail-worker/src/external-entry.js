import app from './index.js';
import cryptoUtils from './utils/crypto-utils.js';
import settingService from './service/setting-service.js';
import { deploymentMeta,setupRequest,ensureSettings } from './oneclick/setup.js';
import { inbound } from './external/inbound.js';

const unavailable = () => new Response('Mailbox setup is not ready',{ status:503,headers:{ 'Cache-Control':'no-store' } });
export default {
  async fetch(request,env,ctx) {
    try {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname).replace(/\/+/g,'/');
      if (env.EXTERNAL_DNS_MODE !== 'true' || url.hostname !== env.EXTERNAL_WEBSITE_HOST ||
          env.email || /^\/(?:api\/)?init(?:\/|$)/i.test(path)) return new Response('Not found',{ status:404 });
      const meta = await deploymentMeta(env);
      if (!meta?.schema_ready || !env.jwt_secret || !await ensureSettings(env,meta,c => settingService.refresh(c))) return unavailable();
      if (path === '/_external/resend') return inbound(request,env);
      // Disable the legacy unverified delivery-status callback in this separate product.
      if (/^\/(?:api\/)?webhooks(?:\/|$)/i.test(path)) return new Response('Not found',{ status:404 });
      if (path === '/setup' || path === '/_cloudmail/health') return setupRequest(request,env,meta,p => cryptoUtils.hashPassword(p));
      if (!meta.activated) return request.method === 'GET' ? new Response(null,{ status:303,headers:{ Location:'/setup' } }) : unavailable();
      return app.fetch(request,env,ctx);
    } catch { return unavailable(); }
  },
  async scheduled(event,env,ctx) {
    const meta = await deploymentMeta(env);
    if (meta?.schema_ready && await ensureSettings(env,meta,c => settingService.refresh(c))) return app.scheduled(event,env,ctx);
  }
};
