import {doc,getDoc,getDocFromServer,setDoc,updateDoc,serverTimestamp,type Firestore} from 'firebase/firestore';
import {dmAllowed,type AccountAccess} from './dm-policy';
export {dmAllowed,validBirthDate,adulthoodDate,ageOn,type AccountAccess} from './dm-policy';
// An intentionally empty, read-only authorization path. Rules evaluate the actual
// pair and global switch; no private student data is read or returned to clients.
export async function canContact(db:Firestore,uid:string):Promise<boolean>{
  if(!uid||uid.includes('/'))return false;
  try{await getDocFromServer(doc(db,'messageAccess',uid));return true;}catch(e:any){if(e?.code==='permission-denied')return false;throw e;}
}
// Sync only one's own nickname/role/eligibility; no migration, no private birth date exposed.
export async function syncOwnAlias(db:Firestore,uid:string,p:AccountAccess){
  if(!p.nickname||!p.role)return;
  const ref=doc(db,'publicNames',uid),snap=await getDoc(ref);const a=snap.data(),canReceiveDM=dmAllowed(p);
  if(!snap.exists())await setDoc(ref,{nickname:p.nickname,role:p.role,canReceiveDM,updatedAt:serverTimestamp()});
  else if(a?.nickname===p.nickname&&(a.role!==p.role||a.canReceiveDM!==canReceiveDM))await updateDoc(ref,{role:p.role,canReceiveDM,updatedAt:serverTimestamp()});
}
export type PublicAuthor={nickname:string;role:string;canReceiveDM?:boolean};
const names:Record<string,[string,string]>={general:['일반회원','Membre général'],member:['정회원','Membre régulier'],special:['특별회원','Membre spécial'],admin:['운영진','Administrateur']};
export type MessageSource={kind:'board'|'learning'|'reply';post:string;comment:string};
const contactChecks=new Map<string,Promise<boolean>>();
export function displayAuthor(target:HTMLElement,info:PublicAuthor,authorUid:string,viewerUid:string,viewerRole:string,viewerDM:boolean,fr:boolean,messageUrl:string,suffix='',db?:Firestore,source?:MessageSource){
  const group=document.createElement('span');group.className='asicc-author';
  const badge=document.createElement('span');badge.className='asicc-role-tag';badge.dataset.role=info.role;badge.textContent=names[info.role]?.[fr?1:0]|| (fr?'Rôle non confirmé':'등급 미확인');
  const n=document.createElement('span');n.textContent=info.nickname;group.append(badge,n);
  target.replaceChildren(group);if(suffix){const date=document.createElement('span');date.className='small muted';date.textContent=suffix;target.append(date);}
  if(!source||!db||!viewerDM||viewerRole==='general'||!authorUid||authorUid===viewerUid)return;
  const key=viewerUid+':'+authorUid;
  if(!contactChecks.has(key))contactChecks.set(key,canContact(db,authorUid).catch(()=>false));
  void contactChecks.get(key)!.then(allowed=>{
    if(!allowed||!group.isConnected)return;
    const menu=document.createElement('details');menu.className='asicc-author-menu';
    const summary=document.createElement('summary');summary.className='asicc-author-name';summary.textContent=info.nickname+' ✉ ▾';
    const link=document.createElement('a');link.textContent=fr?'✉ Envoyer un message':'✉ 쪽지 보내기';link.href=messageUrl+'?'+new URLSearchParams({to:authorUid,kind:source.kind,post:source.post,comment:source.comment}).toString();
    link.setAttribute('aria-label',fr?`Envoyer un message à ${info.nickname}`:`${info.nickname}에게 쪽지 보내기`);
    menu.append(summary,link);menu.addEventListener('click',e=>e.stopPropagation());n.replaceWith(menu);
  });
}
