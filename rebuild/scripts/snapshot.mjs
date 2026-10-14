import { createHash, timingSafeEqual } from 'node:crypto';

export const tables = ['operations','clients','horses','instructors','accounts','series',
  'lessons','bookings','decisions','credit_entries','settings','finance_entries','events','audit_events'];
function snapshotTables(snapshot){return tables.filter(t=>t!=='events'||(snapshot.schema_version??1)>=9||Object.hasOwn(snapshot.data??{},'events'));}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function checksum(snapshot) { return createHash('sha256').update(canonical(snapshot)).digest('hex'); }
export function packSnapshot(snapshot) {
  validateSnapshot(snapshot);
  return { snapshot, manifest: { checksum: checksum(snapshot), algorithm: 'sha256',
    counts: Object.fromEntries(snapshotTables(snapshot).map(t=>[t,snapshot.data[t].length])) } };
}
export function unpackSnapshot(envelope) {
  if (!envelope?.snapshot || !envelope.manifest || envelope.manifest.algorithm !== 'sha256') throw new Error('Invalid snapshot envelope');
  const expected=checksum(envelope.snapshot), actual=envelope.manifest.checksum;
  if (typeof actual!=='string' || !/^[a-f0-9]{64}$/.test(actual) || !timingSafeEqual(Buffer.from(expected),Buffer.from(actual))) {
    throw new Error('Snapshot checksum mismatch');
  }
  validateSnapshot(envelope.snapshot);
  for (const t of snapshotTables(envelope.snapshot)) if(envelope.manifest.counts[t]!==envelope.snapshot.data[t].length) throw new Error(`Snapshot count mismatch: ${t}`);
  return envelope.snapshot;
}
export function validateSnapshot(snapshot) {
  if (snapshot?.format!=='horsebook.snapshot' || snapshot.version!==1 || !snapshot.data
    || !Number.isFinite(Date.parse(snapshot.created_at))) throw new Error('Unsupported snapshot format');
  if (Object.keys(snapshot.data).sort().join(',')!==snapshotTables(snapshot).sort().join(',')) throw new Error('Missing or unexpected snapshot tables');
  for (const table of snapshotTables(snapshot)) {
    if (!Array.isArray(snapshot.data[table])) throw new Error(`Invalid table: ${table}`);
    const ids=new Set();
    for (const row of snapshot.data[table]) {
      if (!row || Array.isArray(row) || typeof row!=='object') throw new Error(`Invalid record in ${table}`);
      const id = row.id ?? row.client_id ?? row.key;
      if (typeof id!=='string' || ids.has(id)) throw new Error(`Missing or duplicate identity in ${table}`);
      ids.add(id);
    }
  }
}

// Owner-only restore primitive, intentionally NOT a browser-accessible RPC.
// Call inside a transaction after validating the envelope and the target URL.
export async function restoreSnapshot(db, snapshot) {
  validateSnapshot(snapshot);
  const version=(await db.query('select max(version) as version from horsebook.schema_version')).rows[0].version;
  if((snapshot.schema_version??1)>version) throw new Error('Snapshot requires newer database migrations');
  await db.query("select pg_advisory_xact_lock(hashtextextended('horsebook.business-write',0))");
  for (const table of tables) {
    const { rows }=await db.query(`select exists(select 1 from horsebook.${table}) as populated`);
    if(rows[0].populated) throw new Error(`Restore requires an empty database: ${table} contains records`);
  }
  await db.query("select set_config('horsebook.restoring','on',true)");
  await db.query('set constraints all deferred');
  for (const table of tables) {
    if(!Object.hasOwn(snapshot.data,table))continue;
    const rows=table==='lessons'?snapshot.data.lessons.map(row=>{
      const oldSeries=snapshot.data.series.find(s=>s.id===row.series_id);
      const last=Boolean(oldSeries&&!oldSeries.stopped&&!snapshot.data.lessons.some(l=>l.series_id===row.series_id&&l.occurrence_date>row.occurrence_date));
      return {...row,series_id:null,occurrence_date:null,is_last_in_series:row.is_last_in_series??last};
    }):snapshot.data[table];
    await db.query(`insert into horsebook.${table} select * from jsonb_populate_recordset(null::horsebook.${table}, $1::jsonb)`,[JSON.stringify(rows)]);
  }
  const { rows }=await db.query('select horsebook.integrity() as problems');
  if(rows[0].problems.length) throw new Error(`Restored database failed integrity checks: ${JSON.stringify(rows[0].problems)}`);
  await db.query('set constraints all immediate');
  await db.query("select set_config('horsebook.restoring','off',true)");
}
