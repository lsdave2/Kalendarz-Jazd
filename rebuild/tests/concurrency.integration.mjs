import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isolatedPostgres} from './real-database.mjs';
import {migration,admin,otherAdmin,asUser,client,lesson,save,rpc} from './harness.mjs';

test('real multi-session approvals: only one charge wins; retries return the same committed result',async()=>{
  const db=await isolatedPostgres(migration);
  let first,second;
  try {
    await db.query('insert into horsebook.admin_members values ($1,$2),($3,$4)',[admin,'Admin',otherAdmin,'Second admin']);
    await asUser(db,admin);const c=await client(db),l=await save(db,lesson(c.id));
    first=await db.session(admin);second=await db.session(otherAdmin);
    const decisions=[{booking_id:l.bookings[0].id,expected_revision:1,action:'charge',reason:''}];
    const args={p_operation_id:randomUUID(),p_decisions:decisions};
    const results=await Promise.allSettled([rpc(first,'hb_review_credits',args),rpc(second,'hb_review_credits',{...args,p_operation_id:randomUUID()})]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    const rejected=results.find(x=>x.status==='rejected');assert.equal(rejected.reason.code,'40001');
    assert.equal((await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id})).length,1);
    assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
    // Repeat a shared operation from two sessions for the same admin.
    await second.end();second=await db.session(admin);
    const topup={p_operation_id:randomUUID(),p_client_id:c.id,p_expected_revision:1,p_delta:5,p_reason:'Purchase'};
    const duplicates=await Promise.all([rpc(first,'hb_adjust_credits',topup),rpc(second,'hb_adjust_credits',topup)]);
    assert.deepEqual(duplicates[0],duplicates[1]);assert.equal(duplicates[0].balance_after,4);
    assert.equal((await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id})).length,2);
  } finally {await first?.end();await second?.end();await db.close();}
});

test('delete and credit review serialize: the first transaction wins without losing audit or posted decisions',async()=>{
  const db=await isolatedPostgres(migration);let first,second;
  try {
    await db.query('insert into horsebook.admin_members values ($1,$2),($3,$4)',[admin,'Admin',otherAdmin,'Second admin']);
    await asUser(db,admin);const c=await client(db);
    first=await db.session(admin);second=await db.session(otherAdmin);
    for(const winner of ['review','delete']){
      const l=await save(db,lesson(c.id));
      const deletion={p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:l.revision};
      const approval={p_operation_id:randomUUID(),p_decisions:[{booking_id:l.bookings[0].id,expected_revision:1,action:'charge',reason:''}]};
      await first.query('begin');
      await rpc(first,winner==='review'?'hb_review_credits':'hb_delete_lesson',winner==='review'?approval:deletion);
      const competitor=rpc(second,winner==='review'?'hb_delete_lesson':'hb_review_credits',winner==='review'?deletion:approval)
        .then(()=>({code:null}),error=>({code:error.code}));
      await first.query('commit');
      assert.equal((await competitor).code,winner==='review'?'55000':'40001');
      const calendar=await rpc(db,'hb_calendar',{p_from:'2020-03-01',p_to:'2020-03-31'});
      assert.equal(calendar.lessons.some(x=>x.id===l.id),winner==='review');
      const credits=await rpc(db,'hb_history',{p_kind:'credits',p_client_id:c.id});
      assert.equal(credits.filter(x=>x.booking_id===l.bookings[0].id).length,winner==='review'?1:0);
      const audit=await rpc(db,'hb_history',{p_kind:'audit'});
      assert.equal(audit.filter(x=>x.operation_id===deletion.p_operation_id&&x.after_row===null).length,winner==='delete'?2:0);
      assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
    }
  } finally {await first?.end();await second?.end();await db.close();}
});

test('drag moves serialize with other moves and credit review without overwriting edits or duplicating charges',async()=>{
  const db=await isolatedPostgres(migration);let first,second;
  try{
    await db.query('insert into horsebook.admin_members values ($1,$2),($3,$4)',[admin,'Admin',otherAdmin,'Second admin']);
    await asUser(db,admin);const c=await client(db),l=await save(db,lesson(c.id));
    first=await db.session(admin);second=await db.session(otherAdmin);
    const move={p_operation_id:randomUUID(),p_lesson_id:l.id,p_expected_revision:1,p_start_minute:615};
    const concurrent=await Promise.allSettled([rpc(first,'hb_move_lesson_time',move),
      rpc(second,'hb_move_lesson_time',{...move,p_operation_id:randomUUID(),p_start_minute:630})]);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(concurrent.find(x=>x.status==='rejected').reason.code,'40001');
    for(const winner of ['move','review']){
      const record=await save(db,lesson(c.id));
      const movement={...move,p_operation_id:randomUUID(),p_lesson_id:record.id};
      const approval={p_operation_id:randomUUID(),p_decisions:[{booking_id:record.bookings[0].id,expected_revision:1,action:'charge',reason:''}]};
      await first.query('begin');
      await rpc(first,winner==='move'?'hb_move_lesson_time':'hb_review_credits',winner==='move'?movement:approval);
      const competitor=rpc(second,winner==='move'?'hb_review_credits':'hb_move_lesson_time',winner==='move'?approval:movement)
        .then(result=>({result,code:null}),error=>({code:error.code}));
      await first.query('commit');const outcome=await competitor;
      assert.equal(outcome.code,winner==='move'?'40001':null);
      const snapshot=await rpc(db,'hb_export_snapshot',{}),booking=snapshot.data.bookings.find(x=>x.id===record.bookings[0].id);
      assert.equal(booking.review_status,winner==='move'?'pending':'charged');
      assert.equal(snapshot.data.credit_entries.filter(x=>x.booking_id===booking.id).length,winner==='move'?0:1);
      assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
    }
  }finally{await first?.end();await second?.end();await db.close();}
});
