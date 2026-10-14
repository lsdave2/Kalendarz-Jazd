import {t} from './i18n';
import {useEffect,useState} from 'react';
import {rpc,errorMessage} from './api';
import {Empty,Field,Modal,type Run} from './components';
import {minuteTime} from './dates';
import type {ReviewItem,Snapshot} from './types';
import {saveSnapshot} from './snapshot';
export function ReviewPanel({through,onClose,run,busy}:{through:string;onClose:()=>void;run:Run;busy:boolean}){
  const [items,setItems]=useState<ReviewItem[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [selection,setSelection]=useState<Record<string,{action:'charge'|'waive';reason:string}>>({});
  const [page,setPage]=useState(0),[refresh,setRefresh]=useState(0);
  const [offerBackup,setOfferBackup]=useState(false),[saving,setSaving]=useState(false),[backupError,setBackupError]=useState(''),[backupStatus,setBackupStatus]=useState('');
  useEffect(()=>{let active=true;setLoading(true);setSelection({});setError('');
    rpc<ReviewItem[]>('hb_review_queue',{p_through:through,p_limit:50,p_offset:page*50}).then(rows=>{if(active)setItems(rows);}).catch(e=>{if(active)setError(errorMessage(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
  },[through,page,refresh]);
  function choose(item:ReviewItem,action:'charge'|'waive'|null){setSelection(s=>{const next={...s};if(action)next[item.id]={action,reason:s[item.id]?.reason??''};else delete next[item.id];return next;});}
  const selected=items.filter(x=>selection[x.id]);
  const projected=new Map<string,number>();
  const rows=items.map(item=>{
    const decision=selection[item.id],canDeduct=!item.removed&&item.billing_mode==='package';
    const target=(decision?decision.action==='charge':canDeduct)?-1:0;
    const before=projected.get(item.client_id)??item.balance,after=before+target-item.posted_net;
    if(decision)projected.set(item.client_id,after);
    const notes=[item.lesson_status==='cancelled'?t("Odwołana"):'',item.attendance==='no_show'?t("Nieobecny"):item.attendance==='cancelled'?t("Udział odwołany"):'',
      item.removed?t("Usunięty uczestnik"):'',item.review_status==='needs_review'?t("Wymaga korekty · Już zaksięgowano: {0}",item.posted_net):''].filter(Boolean);
    return {item,decision,canDeduct,before,after,notes};
  });
  async function approve(){
    const decisions=selected.map(b=>({booking_id:b.id,expected_revision:b.revision,...selection[b.id]}));
    if(await run('hb_review_credits',{p_decisions:decisions})) {setSelection({});setPage(0);setRefresh(x=>x+1);setBackupError('');setBackupStatus('');setOfferBackup(true);}
  }
  if(offerBackup)return <Modal key="backup" title={t("Zapisać kopię danych?")} onClose={()=>setOfferBackup(false)} busy={saving}>
    <p>{t("Przegląd kredytów został zatwierdzony. Możesz teraz zapisać pełną kopię danych na urządzeniu.")}</p>
    <p className="v2-note">{t("Wybierz folder HorseBook Backups, np. w Dokumentach. Dostępne miejsca zapisu zależą od przeglądarki.")}</p>
    {backupError&&<p role="alert" className="v2-error">{backupError}</p>}
    {backupStatus&&<p role="status">{backupStatus}</p>}
    <div className="v2-stack"><button className="btn btn-primary v2-wide" disabled={saving} onClick={async()=>{
      setSaving(true);setBackupError('');setBackupStatus('');
      try {const result=await saveSnapshot(()=>rpc<Snapshot>('hb_export_snapshot'));
        if(result==='saved')setBackupStatus(t("Kopia została zapisana na urządzeniu."));
        else if(result==='download')setBackupStatus(t("Przygotowano kopię. Sprawdź, czy plik został zapisany w pobranych."));
      }catch(e){setBackupError(errorMessage(e));}finally{setSaving(false);}
    }}>{saving?t("Przygotowywanie kopii…"):t("Zapisz kopię na urządzeniu")}</button>
    <button className="btn btn-secondary v2-wide" disabled={saving} onClick={()=>setOfferBackup(false)}>{backupStatus?t("Gotowe"):t("Pomiń")}</button></div>
  </Modal>;
  return <Modal key="review" title={t("Przegląd kredytów")} onClose={onClose} busy={busy}>
    {error&&<p role="alert" className="v2-error">{error}<button className="btn btn-secondary" onClick={()=>setRefresh(x=>x+1)}>{t("Odśwież")}</button></p>}
    <fieldset disabled={busy||loading}>
      {loading?<Empty>{t("Wczytywanie…")}</Empty>:items.length===0?<Empty>{t("Brak lekcji oczekujących na decyzję.")}</Empty>:<>
        {rows.map(({item,decision,canDeduct,before,after,notes})=>{
          return <article className={`v2-review ${decision?'selected':''}`} key={item.id}>
            <div className="v2-heading"><strong>{item.client_name}</strong><span className={`credit-badge ${item.balance<0?'negative':'zero'}`}>{item.balance}</span></div>
            <p>{item.date} · {minuteTime(item.start_minute)} · {item.lesson_kind==='individual'?t("Lekcja indywidualna"):item.lesson_kind==='group'?t("Lekcja grupowa"):t("Lekcja niestandardowa")}</p>
            {notes.length>0&&<p className="v2-note">{notes.join(' · ')}</p>}
            <p className="v2-note">{t("Kredyty przed lekcją:")} {before} · {t('Kredyty po lekcji:')} {after}</p>
            <div className="review-choices"><button type="button" className={`review-choice ${decision?.action==='charge'?'choice-selected':''}`.trim()} aria-pressed={decision?.action==='charge'} disabled={!canDeduct} onClick={()=>choose(item,decision?.action==='charge'?null:'charge')}>{t("Odejmij")}</button>
              <button type="button" className={`review-choice ${decision?.action==='waive'?'choice-selected':''}`.trim()} aria-pressed={decision?.action==='waive'} onClick={()=>choose(item,decision?.action==='waive'?null:'waive')}>{t("Nie odejmuj")}</button></div>
            {decision&&<Field label={item.review_status==='needs_review'?t("Powód korekty (wymagany)"):t("Powód (opcjonalnie)")}><input className="form-input" value={decision.reason} onChange={e=>setSelection(s=>({...s,[item.id]:{...s[item.id],reason:e.target.value}}))}/></Field>}
          </article>;
        })}
        {selected.length>0&&<div className="v2-summary"><strong>{t("Zmiany sald po zatwierdzeniu")}</strong>{Object.entries(selected.reduce<Record<string,{name:string;before:number;delta:number}>>((s,b)=>{
          const target=selection[b.id].action==='charge'?-1:0;
          const row=s[b.client_id]??{name:b.client_name??'',before:b.balance,delta:0};row.delta+=target-b.posted_net;s[b.client_id]=row;return s;
        },{})).map(([id,row])=><p key={id}>{row.name}: {row.before} → {row.before+row.delta}</p>)}</div>}
        <div className="v2-row"><button className="btn btn-secondary btn-sm" disabled={page===0} onClick={()=>setPage(x=>x-1)}>{t("Poprzednia strona")}</button><button className="btn btn-secondary btn-sm" disabled={items.length<50} onClick={()=>setPage(x=>x+1)}>{t("Następna strona")}</button></div>
        <button className="btn btn-primary v2-wide" disabled={selected.length===0||selected.some(x=>x.review_status==='needs_review'&&!selection[x.id].reason.trim())} onClick={approve}>{busy?t("Zatwierdzanie…"):t("Zatwierdź zaznaczone ({0})",selected.length)}</button>
      </>}
    </fieldset>
  </Modal>;
}
