import {t} from './i18n';
import type {ReactNode,ReactElement} from 'react';
import {useEffect,useRef,useState,useId,isValidElement,cloneElement} from 'react';
export function Icon({name}:{name:string}){return <span className={name==='horse'?'horse-icon':'material-symbols-rounded'} aria-hidden="true">{name==='horse'?null:name}</span>;}
export function Modal({title,heading,children,onClose,busy=false,className=''}:{title:string;heading?:ReactNode;children:ReactNode;onClose:()=>void;busy?:boolean;className?:string}){
  const ref=useRef<HTMLDivElement>(null);
  const [closing,setClosing]=useState(false),closingRef=useRef(false);
  const drag=useRef<{id:number;startY:number;distance:number}|null>(null),closeTimer=useRef<number|undefined>(undefined);
  const closeRef=useRef(onClose),busyRef=useRef(busy);closeRef.current=onClose;busyRef.current=busy;
  const dismiss=()=>{
    if(busyRef.current||closingRef.current)return;
    closingRef.current=true;drag.current=null;
    // The original closing animation starts at the sheet's current drag position.
    if(ref.current)ref.current.style.animation='';
    setClosing(true);
    closeTimer.current=window.setTimeout(()=>closeRef.current(),200);
  };
  const dismissRef=useRef(dismiss);dismissRef.current=dismiss;
  const resetDrag=()=>{
    drag.current=null;
    const el=ref.current;if(!el)return;
    el.style.transition='transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    el.style.transform='translateY(0)';el.style.setProperty('--drag-y','0px');
  };
  useEffect(()=>{if(busy)resetDrag();},[busy]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const el=ref.current!;const focusable=()=>Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]'));
    focusable()[0]?.focus();
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape')dismissRef.current();
      if(e.key==='Tab'){const items=focusable(),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    };
    document.addEventListener('keydown',key);const oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{window.clearTimeout(closeTimer.current);document.removeEventListener('keydown',key);document.body.style.overflow=oldOverflow;previous?.focus();};
  },[]);
  return <div className={`modal-overlay ${closing?'closing':''}`.trim()} onMouseDown={e=>{if(e.target===e.currentTarget)dismiss();}}>
    <div className={`modal ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title} ref={ref} inert={closing}>
      <div className="modal-handle"
        onPointerDown={e=>{
          if(!e.isPrimary||e.button!==0||busyRef.current||closingRef.current)return;
          e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
          drag.current={id:e.pointerId,startY:e.clientY,distance:0};
          const el=ref.current!;el.style.animation='none';el.style.transition='none';
        }}
        onPointerMove={e=>{
          const current=drag.current;if(!current||current.id!==e.pointerId)return;
          current.distance=Math.max(0,e.clientY-current.startY);
          const el=ref.current!;el.style.transform=`translateY(${current.distance}px)`;el.style.setProperty('--drag-y',`${current.distance}px`);
        }}
        onPointerUp={e=>{
          if(drag.current?.id!==e.pointerId)return;
          const distance=Math.max(0,e.clientY-drag.current.startY);
          if(distance>100&&!busyRef.current){ref.current!.style.setProperty('--drag-y',`${distance}px`);dismiss();}
          else resetDrag();
        }}
        onPointerCancel={resetDrag} onLostPointerCapture={()=>{if(drag.current)resetDrag();}}/>
      <div className="v2-heading"><h3>{heading??title}</h3><button className="header-btn" type="button" aria-label={t("Zamknij")} disabled={busy||closing} onClick={dismiss}><Icon name="close"/></button></div>{children}
    </div></div>;
}
export function Field({label,children}:{label:string;children:ReactNode}){
  const id=useId();
  return <div className="form-group v2-field"><label htmlFor={id}>{label}</label>
    {isValidElement(children)?cloneElement(children as ReactElement<{id:string}>,{id}):children}</div>;
}
export function Empty({children}:{children:ReactNode}){return <div className="v2-empty">{children}</div>;}
export type Run=(name:string,args:Record<string,unknown>)=>Promise<boolean>;
