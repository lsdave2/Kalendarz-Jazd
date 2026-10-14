import {t,getLocale} from './i18n';
import {useEffect,useId,useRef,useState} from 'react';
import type {Booking,Lesson,References} from './types';
import {Field,Icon,Modal,type Run} from './components';
import {minuteTime,timeMinute} from './dates';
function newBooking(clientId=''):Booking{return {id:crypto.randomUUID(),client_id:clientId,horse_id:null,instructor_id:null,billing_mode:'cash',units:1,cash_amount:140,attendance:'unknown',removed:false,review_status:'pending',revision:1};}
function ClientInput({id,label,className,clients,clientId,onSelect}:{id?:string;label:string;className:string;clients:References['clients'];clientId:string;onSelect:(id:string)=>void}){
  const listId=useId(),input=useRef<HTMLInputElement>(null);
  const [name,setName]=useState(()=>clients.find(c=>c.id===clientId)?.name??'');
  const match=clients.find(c=>c.name===name);
  useEffect(()=>{input.current?.setCustomValidity(name&&!match?t("Wybierz klienta..."):'');},[name,match]);
  return <><input ref={input} id={id} type="text" className={className} required aria-label={label}
    placeholder={t("Wpisz imię klienta...")} autoComplete="off" list={listId} value={name} onChange={e=>{
      const value=e.target.value,client=clients.find(c=>c.name===value);
      setName(value);
      e.target.setCustomValidity(value&&!client?t("Wybierz klienta..."):'');
      if(client&&client.id!==clientId)onSelect(client.id);
      else if(!value&&clientId)onSelect('');
    }}/><datalist id={listId}>{clients.map(c=><option key={c.id} value={c.name}/>)}</datalist></>;
}
function Switch({label,checked,disabled=false,onChange,title}:{label:string;checked:boolean;disabled?:boolean;onChange:()=>void;title?:string}){
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} title={title}
    className={`toggle ${checked?'active':''}`.trim()} onClick={onChange}/>;
}
export function LessonEditor({date,lesson,refs,run,busy,onClose,embedded=false}:{date:string;lesson:Lesson|null;refs:References;run:Run;busy:boolean;onClose:()=>void;embedded?:boolean}){
  const hours=refs.settings.find(s=>s.key==='schedule_hours')?.value??{start:8,end:21};
  const startMinute=hours.start*60,endMinute=hours.end*60;
  const [draft,setDraft]=useState<Lesson>(()=>lesson?structuredClone(lesson):{
    id:crypto.randomUUID(),date,start_minute:Math.max(startMinute,Math.min(600,endMinute-15)),duration_minutes:60,title:'',kind:'individual',instructor_id:null,
    status:'scheduled',notes:'',revision:1,series_id:null,occurrence_date:null,bookings:[newBooking()]});
  const [repeat,setRepeat]=useState(false),[weeks,setWeeks]=useState('8'),[moving,setMoving]=useState(false);
  const description=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{const input=description.current;if(input){input.style.height='auto';input.style.height=input.scrollHeight+'px';}},[draft.kind,draft.notes,moving]);
  const active=draft.bookings.filter(b=>!b.removed),individual=draft.kind==='individual',custom=draft.kind==='custom';
  const canDelete=lesson&&lesson.bookings.every(b=>b.review_status==='pending'&&!b.last_decision_id);
  const currentInRange=draft.start_minute>=startMinute&&draft.start_minute<endMinute;
  const startTimes=[...new Set([...Array.from({length:(endMinute-startMinute)/15},(_,i)=>startMinute+i*15),
    ...(currentInRange?[draft.start_minute]:[])])].sort((a,b)=>a-b);
  const durations=[...new Set([30,45,60,90,120,draft.duration_minutes])].sort((a,b)=>a-b);
  function change(key:keyof Lesson,value:unknown){setDraft(d=>({...d,[key]:value}));}
  function booking(id:string,key:keyof Booking,value:unknown){setDraft(d=>({...d,bookings:d.bookings.map(b=>b.id===id?{...b,[key]:value}:b)}));}
  function clientSelect(b:Booking,label:string){return <ClientInput key={b.id} className={`form-input ${individual?'':'participant-name-input'}`.trim()} label={label} clientId={b.client_id}
    clients={refs.clients.filter(x=>(!x.archived||x.id===b.client_id)&&!active.some(other=>other.id!==b.id&&other.client_id===x.id))} onSelect={cid=>{
    const original=lesson?.bookings.find(x=>x.client_id===cid);
    const billingMode=original?.billing_mode??(refs.clients.find(c=>c.id===cid)?.has_credit_deduction?'package':'cash');
    setDraft(d=>({...d,bookings:d.bookings.map(x=>x.id===b.id?{...x,id:original?.id??(x.client_id&&x.client_id!==cid?crypto.randomUUID():x.id),client_id:cid,billing_mode:billingMode,review_status:'pending',revision:1}:x)}));
  }}/>;}
  function horseSelect(b:Booking){return <select className="form-input participant-horse-select" aria-label={t("Koń")} value={b.horse_id??''} onChange={e=>booking(b.id,'horse_id',e.target.value||null)}>
    <option value="">{individual?t("Wybierz konia..."):t("Brak konia")}</option>{refs.horses.filter(x=>!x.archived||x.id===b.horse_id).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>;}
  function instructorSelect(value:string|null,onChange:(id:string|null)=>void,label=t("Instruktor"),participant=false){return <select aria-label={label} className={`form-input ${participant?'participant-horse-select':''}`.trim()} value={value??''} onChange={e=>onChange(e.target.value||null)}>
    <option value="">{t("Brak instruktora")}</option>{refs.instructors.filter(x=>!x.archived||x.id===value).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>;}
  function startSelect(){return <select className="form-input" required value={currentInRange?minuteTime(draft.start_minute):''} onChange={e=>change('start_minute',timeMinute(e.target.value))}>
    {!currentInRange&&<option value="" disabled>{t("Wybierz godzinę...")}</option>}
    {startTimes.map(minute=><option key={minute} value={minuteTime(minute)}>{minuteTime(minute)}</option>)}</select>;}
  const repeatControl=<div className="lesson-repeat-control">
    <div className="toggle-row lesson-repeat-row"><span>{t("Powielaj")}</span>
      {repeat&&<label className="lesson-repeat-count"><input aria-label={lesson?t("Dodatkowe tygodnie"):t("Liczba tygodni")} type="number" inputMode="numeric" className="form-input lesson-repeat-weeks" required min="1" max={lesson?'52':'53'} step="1" value={weeks} onChange={e=>setWeeks(e.target.value)}/><span>{t("tyg.")}</span></label>}
      <Switch label={t("Powielaj")} checked={repeat} onChange={()=>setRepeat(x=>!x)}/>
    </div>
    {repeat&&<small>{lesson?t("Dodatkowe jazdy co tydzień po tej lekcji, z danymi z formularza."):t("Łączna liczba lekcji, wliczając pierwszą.")}</small>}
  </div>;
  async function submit(e:React.FormEvent){
    e.preventDefault();
    const payload={...draft,instructor_id:custom?null:draft.instructor_id,bookings:active.map(b=>({id:b.id,client_id:b.client_id,horse_id:b.horse_id,instructor_id:custom?b.instructor_id:null,
      billing_mode:custom?'cash':b.billing_mode,units:1,cash_amount:b.cash_amount,attendance:b.attendance}))};
    const ok=repeat&&!moving?await run('hb_duplicate_lesson',{p_lesson:payload,p_expected_revision:lesson?.revision??null,p_weeks:Number(weeks)})
      :await run('hb_save_lesson',{p_expected_revision:lesson?.revision??null,p_lesson:payload});
    if(ok)onClose();
  }
  async function deleteLesson(){
    if(!lesson)return;
    const name=lesson.title||lesson.bookings.find(b=>!b.removed)?.client_name||t("Lekcja");
    if(confirm(t("Usunąć lekcję „{0}” z {1} o {2}? Zniknie z kalendarza i przeglądu kredytów. Pełny wpis pozostanie w historii zmian.",name,lesson.date,minuteTime(lesson.start_minute)))&&
      await run('hb_delete_lesson',{p_lesson_id:lesson.id,p_expected_revision:lesson.revision}))onClose();
  }
  if(moving)return <Modal key="move" title={t("Przenieś lekcję")} className="lesson-editor" onClose={()=>setMoving(false)} busy={busy}>
    <form onSubmit={submit}><fieldset disabled={busy}>
      <Field label={t("Data")}><input className="form-input" type="date" required value={draft.date} onChange={e=>change('date',e.target.value)}/></Field>
      <Field label={t("Czas rozpoczęcia")}>{startSelect()}</Field>
      <div className="btn-group modal-actions"><button type="button" className="btn btn-secondary btn-sm" onClick={()=>setMoving(false)}>{t("Wróć")}</button>
        <button type="submit" className="btn btn-primary btn-sm"><Icon name="calendar_month"/>{busy?t("Zapisywanie…"):t("Przenieś")}</button></div>
    </fieldset></form>
  </Modal>;
  const created=lesson?.created_at?new Date(lesson.created_at):null;
  const form=<form onSubmit={submit}><fieldset disabled={busy}>
      {lesson?.is_last_in_series&&<div className="lesson-series-notice" role="status">
        <div className="lesson-series-notice-title"><Icon name="flag"/><strong>{t("Ostatnia jazda w serii")}</strong></div>
      </div>}
      <div className="lesson-type-switch">{(['individual','group','custom'] as const).map(kind=><button key={kind} className={`lesson-type-btn ${draft.kind===kind?'active':''}`} type="button" onClick={()=>{
        if(kind===draft.kind)return;
        setDraft(d=>({...d,kind,start_minute:Math.max(startMinute,Math.min(600,endMinute-15)),duration_minutes:60,
          title:'',notes:'',instructor_id:null,instructor_name:undefined,instructor_color:undefined,bookings:[newBooking()]}));
        setRepeat(false);setWeeks('8');
      }}>{kind==='individual'?t("Indywidualna"):kind==='group'?t("Grupowa"):t("Niestandardowa")}</button>)}</div>
      <div className="form-row"><Field label={t("Czas rozpoczęcia")}>{startSelect()}</Field>
        <Field label={t("Czas trwania")}><select className="form-input" value={draft.duration_minutes} onChange={e=>change('duration_minutes',Number(e.target.value))}>
          {durations.map(minutes=><option key={minutes} value={minutes}>{minutes} min</option>)}</select></Field></div>
      {!custom&&!individual&&<Field label={t("Instruktor")}>{instructorSelect(draft.instructor_id,id=>change('instructor_id',id))}</Field>}
      {individual?<>
        <Field label={t("Imię klienta")}>{clientSelect(active[0],t("Imię klienta"))}</Field>
        <Field label={t("Instruktor")}>{instructorSelect(draft.instructor_id,id=>change('instructor_id',id))}</Field>
        <Field label={t("Koń")}>{horseSelect(active[0])}</Field>
        {repeatControl}
        <div className="toggle-row"><span>{t("Tryb karnetu")}</span><Switch label={t("Tryb karnetu")} checked={active[0].billing_mode==='package'}
          onChange={()=>booking(active[0].id,'billing_mode',active[0].billing_mode==='package'?'cash':'package')}/></div>
      </>:<>
        {repeatControl}
        {custom&&<Field label={t("Opis")}><textarea ref={description} className="form-input lesson-description" rows={1} value={draft.notes} onChange={e=>change('notes',e.target.value)}/></Field>}
        <div className="form-group"><label>{t("Klienci w grupie")}</label><div className="group-participants">{active.map(b=><div className="participant-row" key={b.id}>
          <div className={`participant-row-top ${custom?'custom-participant-top':''}`.trim()}>{clientSelect(b,t('Klient'))}
            {custom&&<div className="participant-cost"><input className="form-input" aria-label={t("Cena (zł)")} type="number" min="0" step="0.01" required value={b.cash_amount} onChange={e=>booking(b.id,'cash_amount',Number(e.target.value))}/><span>{t("zł")}</span></div>}
          </div><div className="participant-row-bottom">
            {custom&&instructorSelect(b.instructor_id,id=>booking(b.id,'instructor_id',id),t("Instruktor uczestnika"),true)}
            {horseSelect(b)}<button type="button" className="btn btn-secondary btn-sm participant-remove-btn" aria-label={t("Usuń uczestnika")} disabled={active.length===1} onClick={()=>booking(b.id,'removed',true)}><Icon name="close"/></button>
            {!custom&&<div className="participant-package-control"><span className="participant-package-label">{t("Karnet")}</span><Switch label={t("Tryb karnetu")} checked={b.billing_mode==='package'}
              onChange={()=>booking(b.id,'billing_mode',b.billing_mode==='package'?'cash':'package')}/></div>}
          </div></div>)}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={()=>setDraft(d=>({...d,bookings:[...d.bookings,newBooking()]}))}><Icon name="add"/>{t("Dodaj uczestnika")}</button>
        </div>
      </>}
      {created&&Number.isFinite(created.getTime())&&<div className="lesson-creation-meta">{t("Utworzono")} {new Intl.DateTimeFormat(getLocale(),{timeZone:'Europe/Warsaw',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(created)}</div>}
      <div className="btn-group modal-actions">
        {canDelete&&<button type="button" className="btn btn-danger btn-sm" aria-label={t("Usuń lekcję")} onClick={()=>void deleteLesson()}><Icon name="delete"/>{t("Usuń")}</button>}
        {lesson&&<><button type="button" className="btn btn-secondary btn-sm" aria-label={lesson.status==='cancelled'?t("Przywróć lekcję"):t("Odwołaj lekcję")} onClick={async()=>{
          if(await run('hb_cancel_lesson',{p_lesson_id:lesson.id,p_expected_revision:lesson.revision,p_cancelled:lesson.status!=='cancelled'}))onClose();
        }}><Icon name={lesson.status==='cancelled'?'restore':'cancel'}/>{lesson.status==='cancelled'?t("Przywróć"):t("Odwołaj")}</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={()=>setMoving(true)}><Icon name="calendar_month"/>{t("Przenieś")}</button></>}
        <button className="btn btn-primary btn-sm" type="submit" style={{marginLeft:'auto'}}><Icon name="check"/>{busy?t("Zapisywanie…"):repeat&&lesson?t("Zapisz i powiel"):lesson?t("Aktualizuj"):t("Utwórz")}</button>
      </div>
    </fieldset></form>;
  return embedded?form:<Modal key="editor" title={lesson?t("Edytuj lekcję"):t("Nowa jazda")} className="lesson-editor" onClose={onClose} busy={busy}>{form}</Modal>;
}
