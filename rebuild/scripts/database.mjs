import { readFile,writeFile,mkdir,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config,assertNewProject,connect,safeError } from './config.mjs';
import { packSnapshot,unpackSnapshot,restoreSnapshot } from './snapshot.mjs';
const command=process.argv[2],cfg=await config();
let db;
try {
  if(command==='restore') {
    if(!cfg.RESTORE_DATABASE_URL) throw new Error('RESTORE_DATABASE_URL must identify a separate empty local/test database.');
    const target=new URL(cfg.RESTORE_DATABASE_URL);
    if(target.hostname.includes('supabase') || cfg.RESTORE_DATABASE_URL===cfg.DATABASE_URL) throw new Error('Restore tool accepts only an isolated local/test target, not a hosted production project.');
    if(!['localhost','127.0.0.1','::1','postgres'].includes(target.hostname)) throw new Error('Restore target must be an isolated localhost/test PostgreSQL database.');
    if(!process.argv[3]) throw new Error('Usage: npm run db:restore -- private/snapshot.json');
    const snapshot=unpackSnapshot(JSON.parse(await readFile(resolve(process.argv[3]),'utf8')));
    db=await connect(cfg.RESTORE_DATABASE_URL,{local:true});
    await db.query('begin');
    try {await restoreSnapshot(db,snapshot);await db.query('commit');} catch(e) {await db.query('rollback');throw e;}
    console.log('Snapshot restored and accounting integrity verified. Auth membership must be configured separately.');
  } else {
    assertNewProject(cfg.DATABASE_URL);
    db=await connect(cfg.DATABASE_URL);
    if(command==='apply') {
      const existing=await db.query("select to_regnamespace('horsebook') as schema,to_regclass('public.lessons') as legacy");
      if(existing.rows[0].legacy) throw new Error('Refusing migration: legacy schema exists.');
      await db.query('begin');
      try {
        let version=existing.rows[0].schema?(await db.query('select max(version) as version from horsebook.schema_version')).rows[0].version:0;
        for(const file of (await readdir(new URL('../database/',import.meta.url))).filter(x=>/^\d+_.*\.sql$/.test(x)).sort()) {
          if(Number(file.split('_')[0])>version) await db.query(await readFile(new URL('../database/'+file,import.meta.url),'utf8'));
        }
        await db.query('commit');
      }
      catch(e) {await db.query('rollback');throw e;}
      await db.query("notify pgrst, 'reload schema'");
      console.log('Clean schema installed on the new project. Legacy database was not modified.');
    } else if(command==='admin') {
      if(!cfg.ADMIN_EMAIL) throw new Error('Create an Auth user in the NEW project, then set ADMIN_EMAIL in the private environment file.');
      const users=await db.query('select id from auth.users where lower(email)=lower($1)',[cfg.ADMIN_EMAIL]);
      if(users.rowCount!==1) throw new Error('Exactly one matching Auth user is required.');
      await db.query('insert into horsebook.admin_members(user_id,display_name) values($1,$2) on conflict(user_id) do update set display_name=excluded.display_name',[users.rows[0].id,cfg.ADMIN_DISPLAY_NAME||cfg.ADMIN_EMAIL]);
      if(cfg.ADMIN_LOGIN_NAME) {
        const alias=cfg.ADMIN_LOGIN_NAME.trim().toLowerCase();
        await db.query('insert into horsebook.admin_login_aliases(login_name,user_id) values($1,$2) on conflict(user_id) do update set login_name=excluded.login_name',[alias,users.rows[0].id]);
      }
      console.log('Explicit admin membership configured for the selected new-project Auth user.');
    } else if(command==='import') {
      const manifest=JSON.parse(await readFile(new URL('../private/reference-import.json',import.meta.url),'utf8'));
      if(manifest.format!=='horsebook.reference-import' || manifest.version!==1 || !['clients','horses','instructors'].every(t=>Array.isArray(manifest.data?.[t]))) throw new Error('Invalid reference import manifest');
      await db.query('begin');
      try {
        await db.query("select pg_advisory_xact_lock(hashtextextended('horsebook.business-write',0))");
        const populated=await db.query('select exists(select 1 from horsebook.clients union all select 1 from horsebook.horses union all select 1 from horsebook.instructors) as populated');
        if(populated.rows[0].populated) throw new Error('Reference import requires empty identity tables; it will not merge or overwrite existing identities.');
        const actor=(await db.query('select user_id from horsebook.admin_members order by user_id limit 1')).rows[0]?.user_id;
        if(!actor) throw new Error('Configure admin membership first.');
        await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
        for(const kind of ['clients','horses','instructors']) for(const record of manifest.data[kind]) {
          await db.query('select public.hb_save_reference($1,$2,null,$3::jsonb)',[randomUUID(),kind,JSON.stringify(record)]);
        }
        const checks=await db.query('select (select count(*)::int from horsebook.lessons) as lessons,(select count(*)::int from horsebook.credit_entries) as credits,(select count(*)::int from horsebook.accounts where balance<>0) as nonzero');
        if(Object.values(checks.rows[0]).some(x=>x!==0)) throw new Error('Import postconditions failed');
        await db.query('commit');
      } catch(e) {await db.query('rollback');throw e;}
      console.log('Imported only reference lists; every account is zero and no lessons or historical transactions were carried over.');
    } else if(command==='backup') {
      const {rows}=await db.query('select horsebook.snapshot() as snapshot');
      const envelope=packSnapshot(rows[0].snapshot);
      await mkdir(new URL('../private/backups/',import.meta.url),{recursive:true});
      const file=new URL(`../private/backups/horsebook-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,import.meta.url);
      await writeFile(file,JSON.stringify(envelope,null,2),{flag:'wx'});
      console.log('Consistent application snapshot saved under rebuild/private/backups; checksum and table counts included.');
    } else throw new Error('Choose apply, admin, import, backup, or restore');
  }
} catch(error) {console.error(safeError(error));process.exitCode=1;}
finally {await db?.end();}
