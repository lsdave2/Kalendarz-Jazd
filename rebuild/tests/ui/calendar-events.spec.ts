import {test,expect} from '@playwright/test';
import {mouseDrag,touchDrag} from './gestures';

for(const width of [390,916])test(`calendar events create, edit, drag, swipe and delete independently at ${width}px`,async({page,request},testInfo)=>{
  test.setTimeout(60000);await page.setViewportSize({width,height:844});
  const rpc=async(name:string,args:Record<string,unknown>={})=>{
    const response=await request.post('/test-api/rpc',{data:{name,args}});expect(response.ok()).toBeTruthy();return (await response.json()).result;
  };
  const current=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
  const prior=new Date(current+'T12:00:00Z');prior.setUTCDate(prior.getUTCDate()-1);
  const date=prior.toISOString().slice(0,10),description=`Wizyta weterynarza ${width}`;
  const before=await rpc('hb_export_snapshot'),reviewCount=await rpc('hb_review_count',{p_through:date});
  await page.goto('/#calendar/'+date);
  await expect(page.getByRole('button',{name:'Dodaj lekcję'})).toBeEnabled();
  await page.getByRole('button',{name:'Dodaj lekcję'}).click();
  await expect(page.getByLabel('Rodzaj wpisu')).toHaveValue('ride');
  await expect(page.getByLabel('Rodzaj wpisu').locator('option:checked')).toHaveText('Nowa jazda');
  await expect(page.getByRole('dialog')).toHaveCSS('transform','none');
  const sheet=(await page.getByRole('dialog').elementHandle())!;
  const openingAnimation=await sheet.evaluateHandle(el=>el.getAnimations()[0]);
  await page.getByLabel('Rodzaj wpisu').focus();
  await page.getByLabel('Rodzaj wpisu').selectOption('event');
  for(const kind of ['ride','event']){
    await page.getByLabel('Rodzaj wpisu').selectOption(kind);
    expect(await sheet.evaluate(el=>el.isConnected&&el===document.querySelector('[role="dialog"]'))).toBeTruthy();
    expect(await openingAnimation.evaluate(previous=>document.querySelector('[role="dialog"]')!.getAnimations()[0]===previous)).toBeTruthy();
    await expect(page.getByLabel('Rodzaj wpisu')).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(1);
  }
  await sheet.dispose();await openingAnimation.dispose();
  const modal=page.getByRole('dialog',{name:'Nowe wydarzenie'});
  await expect(modal).toBeVisible();await expect(modal.locator('input')).toHaveCount(0);
  await expect(modal.getByLabel('Opis')).toHaveAttribute('required','');
  expect(await modal.getByLabel('Czas rozpoczęcia').locator('option').allTextContents()).toEqual(Array.from({length:52},(_,i)=>`${String(8+Math.floor(i/4)).padStart(2,'0')}:${String(i%4*15).padStart(2,'0')}`));
  await modal.getByLabel('Czas rozpoczęcia').selectOption('10:15');await modal.getByLabel('Czas zakończenia').selectOption('11:30');
  await modal.getByLabel('Opis').fill(description);await modal.getByRole('button',{name:'Utwórz'}).click();
  await expect(modal).toHaveCount(0);
  const tile=page.getByRole('button',{name:`Edytuj wydarzenie ${description} o 10:15`,exact:true});
  await expect(tile).toBeVisible();await expect(tile).toHaveClass(/calendar-event-tile/);await expect(tile).toHaveCSS('border-top-style','dashed');
  await expect(tile).toContainText('Wydarzenie');await expect(tile).toContainText('10:15–11:30');
  // An overlapping ride remains alongside the event instead of being covered by it.
  const eventBox=(await tile.boundingBox())!,ride=page.locator('.lesson-tile:not(.calendar-event-tile)').filter({hasText:'Grupowa'}).first(),rideBox=(await ride.boundingBox())!;
  expect(eventBox.x>=rideBox.x+rideBox.width-1||rideBox.x>=eventBox.x+eventBox.width-1).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath(`calendar-events-${width}.png`)});
  await tile.click();await expect(page.getByRole('dialog',{name:'Edytuj wydarzenie'})).toBeVisible();
  await page.getByLabel('Opis').fill(description+' — poprawione');await page.getByRole('button',{name:'Aktualizuj'}).click();
  const changed=page.getByRole('button',{name:`Edytuj wydarzenie ${description} — poprawione o 10:15`,exact:true});await expect(changed).toBeVisible();
  const height=await page.locator('.hour-line:not(.half-hour)').nth(1).evaluate(n=>parseFloat((n as HTMLElement).style.top));
  const rect=(await changed.boundingBox())!;await mouseDrag(page,rect.x+rect.width/2,rect.y+20,0,height/2);
  const moved=page.getByRole('button',{name:`Edytuj wydarzenie ${description} — poprawione o 10:45`,exact:true});
  await expect(moved).toBeVisible();await expect(moved).toContainText('10:45–12:00');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();await expect(moved).toBeVisible();await moved.click();
  await expect(page.getByRole('dialog')).toHaveCSS('transform','none');
  const handle=(await page.locator('.modal-handle').boundingBox())!;await mouseDrag(page,handle.x+handle.width/2,handle.y+handle.height/2,0,125);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const swipeBox=(await moved.boundingBox())!;await mouseDrag(page,swipeBox.x+swipeBox.width/2,swipeBox.y+20,-80,0);
  await expect(page).not.toHaveURL(new RegExp(date));await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/#calendar/'+date);await expect(moved).toBeVisible();await moved.click();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Usuń wydarzenie',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(moved).toHaveCount(0);
  const after=await rpc('hb_export_snapshot');
  for(const table of ['accounts','credit_entries','decisions','bookings','lessons'])expect(after.data[table]).toEqual(before.data[table]);
  expect(await rpc('hb_review_count',{p_through:date})).toBe(reviewCount);
  const audit=after.data.audit_events.filter((x:any)=>x.table_name==='events'&&(x.after_row?.description===description||x.before_row?.description===description||x.after_row?.description===description+' — poprawione'||x.before_row?.description===description+' — poprawione'));
  expect(audit).toHaveLength(4);expect(audit.filter((x:any)=>x.before_row===null)).toHaveLength(1);expect(audit.filter((x:any)=>x.after_row===null)).toHaveLength(1);
});

test('event touch hold moves both times and a lost response retries once without duplicate audit',async({page,request})=>{
  const rpc=async(name:string,args:Record<string,unknown>={})=>{
    const response=await request.post('/test-api/rpc',{data:{name,args}});expect(response.ok()).toBeTruthy();return (await response.json()).result;
  };
  const date='2026-10-08',id=crypto.randomUUID(),description='Touch event';
  const saved=await rpc('hb_save_event',{p_operation_id:crypto.randomUUID(),p_expected_revision:null,p_event:{id,date,start_minute:780,end_minute:825,description}});
  const moves:any[]=[];let loseResponse=true;
  await page.route('**/test-api/rpc',async route=>{
    const body=route.request().postDataJSON();if(body.name!=='hb_move_event_time'){await route.continue();return;}
    moves.push(body.args);if(loseResponse){loseResponse=false;await route.fetch();await route.abort('failed');return;}await route.continue();
  });
  await page.goto('/#calendar/'+date);
  const tile=page.getByRole('button',{name:`Edytuj wydarzenie ${description} o 13:00`,exact:true});await expect(tile).toBeVisible();
  await expect(page.locator('.toggle-day-status')).toBeEnabled();
  const height=await page.locator('.hour-line:not(.half-hour)').nth(1).evaluate(n=>parseFloat((n as HTMLElement).style.top));
  const drag=async()=>{const rect=(await tile.boundingBox())!;await touchDrag(page,rect.x+rect.width/2,rect.y+20,0,height/2,550);};
  await drag();await expect(page.getByRole('status')).toBeVisible();await expect(page.locator('.calendar-event-tile.dragging')).toHaveCount(0);await expect(tile).toBeVisible();await expect(page.locator('.toggle-day-status')).toBeEnabled();
  await drag();const moved=page.getByRole('button',{name:`Edytuj wydarzenie ${description} o 13:30`,exact:true});await expect(moved).toBeVisible();await expect(moved).toContainText('13:30–14:15');
  expect(moves).toHaveLength(2);expect(moves[0]).toEqual(moves[1]);
  const snapshot=await rpc('hb_export_snapshot');expect(snapshot.data.events.find((x:any)=>x.id===id)).toMatchObject({start_minute:810,end_minute:855,revision:saved.revision+1});
  const audit=snapshot.data.audit_events.filter((x:any)=>x.operation_id===moves[0].p_operation_id);expect(audit).toHaveLength(1);
  const rect=(await moved.boundingBox())!;await touchDrag(page,rect.x+rect.width/2,rect.y+20,-80,0);
  await expect(page).not.toHaveURL(new RegExp(date));await expect(page.getByRole('dialog')).toHaveCount(0);
  await rpc('hb_delete_event',{p_operation_id:crypto.randomUUID(),p_event_id:id,p_expected_revision:saved.revision+1});
});
