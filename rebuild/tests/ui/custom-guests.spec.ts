import {test,expect} from '@playwright/test';

test('custom lesson names are free text and survive retry, reload, editing and copying without creating clients',async({page,request})=>{
  const rpc=async(name:string,args:Record<string,unknown>={})=>{
    const response=await request.post('/test-api/rpc',{data:{name,args}});expect(response.ok()).toBeTruthy();return (await response.json()).result;
  };
  const before=await rpc('hb_references'),date='2026-11-09',name='Visitor for one lesson';
  const operations:string[]=[];let loseResponse=true;
  await page.route('**/test-api/rpc',async route=>{
    const body=route.request().postDataJSON();
    if(body.name==='hb_save_lesson'){
      operations.push(body.args.p_operation_id);
      if(loseResponse){loseResponse=false;await route.fetch();await route.abort('failed');return;}
    }
    await route.continue();
  });
  await page.goto('/#calendar/'+date);
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  await page.getByRole('button',{name:'Niestandardowa',exact:true}).click();
  const input=page.getByLabel('Klient',{exact:true});
  expect(await input.getAttribute('list')).toBeNull();
  await input.pressSequentially(name);await expect(input).toBeFocused();
  await page.getByLabel('Cena (zł)',{exact:true}).fill('175');
  await page.getByRole('button',{name:'Dodaj uczestnika',exact:true}).click();
  // A name matching a saved client is still an unlinked guest in custom lessons.
  await page.getByLabel('Klient',{exact:true}).nth(1).fill('Anna Test');
  await page.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('status')).toBeVisible();await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(operations).toHaveLength(2);expect(operations[0]).toBe(operations[1]);
  await page.reload();
  const tile=page.locator('.lesson-tile').filter({hasText:name});await expect(tile).toHaveCount(1);
  await tile.click();
  const names=page.getByLabel('Klient',{exact:true});
  const index=(await names.evaluateAll(elements=>elements.map(el=>(el as HTMLInputElement).value))).indexOf(name);expect(index).toBeGreaterThanOrEqual(0);
  await expect(page.getByLabel('Cena (zł)',{exact:true}).nth(index)).toHaveValue('175');
  await names.nth(index).fill(name+' renamed');
  await page.getByRole('switch',{name:'Powielaj',exact:true}).click();
  await page.getByLabel('Dodatkowe tygodnie',{exact:true}).fill('2');
  await page.getByRole('button',{name:'Zapisz i powiel',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();await expect(page.locator('.lesson-tile')).toContainText(name+' renamed');
  const after=await rpc('hb_references');expect(after.clients).toEqual(before.clients);
  const snapshot=await rpc('hb_export_snapshot');
  const lessons=snapshot.data.lessons.filter((l:any)=>l.kind==='custom'&&l.date>=date);
  expect(lessons).toHaveLength(3);
  const bookings=snapshot.data.bookings.filter((b:any)=>lessons.some((l:any)=>l.id===b.lesson_id));
  expect(bookings).toHaveLength(6);
  expect(bookings.every((b:any)=>b.client_id===null&&b.guest_name)).toBe(true);
  expect(bookings.filter((b:any)=>b.guest_name===name+' renamed'&&Number(b.cash_amount)===175)).toHaveLength(3);
  await page.getByRole('button',{name:'Klienci',exact:true}).click();
  await expect(page.locator('.package-card').filter({hasText:name})).toHaveCount(0);
});
