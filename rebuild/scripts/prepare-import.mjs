// READ-ONLY against the old project. Writes a whitelisted local import manifest.
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { parse } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID,createHash } from 'node:crypto';
import { safeError,projectRef } from './config.mjs';
const sourcePath=process.argv[2];
if(!sourcePath) {console.error('Usage: npm run import:prepare -- PATH_TO_OLD_PROJECT_ENV');process.exit(1);}
try {
  const env=parse(await readFile(sourcePath,'utf8'));
  const url=env.VITE_SUPABASE_URL;
  if(!url || new URL(url).hostname===`${projectRef}.supabase.co`) throw new Error('Source must be the OLD project');
  const key=env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if(!key) throw new Error('Old project browser key is missing');
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  async function all(table) {
    const rows=[];
    for(let offset=0;;offset+=500) {
      const response=await db.from(table).select('*').order('id').range(offset,offset+499);
      if(response.error) throw response.error;
      rows.push(...response.data);if(response.data.length<500) return rows;
    }
  }
  const [clients,horses,instructors]=await Promise.all([all('packages'),all('horses'),all('instructors')]);
  const warnings=[];
  const mapped=(rows,kind)=>{
    const seen=new Set();
    return rows.map(row=> {
      const name=String(row.name||'').trim();if(!name) throw new Error(`Empty name in source ${kind}`);
      const normalized=name.normalize('NFKC').toLocaleLowerCase('pl');
      if(seen.has(normalized)) warnings.push(`Ambiguous duplicate name in ${kind}; retained as separate identities in the draft.`);
      seen.add(normalized);
      return {id:randomUUID(),name,archived:row.active===false,
        ...(kind==='instructors'?{color:/^#[a-f0-9]{6}$/i.test(row.color)?row.color:'#7c5cfc'}:{}),
        ...(kind==='clients'?{payment_rate:row.custom_payment_rate??null}:{})};
    });
  };
  const data={clients:mapped(clients,'clients'),horses:mapped(horses,'horses'),instructors:mapped(instructors,'instructors')};
  const manifest={format:'horsebook.reference-import',version:1,source_project:new URL(url).hostname,
    exported_at:new Date().toISOString(),data,warnings,
    source_checksum:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
  await mkdir(new URL('../private/',import.meta.url),{recursive:true});
  await writeFile(new URL('../private/reference-import.json',import.meta.url),JSON.stringify(manifest,null,2),{flag:'wx'});
  console.log(JSON.stringify({counts:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v.length])),warnings,excluded:'lessons, balances, ledger, finance, vouchers and audit history'}));
} catch(error) {console.error(safeError(error));process.exitCode=1;}
