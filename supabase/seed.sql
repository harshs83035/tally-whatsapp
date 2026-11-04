-- Sample data to test without Tally. Run AFTER 0001_schema.sql.
-- 1) Replace 9999999999 below with YOUR OWN WhatsApp number (10 digits, India) before running.
-- 2) The tally_*_guid values are placeholders; real Tally GUIDs will not clash with them.

INSERT INTO customers (tally_ledger_guid, name, billing_address, shipping_address, gstin, phone, email) VALUES
  ('test-cust-1', 'Demo Customer Lucknow',
   '12 Hazratganj, Lucknow, Uttar Pradesh 226001',
   '12 Hazratganj, Lucknow, Uttar Pradesh 226001',
   '09ABCDE1234F1Z5', '9999999999', 'lucknow@example.com'),
  ('test-cust-2', 'Demo Customer Mumbai',
   '45 Park Street, Andheri, Mumbai, Maharashtra 400053',
   '88 Warehouse Road, Bhiwandi, Maharashtra 421302',
   '27ABCDE1234F1Z5', '9999999999', 'mumbai@example.com')
ON CONFLICT (tally_ledger_guid) DO NOTHING;

INSERT INTO products (tally_item_guid, name, hsn_sac_code, uom, base_price, tax_rate) VALUES
  ('test-item-1', 'Widget A', '8501', 'Nos', 1000.00, 18.00),
  ('test-item-2', 'Steel Rod 12mm', '7214', 'Kgs', 65.50, 18.00),
  ('test-item-3', 'Notebook A4', '4820', 'Nos', 45.00, 12.00)
ON CONFLICT (tally_item_guid) DO NOTHING;
