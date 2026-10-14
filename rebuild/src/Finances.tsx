import {t} from './i18n';
import {Fragment,useEffect,useState,type ReactNode} from 'react';
import {rpc,errorMessage} from './api';
import {today} from './dates';
import {Field,Icon,Modal,type Run} from './components';
import type {Finance,Lesson,References} from './types';
// v1 uses this compact amount format throughout its finance reports.
const money=(value:number)=>`${Number.isInteger(value)?value:value.toFixed(2)} zł`;
const duration=(minutes:number)=>[minutes>=60?`${Math.floor(minutes/60)}h`:'',minutes%60?`${minutes%60}m`:''].filter(Boolean).join(' ')||'0m';
const defaultFrom=()=>{const date=new Date(today()+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-7);return date.toISOString().slice(0,10);};
function Section({title,icon,initiallyOpen=false,children}:{title:string;icon:string;initiallyOpen?:boolean;children:ReactNode}){
  const [open,setOpen]=useState(initiallyOpen);
  return <section className={`fin-section ${open?'':'collapsed'}`}><button type="button" className="fin-section-header" aria-expanded={open} onClick={()=>setOpen(!open)}><span className="fin-section-title"><Icon name={icon}/>{title}</span><span className="material-symbols-rounded fin-section-arrow" aria-hidden="true">{open?'expand_less':'expand_more'}</span></button><div className="fin-section-body" inert={!open}>{children}</div></section>;
}
function Switch({label,checked,onChange}:{label:string;checked:boolean;onChange:()=>void}){return <button type="button" role="switch" aria-label={label} aria-checked={checked} className={`toggle ${checked?'active':''}`} onClick={onChange}/>;}
function FinanceEditor({record,run,busy,onClose}:{record:Finance|null;run:Run;busy:boolean;onClose:()=>void}){
  const [draft,setDraft]=useState<Finance>(record??{id:crypto.randomUUID(),kind:'expense',title:'',amount:0,date:today(),notes:'',archived:false,revision:1});
  return <Modal className="finance-editor" title={record?t('Edytuj transakcję'):t('Dodaj transakcję')} onClose={onClose} busy={busy}><form onSubmit={async e=>{
    e.preventDefault();if(await run('hb_save_finance',{p_expected_revision:record?.revision??null,p_record:draft}))onClose();
  }}><fieldset disabled={busy}>
    <div className="form-group"><label>{t('Rodzaj')}</label><div className="fin-cat-picker">{(['expense','income'] as const).map(kind=><button key={kind} type="button" className={`fin-cat-chip ${draft.kind===kind?'active':''}`} aria-pressed={draft.kind===kind} onClick={()=>setDraft(d=>({...d,kind}))}><Icon name={kind==='expense'?'remove_circle':'add_circle'}/>{kind==='expense'?t('Wydatek'):t('Przychód')}</button>)}</div></div>
    <Field label={t('Tytuł')}><input className="form-input" required value={draft.title} onChange={e=>setDraft(d=>({...d,title:e.target.value}))}/></Field>
    <Field label={t('Wartość')}><input className="form-input" type="number" required min="0.01" step="0.01" value={draft.amount||''} onChange={e=>setDraft(d=>({...d,amount:Number(e.target.value)}))}/></Field>
    <Field label={t('Data')}><input className="form-input" type="date" required value={draft.date} onChange={e=>setDraft(d=>({...d,date:e.target.value}))}/></Field>
    <Field label={t('Opis')}><textarea className="form-input" style={{minHeight:60,resize:'vertical'}} value={draft.notes} onChange={e=>setDraft(d=>({...d,notes:e.target.value}))}/></Field>
    <div className="btn-group" style={{marginTop:16}}><button className="btn btn-primary" style={{flex:1}} type="submit">{record?t('Zapisz'):t('Dodaj')}</button>
    {record&&<button type="button" className="btn btn-danger" aria-label={t('Usuń transakcję')} onClick={async()=>{if(confirm(t('Usunąć tę transakcję?'))&&await run('hb_save_finance',{p_expected_revision:record.revision,p_record:{...record,archived:true}}))onClose();}}><Icon name="delete"/></button>}
    <button type="button" className="btn btn-secondary" onClick={onClose}>{t('Anuluj')}</button></div>
  </fieldset></form></Modal>;
}
type Entry={date:string;client:string;kind:Lesson['kind'];minutes:number;amount:number};
function Days({entries,revenue=false}:{entries:Entry[];revenue?:boolean}){
  const dates=[...new Set(entries.map(e=>e.date))].sort();
  return <div className="report-day-list" style={{display:'flex',flexDirection:'column',gap:12}}>{dates.length===0?<div className="fin-exp-empty">{t('Brak jazd w tym okresie.')}</div>:dates.map(date=>{const day=entries.filter(e=>e.date===date);return <div className="report-day-section" key={date}><div className="report-day-header"><div className="report-day-title">{date}</div><div className="report-day-total">{money(day.reduce((s,e)=>s+e.amount,0))}</div></div><div className="report-day-entries">{day.map((e,i)=><div className="report-entry-row" key={i}><div className="report-entry-left"><div className="report-entry-name">{e.client}</div><div className="report-entry-meta">{e.kind==='group'?t('Jazda grupowa'):e.kind==='custom'?t('Jazda niestandardowa'):t('Jazda indywidualna')}{(!revenue||e.kind!=='custom')&&<> - {duration(e.minutes)}{revenue&&<> × {money(e.amount/(e.minutes/60))}</>}</>}</div></div><div className="report-entry-amount">{money(e.amount)}</div></div>)}</div></div>;})}</div>;
}
export function Finances({refs,run,busy,revision}:{refs:References;run:Run;busy:boolean;revision:number}){
  const [from,setFrom]=useState(defaultFrom),[to,setTo]=useState(today());
  const [rows,setRows]=useState<Finance[]>([]),[lessons,setLessons]=useState<Lesson[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[edit,setEdit]=useState<Finance|null|undefined>();
  const [expanded,setExpanded]=useState<Record<string,boolean>>({}),[excluded,setExcluded]=useState<Record<string,boolean>>({}),[detailed,setDetailed]=useState(false),[report,setReport]=useState<string>();
  const savedRates=refs.settings.find(s=>s.key==='report_rates');
  const readRates=()=>({individual:Number(savedRates?.value.revenue_individual??140),group:Number(savedRates?.value.revenue_group??110),packageIndividual:Number(savedRates?.value.package_individual??110),packageGroup:Number(savedRates?.value.package_group??90)});
  const [rates,setRates]=useState(readRates),[ratesRevision,setRatesRevision]=useState<number|null>(savedRates?.revision??null),[ratesDirty,setRatesDirty]=useState(false);
  useEffect(()=>{if(!ratesDirty){setRates(readRates());setRatesRevision(savedRates?.revision??null);}},[savedRates,ratesDirty]);
  useEffect(()=>{let active=true;setError('');setLoading(true);
    (async()=>{
      if(to<from)throw new Error(t('Data końcowa musi być po dacie początkowej.'));
      const entries:Finance[]=[];for(let offset=0;;offset+=100){const page=await rpc<Finance[]>('hb_finances',{p_from:from,p_to:to,p_limit:100,p_offset:offset});entries.push(...page);if(page.length<100)break;}
      const allLessons:Lesson[]=[];let start=from;while(start<=to){const max=new Date(start+'T12:00:00Z');max.setUTCDate(max.getUTCDate()+93);const end=max.toISOString().slice(0,10)<to?max.toISOString().slice(0,10):to;
        allLessons.push(...(await rpc<{lessons:Lesson[]}>('hb_calendar',{p_from:start,p_to:end})).lessons);
        const next=new Date(end+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);start=next.toISOString().slice(0,10);}
      if(active){setRows(entries);setLessons(allLessons);}
    })().catch(e=>{if(active)setError(errorMessage(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
  },[from,to,revision]);
  const income=rows.filter(x=>x.kind==='income').reduce((s,x)=>s+Number(x.amount),0),expense=rows.filter(x=>x.kind==='expense').reduce((s,x)=>s+Number(x.amount),0);
  const revenue={individual:{count:0,amount:0},group:{count:0,amount:0},packageIndividual:{count:0,amount:0},packageGroup:{count:0,amount:0},custom:{count:0,amount:0}};
  const payments:Record<string,Entry[]>={},revenueEntries:Entry[]=[];
  for(const lesson of lessons){
    const hours=lesson.duration_minutes/60;
    const eligible=lesson.bookings.filter(b=>eligibleBooking(b,lesson));
    for(const b of eligible){
      const client=refs.clients.find(c=>c.id===b.client_id),custom=client?.payment_rate;
      // Preserve rebuild billing: cash uses the saved price, packages only count approved charges.
      const amount=b.billing_mode==='cash'?Number(b.cash_amount):hours*Number(custom??(lesson.kind==='group'?rates.packageGroup:rates.packageIndividual));
      const key=lesson.kind==='custom'?'custom':b.billing_mode==='package'?(lesson.kind==='group'?'packageGroup':'packageIndividual'):lesson.kind;
      revenue[key].count++;revenue[key].amount+=amount;
      const entry={date:lesson.date,client:b.client_name??client?.name??t('Klient'),kind:lesson.kind,minutes:lesson.duration_minutes,amount};revenueEntries.push(entry);
    }
    const instructorId=(b:Lesson['bookings'][number])=>lesson.kind==='custom'?b.instructor_id:lesson.instructor_id;
    const instructorIds=[...new Set(eligible.map(instructorId).filter((id):id is string=>!!id))];
    for(const id of instructorIds){
      const instructor=refs.instructors.find(i=>i.id===id);
      const bookings=eligible.filter(b=>instructorId(b)===id);
      const entries=bookings.map(b=>({date:lesson.date,client:b.client_name??refs.clients.find(c=>c.id===b.client_id)?.name??t('Klient'),kind:lesson.kind,minutes:lesson.duration_minutes,amount:hours*Number(instructor?.lesson_rate??60)}));
      // Pay once per instructor per group lesson, regardless of participant count.
      if(lesson.kind==='group')(payments[id]??=[]).push({...entries[0],client:entries.map(e=>e.client).join(', '),amount:entries[0].amount});
      else (payments[id]??=[]).push(...entries);
    }
  }
  const gross=revenueEntries.reduce((s,e)=>s+e.amount,0),instructorTotal=Object.entries(payments).reduce((sum,[id,entries])=>sum+(excluded[id]?0:entries.reduce((s,e)=>s+e.amount,0)),0);
  const instructors=refs.instructors.filter(i=>!i.archived||payments[i.id]);
  const summaryRow=(label:string,value:string,total=false)=><Fragment key={label}><div className={`report-summary-label ${total?'total':''}`}>{label}</div><div className={`report-summary-value ${total?'total':''}`}>{value}</div></Fragment>;
  const rateInput=(label:string,key:keyof typeof rates)=><Field label={label}><input className="form-input" type="number" min="0" step="1" value={rates[key]} onChange={e=>{setRatesDirty(true);setRates(r=>({...r,[key]:Number(e.target.value)}));}}/></Field>;
  return <div className="fin-container">
    <div className="fin-section finance-dates" style={{padding:16}}><div className="form-row" style={{marginBottom:0}}><Field label={t('Od')}><input className="form-input" type="date" required value={from} onClick={e=>{try{e.currentTarget.showPicker();}catch{}}} onChange={e=>{if(e.target.value)setFrom(e.target.value);}}/></Field><Field label={t('do')}><input className="form-input" type="date" required value={to} onClick={e=>{try{e.currentTarget.showPicker();}catch{}}} onChange={e=>{if(e.target.value)setTo(e.target.value);}}/></Field></div></div>
    {error&&<p className="v2-error" role="alert">{error}</p>}
    {loading&&<div className="fin-exp-empty" role="status">{t('Wczytywanie zestawienia…')}</div>}
    <div inert={loading||!!error} className="finance-sections">
    <Section title={t('Wynagrodzenia instruktorów')} icon="school" initiallyOpen>
      {instructors.length===0?<div className="report-instructor-empty">{t('Brak instruktorów.')}</div>:<div className="report-instructor-list">{instructors.map(i=>{const entries=payments[i.id]??[],amount=entries.reduce((s,e)=>s+e.amount,0),individual=entries.filter(e=>e.kind==='individual'),group=entries.filter(e=>e.kind==='group'),custom=entries.filter(e=>e.kind==='custom');return <Fragment key={i.id}><div className="report-instructor-row"><button type="button" className="report-instructor-left finance-instructor-expand" aria-expanded={!!expanded[i.id]} onClick={()=>setExpanded(s=>({...s,[i.id]:!s[i.id]}))}><span className="material-symbols-rounded" style={{fontSize:18,color:'var(--text-muted)'}} aria-hidden="true">{expanded[i.id]?'expand_more':'chevron_right'}</span><span style={{display:'flex',flexDirection:'column',gap:2}}><span className="report-instructor-name">{i.name}</span><span className="report-instructor-payment">{money(amount)}</span></span></button><Switch label={i.name} checked={!excluded[i.id]} onChange={()=>setExcluded(s=>({...s,[i.id]:!s[i.id]}))}/></div>{expanded[i.id]&&<><div className="report-summary-grid" style={{padding:'8px 12px',background:'var(--bg-elevated)',borderBottom:'1px solid var(--border)',fontSize:'.8rem',marginBottom:8}}>
      {summaryRow(t('Jazdy indywidualne'),`${individual.length} (${duration(individual.reduce((s,e)=>s+e.minutes,0))})`)}
      {summaryRow(t('Jazdy grupowe'),`${group.length} (${duration(group.reduce((s,e)=>s+e.minutes,0))})`)}
      {summaryRow(t('Jazda niestandardowa'),`${custom.length} (${duration(custom.reduce((s,e)=>s+e.minutes,0))})`)}
      {summaryRow(t('Wynagrodzenie za jazdy indywidualne'),money(individual.reduce((s,e)=>s+e.amount,0)))}{summaryRow(t('Wynagrodzenie za jazdy niestandardowe'),money(custom.reduce((s,e)=>s+e.amount,0)))}{summaryRow(t('Wynagrodzenie za jazdy grupowe'),money(group.reduce((s,e)=>s+e.amount,0)))}{summaryRow(t('Łączne wynagrodzenie'),money(amount),true)}</div><button className="btn btn-secondary btn-sm finance-detail-button" onClick={()=>setReport(i.id)}><Icon name="description"/>{t('Raport szczegółowy')}</button></>}</Fragment>;})}</div>}
    </Section>
    <Section title={t('Zysk i straty')} icon="analytics">
      <div className="report-summary-grid" style={{marginBottom:16,paddingBottom:16,borderBottom:'1px dashed var(--border)'}}>{([[t('Jazdy indywidualne'),'individual'],[t('Jazdy grupowe'),'group'],[t('Jazdy indywidualne w karnecie'),'packageIndividual'],[t('Jazdy grupowe w karnecie'),'packageGroup'],[t('Jazdy niestandardowe'),'custom']] as const).map(([label,key])=><Fragment key={key}><div className="report-summary-label">{label}</div><div className="report-summary-stat"><div className="report-summary-stat-count">{revenue[key].count}×</div><div className="report-summary-stat-revenue">{money(revenue[key].amount)}</div></div></Fragment>)}</div>
      <div className="report-summary-grid">{summaryRow(t('Przychód brutto'),money(gross))}{summaryRow(t('Suma przychodów')+':',`+ ${money(income)}`)}{summaryRow(t('Potrącenia instruktorów')+':',`− ${money(instructorTotal)}`)}{summaryRow(t('Suma wydatków')+':',`− ${money(expense)}`)}{summaryRow(t('Zysk netto'),money(gross+income-instructorTotal-expense),true)}</div>
      <div className="toggle-row" style={{marginTop:16,borderTop:'1px solid var(--border)',paddingTop:16}}><span>{t('Raport szczegółowy')}</span><Switch label={t('Raport szczegółowy')} checked={detailed} onChange={()=>setDetailed(!detailed)}/></div>{detailed&&revenueEntries.length>0&&<div style={{marginTop:12}}><Days entries={revenueEntries} revenue/></div>}
    </Section>
    <Section title={t('Transakcje')} icon="receipt_long">
      {rows.length>0&&<div className="fin-exp-total finance-transaction-totals"><div><span>{t('Suma przychodów')}:</span><span className="fin-exp-total-val v2-positive">{money(income)}</span></div><div><span>{t('Suma wydatków')}:</span><span className="fin-exp-total-val v2-negative">{money(expense)}</span></div></div>}
      <div className="expenses-list">{rows.length===0?<div className="fin-exp-empty">{t('Brak transakcji w tym okresie.')}</div>:[...rows].sort((a,b)=>b.date.localeCompare(a.date)).map(row=><button type="button" className="fin-exp-row" key={row.id} disabled={busy} onClick={()=>setEdit(row)}><span className="fin-exp-left"><span className="fin-exp-title">{row.title||t('Bez tytułu')}</span><span className="fin-exp-meta">{row.date}</span></span><span className={`fin-exp-cost ${row.kind==='income'?'v2-positive':'v2-negative'}`}>{row.kind==='income'?'+':'−'}{money(Number(row.amount))}</span></button>)}</div>
      <button className="btn btn-primary btn-sm" style={{width:'100%',marginTop:12}} disabled={busy} onClick={()=>setEdit(null)}><Icon name="add"/>{t('Dodaj transakcję')}</button>
    </Section>
    <Section title={t('Ustawienia stawek')} icon="tune">
      <div className="fin-rates-label">{t('Stawki przychodów')}</div><div className="form-row">{rateInput(t('Jazda indywidualna (zł/h)'),'individual')}{rateInput(t('Jazda grupowa (zł/h)'),'group')}</div><div className="form-row">{rateInput(t('Jazda indywidualna w karnecie (zł/h)'),'packageIndividual')}{rateInput(t('Jazda grupowa w karnecie (zł/h)'),'packageGroup')}</div>
      {ratesDirty&&<button className="btn btn-secondary v2-wide" disabled={busy} onClick={async()=>{if(await run('hb_save_setting',{p_key:'report_rates',p_expected_revision:ratesRevision,p_value:{...savedRates?.value,revenue_individual:rates.individual,revenue_group:rates.group,package_individual:rates.packageIndividual,package_group:rates.packageGroup}}))setRatesDirty(false);}}>{t('Zapisz stawki raportów')}</button>}
      {ratesDirty&&ratesRevision!==(savedRates?.revision??null)&&<p className="v2-note">{t('Stawki zmienił inny administrator.')} <button className="btn btn-secondary btn-sm" onClick={()=>setRatesDirty(false)}>{t('Wczytaj aktualne stawki')}</button></p>}
    </Section>
    </div>
    {edit!==undefined&&<FinanceEditor record={edit} run={run} busy={busy} onClose={()=>setEdit(undefined)}/>}
    {report&&<Modal className="finance-report-modal" title={t('Raport szczegółowy')} onClose={()=>setReport(undefined)}><div style={{color:'var(--text-muted)',fontSize:'.9rem',marginBottom:16}}>{refs.instructors.find(i=>i.id===report)?.name}</div><div className="finance-report-content"><Days entries={payments[report]??[]}/></div><button className="btn btn-secondary" style={{marginTop:16,width:'100%'}} onClick={()=>setReport(undefined)}>{t('Zamknij')}</button></Modal>}
  </div>;
}
function eligibleBooking(b:Lesson['bookings'][number],lesson:Lesson){return b.billing_mode==='package'?b.review_status==='charged':!b.removed&&lesson.status!=='cancelled'&&b.attendance!=='cancelled'&&b.attendance!=='no_show';}
