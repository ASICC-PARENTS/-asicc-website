import { CUTOFF, PURGE_AT, validateRegistration, InputError, SESSION } from './validation.mjs';
const json = (body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const sha256=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');
const origins=env=>env.ALLOWED_ORIGINS.split(',').map(v=>v.trim());
const cors=origin=>({'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Vary':'Origin'});
const withCors=(res,origin)=>new Response(res.body,{status:res.status,headers:{...Object.fromEntries(res.headers),...cors(origin)}});
const cutoff=env=>env.ADMISSIONS_MODE==='test'?Number.POSITIVE_INFINITY:CUTOFF;
const isClosed=env=>Date.now()>=cutoff(env);
async function readBody(req){
  if(!req.headers.get('Content-Type')?.startsWith('application/json')) throw new InputError();
  const body=await req.text(); if(body.length>10000) throw new InputError();
  try { return JSON.parse(body); } catch { throw new InputError(); }
}
// Firebase ID tokens are validated by Google, not by this UI. The member profile
// read uses the caller's own token; this Worker has no service-account access.
export async function authorizedAdmin(req,env,fetcher=fetch){
  const token=req.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
  if(!token || token.length>8192) return false;
  try {
    const response=await fetcher('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+encodeURIComponent(env.FIREBASE_API_KEY),{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});
    if(!response.ok)return false;
    const user=(await response.json()).users?.[0];
    if(!user || user.emailVerified!==true || user.disabled===true || typeof user.localId!=='string' || !user.localId || user.localId.includes('/'))return false;
    const profile=await fetcher('https://firestore.googleapis.com/v1/projects/'+env.FIREBASE_PROJECT_ID+
      '/databases/(default)/documents/members/'+encodeURIComponent(user.localId),{headers:{Authorization:'Bearer '+token}});
    if(!profile.ok)return false;
    const fields=(await profile.json()).fields;
    return fields?.role?.stringValue==='admin' && fields?.status?.stringValue==='approved';
  } catch { return false; }
}

export default {
  async fetch(req,env,ctx){
    const path=new URL(req.url).pathname;
    if(path==='/health' && req.method==='GET')return json({ok:true,service:'admissions-registration',mode:env.ADMISSIONS_MODE,session:SESSION,open:!isClosed(env),confirmationEmail:Boolean(env.BREVO_API_KEY)});
    const origin=req.headers.get('Origin')||'';
    if(!origins(env).includes(origin))return json({error:'origin'},403);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(origin)});
    let res;
    try {
      const object=env.REGISTRATIONS.get(env.REGISTRATIONS.idFromName(SESSION));
      if(path==='/api/status' && req.method==='GET')res=json({open:!isClosed(env),confirmationEmail:Boolean(env.BREVO_API_KEY)});
      else if(path==='/api/register' && req.method==='POST'){
        if(isClosed(env))res=json({error:'closed'},410);
        else{
          const registration=validateRegistration(await readBody(req));
          // The service intentionally does not expose whether an e-mail is already registered.
          const key=await sha256(registration.email);
          const rateKey=await sha256((req.headers.get('CF-Connecting-IP')||'unknown')+'|'+new Date().toISOString().slice(0,13));
          const result=await object.fetch('https://internal/register',{method:'POST',body:JSON.stringify({registration,key,rateKey})});
          if(!result.ok)res=json({error:'rate'},result.status===429?429:503);
          else{
            const {created}=await result.json();
            // Persist before attempting email. Test never sends email; a retry of
            // the request won't send a second message to the same address.
            if(created && env.ADMISSIONS_MODE==='production' && env.BREVO_API_KEY){
              ctx.waitUntil(sendConfirmation(registration,env).catch(()=>{}));
            }
            res=json({ok:true});
          }
        }
      }else if(path==='/api/admin/list' && req.method==='POST'){
        if(!await authorizedAdmin(req,env))res=json({error:'forbidden'},403);
        else res=await object.fetch('https://internal/list',{method:'POST'});
      }else res=json({error:'not_found'},404);
    }catch(e){res=json({error:e instanceof InputError?'invalid':'unavailable'},e instanceof InputError?400:503);}
    return withCors(res,origin);
  }
};
async function sendConfirmation(registration,env){
  const ko=registration.lang==='ko';
  const subject=ko?'ASICC 온라인 입학설명회 참가 신청 접수':'ASICC – inscription à la réunion d’information';
  const textContent=ko?'안녕하세요. 12월 4일(금) 저녁 8시 온라인 입학설명회 참가 신청이 접수되었습니다. 접속 방법은 추후 이메일로 안내해 드리겠습니다. 문의: contact@asicc-parents.fr':'Bonjour, votre inscription à la réunion d’information en ligne du vendredi 4 décembre 2026 à 20 h est enregistrée. Les modalités de connexion vous seront communiquées par e-mail. Contact : contact@asicc-parents.fr';
  await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'Content-Type':'application/json','api-key':env.BREVO_API_KEY},body:JSON.stringify({sender:{name:'ASICC',email:'contact@asicc-parents.fr'},to:[{email:registration.email}],subject,textContent})});
}
// Isolated SQLite-backed Durable Object. This binding is never shared with
// member survey, Bazaar, Firebase, or the other environment.
export class Registrations {
  constructor(state,env){this.storage=state.storage;this.env=env;}
  async fetch(req){
    const p=new URL(req.url).pathname;
    if(p==='/register'){
      const {registration,key,rateKey}=await req.json();
      if(isClosed(this.env))return json({error:'closed'},410);
      const now=Date.now();
      const result=await this.storage.transaction(async tx=>{
        const rk='rate:'+rateKey;
        const rate=await tx.get(rk)||0;
        if(rate>=20)return {error:'rate'};
        await tx.put(rk,rate+1);
        const count=await tx.get('count')||0;
        if(await tx.get('reg:'+key))return {created:false};
        if(count>=1000)return {error:'rate'};
        await tx.put('reg:'+key,{...registration,createdAt:new Date(now).toISOString()});
        await tx.put('count',count+1);
        return {created:true};
      });
      if(this.env.ADMISSIONS_MODE==='production' && !await this.storage.getAlarm())await this.storage.setAlarm(PURGE_AT);
      return result.error?json(result,429):json(result);
    }
    if(p==='/list'){
      if(this.env.ADMISSIONS_MODE==='production' && Date.now()>=PURGE_AT)return json({registrations:[]});
      const records=await this.storage.list({prefix:'reg:',limit:1000});
      return json({registrations:Array.from(records.values()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
    }
    return json({error:'not_found'},404);
  }
  async alarm(){if(this.env.ADMISSIONS_MODE==='production' && Date.now()>=PURGE_AT)await this.storage.deleteAll();}
}
