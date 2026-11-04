// Offline check of XML parsing/mapping using sample Tally-shaped responses.
import assert from 'node:assert/strict';
import { buildCollectionRequest, parseTallyResponse, TallyError } from './tallyXml.js';
import { mapCustomers, mapProducts } from './mappers.js';

const ledgers = `<ENVELOPE><BODY><DATA><COLLECTION>
<LEDGER NAME="Acme Traders" RESERVEDNAME="">
  <GUID>guid-1</GUID><ALTERID>42</ALTERID>
  <ADDRESS.LIST><ADDRESS>12 MG Road</ADDRESS><ADDRESS>Lucknow 226001</ADDRESS></ADDRESS.LIST>
  <LEDGERMOBILE>9876543210</LEDGERMOBILE>
  <EMAIL>acme@example.com</EMAIL>
  <PARTYGSTIN>09ABCDE1234F1Z5</PARTYGSTIN>
</LEDGER>
<LEDGER NAME="Bare Ledger"><GUID>guid-2</GUID><ALTERID>43</ALTERID></LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const items = `<ENVELOPE><BODY><DATA><COLLECTION>
<STOCKITEM NAME="Widget A">
  <GUID>item-1</GUID><ALTERID>7</ALTERID><BASEUNITS>Nos</BASEUNITS>
  <GSTDETAILS.LIST><HSNCODE>8501</HSNCODE>
    <STATEWISEDETAILS.LIST>
      <RATEDETAILS.LIST><GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD><GSTRATE>9</GSTRATE></RATEDETAILS.LIST>
      <RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>18</GSTRATE></RATEDETAILS.LIST>
    </STATEWISEDETAILS.LIST>
  </GSTDETAILS.LIST>
  <STANDARDPRICE.LIST><RATE>125.50/Nos</RATE></STANDARDPRICE.LIST>
</STOCKITEM>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const c = mapCustomers(parseTallyResponse(ledgers));
assert.equal(c.rows.length, 2);
assert.equal(c.rows[0].name, 'Acme Traders');
assert.equal(c.rows[0].billing_address, '12 MG Road, Lucknow 226001');
assert.equal(c.rows[0].phone, '9876543210');
assert.equal(c.rows[0].gstin, '09ABCDE1234F1Z5');
assert.equal(c.maxAlterId, 43);

const p = mapProducts(parseTallyResponse(items));
assert.equal(p.rows.length, 1);
assert.equal(p.rows[0].hsn_sac_code, '8501');
assert.equal(p.rows[0].uom, 'Nos');
assert.equal(p.rows[0].base_price, 125.5);
assert.equal(p.rows[0].tax_rate, 18);

// HTTP-200-with-error bodies must throw
assert.throws(
  () => parseTallyResponse('<RESPONSE>Unknown Request, cannot be processed</RESPONSE>'),
  TallyError,
);
assert.throws(
  () => parseTallyResponse('<ENVELOPE><BODY><DATA><LINEERROR>Company not loaded</LINEERROR></DATA></BODY></ENVELOPE>'),
  TallyError,
);

// Request carries the company and delta filter
const req = buildCollectionRequest({
  company: 'Dummy & Co',
  collectionName: 'X',
  type: 'Ledger',
  fetch: ['NAME'],
  childOf: 'Sundry Debtors',
  minAlterId: 10,
});
assert.ok(req.includes('<SVCURRENTCOMPANY>Dummy &amp; Co</SVCURRENTCOMPANY>'));
assert.ok(req.includes('$AlterID &gt; 10'));

console.log('agent selftest: all checks passed');
