import { mkdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config,assertNewProject,connect,safeError,projectRef } from './config.mjs';
import { packSnapshot } from './snapshot.mjs';
import { resetReleaseData,clearedTables } from './release-reset.mjs';

let db;
try {
  const args=process.argv.slice(2);
  if (args.length && args.join(' ')!==`--apply --confirm-project ${projectRef}`) throw new Error('Usage: node scripts/prepare-release.mjs [--apply --confirm-project '+projectRef+']');
  const cfg=await config();assertNewProject(cfg.DATABASE_URL);db=await connect(cfg.DATABASE_URL);
  if (!args.length) {
    for (const t of [...clearedTables,'accounts','clients','horses','instructors','settings','admin_members']) {
      const {rows}=await db.query('select count(*)::int as count from horsebook.'+t);
      console.log(t+': '+rows[0].count);
    }
    console.log('Preview only. Apply clears test activity, zeros balances, and preserves references, settings, admin logins and existing audit history.');
  } else {
    await db.query('begin');
    try {
      await db.query("select pg_advisory_xact_lock(hashtextextended('horsebook.business-write',0))");
      const snapshot=(await db.query('select horsebook.snapshot() as snapshot')).rows[0].snapshot;
      const envelope=packSnapshot(snapshot);
      await mkdir(new URL('../private/backups/',import.meta.url),{recursive:true});
      const file=fileURLToPath(new URL('../private/backups/prelaunch-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',import.meta.url));
      await writeFile(file,JSON.stringify(envelope,null,2),{flag:'wx'});
      // Prove recovery in an independent local PostgreSQL instance before clearing.
      const verification=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./verify-snapshot.mjs',import.meta.url)),file],{timeout:120000});
      console.log(verification.stdout.trim());
      const result=await resetReleaseData(db,snapshot,file,envelope.manifest.checksum);
      await db.query('commit');
      console.log(JSON.stringify(result,null,2));
      console.log('V2 test data reset committed. Refresh all open v2 browser tabs before further edits.');
    } catch(error) {await db.query('rollback');throw error;}
  }
} catch(error) {console.error(safeError(error));process.exitCode=1;}
finally {await db?.end();}
