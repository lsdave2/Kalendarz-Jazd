import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

const TABLES = [
  { name: 'horses', key: 'id' },
  { name: 'instructors', key: 'id' },
  { name: 'groups', key: 'id' },
  { name: 'packages', key: 'id' },
  { name: 'lessons', key: 'id' },
  { name: 'settings', key: 'key' },
];

const LEGACY_TABLE = { name: 'app_state', key: 'id' };
const BATCH_SIZE = 1000;

function loadEnv(filePath) {
  if (fs.existsSync(filePath)) {
    return dotenv.parse(fs.readFileSync(filePath));
  }
  return {};
}

const prodEnv = loadEnv('.env');
const localEnv = loadEnv('.env.local');

const srcUrl = prodEnv.VITE_SUPABASE_URL?.trim();
const srcKey = (prodEnv.SUPABASE_SERVICE_ROLE_KEY || prodEnv.VITE_SUPABASE_ANON_KEY)?.trim();

const targetUrl = localEnv.VITE_SUPABASE_URL?.trim();
const targetKey = (localEnv.SUPABASE_SERVICE_ROLE_KEY || localEnv.VITE_SUPABASE_ANON_KEY)?.trim();

function createSupabase(url, key, label) {
  if (!url || !key) {
    throw new Error(`Missing ${label} Supabase URL or key.`);
  }
  return createClient(url, key);
}

async function fetchAllRows(client, tableName) {
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + BATCH_SIZE - 1;
    const { data, error } = await client
      .from(tableName)
      .select('*')
      .range(from, to);

    if (error) throw error;

    const batch = data || [];
    rows.push(...batch);

    if (batch.length < BATCH_SIZE) {
      break;
    }

    from += BATCH_SIZE;
  }

  return rows;
}

async function clearTable(client, { name, key }) {
  const { error } = await client.from(name).delete().not(key, 'is', null);
  if (error) throw error;
}

async function upsertRows(client, { name, key }, rows) {
  if (!rows.length) return;
  const { error } = await client.from(name).upsert(rows, { onConflict: key });
  if (error) throw error;
}

async function fetchNormalizedSnapshot(client) {
  const snapshot = {};
  let totalRows = 0;

  for (const table of TABLES) {
    const rows = await fetchAllRows(client, table.name);
    snapshot[table.name] = rows;
    totalRows += rows.length;
  }

  return { snapshot, totalRows };
}

async function fetchLegacyState(client) {
  const { data, error } = await client
    .from(LEGACY_TABLE.name)
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function syncNormalizedTables(sourceSupabase, targetSupabase) {
  const { snapshot, totalRows } = await fetchNormalizedSnapshot(sourceSupabase);

  if (totalRows === 0) {
    return false;
  }

  console.log('\nCopying normalized tables from Source to Target...');
  for (const table of [...TABLES].reverse()) {
    console.log(`- Clearing target table: ${table.name}`);
    await clearTable(targetSupabase, table);
  }

  for (const table of TABLES) {
    const rows = snapshot[table.name] || [];
    console.log(`- Writing ${rows.length} row(s) to ${table.name}`);
    await upsertRows(targetSupabase, table, rows);
  }

  return true;
}

async function syncLegacyState(sourceSupabase, targetSupabase) {
  const legacyState = await fetchLegacyState(sourceSupabase);
  if (!legacyState) {
    return false;
  }

  console.log('\nNo normalized rows found in Source. Falling back to legacy app_state sync...');
  const { error } = await targetSupabase.from(LEGACY_TABLE.name).upsert(legacyState, { onConflict: LEGACY_TABLE.key });
  if (error) throw error;
  return true;
}

async function sync() {
  console.log('Database Sync Tool');
  console.log('------------------');

  if (!srcUrl || !targetUrl) {
    console.error('Error: Missing configuration.');
    console.log('\nMake sure you have:');
    console.log('1. .env       <- contains PRODUCTION keys');
    console.log('2. .env.local <- contains TEST/LOCAL keys');
    console.log('\nBoth files need VITE_SUPABASE_URL and preferably SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  if (srcUrl === targetUrl) {
    console.error('Error: Source and Target URLs are the same.');
    console.log('You are trying to sync a database to itself. Aborting to prevent data loss.');
    process.exit(1);
  }

  console.log(`Source: ${srcUrl} (Key length: ${srcKey?.length || 0})`);
  console.log(`Target: ${targetUrl} (Key length: ${targetKey?.length || 0})`);
  console.log('\nWarning: This will overwrite the normalized Target database tables.');

  const sourceSupabase = createSupabase(srcUrl, srcKey, 'source');
  const targetSupabase = createSupabase(targetUrl, targetKey, 'target');

  try {
    const normalizedSynced = await syncNormalizedTables(sourceSupabase, targetSupabase);

    if (!normalizedSynced) {
      const legacySynced = await syncLegacyState(sourceSupabase, targetSupabase);
      if (!legacySynced) {
        console.error('No normalized table data or legacy app_state row found in the source database.');
        process.exit(1);
      }
      console.log('\nSuccess. Your test database now contains the legacy source state.');
      return;
    }

    console.log('\nSuccess. Your test database is now synced from production using the normalized schema.');
  } catch (error) {
    console.error('\nSync failed:', error.message || error);
    if (String(error.message || '').includes('JWT')) {
      console.log('Tip: Make sure your SUPABASE_SERVICE_ROLE_KEY values are correct in .env and .env.local.');
    }
    process.exit(1);
  }
}

sync();
