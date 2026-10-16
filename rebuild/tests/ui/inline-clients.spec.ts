import {test,expect} from '@playwright/test';

for(const kind of ['Indywidualna','Grupowa'])test(`create ${kind} lesson with a typed new client and retain it after reload`,async({page,request})=>{
  const rpc=async(name:string,args:Record<string,unknown>={})=>{
    const response=await request.post('/test-api/rpc',{data:{name,args}});expect(response.ok()).toBeTruthy();return (await response.json()).result;
  };
  const name=`Inline ${kind}`,date='2026-11-05';
  await page.goto('/#calendar/'+date);
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  if(kind!=='Indywidualna')await page.getByRole('button',{name:kind,exact:true}).click();
  const input=page.getByLabel(kind==='Indywidualna'?'Imię klienta':'Klient',{exact:true});
  await input.pressSequentially(name);
  await expect(input).toHaveValue(name);await expect(input).toBeFocused();
  if(kind!=='Indywidualna'){
    await page.getByRole('button',{name:'Dodaj uczestnika',exact:true}).click();
    const second=page.getByLabel('Klient',{exact:true}).nth(1);
    await second.fill(` ${name.toLowerCase()} `);
    expect(await second.evaluate((el:HTMLInputElement)=>el.validity.valid)).toBe(false);
    await second.fill('Anna Test');
  }
  if(kind==='Grupowa'){
    await page.getByRole('switch',{name:'Powielaj',exact:true}).click();
    await page.getByLabel('Liczba tygodni',{exact:true}).fill('2');
  }
  await page.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();await expect(page.locator('.lesson-tile').filter({hasText:name})).toHaveCount(1);
  const refs=await rpc('hb_references'),clients=refs.clients.filter((c:any)=>c.name===name);
  expect(clients).toHaveLength(1);expect(clients[0].account.balance).toBe(0);
  const snapshot=await rpc('hb_export_snapshot');
  expect(snapshot.data.bookings.filter((b:any)=>b.client_id===clients[0].id)).toHaveLength(kind==='Grupowa'?2:1);
  await page.getByRole('button',{name:'Klienci',exact:true}).click();
  await expect(page.locator('.package-card').filter({hasText:name})).toBeVisible();
});

test('cancelling a typed new client creates nothing; replacing an existing client keeps typing focus and saves the new booking',async({page,request})=>{
  const date='2026-11-06',name='Inline replacement';
  await page.goto('/#calendar/'+date);
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await page.getByLabel('Imię klienta',{exact:true}).fill('Discarded client');
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const response=await request.post('/test-api/rpc',{data:{name:'hb_references',args:{}}});
  expect((await response.json()).result.clients.some((c:any)=>c.name==='Discarded client')).toBe(false);
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await page.getByLabel('Imię klienta',{exact:true}).fill('Anna Test');
  await page.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.lesson-tile').click();
  const input=page.getByLabel('Imię klienta',{exact:true});
  await input.fill('');await input.pressSequentially(name);
  await expect(input).toHaveValue(name);await expect(input).toBeFocused();
  await page.getByRole('button',{name:'Aktualizuj',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();await expect(page.locator('.lesson-tile')).toContainText(name);
});
