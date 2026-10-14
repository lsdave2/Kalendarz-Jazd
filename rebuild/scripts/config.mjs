import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import pg from 'pg';
export const projectRef='kdnhvunmtfqfkhcxtlqp';
export async function config() {
  const path=process.env.REBUILD_ENV_FILE ?? new URL('../.env.local',import.meta.url);
  let source='';
  try { source=await readFile(path,'utf8'); } catch(error) {if(error.code!=='ENOENT') throw error;}
  const parsed=parse(source);
  // Accept a connection string pasted alone in the private file, too.
  if(!parsed.DATABASE_URL && /^postgres(?:ql)?:\/\//.test(source.trim())) parsed.DATABASE_URL=source.trim();
  return { ...parsed, ...Object.fromEntries(Object.entries(process.env).filter(([k])=>[
    'DATABASE_URL','RESTORE_DATABASE_URL','ADMIN_EMAIL','ADMIN_DISPLAY_NAME','ADMIN_LOGIN_NAME','EXPECTED_PROJECT_REF'].includes(k))) };
}
export function safeError(error) {
  return String(error.message??error).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[redacted database URL]')
    .replace(/password\s*[=:]\s*[^\s,;]+/gi,'password=[redacted]');
}
export function assertNewProject(connection) {
  if(!connection) throw new Error('Put DATABASE_URL in rebuild/.env.local (or set REBUILD_ENV_FILE).');
  const url=new URL(connection);
  if(!['postgres:','postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL connection string');
  const username=decodeURIComponent(url.username);
  const poolerUser=[`postgres.${projectRef}`,`horsebook_backup.${projectRef}`].includes(username);
  if(url.hostname!==`db.${projectRef}.supabase.co` && !(url.hostname.endsWith('.pooler.supabase.com') && poolerUser)) {
    throw new Error('Database target is not the explicitly configured NEW Supabase project.');
  }
  if(!url.password || /^\[?(?:YOUR.PASSWORD|PASSWORD)\]?$/i.test(decodeURIComponent(url.password))) throw new Error('Database password is missing or still a placeholder');
}
export async function connect(connection,{local=false}={}) {
  const url=new URL(connection);
  for(const p of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(p);
  const ca=local?undefined:await readFile(new URL('../database/supabase-ca.crt',import.meta.url),'utf8');
  const db=new pg.Client({connectionString:url.toString(),ssl:local?false:{rejectUnauthorized:true,ca},connectionTimeoutMillis:20000,
    statement_timeout:60000,application_name:'horsebook-rebuild-tools'});
  await db.connect();
  return db;
}
