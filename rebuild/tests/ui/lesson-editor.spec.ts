import {chooseTime} from './time-picker';
import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {mouseDrag,touchDrag} from './gestures';
const date='2026-10-08';
function fixture(kind:string){
  const refs={clients:[{id:'anna',name:'Anna Test',archived:false,account:{balance:6}},{id:'jan',name:'Jan Test',archived:false,account:{balance:2}}],
    instructors:[{id:'ania',name:'Ania',color:'#34d399'}],horses:[{id:'rubin',name:'Rubin'}],settings:[] as any[]};
  const booking=(client:any)=>({id:client.id+'-booking',client_id:client.id,client_name:client.name,horse_id:'rubin',horse_name:'Rubin',
    instructor_id:'ania',instructor_name:'Ania',billing_mode:kind==='custom'?'cash':'package',units:1,cash_amount:140,attendance:'unknown',removed:false,review_status:'pending',revision:1});
  const lesson={id:'fixture-lesson',date,start_minute:600,duration_minutes:60,kind,title:kind==='individual'?'Anna Test':'Lekcja testowa',
    instructor_id:'ania',instructor_name:'Ania',instructor_color:'#34d399',status:'scheduled',notes:kind==='custom'?'Ćwiczenia na placu':'',revision:1,
    series_id:null,occurrence_date:null,bookings:refs.clients.slice(0,kind==='individual'?1:2).map(booking)};
  return {refs,lesson};
}
test('switching lesson types discards entered details in every direction',async({page})=>{
  test.setTimeout(60000);
  for(const source of ['individual','group','custom'])for(const target of ['individual','group','custom']){
    if(source===target)continue;
    const state=fixture(source);
    Object.assign(state.lesson,{start_minute:720,duration_minutes:90,notes:'Previous notes'});
    state.lesson.bookings.forEach(b=>Object.assign(b,{cash_amount:222,attendance:'attended'}));
    await openEditor(page,state);
    await page.getByRole('switch',{name:'Powielaj',exact:true}).click();
    await page.getByLabel('Dodatkowe tygodnie',{exact:true}).fill('12');
    const typeName={individual:'Indywidualna',group:'Grupowa',custom:'Niestandardowa'};
    await page.getByRole('button',{name:typeName[target as keyof typeof typeName],exact:true}).click();
    const client=page.getByLabel(target==='individual'?'Imię klienta':'Klient',{exact:true});
    await expect(client).toHaveCount(1);await expect(client).toHaveValue('');
    await expect(page.getByLabel('Koń',{exact:true})).toHaveValue('');
    await expect(page.getByLabel('Czas rozpoczęcia',{exact:true})).toContainText('10:00');
    await expect(page.getByLabel('Czas trwania',{exact:true})).toHaveValue('60');
    await expect(page.getByRole('switch',{name:'Powielaj',exact:true})).toHaveAttribute('aria-checked','false');
    const instructor=page.getByLabel(target==='custom'?'Instruktor uczestnika':'Instruktor',{exact:true});
    await expect(instructor).toHaveValue('');
    await expect(instructor.locator('option:checked')).toHaveText('Brak instruktora');
    if(target==='custom'){
      await expect(page.getByLabel('Opis',{exact:true})).toHaveValue('');
      await expect(page.getByLabel('Cena (zł)',{exact:true})).toHaveValue('140');
    }else await expect(page.getByRole('switch',{name:'Tryb karnetu',exact:true})).toHaveAttribute('aria-checked','false');
    let saved:any;
    await page.route('**/test-api/rpc',route=>{
      const request=route.request().postDataJSON();
      if(request.name==='hb_save_lesson'){saved=request.args.p_lesson;return route.fulfill({json:{result:{}}});}
      return route.fallback();
    });
    await client.fill('Jan Test');
    await page.getByRole('button',{name:'Aktualizuj',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(saved).toMatchObject({id:state.lesson.id,date,kind:target,title:'',notes:'',instructor_id:null,start_minute:600,duration_minutes:60});
    expect(saved.bookings).toHaveLength(1);
    expect(saved.bookings[0]).toMatchObject({client_id:target==='custom'?null:'jan',...(target==='custom'?{client_name:'Jan Test'}:{}),horse_id:null,instructor_id:null,cash_amount:140,attendance:'unknown'});
  }
});
async function openEditor(page:Page,state:ReturnType<typeof fixture>,animate=false){
  await page.goto('about:blank');
  await page.unroute('**/test-api/rpc');
  await page.route('**/test-api/rpc',route=>{
    const {name}=route.request().postDataJSON();
    const result=name==='hb_health'?{admin:true,schema_version:1}:name==='hb_calendar'?{lessons:[state.lesson],settings:[]}:
      name==='hb_references'?state.refs:name==='hb_review_count'?0:[];
    return route.fulfill({json:{result}});
  });
  await page.goto('/#calendar/'+date);
  await expect(page.locator('.lesson-tile')).toBeVisible();
  await page.addStyleTag({content:animate?'.page {animation:none !important;}':'.modal,.modal-overlay,.page {animation:none !important;}'});
  await page.evaluate(()=>document.fonts.ready);
  await page.locator('.lesson-tile').click();
  await expect(page.getByRole('dialog',{name:'Edytuj lekcję'})).toBeVisible();
  if(animate)await expect(page.getByRole('dialog')).toHaveCSS('transform','none');
  await page.evaluate(()=>document.fonts.ready);
}
async function oldEditor(page:Page,state:ReturnType<typeof fixture>){
  const source=await readFile(new URL('../../../src/modals/LessonModal.js',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('function formatLessonCreatedAt'),source.indexOf('export function openLessonModal'));
  const body=source.slice(source.indexOf('export function openLessonModal'),source.indexOf('function openMoveLessonModal')).replace('export function','function');
  const css=await readFile(new URL('../../../src/style.css',import.meta.url),'utf8');
  const index=await readFile(new URL('../../../index.html',import.meta.url),'utf8');
  const fontLinks=index.match(/<link[^>]+>/g)!.join('');
  await page.setContent(`<!doctype html><html><head>${fontLinks}</head><body></body></html>`);
  await page.addStyleTag({content:css+'\n.modal,.modal-overlay {animation:none !important;}'});
  await page.evaluate(async()=>{
    await Promise.all([document.fonts.load('400 14.4px Inter'),document.fonts.load('600 14.4px Inter'),document.fonts.load('600 13.3333px Inter')]);
    await document.fonts.ready;
  });
  await page.evaluate(({state,script})=>{
    const el=(tag:string,attrs:any={},...children:any[])=>{
      const node=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){
        if(key==='className')node.className=value as string;else if(key==='style')Object.assign(node.style,value);
        else if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value as EventListener);
        else if(key==='value')(node as HTMLInputElement).value=value as string;
        else node.setAttribute(key,String(value));
      }for(const child of children){if(typeof child==='string')node.appendChild(document.createTextNode(child));else if(child)node.appendChild(child);}return node;
    };
    const icon=(name:string)=>el('span',{className:'material-symbols-rounded'},name);
    const translated:Record<string,string>={editLesson:'Edytuj lekcję',newLesson:'Nowa lekcja',individualLesson:'Indywidualna',groupLesson:'Grupowa',customLesson:'Niestandardowa',
      startTime:'Czas rozpoczęcia',duration:'Czas trwania',min:'min',instructor:'Instruktor',noInstructor:'Brak instruktora',enterClientName:'Wpisz imię klienta...',
      selectHorse:'Wybierz konia...',noHorse:'Brak konia',horse:'Koń',packageLessonMode:'Tryb karnetu',packageShort:'Karnet',repeatWeekly:'Powtarzaj co tydzień',
      clientName:'Imię klienta',groupClients:'Klienci w grupie',addParticipant:'Dodaj uczestnika',description:'Opis',deleteKey:'Usuń',cancel:'Odwołaj',restore:'Przywróć',
      move:'Przenieś',update:'Aktualizuj',create:'Utwórz',unknownDate:'nieznana data'};
    const l=state.lesson,old={...l,startMinute:l.start_minute,durationMinutes:l.duration_minutes,instructor:l.instructor_name,horse:l.bookings[0].horse_name,
      packageMode:true,description:l.notes,recurring:false,participants:l.kind==='individual'?[]:l.bookings.map(b=>({name:b.client_name,horse:b.horse_name,instructor:b.instructor_name,customCost:b.cash_amount,packageMode:b.billing_mode==='package'}))};
    const env={el,icon,getLang:()=> 'pl',t:(key:string,args:any)=>key==='createdAtBy'?`utworzono ${args.date} przez ${args.name}`:key==='createdAtAutomatically'?`utworzono ${args.date} automatycznie`:translated[key]??key,
      minutesToTime:(m:number)=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`,
      getData:()=>({instructors:state.refs.instructors,horses:state.refs.horses.map(h=>h.name),lessons:[old]}),getKnownClientNames:()=>state.refs.clients.map(c=>c.name),
      isGroupLessonRecord:(l:any)=>l?.kind==='group',isCustomLessonRecord:(l:any)=>l?.kind==='custom',getPackageByName:()=>({}),
      getDayScheduleHours:()=>({startHour:8,endHour:21}),setupModalSwipeToClose:(_modal:any,_overlay:any,onClose:any)=>({closeModal:onClose}),
      fetchLessonCreationInfo:async()=>({info:{},error:null}),openConfirmModal:()=>{},openMoveLessonModal:()=>{}};
    new Function('env','date','lesson',`let editingLesson;const {${Object.keys(env).join(',')}}=env;${script};openLessonModal(date,lesson);`)(env,l.date,old);
  },{state,script:helpers+body});
  await page.evaluate(()=>document.fonts.ready);
}
async function editorGeometry(page:Page){
  return page.evaluate(()=>{
    const modal=document.querySelector('.modal')!.getBoundingClientRect(),origin=document.querySelector('.form-row')!.getBoundingClientRect().top;
    const selectors=['.lesson-type-switch','.lesson-type-btn','.form-row','.form-input','.toggle-row','.group-participants',
      '.participant-row','.participant-row-top','.participant-row-bottom','.participant-package-control','.toggle'];
    return Object.fromEntries(selectors.map(selector=>[selector,Array.from(document.querySelector('.modal')!.querySelectorAll<HTMLElement>(selector))
      .filter(node=>!node.closest('details')&&node.getBoundingClientRect().height>0).map(node=>{
        const r=node.getBoundingClientRect(),css=getComputedStyle(node);
        return {x:r.x-modal.x,y:r.y-origin,width:r.width,height:r.height,fontSize:css.fontSize,fontWeight:css.fontWeight,color:css.color,
          paddingTop:css.paddingTop,paddingBottom:css.paddingBottom,paddingLeft:css.paddingLeft,borderRadius:css.borderRadius};
      })]));
  });
}
for(const width of [390,916])test(`lesson editor retains original form and participant geometry at ${width}px`,async({page,context})=>{
  test.setTimeout(60000);
  await page.setViewportSize({width,height:844});
  const reference=await context.newPage();await reference.setViewportSize({width,height:844});
  try {for(const kind of ['individual','group','custom']){
    const state=fixture(kind);await openEditor(page,state);await oldEditor(reference,state);
    // Recurrence now has a separate creation/extension action; compare the shared editing controls.
    await reference.locator('.toggle-row').filter({hasText:'Powtarzaj co tydzień'}).evaluateAll(rows=>rows.forEach(row=>row.remove()));
    await page.locator('.lesson-repeat-control').evaluateAll(rows=>rows.forEach(row=>row.remove()));
    if(kind==='individual'){
      await page.locator('.form-group').filter({hasText:'Imię klienta'}).evaluateAll(rows=>rows.forEach(row=>row.remove()));
      await reference.locator('.form-group').filter({hasText:'Imię klienta'}).evaluateAll(rows=>rows.forEach(row=>row.remove()));
    }
    expect(await editorGeometry(page),kind).toEqual(await editorGeometry(reference));
    await page.getByRole('dialog').screenshot({path:`test-results/editor-restored-${kind}-${width}.png`});
    await reference.locator('.modal').screenshot({path:`test-results/editor-original-${kind}-${width}.png`});
  }}finally{await reference.close();}
});

test('new lesson billing follows selected client deduction history and remains overridable',async({page})=>{
  const state=fixture('individual');
  Object.assign(state.refs.clients[0],{has_credit_deduction:true,account:{balance:0}});
  Object.assign(state.refs.clients[1],{has_credit_deduction:false,account:{balance:10}});
  await openEditor(page,state);
  const toggle=page.getByRole('switch',{name:'Tryb karnetu',exact:true});
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await expect(toggle).toHaveAttribute('aria-checked','false');
  const client=page.getByLabel('Imię klienta',{exact:true});
  await expect(client).toHaveAttribute('list',/.+/);
  await client.fill('Ann');
  await expect(client).toHaveValue('Ann');
  expect(await client.evaluate((input:HTMLInputElement)=>input.validity.valid)).toBe(true);
  await client.fill('Jan Test');await expect(toggle).toHaveAttribute('aria-checked','false');
  await client.fill('Anna Test');await expect(toggle).toHaveAttribute('aria-checked','true');
  await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','false');
  await page.getByLabel('Czas trwania',{exact:true}).selectOption('90');
  await expect(toggle).toHaveAttribute('aria-checked','false');
  let args:any;
  await page.route('**/test-api/rpc',route=>{
    const request=route.request().postDataJSON();
    if(request.name==='hb_save_lesson'){args=request.args;return route.fulfill({json:{result:{}}});}
    return route.fallback();
  });
  await page.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(args.p_lesson.bookings[0].billing_mode).toBe('cash');
});

test('group participants default independently and existing saved cash mode is preserved',async({page})=>{
  const state=fixture('individual');
  Object.assign(state.refs.clients[0],{has_credit_deduction:true});
  state.lesson.bookings[0].billing_mode='cash';
  await openEditor(page,state);
  await expect(page.getByRole('switch',{name:'Tryb karnetu',exact:true})).toHaveAttribute('aria-checked','false');
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await page.getByRole('button',{name:'Grupowa',exact:true}).click();
  await page.getByLabel('Klient',{exact:true}).fill('Anna Test');
  await page.getByRole('button',{name:'Dodaj uczestnika',exact:true}).click();
  const toggles=page.getByRole('switch',{name:'Tryb karnetu',exact:true});
  await expect(toggles.nth(0)).toHaveAttribute('aria-checked','true');
  await expect(toggles.nth(1)).toHaveAttribute('aria-checked','false');
  const secondClient=page.getByLabel('Klient',{exact:true}).nth(1);
  const suggestions=await secondClient.getAttribute('list');
  expect(await page.locator(`[id="${suggestions}"] option`).evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['Jan Test']);
  await secondClient.fill('Anna Test');
  expect(await secondClient.evaluate((input:HTMLInputElement)=>input.validity.valid)).toBe(false);
  await page.getByLabel('Klient',{exact:true}).nth(1).fill('Jan Test');
  await expect(toggles.nth(1)).toHaveAttribute('aria-checked','false');
  await page.getByLabel('Klient',{exact:true}).nth(0).fill('');
  await expect(toggles.nth(0)).toHaveAttribute('aria-checked','false');
});

test('new weekly lessons use a typed count defaulting to eight including the first lesson',async({page})=>{
  await openEditor(page,fixture('individual'));
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await page.getByRole('switch',{name:'Powielaj',exact:true}).click();
  const weeks=page.getByLabel('Liczba tygodni',{exact:true});
  await expect(weeks).toHaveValue('8');
  const clientBox=(await page.getByLabel('Imię klienta',{exact:true}).boundingBox())!,instructorBox=(await page.getByLabel('Instruktor',{exact:true}).boundingBox())!;
  expect(clientBox.y+clientBox.height).toBeLessThan(instructorBox.y);
  const repeat=page.getByRole('switch',{name:'Powielaj',exact:true}),billing=page.getByRole('switch',{name:'Tryb karnetu',exact:true});
  await expect(repeat).toHaveAttribute('aria-checked','true');
  const repeatBox=(await repeat.boundingBox())!,weeksBox=(await weeks.boundingBox())!,billingBox=(await billing.boundingBox())!;
  expect(Math.abs(repeatBox.y+repeatBox.height/2-weeksBox.y-weeksBox.height/2)).toBeLessThan(1);
  expect(repeatBox.y+repeatBox.height).toBeLessThan(billingBox.y);
  expect(repeatBox.x).toBe(billingBox.x);expect(repeatBox.width).toBe(billingBox.width);
  await page.getByRole('dialog').screenshot({path:'test-results/repeat-inline.png'});
  await expect(page.getByRole('switch',{name:'Powtarzaj co tydzień'})).toHaveCount(0);
  await weeks.fill('3');
  await page.getByLabel('Imię klienta',{exact:true}).fill('Anna Test');
  let args:any;
  await page.route('**/test-api/rpc',route=>{
    const request=route.request().postDataJSON();
    if(request.name==='hb_duplicate_lesson'){args=request.args;return route.fulfill({json:{result:{}}});}
    return route.fallback();
  });
  await page.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(args.p_lesson.date).toBe(date);expect(args.p_weeks).toBe(3);expect(args.p_expected_revision).toBeNull();
});

test('last series lesson shows an amber flag and extends with the typed additional weeks and edited details',async({page})=>{
  const state=fixture('individual');
  Object.assign(state.lesson,{is_last_in_series:true});
  await openEditor(page,state);
  const notice=page.getByRole('status').filter({hasText:'Ostatnia jazda w serii'});
  await expect(notice).toBeVisible();await expect(notice).toHaveCSS('color','rgb(251, 191, 36)');
  await page.getByRole('switch',{name:'Powielaj',exact:true}).click();
  const weeks=page.getByLabel('Dodatkowe tygodnie',{exact:true});await expect(weeks).toHaveValue('8');
  await weeks.fill('0');await page.getByRole('button',{name:'Zapisz i powiel',exact:true}).click();
  await expect(notice).toBeVisible();
  await weeks.fill('4');await chooseTime(page,'Czas rozpoczęcia','11:00');
  let args:any;
  await page.route('**/test-api/rpc',route=>{
    const request=route.request().postDataJSON();
    if(request.name==='hb_duplicate_lesson'){args=request.args;return route.fulfill({json:{result:{}}});}
    return route.fallback();
  });
  await page.getByRole('button',{name:'Zapisz i powiel',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(args.p_weeks).toBe(4);expect(args).not.toHaveProperty('p_expected_series_revision');expect(args.p_expected_revision).toBe(1);
  expect(args.p_lesson.start_minute).toBe(660);
  await openEditor(page,fixture('individual'));await expect(page.getByText('Ostatnia jazda w serii',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('switch',{name:'Powielaj',exact:true})).toBeVisible();
  await openEditor(page,fixture('custom'));await expect(page.getByRole('switch',{name:'Powielaj',exact:true})).toBeVisible();
});

test('compact custom participant controls and move dialog save the intended identifiers and billing values',async({page})=>{
  const state=fixture('custom');state.refs.settings.push({key:'schedule_hours',value:{start:9,end:18},revision:1});await openEditor(page,state);
  let payload:any;
  await page.route('**/test-api/rpc',route=>{
    const {name,args}=route.request().postDataJSON();
    if(name==='hb_save_lesson'){payload=args.p_lesson;return route.fulfill({json:{result:{}}});}
    return route.fallback();
  });
  const modal=page.getByRole('dialog');
  await modal.getByLabel('Czas rozpoczęcia',{exact:true}).click();
  const times=modal.getByRole('listbox',{name:'Godziny'}).getByRole('option');
  await expect(times).toHaveCount(9);await expect(times.first()).toHaveText('09');await expect(times.last()).toHaveText('17');
  await modal.getByRole('button',{name:'Gotowe',exact:true}).click();
  await modal.getByLabel('Cena (zł)',{exact:true}).first().fill('175');
  await modal.getByLabel('Instruktor uczestnika',{exact:true}).first().selectOption('');
  await modal.getByLabel('Opis',{exact:true}).fill('Nowy opis');
  await modal.getByRole('button',{name:'Przenieś',exact:true}).click();
  const move=page.getByRole('dialog',{name:'Przenieś lekcję'});
  await move.getByLabel('Czas rozpoczęcia',{exact:true}).click();
  await expect(move.getByRole('listbox',{name:'Godziny'}).getByRole('option')).toHaveCount(9);
  await move.getByRole('button',{name:'Gotowe',exact:true}).click();
  await move.getByLabel('Data',{exact:true}).fill('2026-10-09');
  await chooseTime(move,'Czas rozpoczęcia','17:30');
  await move.getByRole('button',{name:'Przenieś',exact:true}).click();
  await expect(move).toHaveCount(0);
  expect(payload.date).toBe('2026-10-09');expect(payload.start_minute).toBe(1050);
  expect(payload.notes).toBe('Nowy opis');expect(payload.bookings[0]).toMatchObject({client_id:null,client_name:'Anna Test',horse_id:'rubin',instructor_id:null,cash_amount:175,billing_mode:'cash'});
});

test('popup handle follows mouse drags, snaps back on short pulls and dismisses editors and review without writes',async({page})=>{
  const state=fixture('individual');await openEditor(page,state,true);
  const writes:string[]=[];page.on('request',r=>{
    if(r.url().endsWith('/test-api/rpc')){const {name}=r.postDataJSON();if(!['hb_health','hb_calendar','hb_references','hb_review_count','hb_review_queue'].includes(name))writes.push(name);}
  });
  const modal=page.getByRole('dialog'),handle=modal.locator('.modal-handle');
  const rect=(await handle.boundingBox())!,x=rect.x+rect.width/2,y=rect.y+rect.height/2;
  const original=(await modal.boundingBox())!.y;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+60,{steps:8});
  expect((await modal.boundingBox())!.y-original).toBeCloseTo(60,0);
  await page.mouse.up();await expect(modal).toBeVisible();
  await expect.poll(async()=>Math.round((await modal.boundingBox())!.y)).toBe(Math.round(original));
  await mouseDrag(page,x,y,0,120);await expect(modal).toHaveCount(0);
  await page.locator('.lesson-tile').click();
  await modal.getByRole('button',{name:'Przenieś',exact:true}).click();
  await expect(modal).toHaveAccessibleName('Przenieś lekcję');
  await expect(modal).toHaveCSS('transform','none');
  const moveRect=(await handle.boundingBox())!;
  await mouseDrag(page,moveRect.x+moveRect.width/2,moveRect.y+2,0,120);
  await expect(modal).toHaveAccessibleName('Edytuj lekcję');
  await modal.getByRole('button',{name:'Zamknij',exact:true}).click();await expect(modal).toHaveCount(0);
  await page.getByRole('button',{name:'Przejrzyj kredyty'}).click();
  await expect(modal).toHaveAccessibleName('Przegląd kredytów');
  await expect(modal).toHaveCSS('transform','none');
  const reviewRect=(await handle.boundingBox())!;
  await mouseDrag(page,reviewRect.x+reviewRect.width/2,reviewRect.y+2,0,120);
  await expect(modal).toHaveCount(0);expect(writes).toEqual([]);
});

test.describe('native touch popup gestures',()=>{
  test.use({hasTouch:true});
  test('pulling the handle closes on touch, and dragging cannot dismiss an in-flight save',async({page})=>{
    const state=fixture('individual');await openEditor(page,state,true);
    const modal=page.getByRole('dialog'),handle=modal.locator('.modal-handle');
    const rect=(await handle.boundingBox())!;
    await touchDrag(page,rect.x+rect.width/2,rect.y+2,0,60);
    await expect(modal).toBeVisible();await expect(modal).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
    await touchDrag(page,rect.x+rect.width/2,rect.y+2,0,120);await expect(modal).toHaveCount(0);
    await page.locator('.lesson-tile').tap();await expect(modal).toBeVisible();
    await expect(modal).toHaveCSS('transform','none');
    let finish!:()=>void;const pending=new Promise<void>(resolve=>finish=resolve);
    await page.route('**/test-api/rpc',async route=>{
      if(route.request().postDataJSON().name!=='hb_save_lesson'){await route.fallback();return;}
      await pending;await route.fulfill({json:{result:{}}});
    });
    await modal.getByRole('button',{name:'Aktualizuj',exact:true}).tap();
    await expect(modal.getByRole('button',{name:'Zamknij',exact:true})).toBeDisabled();
    try{
      const busyRect=(await handle.boundingBox())!;
      await touchDrag(page,busyRect.x+busyRect.width/2,busyRect.y+2,0,120);
      await expect(modal).toBeVisible();await expect(modal).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
    }finally{finish();}
    await expect(modal).toHaveCount(0);
  });
});

