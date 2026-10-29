// Provider-neutral boundaries. No Cloudflare account credentials belong in the runtime.
export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const MAX_RAW_BYTES = 20 * 1024 * 1024;

export async function readLimited(body, limit) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('Payload limit exceeded'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function verifyWebhook(payload, headers, secret, now = Date.now()) {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature') || '';
  if (!id || !/^\d{10}$/.test(timestamp || '') || !secret?.startsWith('whsec_') ||
      Math.abs(now / 1000 - Number(timestamp)) > 300) throw new Error('Invalid webhook');
  let bytes;
  try { bytes = Uint8Array.from(atob(secret.slice(6)), ch => ch.charCodeAt(0)); } catch { throw new Error('Invalid webhook'); }
  if (bytes.byteLength < 16) throw new Error('Invalid webhook');
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const content = new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
  for (const signature of signatures.split(/\s+/)) {
    if (!signature.startsWith('v1,')) continue;
    try {
      const data = Uint8Array.from(atob(signature.slice(3)), ch => ch.charCodeAt(0));
      if (await crypto.subtle.verify('HMAC', key, data, content)) return JSON.parse(payload);
    } catch { /* Try the next rotation signature. */ }
  }
  throw new Error('Invalid webhook');
}

export function recipientList(event, domain) {
  // The provider's signed delivery event supplies the delivery targets. Never expand
  // recipients using MIME To/Cc or Received headers, which the sender can fabricate.
  const values = event?.data?.to;
  if (!Array.isArray(values)) throw new Error('Missing delivery recipients');
  return [...new Set(values.map(value => String(value).trim().toLowerCase())
    .filter(value => /^[^\s<>@]+@[^\s<>@]+$/.test(value) && value.split('@')[1] === domain))];
}

export async function getRawEmail(event, apiKey, fetcher = fetch) {
  const id = event?.data?.email_id;
  if (!/^[a-f0-9-]{36}$/i.test(id || '') || !apiKey) throw new Error('Invalid email reference');
  const response = await fetcher(`https://api.resend.com/emails/receiving/${id}`, {
    // Workers supports manual/follow only. Reject 3xx via response.ok below
    // instead of using redirect:'error', which throws before the request is sent.
    headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'manual', signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Receiving API unavailable');
  const detail = await response.json();
  if (detail.id !== id || !detail.raw?.download_url) throw new Error('Raw email unavailable');
  const url = new URL(detail.raw.download_url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid raw email URL');
  // The URL comes only from the authenticated provider API, never the webhook payload.
  // Do not forward the API key to the signed download endpoint or follow redirects.
  const raw = await fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  if (!raw.ok) throw new Error('Raw download unavailable');
  return { detail, raw: await readLimited(raw.body, MAX_RAW_BYTES) };
}
