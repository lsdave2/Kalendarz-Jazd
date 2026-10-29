import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fresh,asUser,rpc,admin,client,lesson,save} from './harness.mjs';

test('new lesson defaults follow creation order across dates, ignore edits and failures, and include custom lessons',async()=>{
  const db=await fresh();
  try{
    await asUser(db,admin);
    const last=async()=>(await rpc(db,'hb_references',{})).last_lesson_start_minute;
    assert.equal(await last(),null);
    const known=await client(db);
    let first=await save(db,lesson(known.id,{id:'20000000-0000-4000-8000-000000000001',date:'2028-12-01',start_minute:1065}));
    assert.equal(await last(),1065);
    let second=await save(db,lesson(known.id,{id:'20000000-0000-4000-8000-000000000002',date:'2020-01-01',start_minute:555}));
    assert.equal(await last(),555);
    second=await rpc(db,'hb_move_lesson_time',{p_operation_id:randomUUID(),p_lesson_id:second.id,p_expected_revision:second.revision,p_start_minute:630});
    assert.equal(await last(),555);
    first=await save(db,{...first,start_minute:1080},first.revision);
    assert.equal(await last(),555);
    await assert.rejects(save(db,lesson(known.id,{start_minute:780,duration_minutes:-1})));
    assert.equal(await last(),555);
    const custom=lesson(null,{kind:'custom',start_minute:720});custom.bookings[0].client_name='One-off';
    await save(db,custom);assert.equal(await last(),720);
    await rpc(db,'hb_duplicate_lesson',{p_operation_id:randomUUID(),p_expected_revision:null,p_lesson:lesson(known.id,{start_minute:930}),p_weeks:2});
    assert.equal(await last(),930);
    assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
  }finally{await db.close();}
});
