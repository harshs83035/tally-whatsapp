import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { postToTally } from './tallyClient.js';
import { buildCollectionRequest } from './tallyXml.js';
import {
  CUSTOMER_FETCH,
  PRODUCT_FETCH,
  mapCustomers,
  mapProducts,
  type TallyCustomer,
  type TallyProduct,
} from './mappers.js';
import { loadState, saveState } from './state.js';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

const CHUNK = 500;

async function upsertChunks<T extends object>(
  table: 'customers' | 'products',
  rows: T[],
  onConflict: string,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })).slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from(table)
      .upsert(slice, { onConflict, ignoreDuplicates: false })
      .select('id');
    if (error) {
      console.error(`Error syncing ${table} to Supabase:`, error.message);
      throw error;
    }
    total += data?.length ?? 0;
  }
  return total;
}

/**
 * Synchronizes mapped Tally customers to Supabase.
 * Upserts on tally_ledger_guid so edits in Tally update the same row.
 */
export async function syncTallyCustomers(customers: TallyCustomer[]): Promise<void> {
  if (customers.length === 0) {
    console.log('No customers to sync.');
    return;
  }
  const n = await upsertChunks('customers', customers, 'tally_ledger_guid');
  console.log(`Successfully synced ${n} customers.`);
}

export async function syncTallyProducts(products: TallyProduct[]): Promise<void> {
  if (products.length === 0) {
    console.log('No products to sync.');
    return;
  }
  const n = await upsertChunks('products', products, 'tally_item_guid');
  console.log(`Successfully synced ${n} products.`);
}

/** One full poll: fetch only records newer than the last seen ALTERID. */
export async function runSync(): Promise<void> {
  const state = loadState();

  // Customers (Sundry Debtors)
  const custEnv = await postToTally(
    buildCollectionRequest({
      company: config.tallyCompany,
      collectionName: 'SyncDebtorLedgers',
      type: 'Ledger',
      childOf: config.debtorsGroup,
      fetch: CUSTOMER_FETCH,
      minAlterId: state.customersAlterId,
    }),
  );
  const customers = mapCustomers(custEnv);
  await syncTallyCustomers(customers.rows);
  state.customersAlterId = Math.max(state.customersAlterId, customers.maxAlterId);

  // Inventory (Stock Items)
  const prodEnv = await postToTally(
    buildCollectionRequest({
      company: config.tallyCompany,
      collectionName: 'SyncStockItems',
      type: 'StockItem',
      fetch: PRODUCT_FETCH,
      minAlterId: state.productsAlterId,
    }),
  );
  const products = mapProducts(prodEnv);
  await syncTallyProducts(products.rows);
  state.productsAlterId = Math.max(state.productsAlterId, products.maxAlterId);

  state.lastSyncAt = new Date().toISOString();
  saveState(state);
}
