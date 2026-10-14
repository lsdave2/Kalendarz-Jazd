import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fresh,asUser,rpc,admin} from './harness.mjs';

test('client phone numbers persist, can be cleared, and survive older client updates',async()=>{
  const db=await fresh();
  try{
    await asUser(db,admin);
    const save=(record,revision=null)=>rpc(db,'hb_save_reference',{p_operation_id:randomUUID(),p_kind:'clients',p_expected_revision:revision,p_record:record});
    let c=await save({id:randomUUID(),name:'Phone client',phone_number:'  +48 012 345 678  '});
    assert.equal(c.phone_number,'+48 012 345 678');
    assert.equal((await rpc(db,'hb_references',{})).clients.find(x=>x.id===c.id).phone_number,c.phone_number);
    assert.equal((await rpc(db,'hb_export_snapshot',{})).data.clients.find(x=>x.id===c.id).phone_number,c.phone_number);
    const oldRevision=c.revision;
    c=await save({id:c.id,name:'Renamed'},c.revision);
    assert.equal(c.phone_number,'+48 012 345 678');
    await assert.rejects(save({...c,phone_number:'stale'},oldRevision),/Record changed/);
    await assert.rejects(save({...c,phone_number:'1'.repeat(51)},c.revision),/check constraint/);
    c=await save({...c,phone_number:'   '},c.revision);
    assert.equal(c.phone_number,null);
    assert.equal((await save({id:randomUUID(),name:'Without phone'})).phone_number,null);
  }finally{await db.close();}
});
