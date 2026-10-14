import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {resolveLoginEmail} from '../src/adminLogin.ts';
test('email logins bypass alias lookup while short names are normalized',async()=>{
  const calls=[];
  const resolve=async value=>{calls.push(value);return value==='ania'?'ania@example.com':null;};
  assert.equal(await resolveLoginEmail(' AnIa ',resolve),'ania@example.com');
  assert.equal(await resolveLoginEmail(' direct@example.com ',resolve),'direct@example.com');
  assert.equal(await resolveLoginEmail(' ',resolve),null);
  assert.equal(await resolveLoginEmail('unknown',resolve),null);
  assert.deepEqual(calls,['ania','unknown']);
});
test('short logins resolve case-insensitively, track email changes and require membership',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;create schema horsebook;
      create table auth.users(id uuid primary key,email text);
      create table horsebook.admin_members(user_id uuid primary key);
      create table horsebook.schema_version(version integer primary key);
      insert into auth.users values('10000000-0000-4000-8000-000000000001','ania@example.com');
      insert into horsebook.admin_members select id from auth.users;`);
    await db.exec(await readFile(new URL('../database/013_admin_login_aliases.sql',import.meta.url),'utf8'));
    await db.exec(`insert into horsebook.admin_login_aliases values('ania','10000000-0000-4000-8000-000000000001');set role anon;`);
    const resolve=async name=>(await db.query('select public.hb_resolve_admin_login_email($1) as email',[name])).rows[0].email;
    assert.equal(await resolve(' AnIa '),'ania@example.com');
    assert.equal(await resolve('missing'),null);
    await assert.rejects(db.query('select * from horsebook.admin_login_aliases'),/permission denied/);
    await db.exec(`reset role;update auth.users set email='changed@example.com';set role anon;`);
    assert.equal(await resolve('ania'),'changed@example.com');
    await db.exec('reset role;delete from horsebook.admin_members;set role anon;');
    assert.equal(await resolve('ania'),null);
  }finally{await db.close();}
});
