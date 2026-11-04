# Tally-to-WhatsApp Document Automation

Built from the PRD: a local Node.js agent syncs TallyPrime customers and stock items to Supabase; a Cloudflare Worker creates Quotations, Invoices and Delivery Challans, renders the PDF, and sends it over the Meta WhatsApp Cloud API; a Tailwind web app drives it.

```
TallyPrime (port 9000) --XML--> agent/ --upsert--> Supabase <--> worker/ <--> web/
                                                                    |
                                                         WhatsApp Cloud API --webhook--> worker/
```

| Folder | What it is |
|---|---|
| `supabase/migrations/0001_schema.sql` | Tables exactly as in the PRD, plus a public `documents` storage bucket |
| `agent/` | Local service: polls Tally, parses XML to JSON, upserts to Supabase |
| `worker/` | Cloudflare Worker API: documents, GST calculation, PDF, WhatsApp send, webhook |
| `web/` | Vite + TypeScript + Tailwind UI |

## 1. Tally test environment
1. Register for the TallyPrime 7-day free trial, install it on Windows, create a dummy company.
2. Add a few Sundry Debtors ledgers (with address, mobile, GSTIN), stock items (with unit, HSN, GST rate) and GST ledgers.
3. In Tally enable the HTTP server: **F1 (Help) > Settings > Connectivity > Client/Server configuration**, set TallyPrime to act as **Server** (or **Both**) on port **9000**.
4. Keep the company **open** in Tally while the agent runs.

## 2. Supabase
1. Create a project. Run `supabase/migrations/0001_schema.sql` in the SQL editor.
2. Create a user under Authentication (email + password) for yourself.
3. Note the project URL, anon key and service role key.

## 3. Local agent
```bash
cd agent
cp .env.example .env     # set TALLY_COMPANY (exact name), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm install
npm test                 # offline XML parsing checks
npm run sync:once        # one sync, then exit
npm start                # keep polling on SYNC_CRON
```
The agent sends every request through a one-at-a-time queue, sets `SVCURRENTCOMPANY` on each request, treats `LINEERROR`/`ERROR` bodies as failures even on HTTP 200, and only fetches records whose `ALTERID` is newer than the last sync (`sync-state.json`).

## 4. Worker
```bash
cd worker
npm install
npm test                 # GST maths + PDF rendering checks
# edit [vars] in wrangler.toml: business name, GSTIN, state code, bank details, template name
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put META_APP_SECRET      # optional: enables webhook signature check
npx wrangler dev         # or: npx wrangler deploy
```

## 5. WhatsApp (Meta)
1. Create a WhatsApp Business Account and register a number in Meta Business Suite.
2. Create a **System User**, assign your app, generate a **permanent token** (do not use the 24-hour quickstart token).
3. Create a **Utility** template named `document_delivery` (language `en`) with a **Document header** and this body:
   `Hello {{1}}, please find attached your {{2}} for {{3}}.`
4. Webhook: callback URL `https://<your-worker>/webhook/whatsapp`, verify token = `WEBHOOK_VERIFY_TOKEN`, subscribe to the **messages** field.

How delivery status works: the Worker sends the document id in `biz_opaque_callback_data`; Meta returns it in each status event, and the Worker maps `sent`/`delivered`/`read` to `SENT` and `failed` to `FAILED` in `documents.whatsapp_status`. After clicking send, the status stays `PENDING` until Meta's webhook reports back.

## 6. Web app
```bash
cd web
cp .env.example .env     # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL
npm install
npm run dev              # http://localhost:5173
```
Deploy with Cloudflare Pages (build command `npm run build`, output `dist`). Set `ALLOWED_ORIGIN` in `wrangler.toml` to the Pages URL.

## How a document is made
1. Pick a customer and products (price defaults to the synced base price, editable).
2. The Worker computes tax per line: **CGST + SGST** when the customer's GSTIN state code equals `BUSINESS_STATE_CODE`, otherwise **IGST**. Customers without a GSTIN are treated as same-state. Grand total is rounded to the nearest rupee.
3. A number like `INV-2026-001` is allocated (per type and year), the PDF is rendered and uploaded to Supabase Storage, and its URL is saved on the document.
4. "Send via WhatsApp" posts the template with the PDF as the header document to the customer's phone (10-digit numbers get `DEFAULT_COUNTRY_CODE`).

## Notes on the build
- Delivery Challans print quantities only (no prices).
- PDFs use "Rs." because the built-in PDF fonts cannot draw the rupee sign.
- Tally holds one mailing address per ledger, so the agent uses it for both billing and shipping.
- Stock item "base price" is read from the item's standard price list entry; items without one sync as 0.00 and the price can be typed in the form.
- Tally XML shapes vary by version and configuration; confirm the field names against your own install with `npm run sync:once` and adjust `agent/src/mappers.ts` if a field comes back empty.
