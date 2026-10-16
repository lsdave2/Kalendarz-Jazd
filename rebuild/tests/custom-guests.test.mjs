import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fresh,asUser,rpc,admin,owner,client,lesson,save} from './harness.mjs';
import {packSnapshot,unpackSnapshot,restoreSnapshot} from '../scripts/snapshot.mjs';

test('custom guests retain names and prices through edits, copying and backups without client accounts',async()=>{
  const db=await fresh();let restored;
  try{
    await asUser(db,admin);
    const known=await client(db,'Existing client');
    const draft=lesson(null,{kind:'custom'});
    draft.bookings=[{id:randomUUID(),client_id:null,client_name:'  One-off visitor  ',billing_mode:'cash',cash_amount:175},
      {id:randomUUID(),client_id:known.id,billing_mode:'cash',cash_amount:125}];
    const operation=randomUUID();let saved=await save(db,draft,null,operation);
    assert.deepEqual(await save(db,draft,null,operation),saved);
    assert.equal(saved.bookings.length,2);
    assert.ok(saved.bookings.every(b=>b.client_id===null&&b.billing_mode==='cash'));
    assert.deepEqual(saved.bookings.map(b=>b.guest_name).sort(),['Existing client','One-off visitor']);
    const visitor=saved.bookings.find(b=>b.guest_name==='One-off visitor');
    saved=await save(db,{...saved,bookings:saved.bookings.map(b=>b.id===visitor.id?{...b,client_name:'Renamed visitor',cash_amount:190}:b)},saved.revision);
    assert.equal(saved.bookings.find(b=>b.id===visitor.id).guest_name,'Renamed visitor');
    const calendar=await rpc(db,'hb_calendar',{p_from:draft.date,p_to:draft.date});
    assert.ok(calendar.lessons[0].bookings.some(b=>b.client_name==='Renamed visitor'&&b.cash_amount===190));
    const batch=await rpc(db,'hb_duplicate_lesson',{p_operation_id:randomUUID(),p_expected_revision:saved.revision,p_lesson:saved,p_weeks:2});
    assert.equal(batch.lessons.length,2);
    await rpc(db,'hb_move_lesson_time',{p_operation_id:randomUUID(),p_lesson_id:batch.lessons[0].id,p_expected_revision:batch.lessons[0].revision,p_start_minute:720});
    const snapshot=await rpc(db,'hb_export_snapshot',{});
    assert.equal(snapshot.data.clients.length,1);assert.equal(snapshot.data.accounts.length,1);
    assert.equal(snapshot.data.bookings.length,6);assert.equal(snapshot.data.credit_entries.length,0);
    assert.ok(snapshot.data.bookings.every(b=>b.client_id===null&&b.guest_name));
    assert.deepEqual(await rpc(db,'hb_review_queue',{p_through:'2030-01-01'}),[]);
    assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
    restored=await fresh();await owner(restored);await restored.exec('begin');
    await restoreSnapshot(restored,unpackSnapshot(packSnapshot(snapshot)));await restored.exec('commit');
    assert.deepEqual((await restored.query('select horsebook.snapshot() as snapshot')).rows[0].snapshot.data,snapshot.data);
    for(const name of ['','  ','x'.repeat(201)]){
      await assert.rejects(save(db,{...saved,bookings:[{...visitor,client_name:name}]},saved.revision),/guest name/);
    }
    const invalid=lesson(null,{kind:'custom',duration_minutes:-1});invalid.bookings[0].client_name='No orphan';
    await assert.rejects(save(db,invalid));
    assert.equal((await rpc(db,'hb_references',{})).clients.length,1);
  }finally{await restored?.close();await db.close();}
});

test('saving an old linked custom participant creates a guest booking while preserving the client and old history',async()=>{
  const db=await fresh();
  try{
    await asUser(db,admin);
    const known=await client(db,'Existing person'),original=lesson(known.id);
    original.bookings[0].billing_mode='cash';
    const saved=await save(db,original);
    const converted=await save(db,{...saved,kind:'custom'},saved.revision);
    const active=converted.bookings.filter(b=>!b.removed);
    assert.equal(active.length,1);assert.equal(active[0].client_id,null);assert.equal(active[0].guest_name,known.name);
    assert.notEqual(active[0].id,saved.bookings[0].id);
    assert.equal(converted.bookings.find(b=>b.id===saved.bookings[0].id).removed,true);
    assert.equal((await rpc(db,'hb_references',{})).clients.length,1);
    const bad=lesson(null,{kind:'custom',bookings:[{...saved.bookings[0],client_name:'Unrelated guest'}]});
    await assert.rejects(save(db,bad),/Booking belongs to another lesson/);
    const publicCalendar=await rpc(db,'hb_calendar',{p_from:saved.date,p_to:saved.date});
    assert.equal(publicCalendar.lessons[0].bookings.filter(b=>!b.removed)[0].client_name,known.name);
    assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
  }finally{await db.close();}
});
