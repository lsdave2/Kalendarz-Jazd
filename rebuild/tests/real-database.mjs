// Tests use an isolated randomly named schema/functions on the NEW project.
// No test query can address the live horsebook schema through this adapter.
import {randomUUID} from 'node:crypto';
import {config,assertNewProject,connect} from '../scripts/config.mjs';
export async function isolatedPostgres(migration) {
  const cfg=await config();assertNewProject(cfg.DATABASE_URL);
  const suffix=randomUUID().replaceAll('-','').slice(0,12), schema=`horsebook_test_${suffix}`,prefix=`hb_test_${suffix}_`;
  const db=await connect(cfg.DATABASE_URL);
  function transform(sql) {
    return sql.replaceAll('schema horsebook',`schema ${schema}`)
      .replaceAll('horsebook.',`${schema}.`).replaceAll(`'${schema}.snapshot'`,"'horsebook.snapshot'")
      .replaceAll('public.hb_',`public.${prefix}`)
      .replaceAll("'hb_health'",`'${prefix}health'`).replaceAll("'hb_calendar'",`'${prefix}calendar'`)
      .replace("p.proname like 'hb\\_%' escape '\\'",`left(p.proname,${prefix.length})='${prefix}'`);
  }
  const api={
    schema,prefix,connection:cfg.DATABASE_URL,
    async query(sql,args=[]){return db.query(transform(sql),args);},
    async exec(sql){return db.query(transform(sql));},
    async transaction(fn){await db.query('begin');try {const result=await fn(api);await db.query('commit');return result;}
      catch(e){await db.query('rollback');throw e;}},
    async close(){
      await db.query('reset role');
      const functions=await db.query("select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and left(p.proname,$1)=$2",[prefix.length,prefix]);
      for(const f of functions.rows) await db.query(`drop function ${f.signature}`);
      await db.query(`drop schema ${schema} cascade`);
      await db.end();
    },
    async session(user){
      const peer=await connect(cfg.DATABASE_URL);
      await peer.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await peer.query('set role authenticated');
      return {query:(sql,args)=>peer.query(transform(sql),args),end:()=>peer.end()};
    }
  };
  await api.transaction(()=>api.exec(migration));
  return api;
}
