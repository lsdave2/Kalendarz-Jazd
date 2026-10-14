import {test,expect} from '@playwright/test';
import {mouseDrag} from './gestures';

test('a lost drag response retries the same transaction, persists the new time and retains one audited move',async({page,request})=>{
  const rpc=async(name:string,args:Record<string,unknown>={})=>{
    const response=await request.post('/test-api/rpc',{data:{name,args}});
    expect(response.ok()).toBeTruthy();return (await response.json()).result;
  };
  const current=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
  const prior=new Date(current+'T12:00:00Z');prior.setUTCDate(prior.getUTCDate()-1);
  const date=prior.toISOString().slice(0,10),refs=await rpc('hb_references');
  const id=crypto.randomUUID(),bookingId=crypto.randomUUID();
  const saved=await rpc('hb_save_lesson',{p_operation_id:crypto.randomUUID(),p_expected_revision:null,
    p_lesson:{id,date,start_minute:780,duration_minutes:60,kind:'individual',title:'Drag retry',notes:'Preserve these notes',
      bookings:[{id:bookingId,client_id:refs.clients[0].id,billing_mode:'cash',cash_amount:175,attendance:'attended'}]}});
  const moves:any[]=[];let loseResponse=true;
  await page.route('**/test-api/rpc',async route=>{
    const body=route.request().postDataJSON();
    if(body.name!=='hb_move_lesson_time'){await route.continue();return;}
    moves.push(body.args);
    if(loseResponse){loseResponse=false;await route.fetch();await route.abort('failed');return;}
    await route.continue();
  });
  await page.goto('/#calendar/'+date);
  const tile=page.getByRole('button',{name:'Edytuj lekcję Drag retry o 13:00',exact:true});
  await expect(tile).toBeVisible();await expect(page.locator('.toggle-day-status')).toBeEnabled();
  const height=await page.locator('.hour-line:not(.half-hour)').nth(1).evaluate(n=>parseFloat((n as HTMLElement).style.top));
  const drag=async()=>{const rect=(await tile.boundingBox())!;await mouseDrag(page,rect.x+rect.width/2,rect.y+20,0,height);};
  await drag();await expect(page.getByRole('status')).toBeVisible();
  await expect(page.locator('.lesson-tile.dragging')).toHaveCount(0);await expect(tile).toBeVisible();
  await expect(page.locator('.toggle-day-status')).toBeEnabled();
  await drag();
  const moved=page.getByRole('button',{name:'Edytuj lekcję Drag retry o 14:00',exact:true});
  await expect(moved).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(moves).toHaveLength(2);expect(moves[0]).toEqual(moves[1]);
  expect(moves[0]).toMatchObject({p_lesson_id:id,p_expected_revision:saved.revision,p_start_minute:840});
  await page.reload();await expect(moved).toBeVisible();
  const snapshot=await rpc('hb_export_snapshot'),lesson=snapshot.data.lessons.find((x:any)=>x.id===id);
  expect(lesson).toMatchObject({start_minute:840,revision:saved.revision+1,notes:'Preserve these notes',date});
  const booking=snapshot.data.bookings.find((x:any)=>x.id===bookingId);
  expect(booking).toMatchObject({client_id:saved.bookings[0].client_id,billing_mode:'cash',cash_amount:175,attendance:'attended',removed:false});
  expect(snapshot.data.credit_entries.filter((x:any)=>x.booking_id===bookingId)).toHaveLength(0);
  const audit=snapshot.data.audit_events.filter((x:any)=>x.operation_id===moves[0].p_operation_id&&x.table_name==='lessons');
  expect(audit).toHaveLength(1);expect(audit[0].before_row.start_minute).toBe(780);expect(audit[0].after_row.start_minute).toBe(840);
});
