import {doc,getDoc,setDoc,updateDoc,serverTimestamp,type Firestore} from 'firebase/firestore';
export type AccountAccess={status?:string;accountType?:string;birthDate?:string;adultAt?:{toMillis?:()=>number}|null;dmMode?:string;role?:string;nickname?:string};
export function dmAllowed(p:AccountAccess,now=Date.now()):boolean {
  if(p.status!=='approved'||p.dmMode==='off'||!['adult','student'].includes(p.accountType||''))return false;
  if(p.accountType==='student'||p.birthDate)return !!p.birthDate&&typeof p.adultAt?.toMillis==='function'&&p.adultAt.toMillis()<=now;
  return p.accountType==='adult';
}
export function validBirthDate(v:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01')return false;
  const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v&&d.getTime()<=Date.now();
}
// At the latest boundary of the birthday in metropolitan France (UTC midnight).
// Feb 29 births use March 1 in a non-leap year; access never opens early.
export function adulthoodDate(v:string):Date {const [y,m,d]=v.split('-').map(Number);return new Date(Date.UTC(y+18,m-1,d));}
export function ageOn(v:string):number|null {if(!validBirthDate(v))return null;const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=(t:string)=>Number(today.find(x=>x.type===t)?.value);const [y,m,d]=v.split('-').map(Number);return get('year')-y-(get('month')<m||get('month')===m&&get('day')<d?1:0);}
// Sync only one's own nickname/role/eligibility; no migration, no private birth date exposed.
export async function syncOwnAlias(db:Firestore,uid:string,p:AccountAccess){
  if(!p.nickname||!p.role)return;
  const ref=doc(db,'publicNames',uid),snap=await getDoc(ref);const a=snap.data(),canReceiveDM=dmAllowed(p);
  if(!snap.exists())await setDoc(ref,{nickname:p.nickname,role:p.role,canReceiveDM,updatedAt:serverTimestamp()});
  else if(a?.nickname===p.nickname&&(a.role!==p.role||a.canReceiveDM!==canReceiveDM))await updateDoc(ref,{role:p.role,canReceiveDM,updatedAt:serverTimestamp()});
}
export type PublicAuthor={nickname:string;role:string;canReceiveDM?:boolean};
const names:Record<string,[string,string]>={general:['일반회원','Membre général'],member:['정회원','Membre régulier'],special:['특별회원','Membre spécial'],admin:['운영진','Administrateur']};
export function displayAuthor(target:HTMLElement,info:PublicAuthor,authorUid:string,viewerUid:string,viewerRole:string,viewerDM:boolean,fr:boolean,messageUrl:string,suffix=''){
  const group=document.createElement('span');group.className='asicc-author';
  const badge=document.createElement('span');badge.className='asicc-role-tag';badge.dataset.role=info.role;badge.textContent=names[info.role]?.[fr?1:0]|| (fr?'Rôle non confirmé':'등급 미확인');
  group.append(badge);const allowed=viewerDM&&info.canReceiveDM===true&&authorUid!==viewerUid&&!!authorUid&&(viewerRole!=='general'||info.role==='admin')&&(viewerRole==='admin'||viewerRole==='general'||info.role!=='general');
  if(allowed){const menu=document.createElement('details');menu.className='asicc-author-menu';const summary=document.createElement('summary');summary.className='asicc-author-name';summary.textContent=info.nickname;const link=document.createElement('a');link.textContent=fr?'Envoyer un message':'쪽지 보내기';link.setAttribute('aria-label',fr?`Envoyer un message à ${info.nickname}`:`${info.nickname}에게 쪽지 보내기`);link.href=messageUrl+'?to='+encodeURIComponent(authorUid);menu.append(summary,link);menu.addEventListener('click',e=>e.stopPropagation());group.append(menu);}else{const n=document.createElement('span');n.textContent=info.nickname;group.append(n);}
  target.replaceChildren(group);if(suffix){const date=document.createElement('span');date.className='small muted';date.textContent=suffix;target.append(date);}
}
