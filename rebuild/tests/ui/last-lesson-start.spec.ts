import {test,expect} from '@playwright/test';
import {chooseTime} from './time-picker';

test('last created lesson time is reused across months, reloads and browsers while cancelled drafts and edits leave it alone',async({page,request,browser})=>{
  const rpc=async(name:string,args:Record<string,unknown>={})=>{
    const response=await request.post('/test-api/rpc',{data:{name,args}});expect(response.ok()).toBeTruthy();return (await response.json()).result;
  };
  const refs=await rpc('hb_references');
  const seed=await rpc('hb_save_lesson',{p_operation_id:crypto.randomUUID(),p_expected_revision:null,p_lesson:{
    id:crypto.randomUUID(),date:'2028-01-05',start_minute:1050,duration_minutes:60,kind:'individual',
    bookings:[{id:crypto.randomUUID(),client_id:refs.clients[0].id,billing_mode:'cash',cash_amount:140}]}});
  await page.goto('/#calendar/2026-11-20');
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await expect(page.getByLabel('Czas rozpoczęcia',{exact:true})).toContainText('17:30');
  await chooseTime(page,'Czas rozpoczęcia','08:15');
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();
  await page.reload();await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await expect(page.getByLabel('Czas rozpoczęcia',{exact:true})).toContainText('17:30');
  await page.getByRole('button',{name:'Grupowa',exact:true}).click();
  await expect(page.getByLabel('Czas rozpoczęcia',{exact:true})).toContainText('17:30');
  await rpc('hb_move_lesson_time',{p_operation_id:crypto.randomUUID(),p_lesson_id:seed.id,p_expected_revision:seed.revision,p_start_minute:840});
  const context=await browser.newContext();
  try{
    const other=await context.newPage();await other.goto('http://127.0.0.1:5175/#calendar/2027-03-10');
    await other.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
    await expect(other.getByLabel('Czas rozpoczęcia',{exact:true})).toContainText('17:30');
  }finally{await context.close();}
});

test('remembered times outside the current schedule are clamped to an available quarter hour',async({page})=>{
  await page.route('**/test-api/rpc',async route=>{
    const {name}=route.request().postDataJSON();
    const settings=[{key:'schedule_hours',value:{start:9,end:17},revision:1}];
    const result=name==='hb_health'?{admin:true,schema_version:1}:name==='hb_references'?{clients:[],horses:[],instructors:[],settings,last_lesson_start_minute:1290}:
      name==='hb_calendar'?{lessons:[],events:[],settings}:0;
    await route.fulfill({json:{result}});
  });
  await page.goto('/#calendar/2026-11-20');await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await expect(page.getByLabel('Czas rozpoczęcia',{exact:true})).toContainText('16:45');
});
