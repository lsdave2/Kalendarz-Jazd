import type {Snapshot} from './types';
function canonical(value:any):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function snapshotBlob(snapshot:Snapshot) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(snapshot)));
  const checksum=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
  const envelope={snapshot,manifest:{algorithm:'sha256',checksum,counts:Object.fromEntries(Object.entries(snapshot.data).map(([k,v])=>[k,v.length]))}};
  return new Blob([JSON.stringify(envelope,null,2)],{type:'application/json'});
}
export async function downloadSnapshot(snapshot:Snapshot) {
  const blob=await snapshotBlob(snapshot);
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;
  link.download=`horsebook-${snapshot.created_at.replace(/[:.]/g,'-')}.json`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
  // The browser cannot confirm the file reached disk. Do not mark it backed up.
}

// Invoke the picker during the Save button gesture, before fetching the snapshot.
// Never retain file handles or write without an explicit Save action.
export async function saveSnapshot(load:()=>Promise<Snapshot>):Promise<'saved'|'download'|'cancelled'> {
  const picker=(window as unknown as {showSaveFilePicker?: (options:unknown)=>Promise<{createWritable:()=>Promise<{write:(blob:Blob)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>}>}>}).showSaveFilePicker;
  if(!picker){await downloadSnapshot(await load());return 'download';}
  let handle;
  try {
    handle=await picker.call(window,{id:'horsebook-snapshots',startIn:'documents',suggestedName:`horsebook-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,types:[{description:'HorseBook JSON',accept:{'application/json':['.json']}}]});
  } catch(e) {
    if(e instanceof DOMException&&e.name==='AbortError')return 'cancelled';
    throw e;
  }
  const blob=await snapshotBlob(await load());
  const writable=await handle.createWritable();
  try {await writable.write(blob);await writable.close();}
  catch(e){await writable.abort().catch(()=>{});throw e;}
  return 'saved';
}
