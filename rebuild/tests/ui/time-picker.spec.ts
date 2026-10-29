import {test,expect,type Page} from '@playwright/test';
import {chooseTime} from './time-picker';
import {touchDrag} from './gestures';

async function open(page:Page,start=8,end=21){
  const writes:any[]=[];
  await page.route('**/test-api/rpc',async route=>{
    const {name,args}=route.request().postDataJSON();
    const settings=[{key:'schedule_hours',value:{start,end},revision:1}];
    if(name==='hb_save_lesson'||name==='hb_save_event')writes.push(args);
    const result=name==='hb_health'?{admin:true,schema_version:1}:name==='hb_references'?{clients:[],horses:[],instructors:[],settings}:
      name==='hb_calendar'?{lessons:[],events:[],settings}:name==='hb_review_count'?0:{};
    await route.fulfill({json:{result}});
  });
  await page.goto('/#calendar/2026-11-12');
  await page.getByRole('button',{name:'Dodaj lekcję',exact:true}).click();
  return writes;
}

for(const touch of [false,true])test.describe(touch?'touch time wheels':'mouse time wheels',()=>{
  test.use({hasTouch:touch});
  test('hour and minute wheels scroll independently, support keys and save the chosen time',async({page},testInfo)=>{
    const writes=await open(page),trigger=page.getByRole('button',{name:'Czas rozpoczęcia',exact:true});
    await trigger.click();
    const hours=page.getByRole('listbox',{name:'Godziny'}),minutes=page.getByRole('listbox',{name:'Minuty'});
    await expect(hours.getByRole('option',{selected:true})).toHaveText('10');
    expect(await minutes.getByRole('option').allTextContents()).toEqual(['00','15','30','45']);
    const hourBox=(await hours.boundingBox())!,minuteBox=(await minutes.boundingBox())!;
    expect(minuteBox.x).toBeGreaterThan(hourBox.x+hourBox.width);
    expect(minuteBox.x+minuteBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    if(touch)await touchDrag(page,hourBox.x+hourBox.width/2,hourBox.y+120,0,-70);
    else{await hours.hover();await page.mouse.wheel(0,80);}
    await expect(hours.getByRole('option',{selected:true})).not.toHaveText('10');
    await expect(minutes.getByRole('option',{selected:true})).toHaveText('00');
    await minutes.focus();await minutes.press('End');
    await expect(minutes.getByRole('option',{selected:true})).toHaveText('45');
    await hours.focus();await hours.press('End');
    await expect(trigger).toContainText('20:45');
    await hours.press('ArrowUp');await expect(trigger).toContainText('19:45');
    await page.getByRole('dialog').screenshot({path:testInfo.outputPath('time-wheels.png')});
    await hours.press('Escape');await expect(hours).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();await expect(trigger).toBeFocused();
    await chooseTime(page,'Czas rozpoczęcia','17:30');
    await page.getByLabel('Imię klienta',{exact:true}).fill('Wheel client');
    await page.getByRole('button',{name:'Utwórz',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes[0].p_lesson.start_minute).toBe(1050);
  });
});

test('event time wheels limit end times and allow midnight as a day endpoint',async({page})=>{
  const writes=await open(page,0,24);
  await page.getByLabel('Rodzaj wpisu').selectOption('event');
  await chooseTime(page,'Czas rozpoczęcia','23:45');
  await expect(page.getByLabel('Czas zakończenia')).toContainText('24:00');
  await page.getByLabel('Czas zakończenia').click();
  await expect(page.getByRole('listbox',{name:'Godziny'}).getByRole('option')).toHaveText(['24']);
  await expect(page.getByRole('listbox',{name:'Minuty'}).getByRole('option')).toHaveText(['00']);
  await page.getByRole('button',{name:'Gotowe',exact:true}).click();
  await page.getByLabel('Opis',{exact:true}).fill('Late event');
  await page.getByRole('button',{name:'Utwórz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes[0].p_event).toMatchObject({start_minute:1425,end_minute:1440});
});
