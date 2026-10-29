import {t} from './i18n';
import {useState} from 'react';
import {Field,Icon,Modal,type Run} from './components';
import {TimePicker} from './TimePicker';
import type {CalendarEvent,References} from './types';

export function EventEditor({date,event,refs,run,busy,onClose,embedded=false}:{date:string;event:CalendarEvent|null;refs:References;run:Run;busy:boolean;onClose:()=>void;embedded?:boolean}){
  const hours=refs.settings.find(s=>s.key==='schedule_hours')?.value??{start:8,end:21};
  const first=hours.start*60,last=hours.end*60;
  const [draft,setDraft]=useState<CalendarEvent>(()=>{
    const start=Math.max(first,Math.min(600,last-15));
    return event?{...event}:{id:crypto.randomUUID(),date,start_minute:start,end_minute:Math.min(start+60,last),description:'',revision:1};
  });
  const [moving,setMoving]=useState(false);
  const quarterHours=Array.from({length:(last-first)/15+1},(_,i)=>first+i*15);
  const starts=[...new Set([...quarterHours.filter(m=>m<last),...(draft.start_minute>=first&&draft.start_minute<last?[draft.start_minute]:[])])].sort((a,b)=>a-b);
  const ends=[...new Set([...quarterHours.filter(m=>m>draft.start_minute),...(draft.end_minute>draft.start_minute&&draft.end_minute<=last?[draft.end_minute]:[])])].sort((a,b)=>a-b);
  const form=<form onSubmit={async e=>{
      e.preventDefault();
      if(await run('hb_save_event',{p_expected_revision:event?.revision??null,p_event:{id:draft.id,date:draft.date,
        start_minute:draft.start_minute,end_minute:draft.end_minute,description:draft.description}}))onClose();
    }}><fieldset disabled={busy}>
      {moving&&<Field label={t("Data")}><input className="form-input" type="date" required value={draft.date} onChange={e=>setDraft(d=>({...d,date:e.target.value}))}/></Field>}
      <div className="form-row"><Field label={t("Czas rozpoczęcia")}><TimePicker label={t('Czas rozpoczęcia')} value={draft.start_minute} times={starts} disabled={busy}
        onChange={start=>setDraft(d=>({...d,start_minute:start,end_minute:d.end_minute>start?d.end_minute:Math.min(start+15,last)}))}/></Field>
        <Field label={t("Czas zakończenia")}><TimePicker label={t('Czas zakończenia')} value={draft.end_minute} times={ends} disabled={busy} alignEnd
          onChange={end=>setDraft(d=>({...d,end_minute:end}))}/></Field></div>
      <Field label={t("Opis")}><textarea className="form-input" rows={3} required maxLength={2000} value={draft.description} onChange={e=>setDraft(d=>({...d,description:e.target.value}))}/></Field>
      <div className="btn-group modal-actions">
        {event&&<><button type="button" className="btn btn-danger btn-sm" aria-label={t("Usuń wydarzenie")} onClick={async()=>{
          if(confirm(t("Usunąć wydarzenie „{0}” z {1}? Wpis pozostanie w historii zmian.",event.description,event.date))&&
            await run('hb_delete_event',{p_event_id:event.id,p_expected_revision:event.revision}))onClose();
        }}><Icon name="delete"/>{t("Usuń")}</button>
        <button type="button" className="btn btn-secondary btn-sm" aria-pressed={moving} onClick={()=>setMoving(v=>!v)}><Icon name="calendar_month"/>{t("Przenieś")}</button></>}
        <button type="submit" className="btn btn-primary btn-sm" style={{marginLeft:'auto'}}><Icon name="check"/>{busy?t("Zapisywanie…"):event?t("Aktualizuj"):t("Utwórz")}</button>
      </div>
    </fieldset></form>;
  return embedded?form:<Modal title={event?t("Edytuj wydarzenie"):t("Nowe wydarzenie")} className="lesson-editor event-editor" onClose={onClose} busy={busy}>{form}</Modal>;
}
