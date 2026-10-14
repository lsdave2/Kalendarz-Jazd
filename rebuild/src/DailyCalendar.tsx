import {t} from './i18n';
import {Fragment,useEffect,useRef,useState} from 'react';
import {Icon} from './components';
import {rpc} from './api';
import {addDays,minuteTime,legacyDateParts} from './dates';
import type {Lesson,CalendarEvent,References,Setting} from './types';
import {useLessonDrag} from './useLessonDrag';

// Ported from src/views/CalendarView.js: retain the original geometry and markup.
const SLOT_HEIGHT=120,MIN_SCALE=.6;
function minimumTileHeight(lesson:Lesson){
  return lesson.kind==='individual'?54:38+lesson.bookings.filter(b=>!b.removed).length*18;
}
type TimedEntry={start_minute:number;duration_minutes:number;status?:string};
type CalendarEntry=(Lesson&{tileType:'lesson'})|(CalendarEvent&{tileType:'event';duration_minutes:number});
function lessonColumns<T extends TimedEntry>(lessons:T[]){
  const columns:T[][]=[];
  for(const lesson of lessons){
    let column=columns.find(c=>lesson.start_minute>=c.at(-1)!.start_minute+c.at(-1)!.duration_minutes);
    if(!column){column=[];columns.push(column);}column.push(lesson);
  }
  return columns;
}
function overlapClusters<T extends TimedEntry>(lessons:T[]){
  const sorted=[...lessons].sort((a,b)=>a.start_minute-b.start_minute||b.duration_minutes-a.duration_minutes);
  const groups:T[][]=[];let end=-1;
  for(const lesson of sorted){
    if(lesson.start_minute>=end){groups.push([]);end=-1;}
    groups.at(-1)!.push(lesson);end=Math.max(end,lesson.start_minute+lesson.duration_minutes);
  }
  return groups.map(group=>({
    start:Math.min(...group.map(l=>l.start_minute)),end:Math.max(...group.map(l=>l.start_minute+l.duration_minutes)),
    columns:[...lessonColumns(group.filter(l=>l.status!=='cancelled')).map(lessons=>({lessons,collapsed:false})),
      ...lessonColumns(group.filter(l=>l.status==='cancelled')).map(lessons=>({lessons,collapsed:group.length>1}))]
  }));
}
function warsawNow(now:Date){
  const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const part=(key:string)=>parts.find(p=>p.type===key)!.value;
  return {date:`${part('year')}-${part('month')}-${part('day')}`,minutes:Number(part('hour'))*60+Number(part('minute')),seconds:Number(part('second'))};
}
function displayName(lesson:Lesson){
  return lesson.kind==='group'?t("Grupowa"):lesson.kind==='custom'?t("Niestandardowa"):lesson.title||lesson.bookings.find(b=>!b.removed)?.client_name||'';
}
function assignedInstructors(lesson:Lesson){
  const ids=lesson.kind==='custom'?lesson.bookings.filter(b=>!b.removed).map(b=>b.instructor_id):[lesson.instructor_id];
  return [...new Set(ids.filter((id):id is string=>Boolean(id)))];
}
function LessonTile({lesson,date,slotHeight,startHour,endHour,previousEnd,collapsed,now,refs,admin,busy,dimmed,onEdit,onMove,onDragActive}:{
  lesson:Lesson;date:string;slotHeight:number;previousEnd:number;collapsed:boolean;now:ReturnType<typeof warsawNow>;
  refs:References;admin:boolean;busy:boolean;dimmed:boolean;onEdit:(lesson:Lesson)=>void;
  startHour:number;endHour:number;onMove:(lesson:Lesson,startMinute:number)=>Promise<boolean>;onDragActive:(active:boolean)=>void;
}){
  const drag=useLessonDrag({lesson,admin,busy,slotHeight,startHour,endHour,onMove,onDragActive});
  const participants=lesson.bookings.filter(b=>!b.removed),first=participants[0];
  const client=refs.clients.find(c=>c.id===first?.client_id),cancelled=lesson.status==='cancelled';
  const custom=lesson.kind==='custom',group=lesson.kind==='group';
  const color=!cancelled&&!custom?lesson.instructor_color:null;
  const past=date<now.date||(date===now.date&&(lesson.start_minute+lesson.duration_minutes)*60<now.minutes*60+now.seconds);
  const title=displayName(lesson);
  const creditColor=(balance:number,archived:boolean)=>cancelled||archived||balance===0?'var(--text-muted)':balance>0?'var(--green)':'var(--red)';
  return <div ref={drag.element} role={admin?'button':undefined} tabIndex={admin?0:undefined} aria-disabled={admin?busy||drag.saving:undefined}
    aria-label={t("Edytuj lekcję {0} o {1}",lesson.title||first?.client_name||title,minuteTime(lesson.start_minute))}
    data-date={date} data-end-minute={lesson.start_minute+lesson.duration_minutes} title={title}
    className={`lesson-tile ${cancelled||(!group&&!custom&&client?.archived)?'status-inactive':'status-neutral'} ${group||custom?'group-session':''} ${past?'past':''} ${cancelled?'cancelled':''} ${collapsed?'collapsed':''} ${dimmed?'instructor-filtered-out':''} ${drag.preview!==null?'dragging':''} ${drag.ready?'long-press-ready':''}`.trim()}
    style={{marginTop:(lesson.start_minute-previousEnd)/60*slotHeight,height:Math.max(lesson.duration_minutes/60*slotHeight,24),
      borderColor:color?`${color}66`:undefined,background:color?`linear-gradient(135deg, ${color}26, ${color}0c)`:undefined,
      position:'relative',width:'auto',minWidth:'100%',flexShrink:0,opacity:dimmed?.35:cancelled?.6:undefined,textDecoration:cancelled?'line-through':undefined,
      transform:drag.preview!==null?`translateY(${(drag.preview-lesson.start_minute)/60*slotHeight}px) scale(1.03)`:undefined,
      zIndex:drag.preview!==null?1000:undefined,transition:drag.preview!==null?'none':undefined}}
    onContextMenu={e=>{if(drag.ready||drag.preview!==null||navigator.maxTouchPoints>0)e.preventDefault();}}
    onClick={e=>{if(e.detail>0&&drag.consumeClick()){e.preventDefault();return;}if(admin&&!busy&&!drag.saving)onEdit(lesson);}}
    onKeyDown={e=>{if(admin&&!busy&&(e.key==='Enter'||e.key===' ')){e.preventDefault();onEdit(lesson);}}}>
    <div className="tile-title">{color&&<span className="tile-group-dot" style={{background:color}}/>}
      <span className="tile-title-text">{collapsed?title.trim().charAt(0).toUpperCase():title}</span></div>
    <div className="tile-meta">{group||custom?<div className="tile-participants">{participants.map(b=>{
      const account=refs.clients.find(c=>c.id===b.client_id),instructor=refs.instructors.find(i=>i.id===b.instructor_id);
      return <div className="tile-participant" key={b.id}>
        <span className="tile-participant-name">{b.client_name||account?.name}</span>
        {b.horse_name&&<span className="tile-participant-horse"><Icon name="horse"/>{b.horse_name}</span>}
        {custom&&b.instructor_name&&<span className="tile-participant-package" style={{color:instructor?.color,paddingLeft:4}}><Icon name="person"/>{b.instructor_name}</span>}
        {admin&&account&&b.billing_mode==='package'&&!custom&&<span className="tile-participant-package" style={{color:creditColor(account.account.balance,account.archived)}}>[{account.account.balance}]</span>}
      </div>;
    })}</div>:<>{first?.horse_name&&<span className="tile-crew"><span className="tile-horse"><Icon name="horse"/>{first.horse_name}</span></span>}
      {admin&&client&&!client.archived&&first?.billing_mode==='package'&&<span style={{color:creditColor(client.account.balance,client.archived)}}>{t("Karnet: [")}{client.account.balance}]</span>}</>}
    </div>
  </div>;
}

function EventTile({event,slotHeight,startHour,endHour,previousEnd,admin,busy,onEdit,onMove,onDragActive}:{
  event:CalendarEvent;slotHeight:number;startHour:number;endHour:number;previousEnd:number;admin:boolean;busy:boolean;
  onEdit:(event:CalendarEvent)=>void;onMove:(event:CalendarEvent,startMinute:number)=>Promise<boolean>;onDragActive:(active:boolean)=>void;
}){
  const duration=event.end_minute-event.start_minute;
  const drag=useLessonDrag({lesson:{...event,duration_minutes:duration},admin,busy,slotHeight,startHour,endHour,fitWithinSchedule:true,onMove,onDragActive});
  return <div ref={drag.element} role={admin?'button':undefined} tabIndex={admin?0:undefined} aria-disabled={admin?busy||drag.saving:undefined}
    aria-label={t("Edytuj wydarzenie {0} o {1}",event.description,minuteTime(event.start_minute))} title={event.description}
    data-date={event.date} data-end-minute={event.end_minute}
    className={`lesson-tile calendar-event-tile ${drag.preview!==null?'dragging':''} ${drag.ready?'long-press-ready':''}`.trim()}
    style={{marginTop:(event.start_minute-previousEnd)/60*slotHeight,height:Math.max(duration/60*slotHeight,24),position:'relative',width:'auto',minWidth:'100%',flexShrink:0,
      transform:drag.preview!==null?`translateY(${(drag.preview-event.start_minute)/60*slotHeight}px) scale(1.03)`:undefined,
      zIndex:drag.preview!==null?1000:undefined,transition:drag.preview!==null?'none':undefined}}
    onContextMenu={e=>{if(drag.ready||drag.preview!==null||navigator.maxTouchPoints>0)e.preventDefault();}}
    onClick={e=>{if(e.detail>0&&drag.consumeClick()){e.preventDefault();return;}if(admin&&!busy&&!drag.saving)onEdit(event);}}
    onKeyDown={e=>{if(admin&&!busy&&!drag.saving&&(e.key==='Enter'||e.key===' ')){e.preventDefault();onEdit(event);}}}>
    <div className="calendar-event-heading"><Icon name="event"/><span>{t("Wydarzenie")}</span><span className="calendar-event-time">{minuteTime(event.start_minute)}–{minuteTime(event.end_minute)}</span></div>
    <div className="calendar-event-description">{event.description}</div>
  </div>;
}

export function DailyCalendar({date,lessons,events,settings,refs,admin,busy,reviewRevision,onEdit,onMove,onEditEvent,onMoveEvent,onMonth,onNavigate,onToggle,onReview}:{
  date:string;lessons:Lesson[];settings:Setting[];refs:References;admin:boolean;busy:boolean;onEdit:(lesson:Lesson)=>void;
  events:CalendarEvent[];onEditEvent:(event:CalendarEvent)=>void;onMoveEvent:(event:CalendarEvent,startMinute:number)=>Promise<boolean>;
  reviewRevision:number;onMonth:()=>void;onNavigate:(date:string)=>void;onToggle:()=>void;onReview:()=>void;
  onMove:(lesson:Lesson,startMinute:number)=>Promise<boolean>;
}){
  const [viewport,setViewport]=useState(()=>document.documentElement.clientHeight||window.innerHeight);
  const [focus,setFocus]=useState<{date:string;instructorId:string|null}>({date,instructorId:null});
  const [reviewState,setReviewState]=useState<{date:string;count:number|null;error:boolean}>({date,count:null,error:false});
  const [now,setNow]=useState(()=>warsawNow(new Date()));
  const swipe=useRef<{id:number;x:number;y:number;date:string}|null>(null),suppressClick=useRef(false);
  const tileDrag=useRef(false);
  const onDragActive=(active:boolean)=>{tileDrag.current=active;if(active)swipe.current=null;};
  useEffect(()=>{
    if(!admin)return;
    let active=true,sequence=0;
    setReviewState({date,count:null,error:false});
    const update=()=>{
      const request=++sequence;
      void rpc<number>('hb_review_count',{p_through:date}).then(count=>{
        if(active&&request===sequence)setReviewState({date,count,error:false});
      }).catch(()=>{if(active&&request===sequence)setReviewState({date,count:null,error:true});});
    };
    update();const interval=window.setInterval(update,30000);
    return()=>{active=false;window.clearInterval(interval);};
  },[date,admin,reviewRevision]);
  useEffect(()=>{
    const resize=()=>setViewport(document.documentElement.clientHeight||window.innerHeight);
    const tick=()=>setNow(warsawNow(new Date()));
    window.addEventListener('resize',resize);window.addEventListener('focus',tick);
    const interval=window.setInterval(tick,30000);
    return()=>{window.removeEventListener('resize',resize);window.removeEventListener('focus',tick);window.clearInterval(interval);};
  },[]);
  const hours=settings.find(s=>s.key==='schedule_hours')?.value??{start:8,end:21};
  const startHour=hours.start,endHour=hours.end;
  const visible=lessons.filter(l=>l.start_minute>=startHour*60&&l.start_minute<endHour*60);
  const visibleEvents=events.filter(e=>e.start_minute>=startHour*60&&e.start_minute<endHour*60);
  const entries:CalendarEntry[]=[...visible.map(l=>({...l,tileType:'lesson' as const})),...visibleEvents.map(e=>({...e,tileType:'event' as const,duration_minutes:e.end_minute-e.start_minute}))];
  const navHeight=Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h'))||60;
  const fit=viewport>0?Math.max(MIN_SCALE,(viewport-navHeight-24)/(Math.max(1,endHour-startHour)*SLOT_HEIGHT)):MIN_SCALE;
  const slotHeight=SLOT_HEIGHT*Math.max(fit,...visible.map(l=>minimumTileHeight(l)/(l.duration_minutes/60*SLOT_HEIGHT)),...visibleEvents.map(e=>48/((e.end_minute-e.start_minute)/60*SLOT_HEIGHT)));
  const closed=(settings.find(s=>s.key==='closed_dates')?.value??[]).includes(date);
  const parts=legacyDateParts(date),clusters=overlapClusters(entries);
  const instructorMap=new Map<string,{id:string;name:string;color?:string}>();
  for(const lesson of visible)for(const id of assignedInstructors(lesson)){
    const reference=refs.instructors.find(i=>i.id===id),booking=lesson.bookings.find(b=>!b.removed&&b.instructor_id===id);
    const name=reference?.name??(id===lesson.instructor_id?lesson.instructor_name:booking?.instructor_name);
    if(name)instructorMap.set(id,{id,name,color:reference?.color??(id===lesson.instructor_id?lesson.instructor_color:undefined)});
  }
  const instructors=[...instructorMap.values()];
  const selectedInstructor=focus.date===date&&focus.instructorId&&instructorMap.has(focus.instructorId)?focus.instructorId:null;
  const reviewCount=reviewState.date===date?reviewState.count:null;
  const reviewError=reviewState.date===date&&reviewState.error;
  const reviewPending=reviewCount!==null&&reviewCount>0;
  const reviewDescription=reviewError?t("Nie udało się sprawdzić stanu przeglądu. Otwórz, aby spróbować ponownie."):reviewCount===null?t("Sprawdzanie oczekujących decyzji…"):
    reviewPending?t("Do {0}: {1} oczekujących decyzji, także z wcześniejszych dni.",date,reviewCount):t("Brak kredytów do przeglądu.");
  return <div className="daily-calendar"
    onPointerDown={e=>{
      suppressClick.current=false;swipe.current=null;
      if(!e.isPrimary){swipe.current=null;return;}
      if(e.button!==0||busy||tileDrag.current||(e.target as HTMLElement).closest('button,input,select,textarea,a'))return;
      swipe.current={id:e.pointerId,x:e.clientX,y:e.clientY,date};
    }}
    onPointerMove={e=>{
      const current=swipe.current;if(!current||current.id!==e.pointerId)return;
      const dx=Math.abs(e.clientX-current.x),dy=Math.abs(e.clientY-current.y);
      if(dx>10&&dx>dy){
        // Capture only a deliberate horizontal drag, so ordinary tile taps still edit.
        suppressClick.current=true;e.currentTarget.setPointerCapture(e.pointerId);
      }
    }}
    onPointerUp={e=>{
      const current=swipe.current;if(!current||current.id!==e.pointerId)return;
      swipe.current=null;
      const dx=current.x-e.clientX,dy=Math.abs(current.y-e.clientY);
      if(current.date===date&&!busy&&Math.abs(dx)>50&&dy<50){suppressClick.current=true;onNavigate(addDays(date,dx>0?1:-1));}
    }}
    onPointerCancel={()=>{swipe.current=null;}}
    onLostPointerCapture={e=>{if(e.target===e.currentTarget)swipe.current=null;}}
    onClickCapture={e=>{if(suppressClick.current&&e.detail>0){e.preventDefault();e.stopPropagation();suppressClick.current=false;}}}>
    <div className="day-header"><div className="day-header-main">
      <button className="back-btn" aria-label={t("Widok miesiąca")} onClick={onMonth}><Icon name="arrow_back"/></button>
      <div className="day-header-text"><h2>{parts.date}</h2><span className="day-subtitle">{parts.weekday}</span></div>
    </div><div className="day-header-actions" style={!admin&&!closed?{display:'none'}:undefined}>
      {admin&&<button type="button" className={`credit-review-icon ${reviewPending?'has-pending':''} ${reviewError?'review-unavailable':''}`.trim()}
        aria-label={t("Przejrzyj kredyty")} aria-description={reviewDescription} title={reviewDescription}
        aria-busy={reviewCount===null&&!reviewError} disabled={busy} onClick={onReview}>
        <Icon name={reviewError?'sync_problem':reviewCount===null?'hourglass_empty':reviewPending?'checklist':'fact_check'}/>
        {reviewPending&&<span className="credit-review-count" aria-hidden="true">{reviewCount>99?'99+':reviewCount}</span>}
      </button>}
      {admin?<button type="button" className={`toggle toggle-day-status ${closed?'active':''}`} aria-pressed={closed}
        aria-label={closed?t("Oznacz dzień jako otwarty"):t("Oznacz dzień jako zamknięty")} title={closed?t("Oznacz dzień jako otwarty"):t("Oznacz dzień jako zamknięty")} disabled={busy} onClick={onToggle}>
        <span className="toggle-text">{closed?t("Zamknięte"):t("Otwarte")}</span></button>:closed&&<span className="closed-badge active">{t("Zamknięte")}</span>}
    </div></div>
    <div className="day-schedule" id="day-schedule" style={{minHeight:(endHour-startHour)*slotHeight}}>
      {Array.from({length:endHour-startHour},(_,i)=>{
        const h=startHour+i,top=i*slotHeight;
        return <Fragment key={h}><div className="hour-row"><div className="hour-content"/></div>
          <div className="hour-label" style={{top}}>{minuteTime(h*60)}</div><div className="hour-line" style={{top}}/>
          <div className="hour-label" style={{top:top+slotHeight/2}}>{minuteTime(h*60+30)}</div><div className="hour-line half-hour" style={{top:top+slotHeight/2}}/>
          {[.25,.75].map(offset=><div className="quarter-line" key={offset} style={{top:top+slotHeight*offset}}/>)}</Fragment>;
      })}
      <div className="hour-line terminal-line" style={{top:(endHour-startHour)*slotHeight}}/>
      <div className="hour-label terminal-label" style={{top:(endHour-startHour)*slotHeight}}>{minuteTime(endHour*60)}</div>
      {clusters.map((cluster,index)=><div key={index} className="lesson-cluster" style={{position:'absolute',top:(cluster.start/60-startHour)*slotHeight,height:(cluster.end-cluster.start)/60*slotHeight,left:48,right:8,display:'flex',gap:2}}>
        {cluster.columns.map((col,c)=><div key={c} className={`lesson-column ${col.collapsed?'lesson-column-collapsed':''}`.trim()} style={{flex:col.collapsed?'0 0 28px':'1 1 auto',minWidth:0,position:'relative',height:'100%'}}>
          {col.lessons.map((lesson,i)=>lesson.tileType==='event'?<EventTile key={lesson.id} event={lesson} slotHeight={slotHeight} startHour={startHour} endHour={endHour} previousEnd={i?col.lessons[i-1].start_minute+col.lessons[i-1].duration_minutes:cluster.start}
            admin={admin} busy={busy} onEdit={onEditEvent} onMove={onMoveEvent} onDragActive={onDragActive}/>:<LessonTile key={lesson.id} lesson={lesson} date={date} slotHeight={slotHeight} startHour={startHour} endHour={endHour} previousEnd={i?col.lessons[i-1].start_minute+col.lessons[i-1].duration_minutes:cluster.start}
            collapsed={col.collapsed} now={now} refs={refs} admin={admin} busy={busy}
            dimmed={Boolean(selectedInstructor&&!assignedInstructors(lesson).includes(selectedInstructor))} onEdit={onEdit} onMove={onMove} onDragActive={onDragActive}/>)}</div>)}
      </div>)}
      {date===now.date&&now.minutes>=startHour*60&&now.minutes<endHour*60&&<div className="time-indicator" aria-label={t("Aktualny czas")} style={{top:(now.minutes/60-startHour)*slotHeight}}><div className="time-indicator-dot"/></div>}
    </div>
    {instructors.length>0&&<div className="calendar-instructor-legend" aria-label={t("Filtr instruktorów")}>{instructors.map(i=><button type="button" key={i.id}
      className={`calendar-instructor-tag ${selectedInstructor&&selectedInstructor!==i.id?'instructor-filtered-out':''}`.trim()}
      aria-pressed={selectedInstructor===i.id} onClick={()=>setFocus({date,instructorId:selectedInstructor===i.id?null:i.id})}>
      <span className="calendar-instructor-dot" style={i.color?{background:i.color}:undefined}/>{i.name}</button>)}</div>}
  </div>;
}
