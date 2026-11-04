export interface LineInput {
  quantity: number;
  unit_price: number;
  discount_amount: number;
  tax_rate: number; // e.g. 18 for 18% GST
}

export interface LineResult {
  taxable_value: number;
  tax_amount: number;
  cgst: number;
  sgst: number;
  igst: number;
  line_total: number; // taxable + tax
}

export interface DocTotals {
  lines: LineResult[];
  sub_total: number; // sum of taxable values
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  tax_total: number;
  round_off: number;
  grand_total: number; // rounded to nearest rupee
  interstate: boolean;
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** GST state code = first two digits of a GSTIN. */
export function stateCodeFromGstin(gstin?: string | null): string | null {
  if (!gstin) return null;
  const m = gstin.trim().match(/^(\d{2})/);
  return m ? m[1] : null;
}

/**
 * CGST+SGST when customer and business are in the same state, IGST otherwise.
 * If the customer's state is unknown (no GSTIN), treat as intra-state.
 */
export function isInterstate(businessState: string, customerState: string | null): boolean {
  if (!customerState) return false;
  return customerState !== businessState;
}

function splitTax(taxable: number, tax: number, interstate: boolean): LineResult {
  if (interstate) {
    return { taxable_value: taxable, tax_amount: tax, cgst: 0, sgst: 0, igst: tax, line_total: r2(taxable + tax) };
  }
  const half = r2(tax / 2);
  const other = r2(tax - half); // keeps cgst+sgst exactly equal to tax
  return { taxable_value: taxable, tax_amount: tax, cgst: half, sgst: other, igst: 0, line_total: r2(taxable + tax) };
}

export function computeTotals(lines: LineInput[], interstate: boolean): DocTotals {
  const results: LineResult[] = lines.map((l) => {
    const taxable = r2(Math.max(l.quantity * l.unit_price - l.discount_amount, 0));
    return splitTax(taxable, r2((taxable * l.tax_rate) / 100), interstate);
  });
  return aggregate(results, interstate);
}

/** Rebuild totals from amounts already saved on a document (used when re-rendering the PDF). */
export function totalsFromStored(
  lines: { taxable_value: number; tax_amount: number }[],
  interstate: boolean,
): DocTotals {
  return aggregate(
    lines.map((l) => splitTax(l.taxable_value, l.tax_amount, interstate)),
    interstate,
  );
}

function aggregate(results: LineResult[], interstate: boolean): DocTotals {
  const sub_total = r2(results.reduce((s, l) => s + l.taxable_value, 0));
  const cgst_total = r2(results.reduce((s, l) => s + l.cgst, 0));
  const sgst_total = r2(results.reduce((s, l) => s + l.sgst, 0));
  const igst_total = r2(results.reduce((s, l) => s + l.igst, 0));
  const tax_total = r2(cgst_total + sgst_total + igst_total);
  const exact = r2(sub_total + tax_total);
  const grand_total = Math.round(exact);
  return {
    lines: results,
    sub_total,
    cgst_total,
    sgst_total,
    igst_total,
    tax_total,
    round_off: r2(grand_total - exact),
    grand_total,
    interstate,
  };
}

/** Financial year label for India (April-March): 2026-27 for dates from 1 Apr 2026. */
export function financialYear(date: Date): string {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** 10-digit Indian numbers get the default country code; output is digits only. */
export function normalizePhone(raw: string, defaultCountryCode: string): string | null {
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length === 10) return defaultCountryCode + digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

export const DOC_PREFIX = { QUOTATION: 'QTN', INVOICE: 'INV', DELIVERY_CHALLAN: 'DC' } as const;
export const DOC_LABEL = {
  QUOTATION: 'Quotation',
  INVOICE: 'Tax Invoice',
  DELIVERY_CHALLAN: 'Delivery Challan',
} as const;
export type DocType = keyof typeof DOC_PREFIX;
