import {useSyncExternalStore} from 'react';
// Applicable English wording is ported from v1's src/i18n.js. The remaining
// entries cover rebuild-specific screens; Polish source wording stays intact.
import english from './en.json';

export type Language='pl'|'en';
const storageKey='horsebook-v2-language';
const valid=(value:unknown):value is Language=>value==='pl'||value==='en';
function initialLanguage():Language {
  try {
    const saved=localStorage.getItem(storageKey);
    if(valid(saved))return saved;
    const legacy=JSON.parse(localStorage.getItem('horsebook_settings')??'{}')?.lang;
    if(valid(legacy))return legacy;
  }catch{/* The switch still works when browser storage is unavailable. */}
  return 'pl';
}
let language=initialLanguage();
const listeners=new Set<()=>void>();
export const getLanguage=()=>language;
export const getLocale=()=>language==='pl'?'pl-PL':'en-US';
// Keep the v1 Monday-first abbreviations.
export const weekdays=()=>language==='pl'?['Pon','Wt','Śr','Czw','Pt','Sob','Ndz']:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function updateLanguage(value:Language){
  language=value;
  document.documentElement.lang=value;
  listeners.forEach(listener=>listener());
}
document.documentElement.lang=language;
export function setLanguage(value:Language){
  if(!valid(value))return;
  try{localStorage.setItem(storageKey,value);}catch{/* Keep the current session usable. */}
  updateLanguage(value);
}
window.addEventListener('storage',event=>{
  if(event.key===storageKey)updateLanguage(valid(event.newValue)?event.newValue:'pl');
});
export function useLanguage(){
  const current=useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},getLanguage);
  return [current,setLanguage] as const;
}
// Polish source text is also the default translation. Parameters are substituted
// once, so names and descriptions containing braces are preserved verbatim.
export function t(source:keyof typeof english,...values:(string|number)[]):string {
  const text=language==='en'?english[source]:source;
  return text.replace(/\{(\d+)\}/g,(match,index)=>values[Number(index)]===undefined?match:String(values[Number(index)]));
}
