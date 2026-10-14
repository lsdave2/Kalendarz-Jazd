// Rehearse recovery locally, with no network or modification of the source file.
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {resolve} from 'node:path';
import {canonical,unpackSnapshot,restoreSnapshot} from './snapshot.mjs';
import {safeError} from './config.mjs';
let db;
try {
  if(!process.argv[2])throw new Error('Usage: npm run backup:verify -- "path/to/snapshot.json"');
  const snapshot=unpackSnapshot(JSON.parse(await readFile(resolve(process.argv[2]),'utf8')));
  db=new PGlite();
  await db.exec("set time zone 'UTC'");
  // Local Auth stub only. Real Supabase authentication is deliberately separate.
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid; $$;`);
  for(const file of (await readdir(new URL('../database/',import.meta.url))).filter(f=>/^\d+_.*\.sql$/.test(f)).sort()) {
    await db.exec(await readFile(new URL('../database/'+file,import.meta.url),'utf8'));
  }
  await db.transaction(tx=>restoreSnapshot(tx,snapshot));
  const restored=(await db.query('select horsebook.snapshot() as snapshot')).rows[0].snapshot;
  const restoredSourceTables=Object.fromEntries(Object.keys(snapshot.data).map(t=>[t,restored.data[t]]));
  if(canonical(restoredSourceTables)!==canonical(snapshot.data)) {
    const table=Object.keys(snapshot.data).find(t=>canonical(restored.data[t])!==canonical(snapshot.data[t]));
    const index=snapshot.data[table].findIndex((row,i)=>canonical(row)!==canonical(restored.data[table][i]));
    const row=snapshot.data[table][index],after=restored.data[table][index];
    const fields=Object.keys(row).filter(k=>canonical(row[k])!==canonical(after?.[k]));
    throw new Error(`Restored records differ from the snapshot: ${table}, row ${index}, fields ${fields.join(', ')}`);
  }
  console.log('Checksum, schema, relationships, balances, and full restored records verified locally.');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(restored.data).map(([t,rows])=>[t,rows.length]))));
}catch(error){console.error(safeError(error));process.exitCode=1;}finally{await db?.close();}
