import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';
import {
  DOC_LABEL,
  DOC_PREFIX,
  computeTotals,
  isInterstate,
  normalizePhone,
  stateCodeFromGstin,
  totalsFromStored,
  type DocType,
} from './tax.js';
import { buildPdf } from './pdf.js';
import { processStatuses, sendTemplate, validSignature, verifyWebhook } from './whatsapp.js';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function dbFor(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function cors(env: Env, res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

/** Requests from the web app carry the Supabase Auth access token. */
async function authorize(req: Request, env: Env, db: SupabaseClient): Promise<Response | null> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing bearer token' }, 401);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return json({ error: 'Invalid or expired session' }, 401);
  const allowed = env.ALLOWED_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes((data.user.email ?? '').toLowerCase())) {
    return json({ error: 'Not allowed' }, 403);
  }
  return null;
}

/** Next number like INV-2026-001, based on the highest existing number for that type and year. */
async function nextNumber(db: SupabaseClient, type: DocType, year: number): Promise<string> {
  const prefix = `${DOC_PREFIX[type]}-${year}-`;
  const { data } = await db
    .from('documents')
    .select('document_number')
    .like('document_number', `${prefix}%`)
    .order('document_number', { ascending: false })
    .limit(1);
  const last = data?.[0]?.document_number as string | undefined;
  const n = last ? parseInt(last.slice(prefix.length), 10) || 0 : 0;
  return `${prefix}${String(n + 1).padStart(3, '0')}`;
}

/** Load a document from the database, render the PDF, store it, and save the URL. */
async function renderAndStore(env: Env, db: SupabaseClient, docId: string): Promise<string> {
  const { data: doc, error } = await db
    .from('documents')
    .select('*, customers(*)')
    .eq('id', docId)
    .single();
  if (error || !doc) throw new Error('Document not found');

  const { data: items, error: itemsErr } = await db
    .from('document_line_items')
    .select('*, products(name, hsn_sac_code, uom)')
    .eq('document_id', docId)
    .order('created_at', { ascending: true });
  if (itemsErr) throw new Error(itemsErr.message);

  const customer = doc.customers;
  const interstate = isInterstate(env.BUSINESS_STATE_CODE, stateCodeFromGstin(customer?.gstin));

  const lines = (items ?? []).map((i: any) => {
    const taxable = r2(Number(i.quantity) * Number(i.unit_price) - Number(i.discount_amount ?? 0));
    return {
      name: i.products?.name ?? 'Item',
      hsn: i.products?.hsn_sac_code,
      uom: i.products?.uom,
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
      discount_amount: Number(i.discount_amount ?? 0),
      tax_rate: 0,
      taxable_value: Math.max(taxable, 0),
      tax_amount: Number(i.tax_amount),
    };
  });
  const totals = totalsFromStored(lines, interstate);

  const bytes = await buildPdf({
    type: doc.type as DocType,
    number: doc.document_number,
    date: doc.document_date,
    dueDate: doc.due_date,
    business: { name: env.BUSINESS_NAME, address: env.BUSINESS_ADDRESS, gstin: env.BUSINESS_GSTIN },
    customer: {
      name: customer?.name ?? '',
      billing_address: customer?.billing_address,
      shipping_address: customer?.shipping_address,
      gstin: customer?.gstin,
      phone: customer?.phone,
    },
    lines,
    totals,
    paymentTerms: env.PAYMENT_TERMS,
    bankDetails: env.BANK_DETAILS,
  });

  const path = `${doc.id}.pdf`;
  const { error: upErr } = await db.storage
    .from('documents')
    .upload(path, bytes, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new Error(`PDF upload failed: ${upErr.message}`);

  const url = db.storage.from('documents').getPublicUrl(path).data.publicUrl;
  await db.from('documents').update({ pdf_url: url }).eq('id', doc.id);
  return url;
}

async function createDocument(req: Request, env: Env, db: SupabaseClient): Promise<Response> {
  const body = (await req.json().catch(() => null)) as any;
  if (!body) return json({ error: 'Invalid JSON' }, 400);

  const type = body.type as DocType;
  if (!(type in DOC_PREFIX)) return json({ error: 'type must be QUOTATION, INVOICE or DELIVERY_CHALLAN' }, 400);
  if (!body.customer_id) return json({ error: 'customer_id is required' }, 400);
  const items: any[] = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return json({ error: 'Add at least one item' }, 400);
  for (const it of items) {
    if (!it.product_id || !(Number(it.quantity) > 0)) {
      return json({ error: 'Each item needs product_id and quantity > 0' }, 400);
    }
  }

  const { data: customer } = await db.from('customers').select('*').eq('id', body.customer_id).single();
  if (!customer) return json({ error: 'Customer not found' }, 404);

  const ids = [...new Set(items.map((i) => i.product_id))];
  const { data: products } = await db.from('products').select('*').in('id', ids);
  const byId = new Map((products ?? []).map((p: any) => [p.id, p]));
  if (byId.size !== ids.length) return json({ error: 'One or more products not found' }, 404);

  const date: string = body.document_date ?? new Date().toISOString().slice(0, 10);
  const customerState = body.place_of_supply_state_code ?? stateCodeFromGstin(customer.gstin);
  const interstate = isInterstate(env.BUSINESS_STATE_CODE, customerState);

  const prepared = items.map((it) => {
    const p: any = byId.get(it.product_id);
    return {
      product_id: p.id as string,
      quantity: Number(it.quantity),
      unit_price: it.unit_price !== undefined ? Number(it.unit_price) : Number(p.base_price),
      discount_amount: Number(it.discount_amount ?? 0),
      tax_rate: Number(p.tax_rate ?? 0),
    };
  });
  const totals = computeTotals(prepared, interstate);

  // Insert header, retrying if a concurrent request took the same number.
  const year = Number(date.slice(0, 4));
  let doc: any = null;
  for (let attempt = 0; attempt < 5 && !doc; attempt++) {
    const document_number = await nextNumber(db, type, year);
    const { data, error } = await db
      .from('documents')
      .insert({
        customer_id: customer.id,
        type,
        document_number,
        document_date: date,
        due_date: body.due_date ?? null,
        sub_total: totals.sub_total,
        tax_total: totals.tax_total,
        grand_total: totals.grand_total,
      })
      .select()
      .single();
    if (!error) doc = data;
    else if (error.code !== '23505') return json({ error: error.message }, 500);
  }
  if (!doc) return json({ error: 'Could not allocate a document number, try again' }, 409);

  const { error: liErr } = await db.from('document_line_items').insert(
    prepared.map((p, i) => ({
      document_id: doc.id,
      product_id: p.product_id,
      quantity: p.quantity,
      unit_price: p.unit_price,
      discount_amount: p.discount_amount,
      tax_amount: totals.lines[i].tax_amount,
      line_total: totals.lines[i].line_total,
    })),
  );
  if (liErr) {
    await db.from('documents').delete().eq('id', doc.id);
    return json({ error: liErr.message }, 500);
  }

  try {
    doc.pdf_url = await renderAndStore(env, db, doc.id);
  } catch (e) {
    return json({ ...doc, pdf_error: e instanceof Error ? e.message : String(e) }, 201);
  }
  return json(doc, 201);
}

async function sendDocument(env: Env, db: SupabaseClient, id: string): Promise<Response> {
  const { data: doc } = await db.from('documents').select('*, customers(*)').eq('id', id).single();
  if (!doc) return json({ error: 'Document not found' }, 404);

  const to = normalizePhone(doc.customers?.phone ?? '', env.DEFAULT_COUNTRY_CODE);
  if (!to) return json({ error: 'Customer has no valid WhatsApp phone number' }, 422);

  const pdfUrl: string = doc.pdf_url ?? (await renderAndStore(env, db, id));
  const type = doc.type as DocType;
  const amount = `Rs. ${Number(doc.grand_total).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  await db.from('documents').update({ whatsapp_status: 'PENDING' }).eq('id', id);
  const result = await sendTemplate(env, {
    to,
    customerName: doc.customers.name,
    documentLabel: DOC_LABEL[type],
    amount,
    pdfUrl,
    filename: `${doc.document_number}.pdf`,
    documentId: id,
  });
  if (!result.ok) {
    await db.from('documents').update({ whatsapp_status: 'FAILED' }).eq('id', id);
    return json({ error: result.error }, 502);
  }
  // Stays PENDING until Meta's webhook reports sent / delivered / read.
  return json({ ok: true, status: 'PENDING' });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
    if (path === '/health') return json({ ok: true });

    // Meta webhook (public; protected by verify token and optional signature)
    if (path === '/webhook/whatsapp') {
      if (req.method === 'GET') return verifyWebhook(env, url);
      if (req.method === 'POST') {
        const raw = await req.text();
        if (!(await validSignature(env, raw, req.headers.get('X-Hub-Signature-256')))) {
          return new Response('Invalid signature', { status: 401 });
        }
        try {
          await processStatuses(dbFor(env), JSON.parse(raw));
        } catch (e) {
          console.error('webhook processing failed', e);
        }
        return new Response('OK', { status: 200 }); // always ack so Meta does not retry endlessly
      }
      return new Response('Method not allowed', { status: 405 });
    }

    if (!path.startsWith('/api/')) return json({ error: 'Not found' }, 404);

    const db = dbFor(env);
    const denied = await authorize(req, env, db);
    if (denied) return cors(env, denied);

    try {
      let res: Response;
      if (path === '/api/customers' && req.method === 'GET') {
        const { data, error } = await db
          .from('customers')
          .select('id,name,gstin,phone,billing_address,shipping_address')
          .order('name')
          .limit(5000);
        res = error ? json({ error: error.message }, 500) : json(data);
      } else if (path === '/api/products' && req.method === 'GET') {
        const { data, error } = await db
          .from('products')
          .select('id,name,hsn_sac_code,uom,base_price,tax_rate')
          .order('name')
          .limit(5000);
        res = error ? json({ error: error.message }, 500) : json(data);
      } else if (path === '/api/documents' && req.method === 'GET') {
        const { data, error } = await db
          .from('documents')
          .select('id,type,document_number,document_date,grand_total,pdf_url,whatsapp_status,customers(name)')
          .order('created_at', { ascending: false })
          .limit(100);
        res = error ? json({ error: error.message }, 500) : json(data);
      } else if (path === '/api/documents' && req.method === 'POST') {
        res = await createDocument(req, env, db);
      } else {
        const m = path.match(/^\/api\/documents\/([0-9a-f-]{36})\/send$/);
        if (m && req.method === 'POST') res = await sendDocument(env, db, m[1]);
        else res = json({ error: 'Not found' }, 404);
      }
      return cors(env, res);
    } catch (e) {
      console.error(e);
      return cors(env, json({ error: e instanceof Error ? e.message : 'Server error' }, 500));
    }
  },
} satisfies ExportedHandler<Env>;
