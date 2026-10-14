import {getLocale} from './i18n';
export function today(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());}
export function addDays(date:string,days:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function minuteTime(minute:number){return `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;}
export function timeMinute(time:string){const [h,m]=time.split(':').map(Number);return h*60+m;}
export function legacyDateParts(date:string){
  const d=new Date(date+'T12:00:00Z'),capitalize=(text:string)=>text.charAt(0).toUpperCase()+text.slice(1);
  const month=capitalize(new Intl.DateTimeFormat(getLocale(),{month:'long',timeZone:'Europe/Warsaw'}).format(d));
  const weekday=capitalize(new Intl.DateTimeFormat(getLocale(),{weekday:'long',timeZone:'Europe/Warsaw'}).format(d));
  return {date:`${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`,weekday,short:`${weekday}, ${d.getUTCDate()} ${month}`};
}
export function dateLabel(date:string){return legacyDateParts(date).short;}
export function monthRange(month:string){const [y,m]=month.split('-').map(Number);return {from:`${month}-01`,to:new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10)};}
export function shiftMonth(month:string,by:number){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+by,1,12)).toISOString().slice(0,7);}
export function calendarLayout<T extends {start_minute:number;duration_minutes:number}>(lessons:T[]) {
  const sorted=[...lessons].sort((a,b)=>a.start_minute-b.start_minute||b.duration_minutes-a.duration_minutes);
  const clusters:T[][]=[];let end=-1;
  for(const lesson of sorted){if(lesson.start_minute>=end){clusters.push([]);end=-1;}clusters.at(-1)!.push(lesson);end=Math.max(end,lesson.start_minute+lesson.duration_minutes);}
  return clusters.flatMap(cluster=>{
    const columns:T[][]=[];const placements=cluster.map(lesson=>{
      let col=columns.findIndex(items=>{const previous=items.at(-1)!;return previous.start_minute+previous.duration_minutes<=lesson.start_minute;});
      if(col<0){col=columns.length;columns.push([]);}columns[col].push(lesson);return {lesson,col};
    });return placements.map(p=>({...p,columns:columns.length}));
  });
}
