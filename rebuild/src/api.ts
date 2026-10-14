import {t} from './i18n';
import {createClient} from '@supabase/supabase-js';
export const localTest=import.meta.env.DEV && import.meta.env.VITE_LOCAL_TEST_MODE==='true';
const url=import.meta.env.VITE_SUPABASE_URL;
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if(!localTest && (!url || !key || new URL(url).hostname!=='kdnhvunmtfqfkhcxtlqp.supabase.co')) {
  throw new Error('Configure the NEW project in rebuild/.env.local before running the rebuild.');
}
export const supabase=localTest?null:createClient(url,key,{auth:{storageKey:'horsebook-v2-auth'}});
export async function rpc<T>(name:string,args:Record<string,unknown>={}):Promise<T> {
  const controller=new AbortController();
  const timer=window.setTimeout(()=>controller.abort(),15000);
  try {
    if(localTest) {
      const response=await fetch('/test-api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name,args}),signal:controller.signal});
      const body=await response.json();if(!response.ok) throw Object.assign(new Error(body.message),{code:body.code});
      return body.result;
    }
    const {data,error}=await supabase!.rpc(name,args).abortSignal(controller.signal);
    if(error) throw Object.assign(new Error(error.message),{code:error.code});
    return data as T;
  } catch(error) {
    if(controller.signal.aborted) throw new Error(t("Nie potwierdzono zapisu. Ponów tę samą operację, aby sprawdzić jej wynik."));
    throw error;
  } finally {window.clearTimeout(timer);}
}

// Persist request identities, never browser snapshots. A timeout/reload retries
// the identical request ID. Definitive SQL failures roll back that operation.
function loadRequests():Record<string,string> {
  try{return JSON.parse(sessionStorage.getItem('hb-v2-pending-requests')||'{}');}catch{return {};}
}
const requests=loadRequests();
function persistRequests(){try{sessionStorage.setItem('hb-v2-pending-requests',JSON.stringify(requests));}catch{/* SQL revision checks remain the fallback. */}}
export async function write<T>(name:string,args:Record<string,unknown>):Promise<T> {
  const identity=JSON.stringify({name,args});
  const op=requests[identity]??crypto.randomUUID();requests[identity]=op;persistRequests();
  const result=await rpc<T>(name,{p_operation_id:op,...args});
  delete requests[identity];persistRequests();return result;
}
export function errorMessage(error:unknown):string {
  const e=error as {code?:string;message?:string};
  if(e.code==='40001') return t("Dane zmienił inny administrator. Odśwież widok i sprawdź zmianę przed ponownym zapisem.");
  if(e.code==='55000') return t("Nie można usunąć lekcji z zapisaną decyzją kredytową. Możesz ją odwołać.");
  if(e.code==='42501') return t("Brak uprawnień administratora. Sprawdź konto i członkostwo w nowym projekcie.");
  if(e.code==='PGRST202'||e.code==='42883') return t("Nowa baza nie jest jeszcze przygotowana. Zastosuj schemat z folderu rebuild/database.");
  return e.message||t("Nie udało się potwierdzić operacji.");
}
