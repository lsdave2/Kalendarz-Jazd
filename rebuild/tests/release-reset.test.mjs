import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fresh,asUser,owner,admin,client,lesson,save,review,rpc} from './harness.mjs';
import {resetReleaseData,clearedTables} from '../scripts/release-reset.mjs';

test('prelaunch reset clears reviewed lessons and test transactions, preserves references and audit, and rolls back atomically',async()=>{
  const db=await fresh();
  try {
    await asUser(db,admin);
    const c=await client(db);
    await rpc(db,'hb_adjust_credits',{p_operation_id:randomUUID(),p_client_id:c.id,p_expected_revision:0,p_delta:5,p_reason:'Test purchase'});
    const saved=await save(db,lesson(c.id));
    await review(db,saved.bookings);
    await rpc(db,'hb_save_event',{p_operation_id:randomUUID(),p_expected_revision:null,p_event:{id:randomUUID(),date:'2020-03-28',start_minute:600,end_minute:660,description:'Test event'}});
    await rpc(db,'hb_save_finance',{p_operation_id:randomUUID(),p_expected_revision:null,p_record:{id:randomUUID(),kind:'income',title:'Test',amount:5,date:'2020-03-28'}});
    await owner(db);
    const snapshot=(await db.query('select horsebook.snapshot() as snapshot')).rows[0].snapshot;
    const admins=(await db.query('select * from horsebook.admin_members order by user_id')).rows;
    await db.exec('begin');
    await resetReleaseData(db,snapshot,'verified-local-backup.json','test-checksum');
    for(const t of clearedTables) assert.equal((await db.query('select count(*)::int as n from horsebook.'+t)).rows[0].n,0);
    assert.deepEqual((await db.query('select balance,revision from horsebook.accounts')).rows,[{balance:0,revision:0}]);
    assert.deepEqual((await db.query('select * from horsebook.admin_members order by user_id')).rows,admins);
    assert.equal((await db.query('select count(*)::int as n from horsebook.audit_events')).rows[0].n,snapshot.data.audit_events.length+1);
    await db.exec('rollback');
    assert.deepEqual((await db.query('select horsebook.snapshot() as snapshot')).rows[0].snapshot.data,snapshot.data);
    const stale=structuredClone(snapshot);stale.data.lessons=[];
    await db.exec('begin');
    await assert.rejects(resetReleaseData(db,stale,'backup','checksum'),/changed since backup/);
    await db.exec('rollback');
  } finally {await db.close();}
});
