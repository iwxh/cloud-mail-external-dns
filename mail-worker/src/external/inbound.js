import PostalMime from 'postal-mime';
import settingService from '../service/setting-service';
import accountService from '../service/account-service';
import userService from '../service/user-service';
import roleService from '../service/role-service';
import emailService from '../service/email-service';
import aiService from '../service/ai-service';
import telegramService from '../service/telegram-service';
import r2Service from '../service/r2-service';
import fileUtils from '../utils/file-utils';
import constant from '../const/constant';
import { checkBlock } from '../email/email';
import { MAX_WEBHOOK_BYTES, readLimited, verifyWebhook, recipientList, getRawEmail } from './protocol.js';
import { storeReceived } from './store.js';

export async function inbound(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let event;
  try {
    const payload = new TextDecoder().decode(await readLimited(request.body, MAX_WEBHOOK_BYTES));
    event = await verifyWebhook(payload, request.headers, env.EXTERNAL_WEBHOOK_SECRET);
  } catch { return new Response('Invalid webhook', { status: 400 }); }
  try {
    if (event.type !== 'email.received') {
      const types = { 'email.delivered':2, 'email.bounced':3, 'email.complained':4, 'email.delivery_delayed':5, 'email.failed':8 };
      if (types[event.type] !== undefined && /^[a-f0-9-]{36}$/i.test(event.data?.email_id || '')) {
        await env.db.prepare('UPDATE email SET status=? WHERE resend_email_id=? AND type=1')
          .bind(types[event.type], event.data.email_id).run();
      }
      return new Response('OK');
    }
    const recipients = recipientList(event, env.ONECLICK_DOMAIN);
    if (!recipients.length) return new Response('OK'); // Another customer's event: never fetch its content.
    const setting = await settingService.query({ env });
    if (setting.receive === 1) return new Response('Receiving paused', { status: 503 });
    const { raw } = await getRawEmail(event, env.EXTERNAL_RESEND_API_KEY);
    const parsed = await PostalMime.parse(raw);
    if (!parsed.from?.address) throw new Error('Missing sender');
    if ((parsed.attachments || []).length > 40 || recipients.length > 50) throw new Error('Message processing limit exceeded');
    if (checkBlock(setting.blackSubject,setting.blackContent,setting.blackFrom,parsed)) return new Response('OK');
    const attachments = [];
    for (const item of parsed.attachments || []) {
      const content = new Uint8Array(item.content);
      const key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(content) + fileUtils.getExtFileName(item.filename || 'attachment');
      attachments.push({ ...item, key, content, size:content.byteLength });
    }
    const code = await aiService.extractCode({ env },parsed,{ aiCode:setting.aiCode,aiCodeFilter:setting.aiCodeFilter });
    for (const recipient of recipients) {
      const account = await accountService.selectByEmailIncludeDel({ env },recipient);
      if (!account && setting.noRecipient === 1) continue;
      if (account) {
        const user = await userService.selectByIdIncludeDel({ env },account.userId);
        if (user?.email !== env.admin) {
          const role = await roleService.selectByUserId({ env },account.userId);
          if (!roleService.hasAvailDomainPerm(role.availDomain,recipient) || roleService.isBanEmail(role.banEmail,parsed.from.address)) continue;
        }
      }
      // Write deterministic objects before committing the inbox row. Failed storage is
      // retried by the provider and cannot acknowledge an email with missing attachments.
      for (const item of attachments) await r2Service.putObj({ env },item.key,item.content,{
        contentType:item.mimeType || 'application/octet-stream',
        contentDisposition:`${item.contentId ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.filename || 'attachment')}`
      });
      const content = emailService.imgReplace(parsed.html || '',attachments.filter(item => item.contentId),setting.r2Domain);
      const saved = await storeReceived(env.db,event.data.email_id,{
        sendEmail:parsed.from.address,name:parsed.from.name || parsed.from.address,
        userId:account?.userId || 0,accountId:account?.accountId || 0,toEmail:recipient,
        toName:(parsed.to || []).find(item => item.address?.toLowerCase() === recipient)?.name || '',
        subject:parsed.subject,code,text:parsed.text,content,cc:parsed.cc,recipients:parsed.to,
        inReplyTo:parsed.inReplyTo,references:parsed.references,messageId:parsed.messageId,status:account ? 0 : 7
      },attachments);
      // Optional notification failure does not cause duplicate inbox writes.
      if (saved.inserted && setting.tgBotStatus === 0 && setting.tgChatId) {
        try { await telegramService.sendEmailToBot({ env },{ ...saved.row,emailId:saved.row.email_id }); }
        catch { console.error('External mail notification failed'); }
      }
    }
    return new Response('OK');
  } catch {
    console.error('External mail processing failed; provider retry required');
    return new Response('Mail processing temporarily unavailable', { status: 503 });
  }
}
