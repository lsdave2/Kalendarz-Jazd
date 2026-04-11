import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Helper to load a specific env file
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

async function sync() {
  console.log('🔄 Database Sync Tool');
  console.log('----------------------');

  if (!srcUrl || !targetUrl) {
    console.error('❌ Error: Missing configuration.');
    console.log('\nMake sure you have:');
    console.log('1. .env       <- contains PRODUCTION keys');
    console.log('2. .env.local <- contains TEST/LOCAL keys');
    console.log('\nBoth files need VITE_SUPABASE_URL and preferably SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  if (srcUrl === targetUrl) {
    console.error('❌ Error: Source and Target URLs are the same!');
    console.log('You are trying to sync a database to itself. Aborting to prevent data loss.');
    process.exit(1);
  }

  console.log(`📡 Source: ${srcUrl} (Key length: ${srcKey?.length || 0})`);
  console.log(`🎯 Target: ${targetUrl} (Key length: ${targetKey?.length || 0})`);
  console.log('\nFetching data from Source...');

  const sourceSupabase = createClient(srcUrl, srcKey);
  const targetSupabase = createClient(targetUrl, targetKey);

  // Use a simple prompt-like check (since we can't do interactive, we'll just log)
  console.log('⚠️  WARNING: This will OVERWRITE the "app_state" (id: 1) in your Target database.');
  
  const { data, error: fetchError } = await sourceSupabase
    .from('app_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (fetchError) {
    console.error('❌ Error fetching from source:', fetchError.message);
    if (fetchError.message.includes('JWT')) {
      console.log('💡 Tip: Make sure your SERVICE_ROLE_KEY is correct in .env');
    }
    return;
  }

  if (!data) {
    console.error('❌ No data found in source database (app_state table, id: 1)');
    return;
  }

  console.log('✅ Data fetched. Now pushing to target...');

  const { error: pushError } = await targetSupabase
    .from('app_state')
    .upsert(data);

  if (pushError) {
    console.error('❌ Error pushing to target:', pushError.message);
    if (pushError.message.includes('JWT')) {
      console.log('💡 Tip: Make sure your SERVICE_ROLE_KEY is correct in .env.local');
    }
    return;
  }

  console.log('\n✨ Success! Your test database is now synced with production data.');
}

sync();
