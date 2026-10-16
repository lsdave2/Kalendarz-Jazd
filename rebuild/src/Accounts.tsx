import {t} from './i18n';
import {useState} from 'react';
import {Empty,Field,Icon,Modal,type Run} from './components';
import {History} from './History';
import type {Client,Reference,References} from './types';
export function ReferenceEditor({record,kind,run,busy,onClose}:{record:Reference|null;kind:'clients'|'horses'|'instructors';run:Run;busy:boolean;onClose:()=>void}){
  const [draft,setDraft]=useState(()=>record?{...record}:{id:crypto.randomUUID(),name:'',archived:false,revision:1,color:'#7c5cfc',payment_rate:null} as Reference);
  const [lessonRate,setLessonRate]=useState(String(record?.lesson_rate??60));
  return <Modal title={record?t("Edytuj dane"):kind==='clients'?t("Dodaj klienta"):kind==='horses'?t("Dodaj konia"):t("Dodaj instruktora")} onClose={onClose} busy={busy}>
    <form onSubmit={async e=>{e.preventDefault();if(await run('hb_save_reference',{p_kind:kind,p_expected_revision:record?.revision??null,p_record:{id:draft.id,name:draft.name,archived:draft.archived,...(kind==='instructors'?{color:draft.color,lesson_rate:Number(lessonRate)}:{}),...(kind==='clients'?{payment_rate:draft.payment_rate,phone_number:draft.phone_number?.trim()||null}:{})}}))onClose();}}><fieldset disabled={busy}>
      <Field label={t("Nazwa")}><input className="form-input" required maxLength={200} value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))}/></Field>
      {kind==='instructors'&&<Field label={t("Kolor")}><input type="color" value={draft.color??'#7c5cfc'} onChange={e=>setDraft(d=>({...d,color:e.target.value}))}/></Field>}
      {kind==='instructors'&&<Field label={t('Stawka za lekcję (zł/h)')}><input className="form-input" type="number" required min="0" step="0.01" value={lessonRate} onChange={e=>setLessonRate(e.target.value)}/></Field>}
      {kind==='clients'&&<Field label={t("Numer telefonu (opcjonalnie)")}><input className="form-input" type="tel" autoComplete="tel" maxLength={50} value={draft.phone_number??''} onChange={e=>setDraft(d=>({...d,phone_number:e.target.value}))}/></Field>}
      {kind==='clients'&&<Field label={t("Indywidualna stawka (zł/h, opcjonalnie)")}><input className="form-input" type="number" min="0" step="0.01" value={draft.payment_rate??''} onChange={e=>setDraft(d=>({...d,payment_rate:e.target.value===''?null:Number(e.target.value)}))}/></Field>}
      <label className="v2-check"><input type="checkbox" checked={draft.archived} onChange={e=>setDraft(d=>({...d,archived:e.target.checked}))}/>{t("Archiwalny")}</label>
      <p className="v2-note">{t("Archiwizacja zachowuje wcześniejsze lekcje i historię.")}</p>
      <button className="btn btn-primary v2-wide" type="submit">{busy?t("Zapisywanie…"):t("Zapisz")}</button>
    </fieldset></form>
  </Modal>;
}
function CreditEditor({client,run,busy,onClose}:{client:Client;run:Run;busy:boolean;onClose:()=>void}){
  const [delta,setDelta]=useState(4),[reason,setReason]=useState(t("Zakup karnetu"));
  return <Modal title={t("Kredyty · {0}",client.name)} onClose={onClose} busy={busy}>
    <form onSubmit={async e=>{e.preventDefault();if(await run('hb_adjust_credits',{p_client_id:client.id,p_expected_revision:client.account.revision,p_delta:delta,p_reason:reason}))onClose();}}><fieldset disabled={busy}>
      <Field label={t("Zmiana kredytów (ujemna wartość odejmuje)")}><input className="form-input" type="number" step="1" min="-100000" max="100000" required value={delta} onChange={e=>setDelta(Number(e.target.value))}/></Field>
      <Field label={t("Powód")}><input className="form-input" required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></Field>
      <p className="v2-summary">{t("Saldo:")} {client.account.balance} → <strong>{client.account.balance+delta}</strong></p>
      <button className="btn btn-primary v2-wide" type="submit" disabled={delta===0}>{busy?t("Zapisywanie…"):t("Zatwierdź zmianę")}</button>
    </fieldset></form>
  </Modal>;
}
export function Accounts({refs,run,busy}:{refs:References;run:Run;busy:boolean}){
  const [search,setSearch]=useState(''),[archived,setArchived]=useState(false),[edit,setEdit]=useState<Reference|null|undefined>(),[credit,setCredit]=useState<Client|null>(null),[history,setHistory]=useState<string|null>(null);
  const clients=refs.clients.filter(c=>c.archived===archived&&c.name.toLocaleLowerCase('pl').includes(search.toLocaleLowerCase('pl')));
  return <>
    <div className="v2-heading"><h2>{t("Klienci")}</h2><button className="btn btn-primary btn-sm" disabled={busy} onClick={()=>setEdit(null)}><Icon name="person_add"/>{t("Dodaj")}</button></div>
    <input type="search" className="form-input" placeholder={t("Szukaj klienta…")} aria-label={t("Szukaj klienta")} value={search} onChange={e=>setSearch(e.target.value)}/>
    <label className="v2-check"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>{t("Pokaż archiwalnych")}</label>
    <div className="package-list">{clients.length===0?<Empty>{t("Brak klientów.")}</Empty>:clients.map(c=><article className={`package-card ${c.archived?'inactive':''}`} key={c.id}>
      <div className="package-info"><div className="package-name">{c.name}</div>{c.phone_number&&<div className="package-status">{c.phone_number}</div>}<div className="package-status">{c.archived?t("Archiwalny"):t("Kredyty zatwierdzone")}</div></div>
      <span className={`credit-badge ${c.account.balance<0?'negative':c.account.balance>0?'positive':'zero'}`}>{c.account.balance}</span>
      <div className="package-actions"><button className="package-action-btn" aria-label={t("Zmień kredyty: {0}",c.name)} disabled={busy} onClick={()=>setCredit(c)}><Icon name="add"/></button>
        <button className="package-action-btn" aria-label={t("Historia: {0}",c.name)} onClick={()=>setHistory(c.id)}><Icon name="history"/></button>
        <button className="package-action-btn" aria-label={t("Edytuj: {0}",c.name)} disabled={busy} onClick={()=>setEdit(c)}><Icon name="edit"/></button></div>
    </article>)}</div>
    {edit!==undefined&&<ReferenceEditor record={edit} kind="clients" run={run} busy={busy} onClose={()=>setEdit(undefined)}/>}
    {credit&&<CreditEditor client={credit} run={run} busy={busy} onClose={()=>setCredit(null)}/>}
    {history&&<History clientId={history} onClose={()=>setHistory(null)}/>}
  </>;
}
