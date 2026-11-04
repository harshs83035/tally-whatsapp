import { XMLParser } from 'fast-xml-parser';

/** Escape text for safe inclusion in an XML payload. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build a TDL collection export request.
 * SVCURRENTCOMPANY is always set so we never read the wrong company.
 */
export function buildCollectionRequest(opts: {
  company: string;
  collectionName: string;
  type: string;
  fetch: string[];
  childOf?: string;
  minAlterId?: number;
}): string {
  const { company, collectionName, type, fetch, childOf, minAlterId } = opts;
  const filter =
    minAlterId && minAlterId > 0
      ? `<FILTER>NewerThan</FILTER>`
      : '';
  const system =
    minAlterId && minAlterId > 0
      ? `<SYSTEM TYPE="Formulae" NAME="NewerThan">$AlterID &gt; ${Math.floor(minAlterId)}</SYSTEM>`
      : '';
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${esc(collectionName)}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="${esc(collectionName)}" ISMODIFY="No">
            <TYPE>${esc(type)}</TYPE>
            ${childOf ? `<CHILDOF>${esc(childOf)}</CHILDOF><BELONGSTO>Yes</BELONGSTO>` : ''}
            <FETCH>${fetch.map(esc).join(', ')}</FETCH>
            ${filter}
          </COLLECTION>
          ${system}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false, // keep GUIDs/phones/HSN as strings
  trimValues: true,
});

/** Tally emits characters (e.g. &#4;) that are illegal in XML 1.0. Strip them. */
export function sanitizeXml(xml: string): string {
  return xml
    .replace(/&#(?:[0-8]|1[1-2]|1[4-9]|2[0-9]|3[0-1]);/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export class TallyError extends Error {}

/**
 * Parse a Tally response. Tally often replies HTTP 200 even on failure,
 * so we look for error markers inside the body before trusting the data.
 */
export function parseTallyResponse(xml: string): any {
  const clean = sanitizeXml(xml);
  if (!clean.trim()) throw new TallyError('Empty response from Tally');

  // Plain-text style errors, e.g. "Unknown Request, cannot be processed"
  if (/Unknown Request/i.test(clean)) {
    throw new TallyError('Tally: Unknown Request, cannot be processed');
  }
  if (/Could not set 'SVCurrentCompany'/i.test(clean)) {
    throw new TallyError(
      'Tally: company not open or name mismatch (SVCURRENTCOMPANY could not be set)',
    );
  }

  const doc = parser.parse(clean);
  const env = doc?.ENVELOPE ?? doc;

  const lineError = findKey(env, 'LINEERROR');
  if (lineError) throw new TallyError(`Tally LINEERROR: ${textOf(lineError)}`);
  const errorNode = findKey(env, 'ERROR');
  if (errorNode) throw new TallyError(`Tally ERROR: ${textOf(errorNode)}`);

  return env;
}

function findKey(obj: any, key: string): any {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function textOf(node: any): string {
  if (node === undefined || node === null) return '';
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(', ');
  if (typeof node === 'object') return textOf(node['#text']);
  return String(node).trim();
}

/** Collect the entries of a collection response regardless of nesting. */
export function extractCollection(env: any, tag: string): any[] {
  const col = env?.BODY?.DATA?.COLLECTION ?? findKey(env, 'COLLECTION');
  if (!col) return [];
  const items = col[tag];
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

/** Read a child as a list of strings (Tally uses *.LIST wrappers). */
export function listOf(node: any, listTag: string, itemTag: string): string[] {
  const wrapper = node?.[listTag];
  if (!wrapper) return [];
  const lists = Array.isArray(wrapper) ? wrapper : [wrapper];
  const out: string[] = [];
  for (const l of lists) {
    const items = l?.[itemTag];
    if (items === undefined) continue;
    (Array.isArray(items) ? items : [items]).forEach((i) => {
      const t = textOf(i);
      if (t) out.push(t);
    });
  }
  return out;
}
