import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fresh,asUser,rpc,admin,outsider,client,lesson,save} from './harness.mjs';

test('inline clients are atomic, audited, retry safe and reused by weekly copies',async()=>{
  const db=await fresh();
  try{
    await asUser(db,admin);
    const known=await client(db,'Known client');
    const draft=lesson(null,{kind:'group'});
    draft.bookings[0].client_name='  New client  ';
    draft.bookings.push({id:randomUUID(),client_id:known.id,billing_mode:'cash',cash_amount:140});
    const op=randomUUID(),saved=await save(db,draft,null,op);
    assert.deepEqual(await save(db,draft,null,op),saved);
    let snapshot=(await rpc(db,'hb_export_snapshot',{})).data;
    const created=snapshot.clients.find(c=>c.name==='New client');
    assert.ok(created);
    assert.equal(saved.bookings.find(b=>b.client_id!==known.id).client_id,created.id);
    assert.equal(snapshot.accounts.find(a=>a.client_id===created.id).balance,0);
    assert.equal(snapshot.credit_entries.length,0);
    assert.equal(snapshot.audit_events.filter(a=>a.operation_id===op&&a.table_name==='clients').length,1);
    const batch=lesson(null);batch.bookings[0].client_name=' NEW CLIENT ';
    await rpc(db,'hb_duplicate_lesson',{p_operation_id:randomUUID(),p_expected_revision:null,p_lesson:batch,p_weeks:3});
    snapshot=(await rpc(db,'hb_export_snapshot',{})).data;
    assert.equal(snapshot.clients.length,2);
    assert.equal(snapshot.lessons.length,4);
    assert.equal(snapshot.bookings.filter(b=>b.client_id===created.id).length,4);
    const invalid=lesson(null,{duration_minutes:-1});invalid.bookings[0].client_name='Should roll back';
    await assert.rejects(save(db,invalid));
    assert.equal((await rpc(db,'hb_references',{})).clients.length,2);
    const duplicate=lesson(null,{kind:'group'});duplicate.bookings[0].client_name='Duplicate';
    duplicate.bookings.push({...duplicate.bookings[0],id:randomUUID(),client_name:' duplicate '});
    await assert.rejects(save(db,duplicate));
    assert.equal((await rpc(db,'hb_references',{})).clients.length,2);
    const archived=await rpc(db,'hb_save_reference',{p_operation_id:randomUUID(),p_kind:'clients',p_expected_revision:known.revision,p_record:{...known,archived:true}});
    const blocked=lesson(null);blocked.bookings[0].client_name=archived.name;
    await assert.rejects(save(db,blocked),/archived/);
    for(const name of ['   ','x'.repeat(201)]){
      const bad=lesson(null);bad.bookings[0].client_name=name;await assert.rejects(save(db,bad),/Name is required/);
    }
    await asUser(db,outsider);
    await assert.rejects(save(db,draft));
    await asUser(db,admin);
    assert.deepEqual(await rpc(db,'hb_integrity',{}),[]);
  }finally{await db.close();}
});
