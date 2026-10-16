import {useEffect,useRef,useState} from 'react';
type TimedItem={id:string;date:string;start_minute:number;duration_minutes:number;revision:number;status?:string};
type Options<T extends TimedItem>={lesson:T;admin:boolean;busy:boolean;slotHeight:number;startHour:number;endHour:number;fitWithinSchedule?:boolean;
  onMove:(lesson:T,startMinute:number)=>Promise<boolean>;onDragActive:(active:boolean)=>void};
type Gesture<T extends TimedItem>={lesson:T;pointerId:number;touch:boolean;x:number;y:number;slotHeight:number;min:number;max:number;
  ready:boolean;dragging:boolean;minute:number;lastY:number;schedule:HTMLElement;scheduleTop:number};

export function useLessonDrag<T extends TimedItem>(options:Options<T>){
  const element=useRef<HTMLDivElement>(null),latest=useRef(options);latest.current=options;
  const gesture=useRef<Gesture<T>|null>(null),hold=useRef<number|undefined>(undefined),suppressClick=useRef(false);
  const [preview,setPreview]=useState<number|null>(null),[ready,setReady]=useState(false),[saving,setSaving]=useState(false);
  const cancelRef=useRef(()=>{});
  useEffect(()=>{
    const node=element.current!;let mounted=true;
    let scrollFrame:number|undefined,lastFrame=0;
    const stopScroll=()=>{if(scrollFrame!==undefined)cancelAnimationFrame(scrollFrame);scrollFrame=undefined;lastFrame=0;};
    const updatePreview=(g:Gesture<T>)=>{
      // Include scroll movement so a stationary pointer keeps its grip on the tile.
      const dy=g.lastY-g.y+g.scheduleTop-g.schedule.getBoundingClientRect().top;
      const offset=Math.round((dy*60/g.slotHeight)/15)*15;
      g.minute=Math.max(g.min,Math.min(g.max,Math.round((g.lesson.start_minute+offset)/15)*15));
      setPreview(g.minute);
    };
    const autoScroll=(time:number)=>{
      const g=gesture.current;if(!g?.dragging){stopScroll();return;}
      const elapsed=lastFrame?Math.min(time-lastFrame,40):0;lastFrame=time;
      const viewport=window.visualViewport;
      const top=viewport?.offsetTop??0;
      const bottom=Math.min(top+(viewport?.height??window.innerHeight),document.querySelector('.bottom-nav')?.getBoundingClientRect().top??window.innerHeight);
      const edge=Math.min(72,(bottom-top)/4);
      const proximity=g.lastY<top+edge?-Math.min(1,(top+edge-g.lastY)/edge):
        g.lastY>bottom-edge?Math.min(1,(g.lastY-bottom+edge)/edge):0;
      const scroller=document.scrollingElement;
      if(scroller&&proximity){
        const bounds=g.schedule.getBoundingClientRect();
        const limit=proximity<0?0:
          Math.min(scroller.scrollHeight-scroller.clientHeight,scroller.scrollTop+bounds.bottom-bottom);
        const next=scroller.scrollTop+proximity*480*elapsed/1000;
        scroller.scrollTo({top:proximity<0?Math.max(limit,next):Math.max(scroller.scrollTop,Math.min(limit,next)),behavior:'instant'});
      }
      updatePreview(g);
      scrollFrame=requestAnimationFrame(autoScroll);
    };
    const clearHold=()=>{window.clearTimeout(hold.current);hold.current=undefined;};
    const cancel=()=>{
      clearHold();stopScroll();gesture.current=null;latest.current.onDragActive(false);
      setReady(false);setPreview(null);
    };
    cancelRef.current=cancel;
    const start=(id:number,x:number,y:number,touch:boolean)=>{
      const o=latest.current;
      if(!o.admin||o.busy||o.lesson.status==='cancelled')return;
      cancel();suppressClick.current=false;
      const schedule=node.closest<HTMLElement>('.day-schedule')!;
      const g:Gesture<T>={lesson:o.lesson,pointerId:id,touch,x,y,lastY:y,schedule,scheduleTop:schedule.getBoundingClientRect().top,slotHeight:o.slotHeight,min:o.startHour*60,
        max:Math.min(o.fitWithinSchedule?Math.max(o.startHour*60,Math.floor((o.endHour*60-o.lesson.duration_minutes)/15)*15):(o.endHour-1)*60,Math.floor((1440-o.lesson.duration_minutes)/15)*15),
        ready:!touch,dragging:false,minute:o.lesson.start_minute};
      gesture.current=g;
      if(touch)hold.current=window.setTimeout(()=>{
        if(gesture.current!==g||latest.current.busy)return;
        g.ready=true;suppressClick.current=true;setReady(true);latest.current.onDragActive(true);
        navigator.vibrate?.(50);
      },500);
    };
    const move=(x:number,y:number,event:Event)=>{
      const g=gesture.current;if(!g)return;
      g.lastY=y;
      const dx=x-g.x,dy=y-g.y;
      if(!g.ready){if(Math.max(Math.abs(dx),Math.abs(dy))>10)cancel();return;}
      if(!g.dragging&&Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)){cancel();return;}
      if(!g.dragging&&Math.abs(dy)>5&&Math.abs(dy)>=Math.abs(dx)){
        g.dragging=true;suppressClick.current=true;setReady(false);latest.current.onDragActive(true);
        if(!g.touch)node.setPointerCapture(g.pointerId);
        scrollFrame=requestAnimationFrame(autoScroll);
      }
      if(g.dragging||g.touch){if(event.cancelable)event.preventDefault();event.stopPropagation();}
      if(!g.dragging)return;
      updatePreview(g);
    };
    const end=(event:Event)=>{
      const g=gesture.current;if(!g)return;
      if(g.dragging)updatePreview(g);
      clearHold();stopScroll();gesture.current=null;setReady(false);latest.current.onDragActive(false);
      if(g.dragging||g.touch&&g.ready)event.stopPropagation();
      if(!g.dragging||g.minute===g.lesson.start_minute||latest.current.busy){setPreview(null);return;}
      setSaving(true);
      const settled=()=>{if(mounted){setSaving(false);setPreview(null);}};
      void latest.current.onMove(g.lesson,g.minute).then(settled,settled);
    };
    const pointerDown=(e:PointerEvent)=>{
      if(e.pointerType==='touch')return;
      if(e.isPrimary&&e.button===0)start(e.pointerId,e.clientX,e.clientY,false);
    };
    const pointerMove=(e:PointerEvent)=>{if(gesture.current&&!gesture.current.touch&&gesture.current.pointerId===e.pointerId)move(e.clientX,e.clientY,e);};
    const pointerUp=(e:PointerEvent)=>{if(gesture.current&&!gesture.current.touch&&gesture.current.pointerId===e.pointerId)end(e);};
    const pointerCancel=()=>{if(gesture.current&&!gesture.current.touch)cancel();};
    const lostCapture=(e:PointerEvent)=>{if(e.target===node)pointerCancel();};
    const touchStart=(e:TouchEvent)=>{
      if(e.touches.length!==1){cancel();return;}
      const t=e.touches[0];start(t.identifier,t.clientX,t.clientY,true);
    };
    const touchMove=(e:TouchEvent)=>{
      if(e.touches.length!==1){cancel();return;}
      const t=e.touches[0];if(gesture.current?.touch&&gesture.current.pointerId===t.identifier)move(t.clientX,t.clientY,e);
    };
    const touchEnd=(e:TouchEvent)=>{if(gesture.current?.touch)end(e);};
    const touchCancel=()=>{if(gesture.current?.touch)cancel();};
    node.addEventListener('pointerdown',pointerDown);node.addEventListener('pointermove',pointerMove);
    node.addEventListener('pointerup',pointerUp);node.addEventListener('pointercancel',pointerCancel);node.addEventListener('lostpointercapture',lostCapture);
    node.addEventListener('touchstart',touchStart,{passive:true});
    // Prevent native scrolling only after a hold has armed the drag. Changing
    // touch-action mid-gesture would not work and would break ordinary scrolling.
    node.addEventListener('touchmove',touchMove,{passive:false});
    node.addEventListener('touchend',touchEnd);node.addEventListener('touchcancel',touchCancel);
    return()=>{
      mounted=false;clearHold();stopScroll();gesture.current=null;latest.current.onDragActive(false);
      node.removeEventListener('pointerdown',pointerDown);node.removeEventListener('pointermove',pointerMove);
      node.removeEventListener('pointerup',pointerUp);node.removeEventListener('pointercancel',pointerCancel);node.removeEventListener('lostpointercapture',lostCapture);
      node.removeEventListener('touchstart',touchStart);node.removeEventListener('touchmove',touchMove);
      node.removeEventListener('touchend',touchEnd);node.removeEventListener('touchcancel',touchCancel);
    };
  },[]);
  useEffect(()=>{
    const g=gesture.current;
    if(g&&(options.busy||!options.admin||options.lesson.revision!==g.lesson.revision||options.lesson.date!==g.lesson.date))cancelRef.current();
  },[options.busy,options.admin,options.lesson.revision,options.lesson.date]);
  return {element,preview,ready,saving,consumeClick:()=>{
    if(!suppressClick.current)return false;suppressClick.current=false;return true;
  }};
}
