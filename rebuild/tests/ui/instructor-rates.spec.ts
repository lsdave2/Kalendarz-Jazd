import {test,expect} from '@playwright/test';

test('custom participants without an instructor never inherit a hidden lesson instructor',async({page})=>{
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
  const refs={clients:[{id:'a',name:'Anna',account:{balance:0}}],horses:[],instructors:[{id:'i',name:'Ania',lesson_rate:60}],settings:[]};
  const lesson={id:'custom',date,start_minute:600,duration_minutes:60,kind:'custom',status:'scheduled',instructor_id:'i',instructor_name:'Ania',
    bookings:[{id:'a',client_id:'a',client_name:'Anna',billing_mode:'cash',cash_amount:150,attendance:'attended',removed:false,instructor_id:null}]};
  await page.route('**/test-api/rpc',route=>{
    const {name}=route.request().postDataJSON();
    const result=name==='hb_health'?{admin:true,schema_version:1}:name==='hb_references'?refs:name==='hb_calendar'?{lessons:[lesson],events:[],settings:[]}:name==='hb_review_count'?0:[];
    return route.fulfill({json:{result}});
  });
  await page.goto('/#calendar/'+date);
  await expect(page.locator('.lesson-tile')).toBeVisible();
  await expect(page.locator('.calendar-instructor-tag')).toHaveCount(0);
  await page.getByRole('button',{name:'Finanse',exact:true}).click();
  await expect(page.locator('.report-instructor-payment')).toHaveText('0 zł');
});

test('instructor editor rates control hourly group pay and finances totals',async({page})=>{
  const refs={clients:[{id:'a',name:'Anna',account:{balance:0}},{id:'b',name:'Jan',account:{balance:0}}],horses:[],instructors:[{id:'i',name:'Ania',color:'#34d399',revision:1,archived:false,lesson_rate:60}],settings:[]};
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
  const booking=(id:string)=>({id,client_id:id,client_name:id==='a'?'Anna':'Jan',billing_mode:'cash',cash_amount:150,attendance:'attended',removed:false,instructor_id:'i'});
  const group={id:'g',date,start_minute:600,duration_minutes:90,kind:'group',status:'scheduled',instructor_id:'i',bookings:[booking('a'),booking('b')]};
  const individual={...group,id:'single',duration_minutes:30,kind:'individual',bookings:[booking('a')]};
  await page.route('**/test-api/rpc',async route=>{
    const {name,args}=route.request().postDataJSON();let result:any=[];
    if(name==='hb_health')result={admin:true,schema_version:1};
    if(name==='hb_references')result=refs;
    if(name==='hb_calendar')result={lessons:[group,individual],events:[],settings:[]};
    if(name==='hb_review_count')result=0;
    if(name==='hb_save_reference'){expect(args.p_kind).toBe('instructors');Object.assign(refs.instructors[0],args.p_record,{revision:2});result=refs.instructors[0];}
    await route.fulfill({json:{result}});
  });
  await page.goto('/#finances');
  await expect(page.locator('.report-instructor-payment')).toHaveText('120 zł');
  await page.getByRole('button',{name:/Ania.*zł/}).click();
  await expect(page.locator('.report-summary-grid').first()).toContainText('1 (1h 30m)');
  await page.getByRole('button',{name:'Raport szczegółowy',exact:true}).click();
  await expect(page.getByRole('dialog').locator('.report-entry-row')).toHaveCount(2);
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();
  await page.getByRole('button',{name:'Ustawienia',exact:true}).click();
  await page.locator('.settings-chip').filter({hasText:'Ania'}).click();
  await expect(page.getByLabel('Stawka za lekcję (zł/h)',{exact:true})).toHaveValue('60');
  await page.getByLabel('Stawka za lekcję (zł/h)',{exact:true}).fill('80');
  await expect(page.getByRole('dialog').locator('input[type=number]')).toHaveCount(1);
  await page.getByRole('button',{name:'Zapisz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.locator('.settings-chip').filter({hasText:'Ania'}).click();
  await expect(page.getByLabel('Stawka za lekcję (zł/h)',{exact:true})).toHaveValue('80');
  await page.getByRole('button',{name:'Zamknij',exact:true}).click();
  await page.getByRole('button',{name:'Finanse',exact:true}).click();
  await expect(page.locator('.report-instructor-payment')).toHaveText('160 zł');
  await page.getByRole('button',{name:'Zysk i straty',exact:true}).click();
  await expect(page.locator('.report-summary-value.total')).toHaveText('290 zł');
  await page.getByRole('button',{name:'Ustawienia stawek',exact:true}).click();
  await expect(page.getByText('Stawki wynagrodzeń instruktorów',{exact:true})).toHaveCount(0);
  await expect(page.locator('.fin-section').last().locator('input[type=number]')).toHaveCount(4);
});
