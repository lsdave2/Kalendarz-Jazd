import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isolatedPostgres } from './real-database.mjs';
export const admin='10000000-0000-4000-8000-000000000001';
export const otherAdmin='10000000-0000-4000-8000-000000000002';
export const outsider='10000000-0000-4000-8000-000000000003';
export const migration=(await Promise.all(['001_foundation.sql','002_validation.sql','003_backup_access.sql','004_review_count.sql','005_delete_lesson.sql','006_move_lesson_time.sql','007_review_lesson_kind.sql','008_one_credit_per_lesson.sql','009_calendar_events.sql','010_extend_series.sql','011_client_billing_default.sql','012_narrow_time_review.sql'].map(name=>
  readFile(new URL('../database/'+name,import.meta.url),'utf8')))).join('\n')+'\n'+await readFile(new URL('../database/013_admin_login_aliases.sql',import.meta.url),'utf8')+'\n'+await readFile(new URL('../database/014_client_phone_number.sql',import.meta.url),'utf8')+'\n'+await readFile(new URL('../database/015_instructor_rates.sql',import.meta.url),'utf8')+'\n'+await readFile(new URL('../database/016_inline_lesson_clients.sql',import.meta.url),'utf8')+'\n'+await readFile(new URL('../database/017_custom_lesson_guests.sql',import.meta.url),'utf8');
export const bootstrap=`create role anon; create role authenticated; create schema auth;
create table auth.users (id uuid primary key,email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$; grant usage on schema auth to public; grant execute on function auth.uid() to public;`;
export async function fresh() {
  const db=process.env.HB_REAL_POSTGRES==='true'?await isolatedPostgres(migration):new PGlite();
  if(process.env.HB_REAL_POSTGRES!=='true') {await db.exec(bootstrap);await db.exec(migration);}
  await db.query('insert into horsebook.admin_members values ($1,$2),($3,$4)',[admin,'Admin',otherAdmin,'Second admin']);
  return db;
}
export async function asUser(db,user,role='authenticated') {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user??'']);
  await db.exec(`set role ${role}`);
}
export async function owner(db) { await db.exec('reset role'); }
export async function rpc(db,name,args) {
  if(!/^hb_[a-z_]+$/.test(name)) throw new Error('Invalid RPC');
  const values=Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v);
  const names=Object.keys(args).map((key,i)=>`${key} => $${i+1}`).join(',');
  const {rows}=await db.query(`select public.${name}(${names}) as result`,values);
  return rows[0].result;
}
export async function client(db,name='Client') {
  return rpc(db,'hb_save_reference',{p_operation_id:randomUUID(),p_kind:'clients',p_expected_revision:null,p_record:{id:randomUUID(),name}});
}
export function lesson(cid,overrides={}) {
  return {id:randomUUID(),date:'2020-03-28',start_minute:600,duration_minutes:60,kind:'individual',title:'Lesson',
    status:'scheduled',bookings:[{id:randomUUID(),client_id:cid,billing_mode:'package',units:1}],...overrides};
}
export async function save(db,payload,revision=null,op=randomUUID()) {
  return rpc(db,'hb_save_lesson',{p_operation_id:op,p_expected_revision:revision,p_lesson:payload});
}
export async function review(db,bookings,action='charge',reason='',op=randomUUID()) {
  return rpc(db,'hb_review_credits',{p_operation_id:op,p_decisions:bookings.map(b=>({booking_id:b.id,expected_revision:b.revision,action,reason}))});
}
