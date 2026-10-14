import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fresh,asUser,rpc,admin,owner,migration} from './harness.mjs';

test('instructor rates default to 60, persist independently, and reject invalid or stale updates',async()=>{
  const db=await fresh();
  try{
    await asUser(db,admin);
    const save=(record,revision=null)=>rpc(db,'hb_save_reference',{p_operation_id:randomUUID(),p_kind:'instructors',p_expected_revision:revision,p_record:record});
    let i=await save({name:'Instructor'});
    assert.equal(i.lesson_rate,60);
    i=await save({...i,lesson_rate:75.50},i.revision);
    const stale=i.revision;
    i=await save({id:i.id,name:'Renamed'},i.revision);
    assert.equal(i.lesson_rate,75.50);
    await assert.rejects(save({...i,lesson_rate:10},stale),/Record changed/);
    await assert.rejects(save({...i,lesson_rate:-1},i.revision),/check constraint/);
    await assert.rejects(save({...i,lesson_rate:'NaN'},i.revision),/check constraint/);
    assert.equal((await rpc(db,'hb_references',{})).instructors.find(x=>x.id===i.id).lesson_rate,75.50);
    assert.equal((await rpc(db,'hb_export_snapshot',{})).data.instructors.find(x=>x.id===i.id).lesson_rate,75.50);
    const other=await save({name:'Other'});assert.equal(other.lesson_rate,60);
  }finally{await db.close();}
});

test('migration defaults existing instructors to one hourly rate of 60',async()=>{
  const db=await fresh();
  try{
    await asUser(db,admin);
    const i=await rpc(db,'hb_save_reference',{p_operation_id:randomUUID(),p_kind:'instructors',p_expected_revision:null,p_record:{name:'Existing'}});
    await rpc(db,'hb_save_setting',{p_operation_id:randomUUID(),p_key:'report_rates',p_expected_revision:null,p_value:{instructor_individual:72,instructor_group:30,package_individual:110,package_group:90}});
    await owner(db);
    await db.exec('alter table horsebook.instructors drop column lesson_rate; delete from horsebook.schema_version where version=15;');
    await db.exec(migration.slice(migration.indexOf('-- One hourly payment rate per instructor')));
    const {rows}=await db.query('select lesson_rate from horsebook.instructors where id=$1',[i.id]);
    assert.equal(Number(rows[0].lesson_rate),60);
  }finally{await db.close();}
});
