import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  tallyUrl: process.env.TALLY_URL ?? 'http://localhost:9000',
  tallyCompany: required('TALLY_COMPANY'),
  debtorsGroup: process.env.TALLY_DEBTORS_GROUP ?? 'Sundry Debtors',
  supabaseUrl: required('SUPABASE_URL'),
  supabaseKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  syncCron: process.env.SYNC_CRON ?? '*/5 * * * *',
  stateFile: process.env.STATE_FILE ?? './sync-state.json',
};
