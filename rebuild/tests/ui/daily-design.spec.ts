import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {mouseDrag,touchDrag} from './gestures';

const date='2026-10-08',fixedNow=new Date('2026-10-08T10:00:00Z');
test.use({timezoneId:'Europe/Warsaw'});
function fixture(){
  const refs={clients:[{id:'anna',name:'Anna Test',archived:false,account:{balance:6}},{id:'jan',name:'Jan Test',archived:false,account:{balance:-2}}],
    horses:[{id:'rubin',name:'Rubin'}],instructors:[{id:'ania',name:'Ania',color:'#34d399'}],settings:[]};
  const booking=(id:string,client_id:string)=>({id,client_id,client_name:client_id==='anna'?'Anna Test':'Jan Test',horse_id:'rubin',horse_name:'Rubin',
    instructor_id:'ania',instructor_name:'Ania',billing_mode:'package',removed:false,units:1,review_status:'pending',attendance:'unknown',revision:1});
  const lesson=(id:string,start:number,duration:number,kind:string,bookings:any[],status='scheduled')=>({id,date,start_minute:start,duration_minutes:duration,kind,bookings,
    title:kind==='individual'?bookings[0].client_name:'Nazwa grupy',status,instructor_id:'ania',instructor_name:'Ania',instructor_color:'#34d399',revision:1,notes:''});
  const lessons=[lesson('individual',540,60,'individual',[booking('a','anna')]),
    lesson('group',570,60,'group',[booking('b','anna'),booking('c','jan')]),
    lesson('cancelled',585,45,'individual',[booking('d','jan')],'cancelled'),
    lesson('custom',660,60,'custom',[{...booking('e','anna'),billing_mode:'cash'},{...booking('f','jan'),billing_mode:'cash'}])];
  return {refs,lessons,settings:[] as any[],pendingReviews:0,reviewUnavailable:false,moves:[] as any[],moveFailure:null as {code:string;message:string}|null};
}
async function mockCalendar(page:Page,state:ReturnType<typeof fixture>,freeze=false){
  await page.clock.install({time:fixedNow});
  if(freeze)await page.clock.setFixedTime(fixedNow);
  await page.route('**/test-api/rpc',async route=>{
    const {name,args}=route.request().postDataJSON();
    let result:unknown;
    if(name==='hb_health')result={admin:true,schema_version:1};
    else if(name==='hb_calendar')result={lessons:state.lessons,settings:state.settings};
    else if(name==='hb_references')result={...state.refs,settings:state.settings};
    else if(name==='hb_review_count'){
      if(state.reviewUnavailable){await route.fulfill({status:503,json:{message:'Review count unavailable'}});return;}
      result=state.pendingReviews;
    }
    else if(name==='hb_move_lesson_time'){
      state.moves.push(args);
      if(state.moveFailure){await route.fulfill({status:409,json:state.moveFailure});return;}
      const lesson=state.lessons.find(l=>l.id===args.p_lesson_id)!;
      lesson.start_minute=args.p_start_minute;lesson.revision++;result=lesson;
    }
    else if(name==='hb_save_setting'){
      const record={key:args.p_key,value:args.p_value,revision:(args.p_expected_revision??0)+1};
      state.settings=state.settings.filter(s=>s.key!==record.key).concat(record);result=record;
    }else{await route.continue();return;}
    await route.fulfill({json:{result}});
  });
  await page.goto('/#calendar/'+date);
  await expect(page.locator('.toggle-day-status')).toBeEnabled();
  await page.addStyleTag({content:'.page {animation:none;}'});
  await page.evaluate(()=>document.fonts.ready);
}

// Render the original day-view functions with fixture data and no store/network.
// Comparing with the actual legacy source catches spacing/markup drift.
async function legacyReference(page:Page,state:ReturnType<typeof fixture>){
  const source=await readFile(new URL('../../../src/views/CalendarView.js',import.meta.url),'utf8');
  const constants=source.slice(source.indexOf('const DAY_SCHEDULE_SLOT_HEIGHT'),source.indexOf('// ── State'));
  const minimum=source.slice(source.indexOf('function calculateLessonMinHeight'),source.indexOf('export function buildMonthView'));
  const body=source.slice(source.indexOf('export function buildDayView'),source.indexOf('function makeDraggable')).replace('export function','function');
  const image=(await readFile(new URL('../../../src/assets/horse head icon.png',import.meta.url))).toString('base64');
  const css=(await readFile(new URL('../../../src/style.css',import.meta.url),'utf8')).replaceAll('url("./assets/horse%20head%20icon.png")',`url("data:image/png;base64,${image}")`);
  await page.clock.install({time:fixedNow});
  await page.clock.setFixedTime(fixedNow);
  const index=await readFile(new URL('../../../index.html',import.meta.url),'utf8');
  const fontLinks=index.match(/<link[^>]+>/g)!.join('');
  await page.setContent(`<!doctype html><html><head>${fontLinks}</head><body><div id="app"><header class="app-header"><h1>Calendar</h1></header><main class="page"></main></div></body></html>`);
  await page.addStyleTag({content:css+'\n.page {animation:none;}'});
  await page.evaluate(({state,date,script})=>{
    const el=(tag:string,attrs:any={},...children:any[])=>{
      const node=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){
        if(key==='className')node.className=value as string;else if(key==='style')Object.assign(node.style,value);
        else if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value as EventListener);
        else node.setAttribute(key,String(value));
      }for(const child of children){if(typeof child==='string')node.appendChild(document.createTextNode(child));else if(child)node.appendChild(child);}return node;
    };
    const icon=(name:string)=>name==='horse'?el('span',{className:'horse-icon'}):el('span',{className:'material-symbols-rounded'},name);
    const monthName=(month:number)=>['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'][month];
    const parseDate=(date:string)=>new Date(date+'T00:00:00');
    const isCustomLessonRecord=(l:any)=>l.lessonType==='custom';
    const isGroupLessonRecord=(l:any)=>!isCustomLessonRecord(l)&&l.participants.length>0;
    const getLessonDisplayName=(l:any)=>isGroupLessonRecord(l)?'Grupowa':isCustomLessonRecord(l)?'Niestandardowa':l.title;
    const translated:any={closed:'Zamknięte',open:'Otwarte',markDayOpen:'Oznacz dzień jako otwarty',markDayClosed:'Oznacz dzień jako zamknięty',fullDay_4:'Czwartek'};
    const oldLessons=state.lessons.map(l=>({...l,startMinute:l.start_minute,durationMinutes:l.duration_minutes,
      instructor:l.instructor_name,horse:l.bookings[0]?.horse_name,lessonType:l.kind==='custom'?'custom':undefined,
      cancelledDates:l.status==='cancelled'?[date]:[],packageMode:true,
      participants:l.kind==='individual'?[]:l.bookings.map(b=>({name:b.client_name,horse:b.horse_name,instructor:b.instructor_name,packageMode:b.billing_mode==='package'}))}));
    const env={el,icon,monthName,parseDate,isCustomLessonRecord,isGroupLessonRecord,getLessonDisplayName,
      t:(key:string,args:any)=>key==='packageLabel'?`Karnet: [${args.count}]`:key==='packageLabelShort'?`[${args.count}]`:translated[key],
      isAdmin:()=>true,isToday:()=>true,isDateClosed:()=>false,getSettings:()=>({}),getDayScheduleHours:()=>({startHour:8,endHour:21}),
      getLessonParticipants:(l:any)=>l.participants,getLessonsForDate:()=>oldLessons,
      getData:()=>({instructors:state.refs.instructors,packages:state.refs.clients.map(c=>({name:c.name,active:!c.archived,credits:c.account.balance}))}),
      calendarState:{selectedDate:date},render:()=>{},toggleClosedDate:()=>{},openLessonModal:()=>{},makeDraggable:()=>{},navDay:()=>{},buildSyncIndicator:()=>document.createDocumentFragment()};
    const make=new Function('env','date',`const {${Object.keys(env).join(',')}}=env; ${script}; return buildDayView(date);`);
    document.querySelector('main')!.appendChild(make(env,date));
  },{state,date,script:constants+minimum+body});
  await page.evaluate(()=>document.fonts.ready);
}
async function geometry(page:Page){
  return page.evaluate(()=>{
    const schedule=document.querySelector('.day-schedule')!.getBoundingClientRect();
    const selectors=['.hour-label','.hour-line','.quarter-line','.lesson-cluster','.lesson-column','.lesson-tile','.tile-title','.tile-meta','.tile-participant','.time-indicator'];
    return Object.fromEntries(selectors.map(selector=>[selector,Array.from(document.querySelectorAll<HTMLElement>(selector)).map(node=>{
      const rect=node.getBoundingClientRect(),css=getComputedStyle(node);
      const hidden=rect.width===0&&rect.height===0;
      return {x:hidden?0:rect.x-schedule.x,y:hidden?0:rect.y-schedule.y,width:rect.width,height:rect.height,text:node.textContent,
        padding:css.padding,border:css.border,borderRadius:css.borderRadius,background:css.backgroundImage,fontSize:css.fontSize,fontWeight:css.fontWeight,color:css.color,opacity:css.opacity,filter:css.filter};
    })]));
  });
}
for(const width of [390,916])test(`daily grid and lesson tiles match the original at ${width}px`,async({page,context})=>{
  await page.setViewportSize({width,height:844});const state=fixture();await mockCalendar(page,state,true);
  const reference=await context.newPage();await reference.setViewportSize({width,height:844});
  try{
    await legacyReference(reference,state);
    const actual=await geometry(page),expected=await geometry(reference);
    // Chromium can round equivalent inline/flex layouts to adjacent 1/64px
    // values. Keep text and styles exact, and allow only that rounding in bounds.
    for(const selector of Object.keys(expected)){
      expect(actual[selector]).toHaveLength(expected[selector].length);
      expected[selector].forEach((row,index)=>{
        const found=actual[selector][index];
        for(const key of ['x','y','width','height'] as const)expect(Math.abs(found[key]-row[key])).toBeLessThanOrEqual(1/64);
        expect({...found,x:0,y:0,width:0,height:0}).toEqual({...row,x:0,y:0,width:0,height:0});
      });
    }
    await page.screenshot({path:`test-results/daily-restored-${width}.png`,fullPage:true});
    await reference.screenshot({path:`test-results/daily-original-${width}.png`,fullPage:true});
  }finally{await reference.close();}
  const review=await page.getByRole('button',{name:'Przejrzyj kredyty'}).boundingBox(),toggle=await page.locator('.toggle-day-status').boundingBox();
  expect(review!.width).toBe(review!.height);
  expect(review!.x+review!.width).toBeLessThan(toggle!.x);
  expect(review!.y+review!.height/2).toBe(toggle!.y+toggle!.height/2);
});

test('live time line advances; status toggle uses a focused save and back arrow opens the month',async({page})=>{
  const state=fixture();state.lessons=[];await mockCalendar(page,state);
  await expect(page.locator('.app-header')).toHaveCount(0);
  await expect(page.locator('.day-header h2')).toHaveText('8 Październik 2026');
  await expect(page.locator('.day-subtitle')).toHaveText('Czwartek');
  const line=page.locator('.time-indicator'),before=await line.evaluate(node=>parseFloat((node as HTMLElement).style.top));
  await expect(page.locator('.time-indicator-dot')).toHaveCSS('animation-name','time-pulse');
  await page.clock.fastForward(60_000);
  await expect.poll(()=>line.evaluate(node=>parseFloat((node as HTMLElement).style.top))).toBeGreaterThan(before);
  const closed=page.getByRole('button',{name:'Oznacz dzień jako zamknięty'});
  await closed.click();await expect(page.locator('.toggle-day-status')).toHaveAttribute('aria-pressed','true');
  expect(state.settings.find(s=>s.key==='closed_dates').value).toEqual([date]);
  await page.getByRole('button',{name:'Oznacz dzień jako otwarty'}).click();await expect(page.locator('.toggle-day-status')).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'Widok miesiąca',exact:true}).click();
  await expect(page.locator('.calendar-grid')).toBeVisible();await expect(line).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
});

test('horizontal mouse drags change days; short/vertical drags and ordinary lesson clicks retain their behavior',async({page})=>{
  await mockCalendar(page,fixture());
  await mouseDrag(page,280,430,-130,0);await expect(page).toHaveURL(/#calendar\/2026-10-09$/);
  await expect(page.locator('.toggle-day-status')).toBeEnabled();
  await mouseDrag(page,140,430,130,0);await expect(page).toHaveURL(/#calendar\/2026-10-08$/);
  await expect(page.locator('.toggle-day-status')).toBeEnabled();
  await mouseDrag(page,280,430,-40,0);await expect(page).toHaveURL(/#calendar\/2026-10-08$/);
  await mouseDrag(page,280,430,10,-120);await expect(page).toHaveURL(/#calendar\/2026-10-08$/);
  const tile=page.locator('.lesson-tile').first(),rect=(await tile.boundingBox())!;
  await mouseDrag(page,rect.x+rect.width-10,rect.y+15,-100,0);
  await expect(page).toHaveURL(/#calendar\/2026-10-09$/);await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.toggle-day-status')).toBeEnabled();
  await mouseDrag(page,140,430,130,0);await expect(page).toHaveURL(/#calendar\/2026-10-08$/);
  await tile.click();await expect(page.getByRole('dialog',{name:'Edytuj lekcję'})).toBeVisible();
});

test.describe('native touch calendar gestures',()=>{
  test.use({hasTouch:true});
  test('swipes over lessons navigate without editing, while vertical touch scrolling and taps still work',async({page})=>{
    await mockCalendar(page,fixture());
    const tile=page.locator('.lesson-tile').first(),rect=(await tile.boundingBox())!;
    await touchDrag(page,rect.x+rect.width-10,rect.y+15,-110,0);
    await expect(page).toHaveURL(/#calendar\/2026-10-09$/);await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.toggle-day-status')).toBeEnabled();
    await touchDrag(page,140,430,130,0);await expect(page).toHaveURL(/#calendar\/2026-10-08$/);
    await expect(page.locator('.toggle-day-status')).toBeEnabled();
    await touchDrag(page,280,430,-35,0);await expect(page).toHaveURL(/#calendar\/2026-10-08$/);
    await touchDrag(page,280,500,0,-220);
    await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBeGreaterThan(0);
    await expect(page).toHaveURL(/#calendar\/2026-10-08$/);await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(()=>window.scrollTo(0,0));
    await tile.tap();await expect(page.getByRole('dialog',{name:'Edytuj lekcję'})).toBeVisible();
  });
  test('holding a lesson arms touch rescheduling, while a quick vertical gesture scrolls without saving',async({page})=>{
    const state=fixture();await mockCalendar(page,state);
    const tile=page.getByRole('button',{name:'Edytuj lekcję Anna Test o 09:00',exact:true});
    const rect=(await tile.boundingBox())!,x=rect.x+rect.width/2,y=rect.y+20;
    const slotHeight=await page.locator('.hour-line:not(.half-hour)').nth(1).evaluate(n=>parseFloat((n as HTMLElement).style.top));
    await touchDrag(page,x,y,0,slotHeight/2,550);
    await expect(page.getByRole('button',{name:'Edytuj lekcję Anna Test o 09:30',exact:true})).toBeVisible();
    expect(state.moves).toHaveLength(1);expect(state.moves[0]).toMatchObject({p_lesson_id:'individual',p_expected_revision:1,p_start_minute:570});
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page).toHaveURL(/#calendar\/2026-10-08$/);
    const moved=page.getByRole('button',{name:'Edytuj lekcję Anna Test o 09:30',exact:true}),newRect=(await moved.boundingBox())!;
    await touchDrag(page,newRect.x+newRect.width/2,newRect.y+20,0,-130);
    await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBeGreaterThan(0);
    expect(state.moves).toHaveLength(1);await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test('mouse lesson drag previews and snaps time, sends only its identity/revision/time, and rolls back rejected moves',async({page})=>{
  const state=fixture();await mockCalendar(page,state);
  const tile=page.getByRole('button',{name:'Edytuj lekcję Anna Test o 09:00',exact:true}),rect=(await tile.boundingBox())!;
  const slotHeight=await page.locator('.hour-line:not(.half-hour)').nth(1).evaluate(n=>parseFloat((n as HTMLElement).style.top));
  const x=rect.x+rect.width/2,y=rect.y+20;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+slotHeight*.7,{steps:12});
  await expect(tile).toHaveClass(/dragging/);expect(state.moves).toHaveLength(0);
  await page.mouse.up();
  const moved=page.getByRole('button',{name:'Edytuj lekcję Anna Test o 09:45',exact:true});
  await expect(moved).toBeVisible();await expect(page.locator('.lesson-tile.dragging')).toHaveCount(0);
  expect(state.moves).toHaveLength(1);
  expect(Object.keys(state.moves[0]).sort()).toEqual(['p_expected_revision','p_lesson_id','p_operation_id','p_start_minute']);
  expect(state.moves[0]).toMatchObject({p_lesson_id:'individual',p_expected_revision:1,p_start_minute:585});
  expect(state.lessons.find(l=>l.id==='group')!.start_minute).toBe(570);
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page).toHaveURL(/#calendar\/2026-10-08$/);
  state.moveFailure={code:'40001',message:'Lesson changed'};
  const movedRect=(await moved.boundingBox())!;
  await mouseDrag(page,movedRect.x+movedRect.width/2,movedRect.y+20,0,slotHeight/2);
  await expect(page.getByRole('status')).toContainText('Dane zmienił inny administrator');
  await expect(page.locator('.lesson-tile.dragging')).toHaveCount(0);await expect(moved).toBeVisible();
  expect(state.moves[1]).toMatchObject({p_expected_revision:2,p_start_minute:615});
  const cancelled=page.getByRole('button',{name:'Edytuj lekcję Jan Test o 09:45',exact:true}),cancelledRect=(await cancelled.boundingBox())!;
  await mouseDrag(page,cancelledRect.x+cancelledRect.width/2,cancelledRect.y+20,0,slotHeight/2);
  expect(state.moves).toHaveLength(2);
});

test('same-slot drags and cancelled gestures do not save; upward drags stop at the first visible hour',async({page})=>{
  const state=fixture();state.lessons=state.lessons.slice(0,1);await mockCalendar(page,state);
  const tile=page.locator('.lesson-tile'),rect=(await tile.boundingBox())!;
  const x=rect.x+rect.width/2,y=rect.y+20;
  await mouseDrag(page,x,y,0,6);
  expect(state.moves).toHaveLength(0);await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+45,{steps:8});
  await expect(tile).toHaveClass(/dragging/);await tile.dispatchEvent('pointercancel',{pointerType:'mouse',pointerId:1,isPrimary:true});
  await page.mouse.up();await expect(tile).not.toHaveClass(/dragging/);expect(state.moves).toHaveLength(0);
  // Cancellation uses the legacy transform transition to return to the grid.
  await expect.poll(async()=>Math.abs((await tile.boundingBox())!.y-rect.y)).toBeLessThan(1);
  const height=await page.locator('.hour-line:not(.half-hour)').nth(1).evaluate(n=>parseFloat((n as HTMLElement).style.top));
  await mouseDrag(page,x,y,0,-height*2);
  await expect(page.getByRole('button',{name:'Edytuj lekcję Anna Test o 08:00',exact:true})).toBeVisible();
  expect(state.moves).toHaveLength(1);expect(state.moves[0].p_start_minute).toBe(480);
});

test('instructor tags switch focus and toggle all colors without moving lessons or saving data',async({page})=>{
  const state=fixture();
  state.refs.instructors.push({id:'kuba',name:'Kuba',color:'#f59e0b'},{id:'ola',name:'Ola',color:'#a78bfa'});
  for(const lesson of state.lessons.filter(l=>['group','cancelled'].includes(l.id))){
    lesson.instructor_id='kuba';lesson.instructor_name='Kuba';lesson.instructor_color='#f59e0b';
  }
  const custom=state.lessons.find(l=>l.id==='custom')!;
  custom.bookings[1].instructor_id='kuba';custom.bookings[1].instructor_name='Kuba';
  custom.bookings.push({...custom.bookings[0],id:'removed',instructor_id:'ola',instructor_name:'Ola',removed:true});
  const writes:string[]=[];
  page.on('request',request=>{
    if(request.url().endsWith('/test-api/rpc')){
      const {name}=request.postDataJSON();if(!['hb_health','hb_calendar','hb_references','hb_review_count'].includes(name))writes.push(name);
    }
  });
  await mockCalendar(page,state,true);
  const ania=page.getByRole('button',{name:'Ania',exact:true}),kuba=page.getByRole('button',{name:'Kuba',exact:true});
  const individual=page.locator('.lesson-tile[title="Anna Test"]:not(.cancelled)'),group=page.locator('.lesson-tile[title="Grupowa"]');
  const cancelled=page.locator('.lesson-tile.cancelled'),mixed=page.locator('.lesson-tile[title="Niestandardowa"]');
  const positions=()=>page.locator('.lesson-tile').evaluateAll(nodes=>nodes.map(node=>{
    const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};
  }));
  const before=await positions();
  await expect(page.locator('.calendar-instructor-tag')).toHaveCount(2);
  await expect(page.locator('.instructor-filtered-out')).toHaveCount(0);
  await ania.click();
  await expect(ania).toHaveAttribute('aria-pressed','true');await expect(kuba).toHaveCSS('filter','grayscale(1)');
  await expect(group).toHaveCSS('filter','grayscale(1)');await expect(cancelled).toHaveCSS('opacity','0.35');
  await expect(individual).not.toHaveClass(/instructor-filtered-out/);await expect(mixed).not.toHaveClass(/instructor-filtered-out/);
  await kuba.click();
  await expect(ania).toHaveCSS('filter','grayscale(1)');await expect(kuba).toHaveAttribute('aria-pressed','true');
  await expect(individual).toHaveCSS('filter','grayscale(1)');await expect(group).not.toHaveClass(/instructor-filtered-out/);
  await expect(cancelled).toHaveCSS('opacity','0.6');await expect(mixed).not.toHaveClass(/instructor-filtered-out/);
  expect(await positions()).toEqual(before);
  await kuba.press('Space');
  await expect(page.locator('.instructor-filtered-out')).toHaveCount(0);
  await expect(kuba).toHaveAttribute('aria-pressed','false');
  expect(await positions()).toEqual(before);expect(writes).toEqual([]);
});

test('review icon refreshes pending count and never shows an unavailable count as complete',async({page})=>{
  const state=fixture();await mockCalendar(page,state);
  const review=page.getByRole('button',{name:'Przejrzyj kredyty'}),badge=review.locator('.credit-review-count');
  await expect(review).toHaveAttribute('title','Brak kredytów do przeglądu.');
  await expect(review).not.toHaveClass(/has-pending/);await expect(badge).toHaveCount(0);
  state.pendingReviews=7;await page.clock.fastForward(30_000);
  await expect(review).toHaveClass(/has-pending/);await expect(badge).toHaveText('7');
  state.pendingReviews=123;await page.clock.fastForward(30_000);
  await expect(badge).toHaveText('99+');await expect(review).toHaveAttribute('title',/123 oczekujących decyzji/);
  state.reviewUnavailable=true;await page.clock.fastForward(30_000);
  await expect(review).toHaveClass(/review-unavailable/);await expect(badge).toHaveCount(0);
  await expect(review).toHaveAttribute('title',/Nie udało się sprawdzić/);
  state.reviewUnavailable=false;state.pendingReviews=0;await page.clock.fastForward(30_000);
  await expect(review).toHaveAttribute('title','Brak kredytów do przeglądu.');
  await expect(review).not.toHaveClass(/has-pending|review-unavailable/);
});
