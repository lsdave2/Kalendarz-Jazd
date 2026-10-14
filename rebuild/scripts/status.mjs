import {config,assertNewProject,connect,safeError} from './config.mjs';
let db;
try {
  const cfg=await config();assertNewProject(cfg.DATABASE_URL);db=await connect(cfg.DATABASE_URL);
  const {rows}=await db.query(`select
    (select max(version) from horsebook.schema_version) as schema_version,
    to_regprocedure('public.hb_move_lesson_time(uuid,uuid,integer,integer)') is not null as lesson_time_move_available,
    (select count(*)::int from horsebook.clients) as clients,
    (select count(*)::int from horsebook.horses) as horses,
    (select count(*)::int from horsebook.instructors) as instructors,
    (select count(*)::int from horsebook.lessons) as lessons,
    (select count(*)::int from horsebook.events) as events,
    (select count(*)::int from horsebook.accounts where balance<>0) as nonzero_balances,
    (select count(*)::int from horsebook.credit_entries) as credit_entries,
    (select count(*)::int from horsebook.admin_members) as admins,
    (select count(*)::int from auth.users u join horsebook.admin_members m on m.user_id=u.id where u.email_confirmed_at is not null) as confirmed_admin_logins,
    horsebook.integrity() as integrity_problems`);
  console.log(JSON.stringify(rows[0],null,2));
  const response=await fetch(cfg.VITE_SUPABASE_URL+'/rest/v1/rpc/hb_health',{
    method:'POST',headers:{apikey:cfg.VITE_SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:'{}'});
  if(!response.ok)throw new Error('Public health RPC unavailable: HTTP '+response.status);
  const health=await response.json();if(health.admin)throw new Error('Anonymous health unexpectedly reports admin access');
  console.log('Anonymous HTTP health RPC verified.');
  const move=await fetch(cfg.VITE_SUPABASE_URL+'/rest/v1/rpc/hb_move_lesson_time',{
    method:'POST',headers:{apikey:cfg.VITE_SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({p_operation_id:'00000000-0000-4000-8000-000000000000',p_lesson_id:'00000000-0000-4000-8000-000000000000',p_expected_revision:0,p_start_minute:0})});
  const denial=await move.json();
  if(move.ok||denial.code!=='42501')throw new Error('Lesson time-move RPC unavailable or anonymous write permissions incorrect');
  console.log('HTTP lesson time-move RPC verified; anonymous writes denied.');
  for(const [name,args] of [
    ['hb_save_event',{p_operation_id:'00000000-0000-4000-8000-000000000000',p_expected_revision:null,p_event:{}}],
    ['hb_move_event_time',{p_operation_id:'00000000-0000-4000-8000-000000000000',p_event_id:'00000000-0000-4000-8000-000000000000',p_expected_revision:0,p_start_minute:0}],
    ['hb_delete_event',{p_operation_id:'00000000-0000-4000-8000-000000000000',p_event_id:'00000000-0000-4000-8000-000000000000',p_expected_revision:0}]
  ]){
    const response=await fetch(cfg.VITE_SUPABASE_URL+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:cfg.VITE_SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify(args)});
    const error=await response.json();if(response.ok||error.code!=='42501')throw new Error(name+' unavailable or anonymous write permissions incorrect');
  }
  console.log('HTTP event RPCs verified; anonymous writes denied.');
}catch(error){console.error(safeError(error));process.exitCode=1;}finally{await db?.end();}
