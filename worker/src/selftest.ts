import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  computeTotals,
  isInterstate,
  normalizePhone,
  stateCodeFromGstin,
  totalsFromStored,
} from './tax.js';
import { buildPdf } from './pdf.js';

// Intra-state: 2 x 1000 less 100 discount at 18% -> taxable 1900, tax 342 (171 + 171)
const intra = computeTotals([{ quantity: 2, unit_price: 1000, discount_amount: 100, tax_rate: 18 }], false);
assert.equal(intra.sub_total, 1900);
assert.equal(intra.cgst_total, 171);
assert.equal(intra.sgst_total, 171);
assert.equal(intra.igst_total, 0);
assert.equal(intra.tax_total, 342);
assert.equal(intra.grand_total, 2242);
assert.equal(intra.round_off, 0);

// Inter-state: all tax as IGST, and rounding to nearest rupee
const inter = computeTotals(
  [{ quantity: 3, unit_price: 99.99, discount_amount: 0, tax_rate: 12 }],
  true,
);
assert.equal(inter.sub_total, 299.97);
assert.equal(inter.igst_total, 36);
assert.equal(inter.cgst_total, 0);
assert.equal(inter.grand_total, 336);
assert.equal(inter.round_off, 0.03);

// Odd-paisa tax still splits so CGST + SGST == tax exactly
const odd = computeTotals([{ quantity: 1, unit_price: 10.01, discount_amount: 0, tax_rate: 5 }], false);
assert.equal(odd.cgst_total + odd.sgst_total, odd.tax_total);

// Re-render from stored amounts matches the original calculation
const re = totalsFromStored(
  intra.lines.map((l) => ({ taxable_value: l.taxable_value, tax_amount: l.tax_amount })),
  false,
);
assert.equal(re.grand_total, intra.grand_total);

// State logic and phone normalisation
assert.equal(stateCodeFromGstin('09ABCDE1234F1Z5'), '09');
assert.equal(stateCodeFromGstin(''), null);
assert.equal(isInterstate('09', '27'), true);
assert.equal(isInterstate('09', '09'), false);
assert.equal(isInterstate('09', null), false);
assert.equal(normalizePhone('98765 43210', '91'), '919876543210');
assert.equal(normalizePhone('+91 98765-43210', '91'), '919876543210');
assert.equal(normalizePhone('12345', '91'), null);

// PDF renders for each type
for (const type of ['QUOTATION', 'INVOICE', 'DELIVERY_CHALLAN'] as const) {
  const bytes = await buildPdf({
    type,
    number: 'INV-2026-001',
    date: '2026-10-31',
    dueDate: '2026-11-15',
    business: { name: 'Demo Traders', address: '12 MG Road, Lucknow, Uttar Pradesh 226001', gstin: '09AAAAA0000A1Z5' },
    customer: {
      name: 'Acme Traders',
      billing_address: '45 Park Street, Mumbai, Maharashtra',
      gstin: '27ABCDE1234F1Z5',
      phone: '919876543210',
    },
    lines: [
      { name: 'Widget A (long name to test wrapping across the item column)', hsn: '8501', uom: 'Nos', quantity: 2, unit_price: 1000, discount_amount: 100, tax_rate: 18, taxable_value: 1900 },
    ],
    totals: inter,
    paymentTerms: 'Payment due within 15 days.',
    bankDetails: 'Bank: XXXX | A/C: 0000000000 | IFSC: XXXX0000000',
  });
  assert.ok(bytes.length > 1000);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF');
  if (process.env.WRITE_SAMPLE && type === 'INVOICE') writeFileSync(process.env.WRITE_SAMPLE, bytes);
}

console.log('worker selftest: all checks passed');
