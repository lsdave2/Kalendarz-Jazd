import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {t} from './i18n';
import {minuteTime} from './dates';
import {Icon} from './components';

const ROW=40;
const digits=(value:number)=>String(value).padStart(2,'0');

function Wheel({label,options,value,onChange}:{label:string;options:number[];value:number;onChange:(value:number)=>void}){
  const list=useRef<HTMLDivElement>(null),scrolling=useRef(false),timer=useRef<number|undefined>(undefined);
  const chosen=useRef<number|null>(null);
  const wheelId=useId(),previousOptions=useRef('');
  const key=options.join(',');
  const choose=(next:number)=>{
    window.clearTimeout(timer.current);scrolling.current=false;
    // Cancel an ongoing touch fling before a click or keyboard choice takes over.
    const node=list.current!;chosen.current=next;
    node.style.overflowY='hidden';node.scrollTo({top:options.indexOf(next)*ROW,behavior:'instant'});
    requestAnimationFrame(()=>{node.style.overflowY='';});
    onChange(next);
  };
  useLayoutEffect(()=>{
    if(previousOptions.current!==key)chosen.current=null;
    if((!scrolling.current||previousOptions.current!==key)&&list.current)list.current.scrollTop=Math.max(0,options.indexOf(value))*ROW;
    previousOptions.current=key;
  },[value,key]);
  useEffect(()=>()=>window.clearTimeout(timer.current),[]);
  return <div className="time-wheel-column"><span className="time-wheel-label">{label}</span>
    <div className="time-wheel-frame">
      <div className="time-wheel-selection" aria-hidden="true"/>
      <div ref={list} className="time-wheel" role="listbox" aria-label={label} tabIndex={0}
        aria-activedescendant={`${wheelId}-${value}`}
        onPointerDown={()=>{chosen.current=null;}} onWheel={()=>{chosen.current=null;}}
        onScroll={e=>{
          if(chosen.current!==null){
            const top=Math.max(0,options.indexOf(chosen.current))*ROW;
            if(Math.abs(e.currentTarget.scrollTop-top)>1)e.currentTarget.scrollTo({top,behavior:'instant'});
            return;
          }
          const next=options[Math.max(0,Math.min(options.length-1,Math.round(e.currentTarget.scrollTop/ROW)))];
          if(next===value)return;
          scrolling.current=true;window.clearTimeout(timer.current);
          timer.current=window.setTimeout(()=>{scrolling.current=false;},120);
          onChange(next);
        }}
        onKeyDown={e=>{
          if(!options.length)return;
          const index=options.indexOf(value);
          const next=e.key==='ArrowDown'?Math.min(options.length-1,index+1):e.key==='ArrowUp'?Math.max(0,index-1):e.key==='Home'?0:e.key==='End'?options.length-1:null;
          if(next!==null){e.preventDefault();choose(options[next]);}
        }}>
        {options.map(option=><div key={option} id={`${wheelId}-${option}`} role="option" aria-selected={option===value}
          className={`time-wheel-option ${option===value?'selected':''}`.trim()} onClick={()=>choose(option)}>{digits(option)}</div>)}
      </div>
    </div>
  </div>;
}

export function TimePicker({id,label,value,times,onChange,disabled=false,alignEnd=false}:{id?:string;label:string;value:number;times:number[];onChange:(minute:number)=>void;disabled?:boolean;alignEnd?:boolean}){
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [open,setOpen]=useState(false);
  const valid=times.includes(value),selected=valid?value:times[0]??0;
  const hour=Math.floor(selected/60),minute=selected%60;
  const hours=[...new Set(times.map(time=>Math.floor(time/60)))];
  const minutes=times.filter(time=>Math.floor(time/60)===hour).map(time=>time%60);
  useEffect(()=>{
    if(!open)return;
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  return <div ref={root} className="time-picker" onKeyDown={e=>{if(open&&e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}}}>
    <button ref={trigger} id={id} className="form-input time-picker-trigger" type="button" disabled={disabled} aria-label={label} aria-expanded={open}
      onClick={()=>setOpen(v=>!v)}><span>{valid?minuteTime(value):t('Wybierz godzinę...')}</span><Icon name="schedule"/></button>
    <input className="time-picker-validation" tabIndex={-1} aria-hidden="true" required value={valid?minuteTime(value):''}
      onChange={()=>{}} onInvalid={e=>{e.preventDefault();setOpen(true);trigger.current?.focus();}}/>
    {open&&<div className={`time-picker-panel ${alignEnd?'align-end':''}`.trim()} role="group" aria-label={label}>
      <div className="time-picker-wheels">
        <Wheel label={t('Godziny')} options={hours} value={hour} onChange={next=>{
          const available=times.filter(time=>Math.floor(time/60)===next);
          onChange(available.reduce((best,time)=>Math.abs(time%60-minute)<Math.abs(best%60-minute)?time:best));
        }}/>
        <span className="time-picker-colon" aria-hidden="true">:</span>
        <Wheel label={t('Minuty')} options={minutes} value={minute} onChange={next=>onChange(hour*60+next)}/>
      </div>
      <button type="button" className="time-picker-done" onClick={()=>{if(!valid&&times.length)onChange(selected);close();}}>{t('Gotowe')}</button>
    </div>}
  </div>;
}
