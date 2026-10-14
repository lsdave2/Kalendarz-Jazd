import {t} from './i18n';
import {useState} from 'react';
import {LessonEditor} from './LessonEditor';
import {EventEditor} from './EventEditor';
import type {References} from './types';
import {Modal,type Run} from './components';

export function CreationEditor({date,refs,run,busy,onClose}:{date:string;refs:References;run:Run;busy:boolean;onClose:()=>void}){
  const [kind,setKind]=useState('ride');
  const heading=<select className="creation-type-select" aria-label={t("Rodzaj wpisu")} disabled={busy} value={kind} onChange={e=>setKind(e.target.value)}>
    <option value="ride">{t("Nowa jazda")}</option><option value="event">{t("Nowe wydarzenie")}</option>
  </select>;
  return <Modal title={kind==='ride'?t("Nowa jazda"):t("Nowe wydarzenie")} heading={heading} className={`lesson-editor ${kind==='event'?'event-editor':''}`.trim()} onClose={onClose} busy={busy}>
    {kind==='ride'?<LessonEditor date={date} lesson={null} refs={refs} run={run} busy={busy} onClose={onClose} embedded/>:
      <EventEditor date={date} event={null} refs={refs} run={run} busy={busy} onClose={onClose} embedded/>}
  </Modal>;
}
