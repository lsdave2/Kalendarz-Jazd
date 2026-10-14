import {test,expect} from '@playwright/test';

for(const action of ['skip','save'] as const)test(`credit review snapshot: ${action}, picker cancellation and export retry`,async({page})=>{
  let applied=0,exports=0,failExport=true;
  const snapshot={format:'horsebook.snapshot',version:1,created_at:'2026-10-13T10:00:00Z',data:{decisions:[{action:'charge'}]}};
  await page.addInitScript(()=>{
    const state=(window as any).backupTest={options:[],cancel:true,writes:[],closed:0};
    Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async(options:any)=>{
      state.options.push(options);
      if(state.cancel){state.cancel=false;throw new DOMException('Cancelled','AbortError');}
      return {createWritable:async()=>({write:async(blob:Blob)=>state.writes.push(await blob.text()),close:async()=>{state.closed++;},abort:async()=>{}})};
    }});
  });
  await page.route('**/test-api/rpc',async route=>{
    const {name}=route.request().postDataJSON();let result:any=[];
    if(name==='hb_health')result={admin:true,schema_version:1};
    if(name==='hb_calendar')result={lessons:[],events:[],settings:[]};
    if(name==='hb_references')result={clients:[],horses:[],instructors:[],settings:[]};
    if(name==='hb_review_count')result=applied?0:1;
    if(name==='hb_review_queue')result=applied?[]:[{id:'booking',client_id:'client',client_name:'Anna',date:'2026-10-12',start_minute:600,lesson_kind:'individual',lesson_status:'scheduled',billing_mode:'package',balance:3,posted_net:0,review_status:'pending',revision:1}];
    if(name==='hb_review_credits'){applied++;result={};}
    if(name==='hb_export_snapshot'){
      exports++;
      if(failExport){failExport=false;await route.fulfill({status:503,json:{message:'Export unavailable'}});return;}
      result=snapshot;
    }
    await route.fulfill({json:{result}});
  });
  await page.goto('/#calendar/2026-10-12');
  await page.getByRole('button',{name:'Przejrzyj kredyty'}).click();
  await page.getByRole('button',{name:'Odejmij',exact:true}).click();
  await page.getByRole('button',{name:'Zatwierdź zaznaczone (1)'}).click();
  const popup=page.getByRole('dialog',{name:'Zapisać kopię danych?'});
  await expect(popup).toBeVisible();expect(exports).toBe(0);
  if(action==='skip'){
    await popup.getByRole('button',{name:'Pomiń',exact:true}).click();
    await expect(popup).toHaveCount(0);expect(exports).toBe(0);
    expect(await page.evaluate(()=>(window as any).backupTest.options)).toHaveLength(0);
  }else{
    const save=popup.getByRole('button',{name:'Zapisz kopię na urządzeniu'});
    await save.click();await expect(save).toBeEnabled();expect(exports).toBe(0);
    await save.click();await expect(popup.getByRole('alert')).toContainText('Export unavailable');
    await save.click();await expect(popup.getByRole('status')).toContainText('Kopia została zapisana na urządzeniu.');
    const state=await page.evaluate(()=>(window as any).backupTest);
    expect(state.options[0].startIn).toBe('documents');expect(state.options[0].id).toBe('horsebook-snapshots');expect(state.options[0].suggestedName).toMatch(/^horsebook-.*\.json$/);
    expect(state.closed).toBe(1);expect(state.writes).toHaveLength(1);
    expect(JSON.parse(state.writes[0]).snapshot).toEqual(snapshot);
    expect(JSON.parse(state.writes[0]).manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(exports).toBe(2);
  }
  expect(applied).toBe(1);
});
