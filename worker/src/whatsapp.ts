import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';

export interface SendArgs {
  to: string; // digits only, with country code
  customerName: string;
  documentLabel: string;
  amount: string; // already formatted, e.g. "Rs. 11,800.00"
  pdfUrl: string;
  filename: string;
  documentId: string;
}

/**
 * Sends the pre-approved Utility template with a Document header.
 * Body variables: {{1}} customer name, {{2}} document type, {{3}} total amount.
 * biz_opaque_callback_data carries our document id; Meta echoes it back in
 * status webhooks so we can find the document without storing a message id.
 */
export async function sendTemplate(env: Env, a: SendArgs): Promise<{ ok: boolean; error?: string }> {
  const url = `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: a.to,
    type: 'template',
    template: {
      name: env.WHATSAPP_TEMPLATE_NAME,
      language: { code: env.WHATSAPP_TEMPLATE_LANG },
      components: [
        {
          type: 'header',
          parameters: [{ type: 'document', document: { link: a.pdfUrl, filename: a.filename } }],
        },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: a.customerName },
            { type: 'text', text: a.documentLabel },
            { type: 'text', text: a.amount },
          ],
        },
      ],
    },
    biz_opaque_callback_data: a.documentId,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as any;
  return { ok: false, error: body?.error?.message ?? `WhatsApp API HTTP ${res.status}` };
}

/** GET handshake: echo hub.challenge in plain text if the verify token matches. */
export function verifyWebhook(env: Env, url: URL): Response {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token && token === env.WEBHOOK_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

/** Validate X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
export async function validSignature(env: Env, raw: string, header: string | null): Promise<boolean> {
  if (!env.META_APP_SECRET) return true; // signature check is opt-in
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7);
  if (hex.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/**
 * Map Meta delivery states onto whatsapp_status_enum (PENDING | SENT | FAILED):
 * sent / delivered / read -> SENT, failed -> FAILED.
 */
export async function processStatuses(db: SupabaseClient, payload: any): Promise<number> {
  let updated = 0;
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const st of change?.value?.statuses ?? []) {
        const docId: string | undefined = st.biz_opaque_callback_data;
        if (!docId) continue;
        const status = st.status as string;
        if (status === 'failed') {
          const { error } = await db.from('documents').update({ whatsapp_status: 'FAILED' }).eq('id', docId);
          if (!error) updated++;
        } else if (status === 'sent' || status === 'delivered' || status === 'read') {
          // Never downgrade a FAILED row if events arrive out of order after a retry: only move forward from PENDING/SENT.
          const { error } = await db
            .from('documents')
            .update({ whatsapp_status: 'SENT' })
            .eq('id', docId)
            .neq('whatsapp_status', 'FAILED');
          if (!error) updated++;
        }
      }
    }
  }
  return updated;
}
