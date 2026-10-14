import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {config,assertNewProject,connect,safeError} from './config.mjs';
let db;
try {
  const cfg=await config();assertNewProject(cfg.DATABASE_URL);db=await connect(cfg.DATABASE_URL);
  const role=(await db.query("select rolcanlogin from pg_roles where rolname='horsebook_backup'")).rows[0];
  if(!role)throw new Error('Apply backup-access migration first.');
  if(role.rolcanlogin)throw new Error('Backup login is already provisioned; reuse its private environment file rather than silently rotating it.');
  const password=randomBytes(32).toString('base64url');
  const connection=new URL(cfg.DATABASE_URL);
  connection.username=connection.hostname.endsWith('.pooler.supabase.com')?'horsebook_backup.kdnhvunmtfqfkhcxtlqp':'horsebook_backup';
  connection.password=password;
  // Grant the restricted role TO the database administrator, never the reverse.
  // This allows management/SET ROLE without giving the backup login admin rights.
  await db.query('grant horsebook_backup to postgres');
  const change=await db.query("select format('alter role horsebook_backup login password %L',$1::text) as sql",[password]);
  await db.query(change.rows[0].sql);
  await writeFile(new URL('../.env.backup.local',import.meta.url),`DATABASE_URL=${connection.toString()}\n`,{flag:'wx',mode:0o600});
  console.log('Dedicated export-only backup login provisioned; credentials saved in an ignored local file.');
}catch(e){console.error(safeError(e));process.exitCode=1;}finally{await db?.end();}
