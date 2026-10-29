import {test,expect} from '@playwright/test';
import {mouseDrag,touchDrag} from './gestures';

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

for(const touch of [false,true])test.describe(touch?'touch month swipes':'mouse month swipes',()=>{
  test.use({hasTouch:touch});
  test('swiping over dates changes months across the year boundary without opening a day',async({page})=>{
    const ranges:any[]=[];
    await page.route('**/test-api/rpc',async route=>{
      const {name,args}=route.request().postDataJSON();
      if(name==='hb_calendar')ranges.push(args);
      await route.fulfill({json:{result:name==='hb_health'?{admin:false,schema_version:1}:{lessons:[],events:[],settings:[]}}});
    });
    await page.goto('/#calendar/2026-12');
    const calendar=page.locator('.monthly-calendar');
    await expect(calendar).toHaveAttribute('aria-busy','false');
    const swipe=async(dx:number,dy=0)=>{
      const rect=(await page.locator('.calendar-grid').boundingBox())!;
      await (touch?touchDrag:mouseDrag)(page,rect.x+rect.width*.6,rect.y+rect.height*.45,dx,dy);
    };
    await swipe(-110);await expect(page).toHaveURL(/#calendar\/2027-01$/);
    await expect(calendar).toHaveAttribute('aria-busy','false');
    expect(ranges.at(-1)).toEqual({p_from:'2027-01-01',p_to:'2027-01-31'});
    await expect(page.locator('.daily-calendar')).toHaveCount(0);
    await swipe(110);await expect(page).toHaveURL(/#calendar\/2026-12$/);
    await expect(calendar).toHaveAttribute('aria-busy','false');
    expect(ranges.at(-1)).toEqual({p_from:'2026-12-01',p_to:'2026-12-31'});
    await swipe(-35);await expect(page).toHaveURL(/#calendar\/2026-12$/);
    await expect(page.locator('.daily-calendar')).toHaveCount(0);
    if(touch)await page.getByRole('button',{name:'2026-12-17',exact:true}).tap();
    else await page.getByRole('button',{name:'2026-12-17',exact:true}).click();
    await expect(page).toHaveURL(/#calendar\/2026-12-17$/);
    await page.getByRole('button',{name:'Widok miesiąca',exact:true}).click();
    await page.getByRole('button',{name:'Poprzedni miesiąc',exact:true}).click();
    await expect(page).toHaveURL(/#calendar\/2026-11$/);
    await page.getByRole('button',{name:'Następny miesiąc',exact:true}).click();
    await expect(page).toHaveURL(/#calendar\/2026-12$/);
  });
});

test.describe('native touch scrolling in month view',()=>{
  test.use({hasTouch:true,viewport:{width:390,height:430}});
  test('vertical gestures scroll without switching months or opening a day',async({page})=>{
    await page.goto('/#calendar/2026-08');
    await expect(page.locator('.monthly-calendar')).toHaveAttribute('aria-busy','false');
    await touchDrag(page,200,300,0,-120);
    await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBeGreaterThan(0);
    await expect(page).toHaveURL(/#calendar\/2026-08$/);
    await expect(page.locator('.daily-calendar')).toHaveCount(0);
  });
});
