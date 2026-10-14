// Verify the real persistence path inside a transaction that is always rolled back.
import {randomUUID} from 'node:crypto';
import {config,assertNewProject,connect,safeError} from './config.mjs';
let db;
try {
  const cfg=await config();assertNewProject(cfg.DATABASE_URL);db=await connect(cfg.DATABASE_URL);
  await db.query('begin');
  const {rows:[instructor]}=await db.query('select * from horsebook.instructors order by id limit 1');
  if(!instructor)throw new Error('An existing instructor is required for verification');
  const {rows:[admin]}=await db.query('select user_id from horsebook.admin_members order by user_id limit 1');
  if(!admin)throw new Error('An administrator is required for verification');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[admin.user_id]);
  const rate=Number(instructor.lesson_rate)===75.5?80:75.5;
  const {rows:[saved]}=await db.query('select public.hb_save_reference($1,$2,$3,$4::jsonb) as result',
    [randomUUID(),'instructors',instructor.revision,JSON.stringify({...instructor,lesson_rate:rate})]);
  if(Number(saved.result.lesson_rate)!==rate)throw new Error('Save function did not persist the requested rate');
  const {rows:[refs]}=await db.query('select public.hb_references() as result');
  if(Number(refs.result.instructors.find(i=>i.id===instructor.id)?.lesson_rate)!==rate)throw new Error('Reload did not return the saved rate');
  await db.query('rollback');
  const {rows:[restored]}=await db.query('select lesson_rate,revision from horsebook.instructors where id=$1',[instructor.id]);
  if(Number(restored.lesson_rate)!==Number(instructor.lesson_rate)||restored.revision!==instructor.revision)throw new Error('Rollback verification failed');
  console.log('Live instructor rate save and reference reload verified; test transaction rolled back with no lasting data changes.');
}catch(error){if(db)await db.query('rollback').catch(()=>{});console.error(safeError(error));process.exitCode=1;}
finally{await db?.end();}
