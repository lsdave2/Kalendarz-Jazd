import {test,expect} from '@playwright/test';
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());

test('language switches immediately, keeps an unsaved form and persists after reload',async({page})=>{
  const writes:string[]=[];
  page.on('request',request=>{if(request.url().includes('/test-api/rpc'))writes.push(request.postDataJSON().name);});
  await page.goto('/#settings');
  await expect(page.getByLabel('Język',{exact:true})).toHaveValue('pl');
  await expect(page.getByLabel('Od',{exact:true})).toBeVisible();
  await page.getByLabel('Od',{exact:true}).fill('7');
  await page.getByLabel('Język',{exact:true}).selectOption('en');
  await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
  await expect(page.getByLabel('From',{exact:true})).toHaveValue('7');
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await page.reload();
  await expect(page.getByLabel('Language',{exact:true})).toHaveValue('en');
  await page.getByRole('button',{name:'Calendar',exact:true}).click();
  const date=new Date(today+'T12:00:00Z');
  await expect(page.locator('.day-subtitle')).toHaveText(new Intl.DateTimeFormat('en-US',{weekday:'long'}).format(date));
  await page.getByRole('button',{name:'Month view'}).click();
  await expect(page.locator('.month-header h2')).toHaveText(new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric'}).format(date));
  await expect(page.locator('.calendar-day-label')).toHaveText(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByLabel('Language',{exact:true}).selectOption('pl');
  await expect(page.getByRole('heading',{name:'Ustawienia',exact:true})).toBeVisible();
  expect(writes.some(name=>name.startsWith('hb_save_'))).toBe(false);
});

test('v1 language preference is reused and malformed preferences fall back safely',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('horsebook_settings',JSON.stringify({lang:'en'})));
  await page.goto('/#settings');
  await expect(page.getByLabel('Language',{exact:true})).toHaveValue('en');
  await page.getByLabel('Language',{exact:true}).selectOption('pl');
  await page.reload();
  await expect(page.getByLabel('Język',{exact:true})).toHaveValue('pl');
  await page.evaluate(()=>{localStorage.setItem('horsebook-v2-language','invalid');localStorage.setItem('horsebook_settings','invalid json');});
  // Remove the init script by opening a fresh page in the same browser context.
  const fresh=await page.context().newPage();
  await fresh.goto('/#settings');
  await expect(fresh.getByLabel('Język',{exact:true})).toHaveValue('pl');
});

test('viewers can change language without signing in',async({page})=>{
  await page.route('**/test-api/rpc',async route=>{
    if(route.request().postDataJSON().name==='hb_health')await route.fulfill({json:{result:{admin:false,schema_version:1}}});
    else await route.continue();
  });
  await page.goto('/#settings');
  await expect(page.getByRole('button',{name:'Zaloguj jako administrator'})).toBeVisible();
  await page.getByLabel('Język',{exact:true}).selectOption('en');
  await expect(page.getByRole('button',{name:'Login as Admin'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Clients',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Login as Admin'}).click();
  await expect(page.getByRole('dialog',{name:'Administrator login'})).toBeVisible();
  await expect(page.getByLabel('Login name or email',{exact:true})).toHaveAttribute('type','text');
  await page.getByLabel('Login name or email',{exact:true}).fill('ania');
  await expect(page.getByLabel('Login name or email',{exact:true})).toHaveValue('ania');
  await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
});

test('language changes in another tab preserve an open lesson draft',async({page,context})=>{
  await page.goto(`/#calendar/${today}`);
  await expect(page.getByRole('button',{name:'Dodaj lekcję'})).toBeEnabled();
  await page.getByRole('button',{name:'Dodaj lekcję'}).click();
  await page.getByLabel('Czas rozpoczęcia',{exact:true}).selectOption('17:30');
  await page.getByLabel('Imię klienta',{exact:true}).fill('Anna Test');
  const second=await context.newPage();await second.goto('/#settings');
  await second.getByLabel('Język',{exact:true}).selectOption('en');
  await expect(page.getByRole('dialog',{name:'New Lesson',exact:true})).toBeVisible();
  await expect(page.getByLabel('Start Time',{exact:true})).toHaveValue('17:30');
  await expect(page.getByLabel('Client Name',{exact:true})).toHaveValue('Anna Test');
  await page.getByLabel('Entry type',{exact:true}).selectOption('event');
  await expect(page.getByRole('dialog',{name:'New event',exact:true})).toBeVisible();
  await expect(page.getByLabel('End Time',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Description',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Clients',exact:true}).click();
  await expect(page.getByPlaceholder('Search clients…')).toBeVisible();
  await page.getByRole('button',{name:'Finances',exact:true}).click();
  await expect(page.getByRole('button',{name:'Instructor Payments',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Transactions',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add transaction'})).toBeVisible();
  await page.screenshot({path:'test-results/english-finances.png',fullPage:true});
});
