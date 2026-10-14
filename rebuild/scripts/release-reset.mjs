import { randomUUID } from 'node:crypto';
import { canonical } from './snapshot.mjs';

// Owner-only, one-time prelaunch reset. Call inside a transaction after taking
// and rehearsing a snapshot while holding the business writer lock.
export const clearedTables = ['credit_entries','decisions','bookings','lessons','series','events','finance_entries'];
export async function resetReleaseData(db, snapshot, backupFile, checksum) {
  const current = (await db.query('select horsebook.snapshot() as snapshot')).rows[0].snapshot;
  if (canonical(current.data) !== canonical(snapshot.data)) throw new Error('Database changed since backup; take a fresh snapshot.');
  const actor = (await db.query('select user_id,display_name from horsebook.admin_members order by user_id limit 1')).rows[0];
  if (!actor) throw new Error('No admin membership; refusing reset.');
  const id = randomUUID();
  const before = Object.fromEntries(clearedTables.map(t => [t,current.data[t].length]));
  before.nonzero_balances = current.data.accounts.filter(a => a.balance !== 0).length;
  const result = { cleared:before, balances:'zero', backup:backupFile, checksum };
  await db.query(`insert into horsebook.operations(id,name,request,actor_id,actor_name,result)
    values($1,'prelaunch_test_reset',$2::jsonb,$3,$4,$5::jsonb)`,
    [id,JSON.stringify({reason:'Owner-authorized removal of v2 development test data',backup:backupFile,checksum}),actor.user_id,actor.display_name,JSON.stringify(result)]);
  // Explicit list, no CASCADE: an unexpected dependent table fails the reset.
  await db.query('truncate table '+clearedTables.map(t=>'horsebook.'+t).join(','));
  await db.query("select set_config('horsebook.restoring','on',true)");
  await db.query('update horsebook.accounts set balance=0,revision=0');
  await db.query("select set_config('horsebook.restoring','off',true)");
  await db.query(`insert into horsebook.audit_events(operation_id,table_name,record_id,before_row,after_row,actor_id,actor_name)
    values($1::uuid,'prelaunch_test_reset',$1::uuid::text,$2::jsonb,$3::jsonb,$4,$5)`,
    [id,JSON.stringify(before),JSON.stringify(result),actor.user_id,actor.display_name]);
  const after = (await db.query('select horsebook.snapshot() as snapshot')).rows[0].snapshot;
  for (const t of ['clients','horses','instructors','settings']) {
    if (canonical(after.data[t]) !== canonical(current.data[t])) throw new Error('Preserved table changed: '+t);
  }
  if (clearedTables.some(t=>after.data[t].length) || after.data.accounts.some(a=>a.balance!==0 || a.revision!==0)) throw new Error('Reset postconditions failed.');
  const problems = (await db.query('select horsebook.integrity() as problems')).rows[0].problems;
  if (problems.length) throw new Error('Reset integrity failed: '+JSON.stringify(problems));
  return result;
}
