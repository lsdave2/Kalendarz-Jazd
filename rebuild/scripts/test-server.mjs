// Explicit loopback-only integration fixture. Never used by production builds.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fresh,asUser,admin,rpc,client,lesson,save} from '../tests/harness.mjs';
const db=await fresh();await asUser(db,admin);
const alice=await client(db,'Anna Test'),bob=await client(db,'Jan Test');
const horse=await rpc(db,'hb_save_reference',{p_operation_id:randomUUID(),p_kind:'horses',p_expected_revision:null,p_record:{name:'Rubin'}});
const instructor=await rpc(db,'hb_save_reference',{p_operation_id:randomUUID(),p_kind:'instructors',p_expected_revision:null,p_record:{name:'Ania',color:'#FF5722'}});
const current=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
const prior=new Date(current+'T12:00:00Z');prior.setUTCDate(prior.getUTCDate()-1);
const yesterday=prior.toISOString().slice(0,10);
const draft=lesson(alice.id,{date:yesterday,kind:'group',title:'Grupa testowa',instructor_id:instructor.id});
draft.bookings[0].horse_id=horse.id;draft.bookings.push({id:randomUUID(),client_id:bob.id,billing_mode:'package',units:1,attendance:'no_show'});
await save(db,draft);
const allowed=new Set(['hb_health','hb_calendar','hb_references','hb_review_queue','hb_review_count','hb_review_credits','hb_save_lesson','hb_delete_lesson','hb_move_lesson_time',
  'hb_cancel_lesson','hb_create_series','hb_duplicate_lesson','hb_stop_series','hb_save_reference','hb_adjust_credits','hb_history',
  'hb_save_setting','hb_finances','hb_save_finance','hb_integrity','hb_export_snapshot','hb_save_event','hb_move_event_time','hb_delete_event']);
let queue=Promise.resolve();
const server=createServer((req,res)=>{
  const origin=req.headers.origin;
  if(origin&&!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)){res.writeHead(403);res.end();return;}
  if(req.url==='/health'&&req.method==='GET'){res.writeHead(200);res.end('ready');return;}
  if(req.url!=='/test-api/rpc'||req.method!=='POST'){res.writeHead(404);res.end();return;}
  let body='';req.on('data',chunk=>{body+=chunk;if(body.length>2_000_000)req.destroy();});
  req.on('end',()=>{queue=queue.catch(()=>{}).then(async()=>{
    res.setHeader('Content-Type','application/json');
    try{const {name,args}=JSON.parse(body);if(!allowed.has(name))throw new Error('Unknown operation');
      const result=await rpc(db,name,args);res.end(JSON.stringify({result}));
    }catch(e){res.statusCode=400;res.end(JSON.stringify({message:e.message,code:e.code}));}
  });});
});
server.listen(4319,'127.0.0.1',()=>console.log('Isolated PostgreSQL UI fixture listening on 127.0.0.1:4319'));
async function stop(){server.close();await db.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
