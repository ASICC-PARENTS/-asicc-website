import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRegistration,InputError,CITIES} from './validation.mjs';
import worker,{authorizedAdmin,Registrations} from './index.mjs';
const valid={name:'Test Adult',email:'TEST@example.invalid',city:'Courbevoie',interest:'next_year',children:[{school:'mat',grade:'PS'},{school:'elem',grade:'CP'}],lang:'ko',consent:true};
test('next-year applications support multiple children, valid levels and email normalization',()=>{
  assert.deepEqual(validateRegistration(valid).children,valid.children);
  assert.equal(validateRegistration(valid).email,'test@example.invalid');
  assert.ok(CITIES.includes('Nanterre'));
});
test('future and general interest need no child information; other city required',()=>{
  for(const interest of ['future','general']){
    const data=validateRegistration({...valid,interest,children:[],city:'other',cityOther:'Versailles',lang:'fr'});
    assert.equal(data.city,'Versailles');assert.deepEqual(data.children,[]);
  }
  for(const data of [
    {...valid,children:[]}, {...valid,children:[{school:'mat',grade:'CM2'}]},
    {...valid,city:'other'}, {...valid,city:'unauthorized'}, {...valid,consent:false},
    {...valid,email:'invalid'}, {...valid,interest:'general'}, {...valid,website:'bot'}
  ])assert.throws(()=>validateRegistration(data),InputError);
});
const env={ADMISSIONS_MODE:'test',ALLOWED_ORIGINS:'https://test.example',FIREBASE_API_KEY:'test',FIREBASE_PROJECT_ID:'demo-project'};
const testOrigin={'Origin':'https://test.example','Content-Type':'application/json'};
const makeRequest=(path,body,headers=testOrigin)=>new Request('https://worker.example'+path,{method:'POST',headers,body:JSON.stringify(body)});
test('admin authorization validates Google response and Firestore role; fails closed',async()=>{
  const req=makeRequest('/api/admin/list',{}, {...testOrigin,Authorization:'Bearer valid-token'});
  assert.equal(await authorizedAdmin(makeRequest('/api/admin/list',{}),env,()=>{throw Error()}),false);
  const stub=(role,status='approved',verified=true)=>async url=>new Response(JSON.stringify(url.includes('accounts:lookup')?{users:[{localId:'uid',emailVerified:verified}]}:{fields:{role:{stringValue:role},status:{stringValue:status}}}));
  assert.equal(await authorizedAdmin(req,env,stub('admin')),true);
  assert.equal(await authorizedAdmin(req,env,stub('member')),false);
  assert.equal(await authorizedAdmin(req,env,stub('admin','suspended')),false);
  assert.equal(await authorizedAdmin(req,env,stub('admin','approved',false)),false);
});
function fakeStorage(){
  const map=new Map();
  const s={get:k=>map.get(k),put:(k,v)=>map.set(k,v),list:({prefix})=>new Map([...map].filter(([k])=>k.startsWith(prefix))),transaction:async f=>f(s),getAlarm:()=>null,setAlarm:()=>{},deleteAll:()=>map.clear()};
  return s;
}
test('public API stores each normalized email once, never exposes records to unauthenticated public requests',async()=>{
  const obj=new Registrations({storage:fakeStorage()},env);
  const serviceEnv={...env,REGISTRATIONS:{idFromName:v=>v,get:()=>({fetch:(url,init)=>obj.fetch(new Request(url,init))})}};
  const ctx={waitUntil(){throw Error('Test must never send mail')}};
  const first=await worker.fetch(makeRequest('/api/register',valid),serviceEnv,ctx);
  const duplicate=await worker.fetch(makeRequest('/api/register',{...valid,name:'Duplicate',email:'test@example.invalid'}),serviceEnv,ctx);
  assert.equal(first.status,200);assert.deepEqual(await first.json(),{ok:true});assert.deepEqual(await duplicate.json(),{ok:true});
  const saved=await obj.fetch(new Request('https://internal/list',{method:'POST'}));
  const rows=(await saved.json()).registrations;
  assert.equal(rows.length,1);assert.equal(rows[0].name,valid.name);
  const denied=await worker.fetch(makeRequest('/api/admin/list',{}),serviceEnv,ctx);
  assert.equal(denied.status,403);
  assert.equal((await worker.fetch(makeRequest('/api/register',valid,{Origin:'https://elsewhere.example','Content-Type':'application/json'}),serviceEnv,ctx)).status,403);
});

import {ADMISSION_FORM,MEMBER_FORM,statusFor,nextControl} from './form-control.mjs';
import {CUTOFF,PURGE_AT} from './validation.mjs';
test('schedule retains original deadline, exact expiry, reopen, and retention protection',()=>{
  const production={ADMISSIONS_MODE:'production'};
  assert.equal(statusFor(ADMISSION_FORM,production,null,CUTOFF-1).open,true);
  assert.equal(statusFor(ADMISSION_FORM,production,null,CUTOFF).open,false);
  const now=CUTOFF-1000;
  const scheduled=nextControl(ADMISSION_FORM,production,null,{mode:'scheduled',closeAt:new Date(CUTOFF+1000).toISOString(),expectedRevision:0},now);
  assert.equal(statusFor(ADMISSION_FORM,production,scheduled,CUTOFF+999).open,true);
  assert.equal(statusFor(ADMISSION_FORM,production,scheduled,CUTOFF+1000).open,false);
  const manual=nextControl(ADMISSION_FORM,production,scheduled,{mode:'manual',expectedRevision:1},now);
  assert.equal(statusFor(ADMISSION_FORM,production,manual,CUTOFF+1001).open,true);
  assert.equal(statusFor(ADMISSION_FORM,production,manual,PURGE_AT).open,false);
  assert.deepEqual(nextControl(ADMISSION_FORM,production,manual,{mode:'manual',expectedRevision:2},PURGE_AT),{error:'expired'});
  assert.deepEqual(nextControl(ADMISSION_FORM,production,manual,{mode:'closed',expectedRevision:0},now),{error:'conflict'});
  assert.throws(()=>nextControl(ADMISSION_FORM,production,null,{mode:'scheduled',closeAt:new Date(now-1).toISOString(),expectedRevision:0},now),InputError);
  assert.equal(statusFor(MEMBER_FORM,production,null,PURGE_AT).open,true);
});
test('closing does not remove existing submissions, independent form status, no unauthorized controls',async()=>{
  const objects=new Map();
  const serviceEnv={...env,REGISTRATIONS:{idFromName:v=>v,get:id=>{
    if(!objects.has(id))objects.set(id,new Registrations({storage:fakeStorage()},env));
    return {fetch:(url,init)=>objects.get(id).fetch(new Request(url,init))};
  }}};
  const ctx={waitUntil(){throw Error('no mail')}};
  const control=async(id,body)=>worker.fetch(makeRequest('/api/admin/forms/'+id+'/settings',body),serviceEnv,ctx);
  assert.equal((await worker.fetch(makeRequest('/api/register',valid),serviceEnv,ctx)).status,200);
  assert.equal((await control(ADMISSION_FORM,{mode:'closed',expectedRevision:0})).status,403);
  const obj=serviceEnv.REGISTRATIONS.get('2026-12-04-online');
  const internal=async(mode,revision)=>obj.fetch('https://internal/control?form='+ADMISSION_FORM,{method:'POST',body:JSON.stringify({mode,expectedRevision:revision})});
  assert.equal((await internal('closed',0)).status,200);
  assert.equal((await worker.fetch(makeRequest('/api/register',{...valid,email:'second@example.invalid'}),serviceEnv,ctx)).status,410);
  assert.equal((await (await obj.fetch('https://internal/list',{method:'POST'})).json()).registrations.length,1);
  const member=await worker.fetch(new Request('https://worker.example/api/forms/'+MEMBER_FORM+'/status'),serviceEnv,ctx);
  assert.equal((await member.json()).open,true);
  assert.equal((await internal('manual',0)).status,409);
  assert.equal((await internal('manual',1)).status,200);
  assert.equal((await worker.fetch(makeRequest('/api/register',{...valid,email:'second@example.invalid'}),serviceEnv,ctx)).status,200);
  assert.equal((await (await obj.fetch('https://internal/list',{method:'POST'})).json()).registrations.length,2);
});
