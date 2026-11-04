import { extractCollection, listOf, textOf } from './tallyXml.js';

export interface TallyCustomer {
  tally_ledger_guid: string;
  name: string;
  billing_address?: string;
  shipping_address?: string;
  gstin?: string;
  phone?: string;
  email?: string;
}

export interface TallyProduct {
  tally_item_guid: string;
  name: string;
  hsn_sac_code?: string;
  uom?: string;
  base_price: number;
  tax_rate: number;
}

export const CUSTOMER_FETCH = [
  'GUID',
  'ALTERID',
  'NAME',
  'ADDRESS.LIST',
  'LEDGERPHONE',
  'LEDGERMOBILE',
  'EMAIL',
  'PARTYGSTIN',
  'LEDGSTREGDETAILS.LIST',
];

export const PRODUCT_FETCH = [
  'GUID',
  'ALTERID',
  'NAME',
  'BASEUNITS',
  'GSTDETAILS.LIST',
  'STANDARDPRICE.LIST',
];

const nameOf = (node: any): string =>
  textOf(node?.['@_NAME']) || textOf(node?.['NAME']) || textOf(node?.['LANGUAGENAME.LIST']?.['NAME.LIST']?.NAME);

export function alterIdOf(node: any): number {
  const n = Number(textOf(node?.ALTERID));
  return Number.isFinite(n) ? n : 0;
}

export function mapCustomers(env: any): { rows: TallyCustomer[]; maxAlterId: number } {
  const nodes = extractCollection(env, 'LEDGER');
  const rows: TallyCustomer[] = [];
  let maxAlterId = 0;

  for (const n of nodes) {
    const guid = textOf(n.GUID);
    const name = nameOf(n);
    if (!guid || !name) continue;

    const address = listOf(n, 'ADDRESS.LIST', 'ADDRESS').join(', ');
    const phone = textOf(n.LEDGERMOBILE) || textOf(n.LEDGERPHONE);
    const gstin =
      textOf(n.PARTYGSTIN) ||
      listOf(n, 'LEDGSTREGDETAILS.LIST', 'GSTIN')[0] ||
      '';

    rows.push({
      tally_ledger_guid: guid,
      name,
      billing_address: address || undefined,
      // Tally's ledger master keeps one mailing address; reuse it for shipping.
      shipping_address: address || undefined,
      gstin: gstin ? gstin.toUpperCase().slice(0, 15) : undefined,
      phone: phone ? phone.slice(0, 20) : undefined,
      email: textOf(n.EMAIL) || undefined,
    });
    maxAlterId = Math.max(maxAlterId, alterIdOf(n));
  }
  return { rows, maxAlterId };
}

/** "125.00/Nos" -> 125 */
function parseRate(s: string): number {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

export function mapProducts(env: any): { rows: TallyProduct[]; maxAlterId: number } {
  const nodes = extractCollection(env, 'STOCKITEM');
  const rows: TallyProduct[] = [];
  let maxAlterId = 0;

  for (const n of nodes) {
    const guid = textOf(n.GUID);
    const name = nameOf(n);
    if (!guid || !name) continue;

    const hsn = listOf(n, 'GSTDETAILS.LIST', 'HSNCODE')[0];
    const rate = listOf(n, 'STANDARDPRICE.LIST', 'RATE')[0];

    // Total GST rate: Tally lists CGST/SGST/IGST heads; IGST carries the full rate.
    let taxRate = 0;
    const gstDetails = n['GSTDETAILS.LIST'];
    const gstList = Array.isArray(gstDetails) ? gstDetails : gstDetails ? [gstDetails] : [];
    for (const g of gstList) {
      const state = g?.['STATEWISEDETAILS.LIST'];
      const stateList = Array.isArray(state) ? state : state ? [state] : [];
      for (const s of stateList) {
        const rd = s?.['RATEDETAILS.LIST'];
        const rdList = Array.isArray(rd) ? rd : rd ? [rd] : [];
        for (const r of rdList) {
          if (textOf(r.GSTRATEDUTYHEAD).toUpperCase() === 'IGST') {
            taxRate = Math.max(taxRate, Number(textOf(r.GSTRATE)) || 0);
          }
        }
      }
    }

    rows.push({
      tally_item_guid: guid,
      name,
      hsn_sac_code: hsn || undefined,
      uom: textOf(n.BASEUNITS) || undefined,
      base_price: rate ? parseRate(rate) : 0,
      tax_rate: taxRate,
    });
    maxAlterId = Math.max(maxAlterId, alterIdOf(n));
  }
  return { rows, maxAlterId };
}
