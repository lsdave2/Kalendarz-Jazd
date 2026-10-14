import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const current=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
const prior=new Date(current+'T12:00:00Z');prior.setUTCDate(prior.getUTCDate()-1);
const yesterday=prior.toISOString().slice(0,10);
test.describe.configure({mode:'serial'});

test('daily review charges one participant and waives a no-show; reviewed lessons disappear from queue',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
  const writes:string[]=[];page.on('request',r=>{if(r.url().includes('/test-api/rpc')&&r.method()==='POST')writes.push(r.postDataJSON().name);});
  await page.goto(`/#calendar/${yesterday}`);
  await expect(page.getByRole('button',{name:'Przejrzyj kredyty'})).toBeEnabled();
  await expect(page.locator('.credit-review-count')).toHaveText('2');
  await page.getByRole('button',{name:'Przejrzyj kredyty'}).click();
  const modal=page.getByRole('dialog',{name:'Przegląd kredytów'});
  await expect(modal.getByRole('button',{name:'Zaznacz zwykłe lekcje'})).toHaveCount(0);
  await expect(modal.getByRole('button',{name:'Wyczyść wybór'})).toHaveCount(0);
  await expect(modal.getByText(/Lekcja grupowa/)).toHaveCount(2);
  await expect(modal.getByText(/Już zaksięgowano/)).toHaveCount(0);
  await expect(modal.getByText('Kredyty przed lekcją: 0 · Kredyty po lekcji: -1',{exact:true})).toHaveCount(2);
  await modal.locator('article').filter({hasText:'Anna Test'}).getByRole('button',{name:'Odejmij',exact:true}).click();
  await modal.locator('article').filter({hasText:'Jan Test'}).getByRole('button',{name:'Nie odejmuj',exact:true}).click();
  await expect(modal.locator('article').filter({hasText:'Jan Test'})).toContainText('Kredyty przed lekcją: 0 · Kredyty po lekcji: 0');
  await modal.getByRole('button',{name:'Zatwierdź zaznaczone (2)'}).click();
  const backup=page.getByRole('dialog',{name:'Zapisać kopię danych?'});
  await expect(backup).toBeVisible();
  expect(writes).not.toContain('hb_export_snapshot');
  const downloaded=page.waitForEvent('download');
  await backup.getByRole('button',{name:'Zapisz kopię na urządzeniu'}).click();
  const saved=await downloaded;
  const envelope=JSON.parse(await readFile((await saved.path())!,'utf8'));
  expect(envelope.snapshot.data.decisions).toHaveLength(2);
  await backup.getByRole('button',{name:'Gotowe'}).click();
  await expect(modal.getByText('Brak lekcji oczekujących na decyzję.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Przejrzyj kredyty'})).toHaveAttribute('title','Brak kredytów do przeglądu.');
  await expect(page.getByRole('status')).toContainText('Zapisano w bazie');
  await modal.getByRole('button',{name:'Zamknij',exact:true}).click();
  await page.getByRole('button',{name:'Klienci',exact:true}).click();
  const card=page.locator('.package-card').filter({hasText:'Anna Test'});
  await expect(card.locator('.credit-badge')).toHaveText('-1');
  await expect(page.locator('.package-card').filter({hasText:'Jan Test'}).locator('.credit-badge')).toHaveText('0');
  expect(writes).toContain('hb_review_credits');expect(writes).not.toContain('horsebook_apply_snapshot');
  await page.screenshot({path:'test-results/accounts-mobile.png',fullPage:true});
});

test('cancellation does not refund until an explicit corrective decision',async({page})=>{
  await page.goto(`/#calendar/${yesterday}`);
  await expect(page.getByRole('button',{name:'Przejrzyj kredyty'})).toBeEnabled();
  await page.getByRole('button',{name:/Edytuj lekcję Grupa testowa/}).click();
  await expect(page.getByRole('button',{name:'Usuń lekcję',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Odwołaj lekcję',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.credit-review-count')).toHaveText('2');
  await page.getByRole('button',{name:'Przejrzyj kredyty'}).click();
  const modal=page.getByRole('dialog'),anna=modal.locator('article').filter({hasText:'Anna Test'});
  await expect(anna.locator('.credit-badge')).toHaveText('-1');
  await expect(anna).toContainText('Już zaksięgowano: -1');
  await anna.getByRole('button',{name:'Nie odejmuj'}).click();
  await expect(anna).toContainText('Kredyty przed lekcją: -1 · Kredyty po lekcji: 0');
  await expect(modal.getByRole('button',{name:'Zatwierdź zaznaczone (1)'})).toBeDisabled();
  await anna.getByLabel('Powód korekty (wymagany)').fill('Zwrot za odwołaną lekcję');
  await modal.getByRole('button',{name:'Zatwierdź zaznaczone (1)'}).click();
  await page.getByRole('dialog',{name:'Zapisać kopię danych?'}).getByRole('button',{name:'Pomiń',exact:true}).click();
  await expect(modal.locator('article').filter({hasText:'Anna Test'})).toHaveCount(0);
});

test('an interrupted response keeps the draft and retries the same operation without duplicating a lesson',async({page})=>{
  let interrupted=false;const operations:string[]=[];
  await page.route('**/test-api/rpc',async route=>{
    const body=route.request().postDataJSON();if(body.name==='hb_save_lesson'){
      operations.push(body.args.p_operation_id);
      if(!interrupted){interrupted=true;await route.fetch();await route.abort('failed');return;}
    }await route.continue();
  });
  await page.goto(`/#calendar/${current}`);
  await expect(page.getByRole('button',{name:'Dodaj lekcję'})).toBeEnabled();
  await page.getByRole('button',{name:'Dodaj lekcję'}).click();
  const modal=page.getByRole('dialog');
  await modal.getByLabel('Czas rozpoczęcia',{exact:true}).selectOption('17:30');
  await modal.getByLabel('Imię klienta', {exact:true}).fill('Anna Test');
  await modal.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('status')).toContainText(/fetch|Network/i);
  await expect(modal.getByLabel('Imię klienta',{exact:true})).toHaveValue(/.+/);
  await expect(modal.getByLabel('Czas rozpoczęcia',{exact:true})).toHaveValue('17:30');
  await modal.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const savedLesson=page.getByRole('button',{name:'Edytuj lekcję Anna Test o 17:30',exact:true});
  await expect(savedLesson).toHaveCount(1);
  expect(operations).toHaveLength(2);expect(operations[0]).toBe(operations[1]);
  await savedLesson.click();
  await expect(page.getByRole('dialog').getByLabel('Czas rozpoczęcia',{exact:true})).toHaveValue('17:30');
  await page.getByRole('dialog').getByRole('button',{name:'Zamknij',exact:true}).first().click();
  await page.screenshot({path:'test-results/calendar-mobile.png',fullPage:true});
});

test('delete confirms the erroneous lesson, survives a lost response, removes its pending reviews and shows its audit',async({page,request})=>{
  async function rpc(name:string,args:Record<string,unknown>={}){
    const response=await request.post('/test-api/rpc',{data:{name,args}});expect(response.ok()).toBeTruthy();return (await response.json()).result;
  }
  const refs=await rpc('hb_references'),baseline=await rpc('hb_review_count',{p_through:yesterday});
  const id=crypto.randomUUID(),bookings=refs.clients.map((c:any)=>({id:crypto.randomUUID(),client_id:c.id,billing_mode:'package',units:1}));
  const saved=await rpc('hb_save_lesson',{p_operation_id:crypto.randomUUID(),p_expected_revision:null,
    p_lesson:{id,date:yesterday,start_minute:900,duration_minutes:60,kind:'group',title:'Błędna lekcja',bookings}});
  await page.goto(`/#calendar/${yesterday}`);
  await expect(page.locator('.credit-review-count')).toHaveText(String(baseline+bookings.length));
  const tile=page.getByRole('button',{name:'Edytuj lekcję Błędna lekcja o 15:00',exact:true});await tile.click();
  const editor=page.getByRole('dialog',{name:'Edytuj lekcję'}),button=editor.getByRole('button',{name:'Usuń lekcję',exact:true});
  page.once('dialog',dialog=>dialog.dismiss());await button.click();
  await expect(editor).toBeVisible();await expect(tile).toHaveCount(1);
  expect((await rpc('hb_review_count',{p_through:yesterday}))).toBe(baseline+bookings.length);
  let interrupted=false;const operations:string[]=[];
  await page.route('**/test-api/rpc',async route=>{
    const body=route.request().postDataJSON();
    if(body.name==='hb_delete_lesson'){
      operations.push(body.args.p_operation_id);
      if(!interrupted){interrupted=true;await route.fetch();await route.abort('failed');return;}
    }
    await route.continue();
  });
  page.once('dialog',async dialog=>{expect(dialog.message()).toContain('Pełny wpis pozostanie w historii zmian');await dialog.accept();});
  await button.click();await expect(page.getByRole('status')).toContainText(/fetch|Network/i);
  await expect(editor).toBeVisible();
  page.once('dialog',dialog=>dialog.accept());await button.click();
  await expect(editor).toHaveCount(0);await expect(tile).toHaveCount(0);
  expect(operations).toHaveLength(2);expect(operations[0]).toBe(operations[1]);
  expect(await rpc('hb_review_count',{p_through:yesterday})).toBe(baseline);
  expect((await rpc('hb_review_queue',{p_through:yesterday})).some((b:any)=>b.lesson_id===id)).toBe(false);
  const snapshot=await rpc('hb_export_snapshot');
  expect(snapshot.data.lessons.some((l:any)=>l.id===id)).toBe(false);
  expect(snapshot.data.bookings.some((b:any)=>b.lesson_id===id)).toBe(false);
  const audit=snapshot.data.audit_events.filter((row:any)=>row.operation_id===operations[0]);
  expect(audit).toHaveLength(bookings.length+1);expect(audit.every((row:any)=>row.after_row===null)).toBe(true);
  expect(audit.find((row:any)=>row.table_name==='lessons').before_row.revision).toBe(saved.revision);
  await page.getByRole('button',{name:'Ustawienia',exact:true}).click();
  await page.getByRole('button',{name:'Historia zmian'}).click();
  const record=page.getByRole('dialog',{name:'Historia zmian'}).locator('article').filter({hasText:'Usunięto lekcję'}).filter({hasText:'Błędna lekcja'});
  await expect(record).toBeVisible();await expect(record).toContainText('15:00');
  await record.getByText('Szczegóły i identyfikator operacji').click();await expect(record.locator('pre')).toContainText(id);
  await page.screenshot({path:'test-results/deleted-lesson-audit.png',fullPage:true});
});

test('snapshot download contains consistent accounting and review history; audit changes remain inspectable',async({page})=>{
  await page.goto('/#settings');
  const button=page.getByRole('button',{name:'Pobierz kopię danych'});
  await expect(button).toBeVisible();const waiting=page.waitForEvent('download');await button.click();
  const download=await waiting,path=await download.path();expect(path).not.toBeNull();
  const envelope=JSON.parse(await readFile(path!,'utf8'));
  expect(envelope.snapshot.format).toBe('horsebook.snapshot');expect(envelope.manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(envelope.snapshot.data.credit_entries.length).toBe(2);
  expect(envelope.snapshot.data.decisions.length).toBe(3);
  await page.getByRole('button',{name:'Historia zmian'}).click();
  await expect(page.getByRole('dialog',{name:'Historia zmian'})).toBeVisible();
  await expect(page.getByRole('dialog').locator('article').first()).toBeVisible();
  await page.screenshot({path:'test-results/audit-mobile.png',fullPage:true});
});

test('refreshing a dirty settings form cannot overwrite another administrator\'s save',async({page,request})=>{
  async function setHours(revision:number|null,start:number,end:number){
    const response=await request.post('/test-api/rpc',{data:{name:'hb_save_setting',args:{p_operation_id:crypto.randomUUID(),p_key:'schedule_hours',p_expected_revision:revision,p_value:{start,end}}}});
    expect(response.ok()).toBeTruthy();return (await response.json()).result;
  }
  const original=await setHours(null,9,20);
  await page.goto('/#settings');
  const form=page.locator('section').filter({has:page.getByRole('heading',{name:'Godziny kalendarza'})});
  await expect(form.getByLabel('Od',{exact:true})).toHaveValue('9');
  await form.getByLabel('Od',{exact:true}).fill('10');
  await setHours(original.revision,13,19);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(form.getByRole('button',{name:'Wczytaj aktualne godziny'})).toBeVisible();
  await form.getByRole('button',{name:'Zapisz godziny'}).click();
  await expect(page.getByRole('status')).toContainText('Dane zmienił inny administrator');
  const response=await request.post('/test-api/rpc',{data:{name:'hb_references',args:{}}});
  const setting=(await response.json()).result.settings.find((s:{key:string})=>s.key==='schedule_hours');
  expect(setting.value).toEqual({start:13,end:19});
  await form.getByRole('button',{name:'Wczytaj aktualne godziny'}).click();
  await expect(form.getByLabel('Od',{exact:true})).toHaveValue('13');
});
