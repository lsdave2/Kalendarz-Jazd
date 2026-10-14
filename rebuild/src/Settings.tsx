import {t,useLanguage} from './i18n';
import {useEffect,useState} from 'react';
import {rpc,supabase,errorMessage,localTest} from './api';
import {downloadSnapshot} from './snapshot';
import {Empty,Field,Icon,Modal,type Run} from './components';
import {ReferenceEditor} from './Accounts';
import {History} from './History';
import {resolveLoginEmail} from './adminLogin';
import type {References,Reference,Snapshot} from './types';
export function Settings({admin,loggedInEmail,refs,run,busy,refresh,notify}:{admin:boolean;loggedInEmail:string|null;refs:References;run:Run;busy:boolean;refresh:()=>Promise<void>;notify:(s:string)=>void}){
  const [language,setLanguage]=useLanguage();
  const [login,setLogin]=useState(false),[identifier,setIdentifier]=useState(''),[password,setPassword]=useState(''),[authBusy,setAuthBusy]=useState(false);
  const [edit,setEdit]=useState<{kind:'horses'|'instructors';record:Reference|null}|null>(null),[audit,setAudit]=useState(false);
  const hours=refs.settings.find(x=>x.key==='schedule_hours');
  const [start,setStart]=useState(hours?.value.start??8),[end,setEnd]=useState(hours?.value.end??21);
  const [hoursRevision,setHoursRevision]=useState<number|null>(hours?.revision??null),[hoursDirty,setHoursDirty]=useState(false);
  useEffect(()=>{if(!hoursDirty){setStart(hours?.value.start??8);setEnd(hours?.value.end??21);setHoursRevision(hours?.revision??null);}},[hours,hoursDirty]);
  const [exporting,setExporting]=useState(false),[checking,setChecking]=useState(false);
  return <>
    <section className="settings-section"><Field label={t('Język')}>
      <select id="setting-lang-select" className="form-input" value={language} onChange={e=>setLanguage(e.target.value as 'pl'|'en')}>
        <option value="pl" lang="pl">Polski</option><option value="en" lang="en">English</option>
      </select>
    </Field></section>
    <section className="settings-section"><h4>{t("Konto administratora")}</h4>
      {admin&&loggedInEmail&&<p className="v2-note" style={{overflowWrap:'anywhere'}}>{t('Zalogowano jako:')} <strong>{loggedInEmail}</strong></p>}
      {admin?<button className="btn btn-secondary v2-wide" disabled={busy||localTest} onClick={async()=>{await supabase!.auth.signOut();await refresh();}}>{t("Wyloguj")}</button>
        :<button className="btn btn-primary v2-wide" onClick={()=>setLogin(true)}>{t("Zaloguj jako administrator")}</button>}
    </section>
    {admin&&<>
      {(['horses','instructors'] as const).map(kind=><section className="settings-section" key={kind}><div className="v2-heading"><h4>{kind==='horses'?t("Konie"):t("Instruktorzy")}</h4><button className="btn btn-secondary btn-sm" disabled={busy} onClick={()=>setEdit({kind,record:null})}>{t("Dodaj")}</button></div>
        <div className="settings-list">{refs[kind].map(x=><button className="settings-chip" key={x.id} disabled={busy} style={x.archived?{opacity:.5}:{}} onClick={()=>setEdit({kind,record:x})}>
          {x.color&&<span className="v2-dot" style={{background:x.color}}/>}{x.name}{x.archived?' · '+t('Archiwalny'):''}<Icon name="edit"/></button>)}</div></section>)}
      <section className="settings-section"><h4>{t("Godziny kalendarza")}</h4><form onSubmit={async e=>{e.preventDefault();if(await run('hb_save_setting',{p_key:'schedule_hours',p_expected_revision:hoursRevision,p_value:{start,end}}))setHoursDirty(false);}}><fieldset disabled={busy}>
        <div className="v2-row"><Field label={t("Od")}><input className="form-input" type="number" min="0" max="23" value={start} onChange={e=>{setHoursDirty(true);setStart(Number(e.target.value));}}/></Field><Field label={t("Do")}><input className="form-input" type="number" min="1" max="24" value={end} onChange={e=>{setHoursDirty(true);setEnd(Number(e.target.value));}}/></Field></div>
        {hoursDirty&&hoursRevision!==(hours?.revision??null)&&<p className="v2-note">{t("Godziny zmienił inny administrator.")} <button type="button" className="btn btn-secondary btn-sm" onClick={()=>setHoursDirty(false)}>{t("Wczytaj aktualne godziny")}</button></p>}
        <button className="btn btn-secondary v2-wide" type="submit" disabled={start>=end}>{t("Zapisz godziny")}</button></fieldset></form></section>
      <section className="settings-section"><h4>{t("Historia i kopie zapasowe")}</h4><div className="v2-stack">
        <button className="btn btn-secondary" onClick={()=>setAudit(true)}><Icon name="history"/>{t("Historia zmian")}</button>
        <button className="btn btn-secondary" disabled={exporting||busy} onClick={async()=>{
          setExporting(true);try{const snapshot=await rpc<Snapshot>('hb_export_snapshot');await downloadSnapshot(snapshot);notify(t("Przygotowano kopię. Sprawdź, czy plik został zapisany w pobranych."));}catch(e){notify(errorMessage(e));}finally{setExporting(false);}
        }}><Icon name="download"/>{exporting?t("Przygotowywanie kopii…"):t("Pobierz kopię danych")}</button>
        <button className="btn btn-secondary" disabled={checking||busy} onClick={async()=>{
          setChecking(true);try{const problems=await rpc<unknown[]>('hb_integrity');notify(problems.length?t("Wykryto niespójności ({0}). Zachowaj kopię i sprawdź historię.",problems.length):t("Salda i historia rozliczeń są spójne."));}catch(e){notify(errorMessage(e));}finally{setChecking(false);}
        }}>{t("Sprawdź spójność sald")}</button></div>
        <p className="v2-note">{t("Kopia obejmuje wszystkie dane aplikacji. Przechowuj ją w bezpiecznym miejscu. Przywracanie najpierw sprawdzamy w osobnej bazie.")}</p>
      </section>
    </>}
    {!admin&&<Empty>{t("Kalendarz jest dostępny do przeglądania. Zaloguj się, aby edytować lekcje i rozliczać kredyty.")}</Empty>}
    {login&&<Modal title={t("Logowanie administratora")} onClose={()=>setLogin(false)} busy={authBusy}>
      <form onSubmit={async e=>{e.preventDefault();setAuthBusy(true);try{const email=await resolveLoginEmail(identifier,value=>rpc<string|null>('hb_resolve_admin_login_email',{p_identifier:value}));if(!email)throw new Error(t('Nieprawidłowy login lub hasło.'));const {error}=await supabase!.auth.signInWithPassword({email,password});if(error)throw error;setPassword('');await refresh();setLogin(false);}catch(e){notify(errorMessage(e));}finally{setAuthBusy(false);}}}><fieldset disabled={authBusy}>
        <Field label={t("Login lub email")}><input className="form-input" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={identifier} onChange={e=>setIdentifier(e.target.value)}/></Field>
        <Field label={t("Hasło")}><input className="form-input" type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></Field>
        <button className="btn btn-primary v2-wide" type="submit">{authBusy?t("Logowanie…"):t("Zaloguj")}</button>
      </fieldset></form></Modal>}
    {edit&&<ReferenceEditor {...edit} run={run} busy={busy} onClose={()=>setEdit(null)}/>}
    {audit&&<History kind="audit" onClose={()=>setAudit(false)}/>}
  </>;
}
