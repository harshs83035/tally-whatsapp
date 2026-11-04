import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { DocTotals } from './tax.js';
import { DOC_LABEL, type DocType } from './tax.js';

export interface PdfLine {
  name: string;
  hsn?: string | null;
  uom?: string | null;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  tax_rate: number;
  taxable_value: number;
}

export interface PdfInput {
  type: DocType;
  number: string;
  date: string;
  dueDate?: string | null;
  business: { name: string; address: string; gstin: string };
  customer: {
    name: string;
    billing_address?: string | null;
    shipping_address?: string | null;
    gstin?: string | null;
    phone?: string | null;
  };
  lines: PdfLine[];
  totals: DocTotals;
  paymentTerms: string;
  bankDetails: string;
}

const money = (n: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Standard PDF fonts only cover WinAnsi; replace anything else (e.g. the rupee sign). */
const safe = (s: string): string =>
  s.replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E -ÿ]/g, '?');

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) cur = test;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export async function buildPdf(input: PdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28;
  const H = 841.89;
  const M = 40;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.45);
  const accent = rgb(0.07, 0.35, 0.28);
  const showAmounts = input.type !== 'DELIVERY_CHALLAN';

  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, yy: number, size = 9, f: PDFFont = font, color = ink) =>
    page.drawText(safe(s), { x, y: yy, size, font: f, color });
  const right = (s: string, xRight: number, yy: number, size = 9, f: PDFFont = font) => {
    const t = safe(s);
    page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color: ink });
  };

  // Header: business + document title
  text(input.business.name, M, y, 16, bold, accent);
  right(DOC_LABEL[input.type].toUpperCase(), W - M, y, 16, bold);
  y -= 16;
  for (const l of wrap(input.business.address, font, 9, 260)) {
    text(l, M, y, 9, font, muted);
    y -= 12;
  }
  if (input.business.gstin) {
    text(`GSTIN: ${input.business.gstin}`, M, y, 9, font, muted);
    y -= 12;
  }
  // Doc meta (right column)
  let my = H - M - 20;
  const meta: [string, string][] = [
    ['No.', input.number],
    ['Date', input.date],
  ];
  if (input.dueDate) {
    meta.push([input.type === 'QUOTATION' ? 'Valid until' : 'Due date', input.dueDate]);
  }
  for (const [k, v] of meta) {
    text(`${k}:`, W - M - 150, my, 9, font, muted);
    right(v, W - M, my, 9, bold);
    my -= 13;
  }
  y = Math.min(y, my) - 14;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: accent });
  y -= 18;

  // Party blocks
  const colW = (W - 2 * M - 20) / 2;
  const blockTop = y;
  text('BILL TO', M, y, 8, bold, muted);
  text('SHIP TO', M + colW + 20, y, 8, bold, muted);
  y -= 13;
  text(input.customer.name, M, y, 10, bold);
  text(input.customer.name, M + colW + 20, y, 10, bold);
  y -= 12;
  const bill = wrap(input.customer.billing_address ?? '', font, 9, colW);
  const ship = wrap(input.customer.shipping_address ?? input.customer.billing_address ?? '', font, 9, colW);
  const rows = Math.max(bill.length, ship.length);
  for (let i = 0; i < rows; i++) {
    if (bill[i]) text(bill[i], M, y, 9, font, muted);
    if (ship[i]) text(ship[i], M + colW + 20, y, 9, font, muted);
    y -= 12;
  }
  if (input.customer.gstin) {
    text(`GSTIN: ${input.customer.gstin}`, M, y, 9, font, muted);
    y -= 12;
  }
  if (input.customer.phone) {
    text(`Phone: ${input.customer.phone}`, M, y, 9, font, muted);
    y -= 12;
  }
  void blockTop;
  y -= 10;

  // Line-item table
  const cols = showAmounts
    ? { n: M, item: M + 20, hsn: 250, qty: 335, rate: 395, disc: 450, taxable: W - M }
    : { n: M, item: M + 20, hsn: 360, qty: W - M, rate: 0, disc: 0, taxable: 0 };

  const header = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.93, 0.96, 0.95) });
    text('#', cols.n + 2, y, 8, bold);
    text('Item', cols.item, y, 8, bold);
    text('HSN/SAC', cols.hsn, y, 8, bold);
    if (showAmounts) {
      right('Qty', cols.qty + 30, y, 8, bold);
      right('Rate', cols.rate + 40, y, 8, bold);
      right('Disc.', cols.disc + 35, y, 8, bold);
      right('Taxable', cols.taxable, y, 8, bold);
    } else {
      right('Qty', cols.qty, y, 8, bold);
    }
    y -= 18;
  };
  header();

  input.lines.forEach((l, i) => {
    const nameLines = wrap(l.name, font, 9, showAmounts ? 175 : 290);
    const rowH = nameLines.length * 12 + 4;
    if (y - rowH < 150) {
      page = pdf.addPage([W, H]);
      y = H - M;
      header();
    }
    text(String(i + 1), cols.n + 2, y, 9);
    nameLines.forEach((nl, k) => text(nl, cols.item, y - k * 12, 9));
    text(l.hsn ?? '', cols.hsn, y, 9, font, muted);
    const qty = `${l.quantity} ${l.uom ?? ''}`.trim();
    if (showAmounts) {
      right(qty, cols.qty + 30, y, 9);
      right(money(l.unit_price), cols.rate + 40, y, 9);
      right(money(l.discount_amount), cols.disc + 35, y, 9);
      right(money(l.taxable_value), cols.taxable, y, 9);
    } else {
      right(qty, cols.qty, y, 9);
    }
    y -= rowH;
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.3, color: rgb(0.85, 0.85, 0.88) });
  });

  // Totals
  if (showAmounts) {
    if (y < 190) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
    y -= 6;
    const t = input.totals;
    const trow = (label: string, val: string, strong = false) => {
      text(label, W - M - 200, y, strong ? 11 : 9, strong ? bold : font, strong ? ink : muted);
      right(val, W - M, y, strong ? 11 : 9, strong ? bold : font);
      y -= strong ? 18 : 13;
    };
    trow('Taxable value', money(t.sub_total));
    if (t.interstate) {
      trow('IGST', money(t.igst_total));
    } else {
      trow('CGST', money(t.cgst_total));
      trow('SGST', money(t.sgst_total));
    }
    if (t.round_off !== 0) trow('Round off', money(t.round_off));
    y -= 2;
    page.drawLine({ start: { x: W - M - 200, y: y + 12 }, end: { x: W - M, y: y + 12 }, thickness: 0.6, color: accent });
    trow('Grand Total', `Rs. ${money(t.grand_total)}`, true);
  }

  // Footer: payment terms and bank details
  let fy = 90;
  page.drawLine({ start: { x: M, y: fy + 14 }, end: { x: W - M, y: fy + 14 }, thickness: 0.4, color: muted });
  if (input.type !== 'DELIVERY_CHALLAN') {
    for (const l of wrap(input.paymentTerms, font, 8.5, W - 2 * M)) {
      text(l, M, fy, 8.5, font, muted);
      fy -= 11;
    }
    for (const l of wrap(input.bankDetails, font, 8.5, W - 2 * M)) {
      text(l, M, fy, 8.5, bold);
      fy -= 11;
    }
  } else {
    text('Goods received in good condition. Receiver signature: ______________________', M, fy, 8.5, font, muted);
  }
  text('This is a computer-generated document.', M, 40, 7.5, font, muted);

  return pdf.save();
}
