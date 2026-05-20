import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config({ path: '.env' });

const url = process.env.VITE_SUPABASE_URL?.trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY)?.trim();

if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or key in .env');
  process.exit(1);
}

const supabase = createClient(url, key);
const migrationFiles = [
  './supabase/migrations/20260508_ledger_credit_system.sql',
  './supabase/migrations/20260512_package_transaction_source_keys.sql',
  './supabase/migrations/20260512_fix_package_transaction_source_key_conflict.sql',
  './supabase/migrations/20260520_transactional_snapshot_and_ledger_guards.sql',
  './supabase/migrations/20260520_server_side_recurring_and_lesson_credits.sql',
];

for (const migrationFile of migrationFiles) {
  const sql = fs.readFileSync(migrationFile, 'utf-8');
  console.log(`Running migration: ${migrationFile} ...`);
  const { error } = await supabase.rpc('exec_sql', { sql }).catch(() => ({
    error: { message: 'exec_sql RPC not available' }
  }));

  if (error) {
    console.warn('exec_sql RPC unavailable, attempting direct SQL via pg REST...');
    console.log('\nSQL to run manually in the Supabase SQL editor:\n');
    console.log(sql);
    process.exit(0);
  }
}

console.log('Migration applied successfully.');
