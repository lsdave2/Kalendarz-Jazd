import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fresh,asUser,owner,rpc,client,lesson,save,review,admin,otherAdmin,outsider } from './harness.mjs';
import { packSnapshot,unpackSnapshot,restoreSnapshot } from '../scripts/snapshot.mjs';
import {PGlite} from '@electric-sql/pglite';
import {bootstrap,migration} from './harness.mjs';
let db;
before(async()=> {db=await fresh();await asUser(db,admin);});
after(async()=> {await db?.close();});

test('auth membership, private tables, internal helpers, and snapshot export are protected',async()=>{
  await asUser(db,outsider);
  await assert.rejects(client(db),/Admin access required/);
  await assert.rejects(rpc(db,'hb_references',{}),/Admin access required/);
  await assert.rejects(rpc(db,'hb_review_count',{p_through:'2020-03-31'}),/Admin access required/);
  await assert.rejects(rpc(db,'hb_delete_lesson',{p_operation_id:randomUUID(),p_lesson_id:randomUUID(),p_expected_revision:1}),/Admin access required/);
  await assert.rejects(rpc(db,'hb_move_lesson_time',{p_operation_id:randomUUID(),p_lesson_id:randomUUID(),p_expected_revision:1,p_start_minute:615}),/Admin access required/);
  await assert.rejects(db.query('select * from horsebook.clients'),/permission denied/);
  await assert.rejects(db.query('select horsebook.snapshot()'),/permission denied/);
  await assert.rejects(rpc(db,'hb_export_snapshot',{}),/Admin access required/);
  await asUser(db,null,'anon');
  assert.equal((await rpc(db,'hb_health',{})).admin,false);
  await assert.rejects(client(db),/permission denied/);
  await assert.rejects(rpc(db,'hb_review_count',{p_through:'2020-03-31'}),/permission denied/);
  await assert.rejects(rpc(db,'hb_delete_lesson',{p_operation_id:randomUUID(),p_lesson_id:randomUUID(),p_expected_revision:1}),/permission denied/);
  await assert.rejects(rpc(db,'hb_move_lesson_time',{p_operation_id:randomUUID(),p_lesson_id:randomUUID(),p_expected_revision:1,p_start_minute:615}),/permission denied/);
  await rpc(db,'hb_calendar',{p_from:'2020-03-01',p_to:'2020-03-31'});
  await asUser(db,admin);
});

test('unattended backup role can export but cannot read tables or perform app writes',async()=>{
  await asUser(db,null,'horsebook_backup');
  const snapshot=await rpc(db,'hb_backup_snapshot',{});
  assert.equal(snapshot.format,'horsebook.snapshot');assert.equal(snapshot.schema_version,17);
  await assert.rejects(client(db),/permission denied/);
  await assert.rejects(db.query('select * from horsebook.clients'),/permission denied/);
  await assert.rejects(db.query('delete from horsebook.accounts'),/permission denied/);
  await asUser(db,null,'anon');
  await assert.rejects(rpc(db,'hb_backup_snapshot',{}),/permission denied/);
  await asUser(db,admin);
  await assert.rejects(rpc(db,'hb_backup_snapshot',{}),/permission denied/);
});

test('shared settings and finance edits enforce revisions and retries without touching credits',async()=>{
  const rates={instructor_individual:40,instructor_group:50,package_individual:100,package_group:80};
  const args={p_operation_id:randomUUID(),p_key:'report_rates',p_expected_revision:null,p_value:rates};
  const first=await rpc(db,'hb_save_setting',args);
  assert.deepEqual(await rpc(db,'hb_save_setting',args),first);
  await assert.rejects(rpc(db,'hb_save_setting',{...args,p_operation_id:randomUUID()}),/Setting changed/);
  await assert.rejects(rpc(db,'hb_save_setting',{...args,p_operation_id:randomUUID(),p_expected_revision:first.revision,p_value:{...rates,instructor_group:-1}}),/nonnegative/);
  const record={id:randomUUID(),kind:'expense',title:'Equipment',amount:75,date:'2020-03-28'};
  const create={p_operation_id:randomUUID(),p_expected_revision:null,p_record:record};
  const saved=await rpc(db,'hb_save_finance',create);
  assert.deepEqual(await rpc(db,'hb_save_finance',create),saved);
  const edit={p_operation_id:randomUUID(),p_expected_revision:saved.revision,p_record:{...record,amount:90}};
  await rpc(db,'hb_save_finance',edit);
  await assert.rejects(rpc(db,'hb_save_finance',{...edit,p_operation_id:randomUUID()}),/Finance record changed/);
  assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
});

test('creating, editing, opening, and cancelling old lessons never change a balance',async()=>{
  const c=await client(db), draft=lesson(c.id), l=await save(db,draft);
  await rpc(db,'hb_calendar',{p_from:'2020-03-01',p_to:'2020-03-31'});
  await save(db,{...draft,title:'Changed'},l.revision);
  await rpc(db,'hb_cancel_lesson',{p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:2,p_cancelled:true});
  const refs=await rpc(db,'hb_references',{});
  assert.equal(refs.clients.find(x=>x.id===c.id).account.balance,0);
  assert.equal((await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id})).length,0);
});

test('client billing defaults reflect past deductions rather than balances or pending lessons',async()=>{
  const c=await client(db,'Billing default'),manual=await client(db,'Manual deduction default');
  const hasDeduction=async id=>(await rpc(db,'hb_references',{})).clients.find(x=>x.id===id).has_credit_deduction;
  assert.equal(await hasDeduction(c.id),false);
  await rpc(db,'hb_adjust_credits',{p_operation_id:randomUUID(),p_client_id:c.id,p_expected_revision:0,p_delta:5,p_reason:'Purchase'});
  assert.equal(await hasDeduction(c.id),false);
  const draft=lesson(c.id),saved=await save(db,draft);
  assert.equal(await hasDeduction(c.id),false);
  await review(db,saved.bookings,'waive');
  assert.equal(await hasDeduction(c.id),false);
  const charged=await save(db,lesson(c.id));
  await review(db,charged.bookings);
  assert.equal(await hasDeduction(c.id),true);
  const edited=await save(db,{...charged,status:'cancelled'},charged.revision);
  await review(db,edited.bookings,'waive','Refund cancelled lesson');
  assert.equal(await hasDeduction(c.id),true);
  assert.equal((await rpc(db,'hb_references',{})).clients.find(x=>x.id===c.id).account.balance,5);
  await rpc(db,'hb_adjust_credits',{p_operation_id:randomUUID(),p_client_id:manual.id,p_expected_revision:0,p_delta:-1,p_reason:'Manual deduction'});
  assert.equal(await hasDeduction(manual.id),true);
});

test('unreviewed deletion is atomic, revision checked, retry safe, and retains full immutable audit rows',async()=>{
  const a=await client(db,'Delete A'),b=await client(db,'Delete B'),c=await client(db,'Delete removed');
  await rpc(db,'hb_adjust_credits',{p_operation_id:randomUUID(),p_client_id:a.id,p_expected_revision:0,p_delta:5,p_reason:'Purchase'});
  const draft=lesson(a.id,{kind:'group',title:'Erroneous lesson'});
  draft.bookings.push({id:randomUUID(),client_id:b.id,billing_mode:'package',units:1},
    {id:randomUUID(),client_id:c.id,billing_mode:'cash',cash_amount:140});
  const first=await save(db,draft),edited=await save(db,{...draft,bookings:draft.bookings.slice(0,2)},first.revision);
  const before=await rpc(db,'hb_export_snapshot',{});
  const args={p_operation_id:randomUUID(),p_lesson_id:edited.id,p_expected_revision:edited.revision};
  await assert.rejects(rpc(db,'hb_delete_lesson',{...args,p_expected_revision:first.revision}),/Lesson changed/);
  assert.deepEqual((await rpc(db,'hb_export_snapshot',{})).data,before.data);
  const count=await rpc(db,'hb_review_count',{p_through:'2020-03-31'});
  const result=await rpc(db,'hb_delete_lesson',args);
  assert.deepEqual(result,{id:edited.id,deleted:true});
  assert.deepEqual(await rpc(db,'hb_delete_lesson',args),result);
  await assert.rejects(rpc(db,'hb_delete_lesson',{...args,p_operation_id:randomUUID()}),/no longer exists/);
  await assert.rejects(save(db,draft,edited.revision),/no longer exists/);
  assert.equal(await rpc(db,'hb_review_count',{p_through:'2020-03-31'}),count-2);
  for(const role of ['authenticated','anon']){
    await asUser(db,role==='anon'?null:admin,role);
    const calendar=await rpc(db,'hb_calendar',{p_from:'2020-03-01',p_to:'2020-03-31'});
    assert.ok(!calendar.lessons.some(l=>l.id===edited.id));
  }
  await asUser(db,admin);
  assert.ok(!(await rpc(db,'hb_review_queue',{p_through:'2020-03-31'})).some(x=>x.lesson_id===edited.id));
  const after=await rpc(db,'hb_export_snapshot',{});
  assert.ok(!after.data.bookings.some(x=>x.lesson_id===edited.id));
  assert.deepEqual(after.data.accounts,before.data.accounts);assert.deepEqual(after.data.credit_entries,before.data.credit_entries);
  const audit=after.data.audit_events.filter(x=>x.operation_id===args.p_operation_id);
  assert.equal(audit.length,4);
  const lessonAudit=audit.find(x=>x.table_name==='lessons');
  assert.equal(lessonAudit.before_row.title,draft.title);assert.equal(lessonAudit.before_row.revision,edited.revision);
  assert.equal(lessonAudit.actor_id,admin);assert.equal(lessonAudit.actor_name,'Admin');
  assert.ok(audit.every(x=>x.after_row===null));
  assert.deepEqual(audit.filter(x=>x.table_name==='bookings').map(x=>x.before_row).sort((a,b)=>a.id.localeCompare(b.id)),
    [...edited.bookings].sort((a,b)=>a.id.localeCompare(b.id)));
  const operation=after.data.operations.find(x=>x.id===args.p_operation_id);
  assert.equal(operation.name,'delete_lesson');assert.deepEqual(operation.result,result);
  await owner(db);
  await assert.rejects(db.query('delete from horsebook.audit_events where operation_id=$1',[args.p_operation_id]),/cannot be edited/);
  await asUser(db,admin);assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
});

test('charged, waived, corrective and removed-participant decisions prevent whole-lesson deletion',async()=>{
  const a=await client(db,'Protected A'),b=await client(db,'Protected B');
  for(const action of ['charge','waive']){
    const draft=lesson(a.id,{kind:'group'});draft.bookings.push({id:randomUUID(),client_id:b.id,billing_mode:'package',units:1});
    const l=await save(db,draft),book=l.bookings.find(x=>x.client_id===a.id);
    await review(db,[book],action);
    const args={p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:l.revision};
    const before=await rpc(db,'hb_export_snapshot',{});
    await assert.rejects(rpc(db,'hb_delete_lesson',args),/Reviewed lessons cannot be deleted/);
    assert.deepEqual((await rpc(db,'hb_export_snapshot',{})).data,before.data);
    const changed=await save(db,{...draft,bookings:[draft.bookings[1]]},l.revision);
    assert.equal(changed.bookings.find(x=>x.id===book.id).review_status,'needs_review');
    await assert.rejects(rpc(db,'hb_delete_lesson',{...args,p_expected_revision:changed.revision}),/Reviewed lessons cannot be deleted/);
  }
  assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
});

test('negative balances, idempotent approval, double approval rejection, and payload identity',async()=>{
  const c=await client(db), l=await save(db,lesson(c.id)), op=randomUUID();
  const result=await review(db,l.bookings,'charge','',op);
  assert.equal(result[0].account.balance,-1);
  assert.deepEqual(await review(db,l.bookings,'charge','',op),result);
  await assert.rejects(review(db,l.bookings,'waive','',op),/different request/);
  await assert.rejects(review(db,l.bookings),/Review changed/);
  assert.equal((await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id})).length,1);
});

test('lessons enforce one credit per participant and reject higher-unit saves atomically',async()=>{
  const c=await client(db),draft=lesson(c.id),before=await rpc(db,'hb_export_snapshot',{});
  await assert.rejects(save(db,{...draft,bookings:[{...draft.bookings[0],units:2}]}),/bookings_one_credit/);
  assert.deepEqual((await rpc(db,'hb_export_snapshot',{})).data,before.data);
  const saved=await save(db,draft);
  assert.equal((await review(db,saved.bookings))[0].delta,-1);
  await assert.rejects(save(db,{...draft,bookings:[{...draft.bookings[0],units:3}]},saved.revision),/bookings_one_credit/);
  assert.equal((await rpc(db,'hb_references',{})).clients.find(x=>x.id===c.id).account.balance,-1);
});

test('waived bookings are recorded without inserting a zero-value credit entry',async()=>{
  const c=await client(db),l=await save(db,lesson(c.id));
  const decision=await review(db,l.bookings,'waive','No show, waived');
  assert.equal(decision[0].delta,0);
  assert.equal((await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id})).length,0);
  assert.equal((await rpc(db,'hb_history',{p_kind:'decisions',p_client_id:c.id}))[0].reason,'No show, waived');
});

test('a failed batch rolls back its earlier charges, decisions, audit events, and request ID',async()=>{
  const c=await client(db),l=await save(db,lesson(c.id)),op=randomUUID();
  await assert.rejects(review(db,[l.bookings[0],{id:'ffffffff-ffff-4fff-8fff-ffffffffffff',revision:1}],'charge','',op),/Review changed/);
  assert.equal((await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id})).length,0);
  assert.equal((await rpc(db,'hb_history',{p_kind:'decisions',p_client_id:c.id})).length,0);
  await owner(db);
  assert.equal((await db.query('select count(*)::int as n from horsebook.operations where id=$1',[op])).rows[0].n,0);
  await asUser(db,admin);
});

test('cancellation creates a corrective review; only an explicit waiver refunds; reinstatement can be charged once',async()=>{
  const c=await client(db),draft=lesson(c.id),l=await save(db,draft);
  await review(db,l.bookings);
  await rpc(db,'hb_cancel_lesson',{p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:1,p_cancelled:true});
  const queue=await rpc(db,'hb_review_queue',{p_through:'2020-03-31'});
  const booking=queue.find(x=>x.lesson_id===l.id);
  assert.equal(booking.balance,-1);assert.equal(booking.review_status,'needs_review');
  await assert.rejects(review(db,[booking],'waive'),/Explain the corrective/);
  assert.equal((await review(db,[booking],'waive','Refund cancelled lesson'))[0].account.balance,0);
  await rpc(db,'hb_cancel_lesson',{p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:2,p_cancelled:false});
  const changed=(await rpc(db,'hb_review_queue',{p_through:'2020-03-31'})).find(x=>x.lesson_id===l.id);
  assert.equal((await review(db,[changed],'charge','Reinstated lesson'))[0].account.balance,-1);
  const entries=await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id});
  assert.equal(entries.length,3);assert.equal(entries.reduce((s,x)=>s+x.delta,0),-1);
});

test('historical time and duration corrections preserve credit decisions; moving into the future needs review',async()=>{
  const c=await client(db),draft=lesson(c.id),l=await save(db,draft);
  await review(db,l.bookings);
  const cosmetic=await save(db,{...draft,title:'Cosmetic title'},1);
  assert.equal(cosmetic.bookings[0].review_status,'charged');
  const moved=await save(db,{...draft,date:'2020-03-29'},2);
  assert.equal(moved.bookings[0].review_status,'charged');
  const corrected=await save(db,{...draft,date:'2020-03-29',start_minute:615,duration_minutes:90},moved.revision);
  assert.equal(corrected.bookings[0].review_status,'charged');
  const future=await save(db,{...draft,date:'2099-03-29'},corrected.revision);
  assert.equal(future.bookings[0].review_status,'needs_review');
  await assert.rejects(review(db,future.bookings,'charge'),/Explain the corrective decision/);
  assert.equal((await review(db,future.bookings,'charge','Moved same booking'))[0].delta,0);
  assert.equal((await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id})).length,1);
});

test('focused time moves preserve active and removed participant facts, immutable decisions, balances and audit',async()=>{
  const a=await client(db,'Drag A'),b=await client(db,'Drag B'),c=await client(db,'Drag removed');
  const draft=lesson(a.id,{kind:'group',notes:'Keep these notes'});
  draft.bookings.push({id:randomUUID(),client_id:b.id,billing_mode:'cash',cash_amount:175,attendance:'attended'},
    {id:randomUUID(),client_id:c.id,billing_mode:'package',units:1});
  const l=await save(db,draft);
  await review(db,l.bookings.filter(x=>x.client_id!==b.id),'charge');
  await review(db,l.bookings.filter(x=>x.client_id===b.id),'waive');
  const edited=await save(db,{...draft,bookings:draft.bookings.slice(0,2)},l.revision);
  const before=await rpc(db,'hb_export_snapshot',{});
  const args={p_operation_id:randomUUID(),p_lesson_id:edited.id,p_expected_revision:edited.revision,p_start_minute:645};
  const moved=await rpc(db,'hb_move_lesson_time',args);
  assert.equal(moved.start_minute,645);assert.equal(moved.revision,edited.revision+1);
  assert.deepEqual({...moved,start_minute:edited.start_minute,revision:edited.revision,bookings:edited.bookings},edited);
  for(const prior of edited.bookings){
    const current=moved.bookings.find(x=>x.id===prior.id);
    assert.deepEqual(current,prior.removed?prior:{...prior,revision:prior.revision+1});
  }
  assert.deepEqual(await rpc(db,'hb_move_lesson_time',args),moved);
  await assert.rejects(rpc(db,'hb_move_lesson_time',{...args,p_start_minute:660}),/different request/);
  const after=await rpc(db,'hb_export_snapshot',{});
  for(const table of ['accounts','credit_entries','decisions','clients','horses','instructors','series','settings'])
    assert.deepEqual(after.data[table],before.data[table]);
  const audit=after.data.audit_events.filter(x=>x.operation_id===args.p_operation_id);
  assert.equal(audit.length,3);assert.ok(audit.every(x=>x.before_row&&x.after_row));
  const lessonAudit=audit.find(x=>x.table_name==='lessons');
  assert.equal(lessonAudit.before_row.start_minute,600);assert.equal(lessonAudit.after_row.start_minute,645);
  assert.equal(lessonAudit.actor_id,admin);
  await assert.rejects(review(db,edited.bookings.filter(x=>!x.removed),'charge','Stale review'),/Review changed/);
  await assert.rejects(review(db,moved.bookings.filter(x=>x.client_id===a.id),'charge','Same charge after moving'),/Review changed/);
  assert.equal((await rpc(db,'hb_history',{p_kind:'credits',p_client_id:a.id})).length,1);
  assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
});

test('a drag from an ended lesson to a future end time needs review for charged and waived decisions',async t=>{
  const {rows:[clock]}=await db.query("select (now() at time zone 'Europe/Warsaw')::date::text as date, extract(hour from now() at time zone 'Europe/Warsaw')::int*60+extract(minute from now() at time zone 'Europe/Warsaw')::int as minute");
  if(clock.minute<16){t.skip('No completed fifteen-minute lesson yet at the start of the Warsaw day');return;}
  for(const action of ['charge','waive']){
    const c=await client(db),draft=lesson(c.id,{date:clock.date,start_minute:0,duration_minutes:15}),l=await save(db,draft);
    await review(db,l.bookings,action);
    const before=await rpc(db,'hb_export_snapshot',{});
    const moved=await rpc(db,'hb_move_lesson_time',{p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:l.revision,p_start_minute:1425});
    assert.equal(moved.bookings[0].review_status,'needs_review');
    const after=await rpc(db,'hb_export_snapshot',{});
    for(const table of ['accounts','credit_entries','decisions'])assert.deepEqual(after.data[table],before.data[table]);
  }
});

test('waived decisions and pending reviews survive historical duration edits, but attendance changes need correction',async()=>{
  const c=await client(db),draft=lesson(c.id),l=await save(db,draft);
  const pending=await save(db,{...draft,duration_minutes:90},l.revision);
  assert.equal(pending.bookings[0].review_status,'pending');
  await assert.rejects(review(db,l.bookings),/Review changed/);
  await review(db,pending.bookings,'waive');
  const corrected=await save(db,{...draft,start_minute:615,duration_minutes:75},pending.revision);
  assert.equal(corrected.bookings[0].review_status,'waived');
  const attendance=await save(db,{...corrected,bookings:corrected.bookings.map(b=>({...b,attendance:'no_show'}))},corrected.revision);
  assert.equal(attendance.bookings[0].review_status,'needs_review');
  const again=await save(db,{...attendance,start_minute:630},attendance.revision);
  assert.equal(again.bookings[0].review_status,'needs_review');
});

test('time moves validate bounds and revisions; a repeated series occurrence moves independently and no-op preserves revisions',async()=>{
  const c=await client(db),draft=lesson(c.id);
  const series=await rpc(db,'hb_create_series',{p_operation_id:randomUUID(),p_lesson:draft,p_until:'2020-04-04'});
  const l=series.lessons[0],other=series.lessons[1];
  const args={p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:l.revision,p_start_minute:l.start_minute};
  const noOp=await rpc(db,'hb_move_lesson_time',args);assert.deepEqual(noOp,l);
  const before=await rpc(db,'hb_export_snapshot',{});
  for(const minute of [null,-15,1385,1440])
    await assert.rejects(rpc(db,'hb_move_lesson_time',{...args,p_operation_id:randomUUID(),p_start_minute:minute}),/within its day/);
  await assert.rejects(rpc(db,'hb_move_lesson_time',{...args,p_operation_id:randomUUID(),p_expected_revision:0}),/Lesson changed/);
  await assert.rejects(rpc(db,'hb_move_lesson_time',{...args,p_operation_id:randomUUID(),p_lesson_id:randomUUID()}),/no longer exists/);
  assert.deepEqual((await rpc(db,'hb_export_snapshot',{})).data,before.data);
  const moved=await rpc(db,'hb_move_lesson_time',{...args,p_operation_id:randomUUID(),p_start_minute:615});
  assert.equal(moved.start_minute,615);assert.equal(moved.series_id,l.series_id);assert.equal(moved.occurrence_date,l.occurrence_date);
  const after=await rpc(db,'hb_export_snapshot',{});
  assert.deepEqual(after.data.series,before.data.series);
  assert.deepEqual(after.data.lessons.find(x=>x.id===other.id),before.data.lessons.find(x=>x.id===other.id));
  assert.deepEqual(after.data.bookings.filter(x=>x.lesson_id===other.id),before.data.bookings.filter(x=>x.lesson_id===other.id));
  await assert.rejects(rpc(db,'hb_move_lesson_time',{...args,p_operation_id:randomUUID(),p_start_minute:630}),/Lesson changed/);
  await rpc(db,'hb_cancel_lesson',{p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:moved.revision,p_cancelled:true});
  const cancelled=await rpc(db,'hb_export_snapshot',{});
  await assert.rejects(rpc(db,'hb_move_lesson_time',{...args,p_operation_id:randomUUID(),p_expected_revision:moved.revision+1,p_start_minute:630}),/Cancelled lessons/);
  assert.deepEqual((await rpc(db,'hb_export_snapshot',{})).data,cancelled.data);
});

test('group decisions are independent and removed participants preserve charge history for explicit refund',async()=>{
  const a=await client(db,'Group A'),b=await client(db,'Group B');
  const draft=lesson(a.id,{kind:'group'});draft.bookings.push({id:randomUUID(),client_id:b.id,billing_mode:'package',units:1});
  const l=await save(db,draft);
  await review(db,[l.bookings.find(x=>x.client_id===a.id)],'charge');
  await review(db,[l.bookings.find(x=>x.client_id===b.id)],'waive');
  const edited=await save(db,{...draft,bookings:[draft.bookings[1]]},1);
  const removed=edited.bookings.find(x=>x.client_id===a.id);
  assert.equal(removed.removed,true);
  await assert.rejects(review(db,[removed],'charge','Removed'),/Removed or cash/);
  assert.equal((await review(db,[removed],'waive','Removed participant refund'))[0].account.balance,0);
});

test('future lessons cannot be billed; cash bookings never consume package credits',async()=>{
  const c=await client(db),future=await save(db,lesson(c.id,{date:'2099-01-01'}));
  await assert.rejects(review(db,future.bookings),/Lesson has not ended/);
  const cash=await save(db,lesson(c.id,{bookings:[{id:randomUUID(),client_id:c.id,billing_mode:'cash',cash_amount:140}]}));
  await assert.rejects(review(db,cash.bookings),/cash bookings/);
});

test('review badge count matches queue eligibility, including old and corrective reviews without pagination',async()=>{
  const through='2020-03-31',baseline=await rpc(db,'hb_review_count',{p_through:through});
  const a=await client(db,'Review count A'),b=await client(db,'Review count B');
  const draft=lesson(a.id,{kind:'group'});
  draft.bookings.push({id:randomUUID(),client_id:b.id,billing_mode:'cash',cash_amount:140});
  const past=await save(db,draft);
  await save(db,lesson(a.id,{date:'2099-01-01'}));
  await save(db,lesson(a.id,{date:'2020-04-01'}));
  await save(db,lesson(a.id,{status:'cancelled'}));
  const removedDraft=lesson(a.id,{kind:'group',bookings:[{id:randomUUID(),client_id:a.id,billing_mode:'package',units:1},
    {id:randomUUID(),client_id:b.id,billing_mode:'cash',cash_amount:140}]});
  const removed=await save(db,removedDraft);
  await save(db,{...removedDraft,bookings:[removedDraft.bookings[1]]},removed.revision);
  assert.equal(await rpc(db,'hb_review_count',{p_through:through}),baseline+2);
  assert.equal((await rpc(db,'hb_review_queue',{p_through:through,p_limit:1})).length,1);
  await review(db,[past.bookings.find(x=>x.client_id===a.id)]);
  assert.equal(await rpc(db,'hb_review_count',{p_through:through}),baseline+1);
  const changed={...draft,bookings:draft.bookings.map(x=>({...x,billing_mode:'cash',cash_amount:140}))};
  await save(db,changed,past.revision);
  assert.equal(await rpc(db,'hb_review_count',{p_through:through}),baseline+2);
  const queue=await rpc(db,'hb_review_queue',{p_through:through,p_limit:200});
  assert.equal(await rpc(db,'hb_review_count',{p_through:through}),queue.length);
  assert.equal(queue.find(x=>x.lesson_id===past.id).review_status,'needs_review');
  assert.equal(queue.find(x=>x.lesson_id===past.id).lesson_kind,'group');
  await assert.rejects(rpc(db,'hb_review_count',{p_through:null}),/Review date is required/);
  assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
});

test('stale lesson edits and stale topups fail; references can be renamed without relinking bookings',async()=>{
  const c=await client(db),draft=lesson(c.id),l=await save(db,draft);
  await asUser(db,otherAdmin);
  await save(db,{...draft,title:'Other admin'},l.revision);
  await asUser(db,admin);
  await assert.rejects(save(db,{...draft,title:'Stale editor'},l.revision),/Lesson changed/);
  const args={p_operation_id:randomUUID(),p_client_id:c.id,p_expected_revision:0,p_delta:10,p_reason:'Package purchase'};
  assert.equal((await rpc(db,'hb_adjust_credits',args)).balance_after,10);
  assert.deepEqual(await rpc(db,'hb_adjust_credits',args),await rpc(db,'hb_adjust_credits',args));
  await assert.rejects(rpc(db,'hb_adjust_credits',{...args,p_operation_id:randomUUID()}),/Balance changed/);
  await rpc(db,'hb_save_reference',{p_operation_id:randomUUID(),p_kind:'clients',p_expected_revision:c.revision,p_record:{...c,name:'Renamed'}});
  const read=(await rpc(db,'hb_calendar',{p_from:'2020-03-01',p_to:'2020-03-31'})).lessons.find(x=>x.id===l.id);
  assert.equal(read.bookings[0].client_id,c.id);assert.equal(read.bookings[0].client_name,'Renamed');
});

test('the migration detaches existing series, stores final flags, and audits the conversion without changing credits',async()=>{
  const legacy=new PGlite();
  try {
    await legacy.exec(bootstrap);
    const split=migration.indexOf('-- Weekly batches are independent');
    await legacy.exec(migration.slice(0,split));
    await legacy.query('insert into horsebook.admin_members values ($1,$2)',[admin,'Admin']);
    await asUser(legacy,admin);
    const c=await client(legacy),draft=lesson(c.id);
    const batch=await rpc(legacy,'hb_create_series',{p_operation_id:randomUUID(),p_lesson:draft,p_until:'2020-04-11'});
    const before=await rpc(legacy,'hb_export_snapshot',{});
    await owner(legacy);await legacy.exec(migration.slice(split));await asUser(legacy,admin);
    const after=await rpc(legacy,'hb_export_snapshot',{});
    assert.ok(after.data.lessons.every(l=>l.series_id===null&&l.occurrence_date===null));
    assert.deepEqual(after.data.lessons.filter(l=>l.is_last_in_series).map(l=>l.id),[batch.lessons.at(-1).id]);
    assert.deepEqual(after.data.accounts,before.data.accounts);assert.deepEqual(after.data.credit_entries,before.data.credit_entries);
    assert.ok(after.data.audit_events.length>before.data.audit_events.length);
    const restored=await fresh();
    try {
      await owner(restored);await restored.exec('delete from horsebook.admin_members');
      await restored.transaction(tx=>restoreSnapshot(tx,before));
      const rows=(await restored.query('select * from horsebook.lessons order by date')).rows;
      assert.ok(rows.every(l=>l.series_id===null&&l.occurrence_date===null));
      assert.equal(rows.at(-1).is_last_in_series,true);
    } finally {await restored.close();}
  } finally {await legacy.close();}
});

test('independent weekly copies reset attendance, preserve balances, and are retry-safe',async()=>{
  const c=await client(db),draft=lesson(c.id,{date:'2020-03-22'});
  const series=await rpc(db,'hb_create_series',{p_operation_id:randomUUID(),p_lesson:draft,p_until:'2020-04-06'});
  const first=series.lessons[0],last=series.lessons.at(-1);
  const cal=await rpc(db,'hb_calendar',{p_from:'2020-03-22',p_to:'2020-03-22'});
  assert.equal(cal.lessons.find(l=>l.id===first.id).is_last_in_series,false);
  const end=await rpc(db,'hb_calendar',{p_from:'2020-04-05',p_to:'2020-04-05'});
  assert.equal(end.lessons.find(l=>l.id===last.id).is_last_in_series,true);
  const args={p_operation_id:randomUUID(),p_expected_revision:last.revision,
    p_lesson:{...last,start_minute:660,notes:'Updated',status:'cancelled',bookings:last.bookings.map(b=>({...b,attendance:'no_show'}))},p_weeks:8};
  const fromFirst=await rpc(db,'hb_duplicate_lesson',{...args,p_operation_id:randomUUID(),p_lesson:first,p_expected_revision:first.revision,p_weeks:1});
  assert.equal(fromFirst.lessons.length,1);
  await assert.rejects(rpc(db,'hb_duplicate_lesson',{...args,p_weeks:0}),/whole number of weeks/);
  const before=await rpc(db,'hb_export_snapshot',{});
  const result=await rpc(db,'hb_duplicate_lesson',args);
  assert.equal(result.lessons.length,8);assert.equal(result.lessons[0].date,'2020-04-12');
  assert.ok(result.lessons.every(l=>l.series_id===null&&l.occurrence_date===null&&l.start_minute===660&&l.notes==='Updated'&&l.status==='scheduled'
    &&l.bookings.every(b=>b.attendance==='unknown'&&b.review_status==='pending'&&b.id!==last.bookings[0].id)));
  assert.equal(result.lesson.is_last_in_series,false);
  assert.deepEqual(result.lessons.map(l=>l.is_last_in_series),[false,false,false,false,false,false,false,true]);
  assert.deepEqual(await rpc(db,'hb_duplicate_lesson',args),result);
  await assert.rejects(rpc(db,'hb_duplicate_lesson',{...args,p_operation_id:randomUUID()}),/changed/);
  const after=await rpc(db,'hb_export_snapshot',{});
  assert.deepEqual(after.data.accounts,before.data.accounts);assert.deepEqual(after.data.credit_entries,before.data.credit_entries);
  const updated=await rpc(db,'hb_calendar',{p_from:'2020-04-05',p_to:'2020-06-01'});
  assert.deepEqual(updated.lessons.filter(l=>result.lessons.some(copy=>copy.id===l.id)&&l.is_last_in_series).map(l=>l.id),[result.lessons.at(-1).id]);
  const next=result.lessons.at(-1);
  const extended=await rpc(db,'hb_duplicate_lesson',{p_operation_id:randomUUID(),p_expected_revision:next.revision,p_lesson:next,p_weeks:52});
  assert.equal(extended.lessons.length,52);assert.ok(extended.lessons.at(-1).date>'2021-03-22');
});

test('weekly recurring generation is deterministic, retry-safe, and crosses DST with local time intact',async()=>{
  const c=await client(db),draft=lesson(c.id,{date:'2020-03-22'}),args={p_operation_id:randomUUID(),p_lesson:draft,p_until:'2020-04-05'};
  const result=await rpc(db,'hb_create_series',args);
  assert.equal(result.lessons.length,3);
  assert.deepEqual(result.lessons.map(x=>x.date),['2020-03-22','2020-03-29','2020-04-05']);
  assert.ok(result.lessons.every(x=>x.start_minute===600));
  assert.deepEqual(await rpc(db,'hb_create_series',args),result);
  await owner(db);
  const offsets=(await db.query("select (((date + make_interval(mins=>start_minute)) at time zone 'Europe/Warsaw') at time zone 'UTC')::text as instant from horsebook.lessons where id=any($1::uuid[]) order by date",[result.lessons.map(l=>l.id)])).rows;
  assert.match(offsets[0].instant,/09:00:00/);assert.match(offsets[1].instant,/08:00:00/);
  await asUser(db,admin);
  const occurrence=result.lessons[1];
  await rpc(db,'hb_delete_lesson',{p_operation_id:randomUUID(),p_lesson_id:occurrence.id,p_expected_revision:occurrence.revision});
  // A retry of series creation cannot regenerate the deleted occurrence.
  assert.deepEqual(await rpc(db,'hb_create_series',args),result);
  const remaining=(await rpc(db,'hb_calendar',{p_from:'2020-03-01',p_to:'2020-04-30'})).lessons.filter(x=>result.lessons.some(copy=>copy.id===x.id));
  assert.deepEqual(remaining.map(x=>x.id),[result.lessons[0].id,result.lessons[2].id]);
});

test('anonymous calendar does not expose finance, package balances, review facts, or private notes',async()=>{
  const c=await client(db),draft=lesson(c.id,{notes:'Private note'}),l=await save(db,draft);
  await asUser(db,null,'anon');
  const result=(await rpc(db,'hb_calendar',{p_from:'2020-03-01',p_to:'2020-03-31'})).lessons.find(x=>x.id===l.id);
  assert.equal(result.notes,undefined);assert.equal(result.bookings[0].cash_amount,undefined);
  assert.equal(result.bookings[0].review_status,undefined);
  await asUser(db,admin);
});

test('posted records remain immutable even through owner access; integrity is read-only',async()=>{
  assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
  await owner(db);
  await assert.rejects(db.query('update horsebook.credit_entries set delta=99'),/cannot be edited/);
  await assert.rejects(db.query('delete from horsebook.decisions'),/cannot be edited/);
  await assert.rejects(db.query('delete from horsebook.audit_events'),/cannot be edited/);
  await asUser(db,admin);
});

test('calendar events are independent, audited, revision checked, retry safe and bounded within their day',async()=>{
  const draft={id:randomUUID(),date:'2020-03-28',start_minute:600,end_minute:675,description:'  Event description  '};
  const create={p_operation_id:randomUUID(),p_expected_revision:null,p_event:draft};
  for(const role of ['authenticated','anon']){
    await asUser(db,role==='anon'?null:outsider,role);
    for(const [name,args] of [['hb_save_event',create],['hb_move_event_time',{p_operation_id:randomUUID(),p_event_id:draft.id,p_expected_revision:1,p_start_minute:615}],['hb_delete_event',{p_operation_id:randomUUID(),p_event_id:draft.id,p_expected_revision:1}]])
      await assert.rejects(rpc(db,name,args),role==='anon'?/permission denied/:/Admin access required/);
    await assert.rejects(db.query('select * from horsebook.events'),/permission denied/);
  }
  await asUser(db,admin);
  const before=await rpc(db,'hb_export_snapshot',{}),count=await rpc(db,'hb_review_count',{p_through:'2020-03-31'});
  const created=await rpc(db,'hb_save_event',create);
  assert.equal(created.description,'Event description');assert.equal(created.revision,1);
  assert.deepEqual(await rpc(db,'hb_save_event',create),created);
  await assert.rejects(rpc(db,'hb_save_event',{...create,p_event:{...draft,description:'Changed payload'}}),/different request/);
  const edited=await rpc(db,'hb_save_event',{...create,p_operation_id:randomUUID(),p_expected_revision:1,p_event:{...draft,description:'Edited event',end_minute:690}});
  await assert.rejects(rpc(db,'hb_save_event',{...create,p_operation_id:randomUUID(),p_expected_revision:1}),/Event changed/);
  const move={p_operation_id:randomUUID(),p_event_id:created.id,p_expected_revision:edited.revision,p_start_minute:645};
  const moved=await rpc(db,'hb_move_event_time',move);
  assert.equal(moved.end_minute,735);assert.equal(moved.description,edited.description);
  assert.deepEqual(await rpc(db,'hb_move_event_time',move),moved);
  await assert.rejects(rpc(db,'hb_move_event_time',{...move,p_operation_id:randomUUID()}),/Event changed/);
  const noOp=await rpc(db,'hb_move_event_time',{...move,p_operation_id:randomUUID(),p_expected_revision:moved.revision});assert.deepEqual(noOp,moved);
  const valid=await rpc(db,'hb_export_snapshot',{});
  for(const minute of [-15,null,1400,1440])await assert.rejects(rpc(db,'hb_move_event_time',{...move,p_operation_id:randomUUID(),p_expected_revision:moved.revision,p_start_minute:minute}),/constraint|null/);
  for(const changes of [{description:'  '},{end_minute:600},{start_minute:1440},{end_minute:1441}])
    await assert.rejects(rpc(db,'hb_save_event',{...create,p_operation_id:randomUUID(),p_expected_revision:moved.revision,p_event:{...draft,...changes}}),/constraint/);
  assert.deepEqual((await rpc(db,'hb_export_snapshot',{})).data,valid.data);
  await asUser(db,null,'anon');
  const calendar=await rpc(db,'hb_calendar',{p_from:'2020-03-01',p_to:'2020-03-31'});
  assert.deepEqual(calendar.events.find(x=>x.id===moved.id),moved);assert.ok(!calendar.lessons.some(x=>x.id===moved.id));
  await asUser(db,admin);
  const remove={p_operation_id:randomUUID(),p_event_id:moved.id,p_expected_revision:moved.revision};
  await assert.rejects(rpc(db,'hb_delete_event',{...remove,p_expected_revision:edited.revision}),/Event changed/);
  const result=await rpc(db,'hb_delete_event',remove);assert.deepEqual(result,{id:moved.id,deleted:true});assert.deepEqual(await rpc(db,'hb_delete_event',remove),result);
  await assert.rejects(rpc(db,'hb_save_event',{...create,p_operation_id:randomUUID(),p_expected_revision:moved.revision}),/no longer exists/);
  const after=await rpc(db,'hb_export_snapshot',{});
  for(const table of ['accounts','credit_entries','decisions','lessons','bookings','series','settings'])assert.deepEqual(after.data[table],before.data[table]);
  assert.equal(await rpc(db,'hb_review_count',{p_through:'2020-03-31'}),count);
  const audit=after.data.audit_events.filter(x=>x.operation_id===remove.p_operation_id);
  assert.equal(audit.length,1);assert.equal(audit[0].table_name,'events');assert.deepEqual(audit[0].before_row,moved);assert.equal(audit[0].after_row,null);assert.equal(audit[0].actor_id,admin);
  // Leave one real event for the complete snapshot recovery test below.
  await rpc(db,'hb_save_event',{...create,p_operation_id:randomUUID(),p_event:{...draft,id:randomUUID()}});
});

test('pre-event snapshots retain their checksum and restore into the new schema with an empty event calendar',async()=>{
  const legacy=structuredClone(await rpc(db,'hb_export_snapshot',{}));legacy.schema_version=8;delete legacy.data.events;
  const envelope=packSnapshot(legacy);assert.deepEqual(unpackSnapshot(envelope),legacy);
  const target=await fresh();
  try {
    await target.transaction(tx=>restoreSnapshot(tx,legacy));await asUser(target,admin);
    const restored=await rpc(target,'hb_export_snapshot',{});assert.deepEqual(restored.data.events,[]);delete restored.data.events;
    assert.deepEqual(restored.data,legacy.data);
  } finally {await target.close();}
});

test('snapshot roundtrip retains all history, decisions, balances, events and safe retry results',async()=>{
  const c=await client(db),l=await save(db,lesson(c.id)),op=randomUUID();
  const original=await review(db,l.bookings,'charge','',op);
  const snapshot=await rpc(db,'hb_export_snapshot',{}), envelope=packSnapshot(snapshot);
  assert.deepEqual(unpackSnapshot(envelope),snapshot);
  const damaged=structuredClone(envelope);damaged.snapshot.data.accounts[0].balance++;
  assert.throws(()=>unpackSnapshot(damaged),/checksum mismatch/);
  const restored=await fresh();
  try {
    await restored.transaction(tx=>restoreSnapshot(tx,snapshot));
    await asUser(restored,admin);
    assert.deepEqual(await review(restored,l.bookings,'charge','',op),original);
    assert.deepEqual(await rpc(restored,'hb_integrity',{}),[]);
    const after=await rpc(restored,'hb_export_snapshot',{});
    assert.deepEqual(after.data,snapshot.data);
    await owner(restored);
    await assert.rejects(restored.transaction(tx=>restoreSnapshot(tx,snapshot)),/empty database/);
  } finally {await restored.close();}
});

test('even a recomputed checksum cannot import an inconsistent accounting state',async()=>{
  const snapshot=await rpc(db,'hb_export_snapshot',{});
  snapshot.data.accounts[0].balance+=10;
  const target=await fresh();
  try {
    await assert.rejects(target.transaction(tx=>restoreSnapshot(tx,unpackSnapshot(packSnapshot(snapshot)))),/integrity checks/);
    assert.equal((await target.query('select count(*)::int n from horsebook.clients')).rows[0].n,0);
  } finally {await target.close();}
});
