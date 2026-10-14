import {test,expect} from '@playwright/test';

test('calendar tab cycles between daily and monthly views',async({page})=>{
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
  const calendarTab=page.getByRole('navigation',{name:'Nawigacja'}).getByRole('button',{name:'Kalendarz',exact:true});
  await page.goto('/#calendar/2026-02-12');
  await expect(page.locator('.daily-calendar')).toBeVisible();

  await calendarTab.click();
  await expect(page).toHaveURL(/#calendar\/2026-02$/);
  await expect(page.locator('.calendar-grid')).toBeVisible();

  for(let i=0;i<2;i++){
    await calendarTab.click();
    await expect(page).toHaveURL(new RegExp(`#calendar/${today}$`));
    await expect(page.locator('.daily-calendar')).toBeVisible();
    await calendarTab.click();
    await expect(page).toHaveURL(new RegExp(`#calendar/${today.slice(0,7)}$`));
    await expect(page.locator('.calendar-grid')).toBeVisible();
  }

  await page.getByRole('button',{name:'Ustawienia',exact:true}).click();
  await expect(page).toHaveURL(/#settings$/);
  await calendarTab.click();
  await expect(page).toHaveURL(new RegExp(`#calendar/${today}$`));
  await expect(page.locator('.daily-calendar')).toBeVisible();
});
