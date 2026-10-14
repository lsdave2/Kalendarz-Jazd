import {t,getLocale} from './i18n';
import {useEffect,useState} from 'react';
import {rpc,errorMessage} from './api';
import {Modal,Empty} from './components';
import type {HistoryRow} from './types';
import {minuteTime} from './dates';
export function History({clientId,kind='credits',onClose}:{clientId?:string;kind?:'credits'|'decisions'|'audit';onClose:()=>void}){
  const [tab,setTab]=useState(kind),[page,setPage]=useState(0),[rows,setRows]=useState<HistoryRow[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{let active=true;setLoading(true);setError('');rpc<HistoryRow[]>('hb_history',{p_kind:tab,p_client_id:clientId??null,p_limit:50,p_offset:page*50})
    .then(r=>{if(active)setRows(r);}).catch(e=>{if(active)setError(errorMessage(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[tab,page,clientId]);
  return <Modal title={tab==='audit'?t("Historia zmian"):t("Historia rozliczeń")} onClose={onClose}>
    {kind!=='audit'&&<div className="lesson-type-switch">{(['credits','decisions'] as const).map(k=><button className={`lesson-type-btn ${tab===k?'active':''}`} key={k} onClick={()=>{setTab(k);setPage(0);}}>{k==='credits'?t("Zmiany salda"):t("Decyzje")}</button>)}</div>}
    {error&&<p role="alert" className="v2-error">{error}</p>}
    {loading?<Empty>{t("Wczytywanie…")}</Empty>:rows.length===0?<Empty>{t("Brak wpisów.")}</Empty>:rows.map(row=>{
      const deletedLesson=row.table_name==='lessons'&&row.after_row===null&&row.before_row?
        row.before_row as {title:string;date:string;start_minute:number}:null;
      const event=row.table_name==='events'?(row.after_row??row.before_row) as {description:string;date:string;start_minute:number;end_minute:number}:null;
      return <article className="v2-review" key={row.id}>
      <div className="v2-heading"><strong>{event?(row.after_row===null?t("Usunięto wydarzenie"):row.before_row===null?t("Dodano wydarzenie"):t("Zmieniono wydarzenie")):deletedLesson?t("Usunięto lekcję"):row.client_name??row.table_name??t("Zmiana")}</strong>{row.delta!==undefined&&<strong className={row.delta<0?'v2-negative':'v2-positive'}>{row.delta>0?'+':''}{row.delta}</strong>}</div>
      {deletedLesson&&<p>{deletedLesson.title||t("Lekcja")} · {deletedLesson.date} · {minuteTime(deletedLesson.start_minute)}</p>}
      {event&&<p>{event.description} · {event.date} · {minuteTime(event.start_minute)}–{minuteTime(event.end_minute)}</p>}
      <p>{row.reason??row.action??''}</p><p className="v2-note">{new Date(row.created_at).toLocaleString(getLocale(),{timeZone:'Europe/Warsaw'})} · {row.actor_name}</p>
      {row.balance_after!==undefined&&<p>{t("Saldo po zmianie:")} {row.balance_after}</p>}
      <details><summary>{t("Szczegóły i identyfikator operacji")}</summary><pre className="v2-json">{JSON.stringify(row,null,2)}</pre></details>
    </article>;})}
    <div className="v2-row"><button className="btn btn-secondary" disabled={loading||page===0} onClick={()=>setPage(x=>x-1)}>{t("Poprzednia")}</button><button className="btn btn-secondary" disabled={loading||rows.length<50} onClick={()=>setPage(x=>x+1)}>{t("Następna")}</button></div>
  </Modal>;
}
