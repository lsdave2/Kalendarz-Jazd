import {t,useLanguage,getLocale,weekdays} from './i18n';
import {useCallback,useEffect,useRef,useState} from 'react';
import {rpc,write,supabase,localTest,errorMessage} from './api';
import {today,monthRange,shiftMonth} from './dates';
import {Icon} from './components';
import {DailyCalendar} from './DailyCalendar';
import {LessonEditor} from './LessonEditor';
import {CreationEditor} from './CreationEditor';
import {EventEditor} from './EventEditor';
import {ReviewPanel} from './ReviewPanel';
import {Accounts} from './Accounts';
import {Settings} from './Settings';
import {Finances} from './Finances';
import {emptyReferences,type References,type Lesson,type CalendarEvent,type Setting} from './types';
type Page={tab:'calendar'|'clients'|'finances'|'settings';date:string|null;month:string};
function locationPage():Page{
  const [tab,value]=location.hash.slice(1).split('/');
  if(tab==='calendar'&&/^\d{4}-\d{2}-\d{2}$/.test(value))return {tab:'calendar',date:value,month:value.slice(0,7)};
  return {tab:['clients','finances','settings'].includes(tab)?tab as Page['tab']:'calendar',date:null,month:/^\d{4}-\d{2}$/.test(value)?value:today().slice(0,7)};
}
export function App(){
  useLanguage();
  const [page,setPage]=useState(locationPage),[admin,setAdmin]=useState(false),[refs,setRefs]=useState<References>(emptyReferences),[lessons,setLessons]=useState<Lesson[]>([]),[settings,setSettings]=useState<Setting[]>([]);
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [hasLoaded,setHasLoaded]=useState(false);
  const [loggedInEmail,setLoggedInEmail]=useState<string|null>(null);
  const [events,setEvents]=useState<CalendarEvent[]>([]),[eventEditor,setEventEditor]=useState<CalendarEvent>();
  const [editor,setEditor]=useState<Lesson|null|undefined>(),[review,setReview]=useState(false),[authTick,setAuthTick]=useState(0);
  const generation=useRef(0),writeLock=useRef(false),activePage=useRef(page);activePage.current=page;
  const monthSwipe=useRef<{id:number;x:number;y:number;month:string}|null>(null),suppressMonthClick=useRef(false);
  const navigate=(tab:Page['tab'],value?:string)=>{location.hash=tab+(value?'/'+value:'');};
  useEffect(()=>{const change=()=>{setPage(locationPage());setEditor(undefined);setEventEditor(undefined);setReview(false);};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  const refresh=useCallback(async()=>{
    const current=++generation.current;setLoading(true);setLoadError('');
    try {
      const health=await rpc<{admin:boolean;schema_version:number}>('hb_health');
      if(health.schema_version!==1)throw new Error(t("Wersja bazy nie odpowiada aplikacji."));
      const range=monthRange(activePage.current.month);
      const [calendar,references]=await Promise.all([rpc<{lessons:Lesson[];events?:CalendarEvent[];settings:Setting[]}>('hb_calendar',{p_from:range.from,p_to:range.to}),
        health.admin?rpc<References>('hb_references'):Promise.resolve(emptyReferences)]);
      if(current===generation.current){setAdmin(health.admin);setRefs(references);setLessons(calendar.lessons);setEvents(calendar.events??[]);setSettings(calendar.settings);setRevision(x=>x+1);setHasLoaded(true);}
    } catch(e){if(current===generation.current){setLoadError(errorMessage(e));setRefs(emptyReferences);setLessons([]);setEvents([]);setAdmin(false);}throw e;}
    finally{if(current===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{void refresh().catch(()=>{});},[page.month,authTick,refresh]);
  useEffect(()=>{if(notice!=='Zapisano w bazie.')return;const timer=window.setTimeout(()=>setNotice(''),3500);return()=>window.clearTimeout(timer);},[notice]);
  useEffect(()=>{
    const subscription=supabase?.auth.onAuthStateChange((_event,session)=>{setLoggedInEmail(session?.user.email??null);setAuthTick(x=>x+1);}).data.subscription;
    const reload=()=>{if(!writeLock.current&&document.visibilityState==='visible')void refresh().catch(()=>{});};
    window.addEventListener('focus',reload);window.addEventListener('online',reload);
    const timer=window.setInterval(reload,30000);
    return()=>{subscription?.unsubscribe();window.removeEventListener('focus',reload);window.removeEventListener('online',reload);window.clearInterval(timer);};
  },[refresh]);
  async function run(name:string,args:Record<string,unknown>){
    if(writeLock.current)return false;writeLock.current=true;setBusy(true);setNotice('');
    try {await write(name,args);setNotice('Zapisano w bazie.');try{await refresh();}catch{setNotice(t("Zapisano w bazie, ale nie udało się odświeżyć widoku. Odśwież przed kolejną zmianą."));}return true;}
    catch(e){setNotice(errorMessage(e));return false;}finally{writeLock.current=false;setBusy(false);}
  }
  const selectedDate=page.date;
  const dayLessons=lessons.filter(l=>l.date===selectedDate);
  const closed=settings.find(s=>s.key==='closed_dates');
  const closedDates:string[]=closed?.value??[];
  const safeTab=!admin&&['clients','finances'].includes(page.tab)?'settings':page.tab;
  const title=safeTab==='calendar'?'Stajnia Rotmistrz':safeTab==='clients'?t("Klienci"):safeTab==='finances'?t("Finanse"):t("Ustawienia");
  const month=monthRange(page.month),days=Number(month.to.slice(-2)),weekday=(new Date(month.from+'T12:00:00Z').getUTCDay()+6)%7;
  return <>
    {localTest&&<div className="v2-test-banner">{t("Baza testowa · dane przykładowe")}</div>}
    {!(selectedDate&&safeTab==='calendar')&&<header className="app-header"><h1><Icon name="calendar_month"/><span>{title}</span></h1></header>}
    {notice&&<div className={`v2-notice ${notice==='Zapisano w bazie.'?'v2-notice-saved':''}`.trim()} role="status"><span>{notice==='Zapisano w bazie.'?t('Zapisano w bazie.'):notice}</span>
      {notice!=='Zapisano w bazie.'&&<button className="header-btn" aria-label={t("Zamknij komunikat")} onClick={()=>setNotice('')}><Icon name="close"/></button>}</div>}
    <main className="page">
      {loadError&&<div role="alert" className="v2-error">{loadError}<button className="btn btn-secondary v2-wide" onClick={()=>void refresh().catch(()=>{})}>{t("Spróbuj ponownie")}</button></div>}
      {loading&&(safeTab!=='calendar'||!hasLoaded)&&<p className="v2-note" role="status">{t("Wczytywanie danych…")}</p>}
      {!loadError&&safeTab==='calendar'&&(selectedDate?<>
        <DailyCalendar date={selectedDate} lessons={dayLessons} events={events.filter(e=>e.date===selectedDate)} settings={settings} refs={refs} admin={admin} busy={busy||loading} reviewRevision={revision}
          onEdit={setEditor} onMonth={()=>navigate('calendar',page.month)} onNavigate={date=>navigate('calendar',date)} onReview={()=>setReview(true)}
          onEditEvent={setEventEditor} onMoveEvent={(event,startMinute)=>run('hb_move_event_time',{p_event_id:event.id,p_expected_revision:event.revision,p_start_minute:startMinute})}
          onMove={(lesson,startMinute)=>run('hb_move_lesson_time',{p_lesson_id:lesson.id,p_expected_revision:lesson.revision,p_start_minute:startMinute})}
          onToggle={()=>void run('hb_save_setting',{p_key:'closed_dates',p_expected_revision:closed?.revision??null,p_value:closedDates.includes(selectedDate)?closedDates.filter(d=>d!==selectedDate):[...closedDates,selectedDate]})}/>
        {admin&&<button className="fab" id="fab-add-lesson" aria-label={t("Dodaj lekcję")} disabled={busy||loading} onClick={()=>setEditor(null)}><Icon name="add"/></button>}
      </>:<div className="monthly-calendar" aria-busy={loading}
        onPointerDown={e=>{
          monthSwipe.current=null;suppressMonthClick.current=false;
          if(!e.isPrimary||e.button!==0||busy||loading||(e.target as HTMLElement).closest('.month-nav'))return;
          monthSwipe.current={id:e.pointerId,x:e.clientX,y:e.clientY,month:page.month};
        }}
        onPointerMove={e=>{
          const current=monthSwipe.current;if(!current||current.id!==e.pointerId)return;
          const dx=Math.abs(e.clientX-current.x),dy=Math.abs(e.clientY-current.y);
          if(dy>10&&dy>=dx){monthSwipe.current=null;return;}
          if(dx>10&&dx>dy){
            suppressMonthClick.current=true;e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
        onPointerUp={e=>{
          const current=monthSwipe.current;if(!current||current.id!==e.pointerId)return;
          monthSwipe.current=null;
          const dx=current.x-e.clientX,dy=Math.abs(current.y-e.clientY);
          if(current.month===page.month&&!busy&&!loading&&Math.abs(dx)>50&&dy<50){
            suppressMonthClick.current=true;navigate('calendar',shiftMonth(page.month,dx>0?1:-1));
          }
        }}
        onPointerCancel={()=>{monthSwipe.current=null;}}
        onLostPointerCapture={e=>{if(e.target===e.currentTarget)monthSwipe.current=null;}}
        onClickCapture={e=>{if(suppressMonthClick.current&&e.detail>0){e.preventDefault();e.stopPropagation();suppressMonthClick.current=false;}}}>
        <div className="month-header"><h2>{new Intl.DateTimeFormat(getLocale(),{month:'long',year:'numeric',timeZone:'Europe/Warsaw'}).format(new Date(month.from+'T12:00:00Z'))}</h2><div className="month-nav">
          <button aria-label={t("Poprzedni miesiąc")} onClick={()=>navigate('calendar',shiftMonth(page.month,-1))}><Icon name="chevron_left"/></button>
          <button aria-label={t("Dzisiaj")} onClick={()=>navigate('calendar',today())}><Icon name="today"/></button>
          <button aria-label={t("Następny miesiąc")} onClick={()=>navigate('calendar',shiftMonth(page.month,1))}><Icon name="chevron_right"/></button></div></div>
        <div className="calendar-grid">{weekdays().map(x=><div className="calendar-day-label" key={x}>{x}</div>)}
          {Array.from({length:weekday},(_,i)=><div className="calendar-day empty" key={'blank'+i}/>)}
          {Array.from({length:days},(_,i)=>{const d=`${page.month}-${String(i+1).padStart(2,'0')}`,count=lessons.filter(l=>l.date===d&&l.status!=='cancelled').length+events.filter(e=>e.date===d).length;return <button key={d} aria-label={d} className={`calendar-day ${d===today()?'today':''} ${d<today()?'past':''} ${count?'has-lessons':''} ${closedDates.includes(d)?'closed':''}`} onClick={()=>navigate('calendar',d)}>{i+1}{count>0&&<span className="lesson-count-badge">{count}</span>}</button>;})}
        </div>
      </div>)}
      {safeTab==='clients'&&<Accounts refs={refs} run={run} busy={busy||loading}/>}
      {safeTab==='finances'&&<Finances refs={refs} run={run} busy={busy||loading} revision={revision}/>}
      {safeTab==='settings'&&<Settings admin={admin} loggedInEmail={loggedInEmail} refs={refs} run={run} busy={busy||loading} refresh={refresh} notify={setNotice}/>}
    </main>
    <nav className="bottom-nav" aria-label={t("Nawigacja")}>{[{tab:'calendar',label:t("Kalendarz"),icon:'calendar_month'},...(admin?[{tab:'clients',label:t("Klienci"),icon:'groups'},{tab:'finances',label:t("Finanse"),icon:'payments'}]:[]),{tab:'settings',label:t("Ustawienia"),icon:'settings'}].map(x=><button key={x.tab} className={`nav-item ${safeTab===x.tab?'active':''}`} onClick={()=>navigate(x.tab as Page['tab'],x.tab==='calendar'?(safeTab==='calendar'&&selectedDate?page.month:today()):undefined)}><Icon name={x.icon}/>{x.label}</button>)}</nav>
    {editor===null&&admin&&<CreationEditor date={selectedDate??today()} refs={refs} run={run} busy={busy} onClose={()=>setEditor(undefined)}/>}
    {editor&&admin&&<LessonEditor date={selectedDate??today()} lesson={editor} refs={refs} run={run} busy={busy} onClose={()=>setEditor(undefined)}/>}
    {eventEditor&&admin&&<EventEditor date={selectedDate??today()} event={eventEditor} refs={refs} run={run} busy={busy} onClose={()=>setEventEditor(undefined)}/>}
    {review&&admin&&<ReviewPanel through={selectedDate??today()} run={run} busy={busy} onClose={()=>setReview(false)}/>}
  </>;
}
