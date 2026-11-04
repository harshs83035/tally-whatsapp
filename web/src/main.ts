import './style.css';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
);
const API = (import.meta.env.VITE_API_URL as string).replace(/\/$/, '');

interface Customer { id: string; name: string; gstin: string | null; phone: string | null }
interface Product { id: string; name: string; uom: string | null; base_price: number; tax_rate: number }
interface Doc {
  id: string; type: string; document_number: string; document_date: string;
  grand_total: number; pdf_url: string | null; whatsapp_status: string;
  customers: { name: string } | null;
}

const TYPE_LABEL: Record<string, string> = {
  QUOTATION: 'Quotation',
  INVOICE: 'Tax Invoice',
  DELIVERY_CHALLAN: 'Delivery Challan',
};

// ---------- tiny DOM helper (text is always set via textContent, never innerHTML) ----------
type Child = Node | string | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el) (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

const money = (n: number) =>
  Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const root = document.getElementById('app')!;

function toast(msg: string, ok = true) {
  const t = h('div', {
    class: `fixed bottom-4 right-4 z-50 max-w-sm rounded-md px-4 py-3 text-sm text-white shadow-lg ${ok ? 'bg-emerald-700' : 'bg-red-600'}`,
  }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 4500);
}

// ---------- login ----------
function renderLogin() {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const err = h('p', { class: 'text-sm text-red-600' });
  const form = h('form', {
    class: 'mx-auto mt-24 w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm',
    onSubmit: async (e: Event) => {
      e.preventDefault();
      err.textContent = '';
      const { error } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value });
      if (error) err.textContent = error.message;
      else void boot();
    },
  },
    h('h1', { class: 'text-lg font-semibold' }, 'Tally to WhatsApp'),
    h('div', {}, h('label', {}, 'Email'), email),
    h('div', {}, h('label', {}, 'Password'), password),
    err,
    h('button', { class: 'w-full rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800', type: 'submit' }, 'Sign in'),
  );
  root.replaceChildren(form);
}

// ---------- main app ----------
async function renderApp() {
  root.replaceChildren(h('p', { class: 'p-8 text-sm text-slate-500' }, 'Loading...'));
  let customers: Customer[] = [];
  let products: Product[] = [];
  let docs: Doc[] = [];
  try {
    [customers, products, docs] = await Promise.all([
      api<Customer[]>('/api/customers'),
      api<Product[]>('/api/products'),
      api<Doc[]>('/api/documents'),
    ]);
  } catch (e) {
    root.replaceChildren(h('p', { class: 'p-8 text-sm text-red-600' }, (e as Error).message));
    return;
  }

  // --- form pieces ---
  const typeSel = h('select', {}, ...Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  const today = new Date().toISOString().slice(0, 10);
  const dateIn = h('input', { type: 'date', value: today });
  const dueIn = h('input', { type: 'date' });

  const custFilter = h('input', { placeholder: 'Search customers...' });
  const custSel = h('select', { size: 5 });
  const fillCustomers = () => {
    const q = custFilter.value.trim().toLowerCase();
    custSel.replaceChildren(
      ...customers
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .slice(0, 200)
        .map((c) => h('option', { value: c.id }, `${c.name}${c.phone ? ` - ${c.phone}` : ' - (no phone)'}`)),
    );
    if (custSel.options.length) custSel.selectedIndex = 0;
  };
  custFilter.addEventListener('input', fillCustomers);
  fillCustomers();

  // --- line items ---
  interface Row { el: HTMLElement; read: () => { product_id: string; quantity: number; unit_price: number; discount_amount: number } | null }
  const rows: Row[] = [];
  const itemsBox = h('div', { class: 'space-y-2' });

  const addRow = () => {
    const prod = h('select', {}, h('option', { value: '' }, 'Select product'),
      ...products.map((p) => h('option', { value: p.id }, `${p.name}${p.uom ? ` (${p.uom})` : ''}`)));
    const qty = h('input', { type: 'number', min: '0', step: 'any', value: '1', placeholder: 'Qty' });
    const price = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'Price' });
    const disc = h('input', { type: 'number', min: '0', step: 'any', value: '0', placeholder: 'Discount' });
    prod.addEventListener('change', () => {
      const p = products.find((x) => x.id === prod.value);
      if (p) price.value = String(p.base_price);
    });
    const el = h('div', { class: 'grid grid-cols-12 items-center gap-2' },
      h('div', { class: 'col-span-5' }, prod),
      h('div', { class: 'col-span-2' }, qty),
      h('div', { class: 'col-span-2' }, price),
      h('div', { class: 'col-span-2' }, disc),
      h('button', {
        type: 'button', class: 'col-span-1 text-slate-400 hover:text-red-600', title: 'Remove',
        onClick: () => { rows.splice(rows.findIndex((r) => r.el === el), 1); el.remove(); },
      }, '✕'),
    );
    rows.push({
      el,
      read: () => prod.value
        ? { product_id: prod.value, quantity: Number(qty.value), unit_price: Number(price.value), discount_amount: Number(disc.value || 0) }
        : null,
    });
    itemsBox.append(el);
  };
  addRow();

  const submitBtn = h('button', {
    type: 'submit',
    class: 'rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50',
  }, 'Generate PDF');

  const form = h('form', {
    class: 'space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm',
    onSubmit: async (e: Event) => {
      e.preventDefault();
      const items = rows.map((r) => r.read()).filter((x): x is NonNullable<typeof x> => x !== null);
      if (!custSel.value) return toast('Select a customer', false);
      if (!items.length) return toast('Add at least one product', false);
      if (items.some((i) => !(i.quantity > 0) || Number.isNaN(i.unit_price))) return toast('Check quantity and price', false);
      submitBtn.disabled = true;
      try {
        const doc = await api<any>('/api/documents', {
          method: 'POST',
          body: JSON.stringify({
            type: typeSel.value,
            customer_id: custSel.value,
            document_date: dateIn.value || today,
            due_date: dueIn.value || null,
            items,
          }),
        });
        toast(`${doc.document_number} created${doc.pdf_error ? ` (PDF problem: ${doc.pdf_error})` : ''}`, !doc.pdf_error);
        void renderApp();
      } catch (err) {
        toast((err as Error).message, false);
      } finally {
        submitBtn.disabled = false;
      }
    },
  },
    h('h2', { class: 'text-base font-semibold' }, 'New document'),
    h('div', { class: 'grid grid-cols-3 gap-3' },
      h('div', {}, h('label', {}, 'Type'), typeSel),
      h('div', {}, h('label', {}, 'Date'), dateIn),
      h('div', {}, h('label', {}, 'Due / valid until'), dueIn),
    ),
    h('div', {}, h('label', {}, 'Customer'), custFilter, h('div', { class: 'mt-2' }, custSel)),
    h('div', {},
      h('div', { class: 'mb-1 grid grid-cols-12 gap-2 text-xs font-medium text-slate-600' },
        h('span', { class: 'col-span-5' }, 'Product'), h('span', { class: 'col-span-2' }, 'Qty'),
        h('span', { class: 'col-span-2' }, 'Price'), h('span', { class: 'col-span-2' }, 'Discount')),
      itemsBox,
      h('button', { type: 'button', class: 'mt-2 text-sm text-emerald-700 hover:underline', onClick: addRow }, '+ Add product'),
    ),
    submitBtn,
  );

  // --- documents list ---
  const badge = (s: string) => {
    const colors: Record<string, string> = {
      PENDING: 'bg-amber-100 text-amber-800',
      SENT: 'bg-emerald-100 text-emerald-800',
      FAILED: 'bg-red-100 text-red-800',
    };
    return h('span', { class: `rounded-full px-2 py-0.5 text-xs font-medium ${colors[s] ?? 'bg-slate-100'}` }, s);
  };

  const list = h('div', { class: 'divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm' },
    ...(docs.length
      ? docs.map((d) => {
          const send = h('button', {
            class: 'rounded-md border border-emerald-700 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50',
            onClick: async () => {
              if (!confirm(`Send ${d.document_number} to ${d.customers?.name ?? 'customer'} on WhatsApp?`)) return;
              send.disabled = true;
              try {
                await api(`/api/documents/${d.id}/send`, { method: 'POST' });
                toast('Sent to WhatsApp. Status updates when Meta confirms delivery.');
                void renderApp();
              } catch (err) {
                toast((err as Error).message, false);
                send.disabled = false;
              }
            },
          }, 'Send via WhatsApp');
          return h('div', { class: 'flex items-center justify-between gap-3 p-4' },
            h('div', { class: 'min-w-0' },
              h('p', { class: 'truncate text-sm font-medium' }, `${d.document_number} · ${d.customers?.name ?? ''}`),
              h('p', { class: 'text-xs text-slate-500' }, `${TYPE_LABEL[d.type] ?? d.type} · ${d.document_date} · Rs. ${money(d.grand_total)}`),
            ),
            h('div', { class: 'flex shrink-0 items-center gap-2' },
              badge(d.whatsapp_status),
              d.pdf_url ? h('a', { href: d.pdf_url, target: '_blank', rel: 'noopener', class: 'text-xs text-slate-600 underline' }, 'PDF') : null,
              send,
            ),
          );
        })
      : [h('p', { class: 'p-6 text-sm text-slate-500' }, 'No documents yet.')]),
  );

  root.replaceChildren(
    h('header', { class: 'flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3' },
      h('h1', { class: 'text-base font-semibold' }, 'Tally to WhatsApp'),
      h('div', { class: 'flex items-center gap-4 text-xs text-slate-500' },
        h('span', {}, `${customers.length} customers · ${products.length} products synced`),
        h('button', { class: 'underline', onClick: async () => { await supabase.auth.signOut(); void boot(); } }, 'Sign out'),
      ),
    ),
    h('main', { class: 'mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-2' },
      form,
      h('section', { class: 'space-y-3' }, h('h2', { class: 'text-base font-semibold' }, 'Recent documents'), list),
    ),
  );
}

async function boot() {
  const { data } = await supabase.auth.getSession();
  if (data.session) await renderApp();
  else renderLogin();
}

void boot();
