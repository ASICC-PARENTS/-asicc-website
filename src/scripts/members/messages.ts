import {getApps,initializeApp} from 'firebase/app';
import {getAuth,onAuthStateChanged,getIdToken} from 'firebase/auth';
import {getFirestore,collection,doc,getDoc,getDocs,query,where,addDoc,updateDoc,serverTimestamp,onSnapshot} from 'firebase/firestore';
import {firebaseConfig} from '../../firebase-config';
import {BOARD_PHOTO_API} from '../../config/board-photos';
import {dmAllowed,syncOwnAlias,canContact,projectException} from './member-access';
const root=document.querySelector<HTMLElement>('#message-root');
const fr=root?.dataset.lang==='fr';const tr=(ko:string,french:string)=>fr?french:ko;
const by=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T|null;
const show=(id:string,v:boolean)=>{const n=by<HTMLElement>(id);if(n)n.hidden=!v;};
const say=(msg:string,bad=false)=>{const n=by<HTMLElement>('message-state');if(n){n.textContent=msg;n.style.color=bad?'#b42318':'';}};
const node=(tag:string,content?:string)=>{const n=document.createElement(tag);if(content!==undefined)n.textContent=content;return n;};
const app=getApps().find(x=>x.name==='asicc-website')??initializeApp(firebaseConfig,'asicc-website');
const auth=getAuth(app),db=getFirestore(app);let uid='',role='';
let recipients:{uid:string;nickname:string;role:string;canReceiveDM:boolean}[]=[];let selectedAllowed=false,checkSerial=0,sending=false,projectLimited=false;
const names=new Map<string,string>();
const knownName=(id:string)=>names.get(id)||tr('회원','Membre');
const openedMessages=new Set<string>();
function fillRecipients(){const select=by<HTMLSelectElement>('message-recipient');if(!select)return;
  const q=by<HTMLInputElement>('message-search')?.value.toLocaleLowerCase().trim()||'';const current=select.value;
  select.replaceChildren();const opt=node('option',tr('회원 선택','Sélectionner un membre')) as HTMLOptionElement;opt.value='';select.append(opt);
  for(const x of recipients.filter(x=>x.uid!==uid&&(role==='admin'||role==='general'&&x.role==='admin'||['member','special'].includes(role)&&['member','special','admin'].includes(x.role))&&x.nickname.toLocaleLowerCase().includes(q)).slice(0,200)){
    const o=node('option',x.nickname) as HTMLOptionElement;o.value=x.uid;select.append(o);
  }
  if([...select.options].some(o=>o.value===current))select.value=current;
  void checkRecipient();
}
function submitState(){const btn=by<HTMLFormElement>('message-compose')?.querySelector<HTMLButtonElement>('button[type="submit"]');if(btn)btn.disabled=sending||!selectedAllowed;}
async function checkRecipient(){
  const serial=++checkSerial,to=by<HTMLSelectElement>('message-recipient')?.value||'';selectedAllowed=false;submitState();
  const label=by<HTMLElement>('message-recipient-state');if(label)label.textContent=to?tr('연락 권한 확인 중…','Vérification du contact…'):'';if(!to)return;
  try{const allowed=await canContact(db,to);if(serial!==checkSerial)return;selectedAllowed=allowed;
    if(label)label.textContent=allowed?'':tr('이 회원과 쪽지를 교환할 권한이 없거나 쪽지 기능이 꺼져 있습니다. 운영진에게 문의해 주세요.','Ce contact n’est pas autorisé ou la messagerie est désactivée. Contactez l’administration.');
  }catch(e){console.warn(e);if(serial===checkSerial&&label)label.textContent=tr('연락 권한을 확인하지 못했습니다. 다시 선택해 주세요.','Vérification impossible. Sélectionnez à nouveau.');}
  finally{if(serial===checkSerial)submitState();}
}
by<HTMLSelectElement>('message-recipient')?.addEventListener('change',()=>void checkRecipient());
function renderMessage(item:{id:string;senderUid:string;recipientUid:string;body:string;readAt?:unknown;createdAt?:{toDate?:()=>Date}},box:HTMLElement,incoming:boolean){
  const wrap=node('article');if(incoming&&!item.readAt)wrap.className='asicc-message-unread';wrap.style.cssText='padding:12px;border:1px solid #dce0e7;border-radius:10px;display:grid;gap:8px';
  const header=node('strong',incoming?`${tr('보낸 사람','Expéditeur')}: ${knownName(item.senderUid)}`:`${tr('받는 사람','Destinataire')}: ${knownName(item.recipientUid)}`);
  if(incoming&&!item.readAt){const n=node('span','N');n.className='asicc-unread';header.append(' ',n);}if(incoming){const details=document.createElement('details');const summary=document.createElement('summary');summary.append(header);details.append(summary,node('p',item.body));details.open=openedMessages.has(item.id);summary.addEventListener('click',()=>{if(details.open){openedMessages.delete(item.id);return;}openedMessages.add(item.id);if(!item.readAt)void updateDoc(doc(db,'privateMessages',item.id),{readAt:serverTimestamp()}).catch(e=>{console.error(e);say(tr('읽음 처리에 실패했습니다.','Lecture non enregistrée.'),true);});});wrap.append(details);}else wrap.append(header,node('p',item.body));const date=node('span',item.createdAt?.toDate?.().toLocaleString(fr?'fr-FR':'ko-KR')||'');date.className='small muted';wrap.append(date);
  if(!incoming){const state=node('span',item.readAt?tr('읽음','Lu'):tr('읽지 않음','Non lu'));state.className='small muted';wrap.append(state);}
  if(incoming){
    const actions=node('div');actions.className='row gap-8';
    if(!item.readAt){const read=node('button',tr('읽음 처리','Marquer comme lu')) as HTMLButtonElement;read.type='button';read.className='btn btn-ghost';
      read.onclick=async()=>{try{await updateDoc(doc(db,'privateMessages',item.id),{readAt:serverTimestamp()});await refresh();}catch(e){console.error(e);say(tr('읽음 처리에 실패했습니다.','Impossible de marquer comme lu.'),true);}};actions.append(read);}
    const report=node('button',tr('신고','Signaler')) as HTMLButtonElement;report.type='button';report.className='btn btn-ghost';
    report.onclick=()=>{if(confirm(tr('운영진에게 이 쪽지를 신고할까요?','Signaler ce message ?')))void reportMessage(item);};actions.append(report);wrap.append(actions);
  }
  box.append(wrap);
}
async function reportMessage(item:{id:string;senderUid:string;body:string}){
  try{
    const record=await addDoc(collection(db,'suggestions'),{uid,category:'confidential',subject:`쪽지 신고 ${item.id}`.slice(0,120),body:`쪽지 ID: ${item.id}\n발신 UID: ${item.senderUid}\n신고 내용: ${item.body}`.slice(0,3000),status:'received',createdAt:serverTimestamp()});
    const api=BOARD_PHOTO_API.trim().replace(/\/$/,'');
    if(api)try{const token=await getIdToken(auth.currentUser!);const response=await fetch(api+'/api/notify',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({kind:'suggestion',id:record.id})});if(!response.ok)console.warn('Message report email pending',response.status);}catch(error){console.warn('Notification service unavailable',error);}
    say(tr('신고가 접수되었습니다.','Signalement reçu.'));
  }
  catch(e){console.error(e);say(tr('신고에 실패했습니다.','Signalement impossible.'),true);}
}
async function refresh(){
  const inbox=by<HTMLElement>('message-inbox'),sent=by<HTMLElement>('message-sent');if(!inbox||!sent)return;
  const a=await getDocs(query(collection(db,'privateMessages'),where('recipientUid','==',uid)));
  const b=await getDocs(query(collection(db,'privateMessages'),where('senderUid','==',uid)));
  inbox.replaceChildren();sent.replaceChildren();const unread=a.docs.filter(d=>!d.data().readAt).length;const count=by<HTMLElement>('message-unread-count');if(count){count.hidden=!unread;count.textContent=`N ${unread}`;}
  const ordered=(x:typeof a)=>x.docs.map(d=>({id:d.id,...d.data()} as {id:string;senderUid:string;recipientUid:string;body:string;readAt?:unknown;createdAt?:{toDate?:()=>Date}}))
    .sort((l,r)=>(r.createdAt?.toDate?.()?.getTime()||0)-(l.createdAt?.toDate?.()?.getTime()||0)).slice(0,100);
  for(const x of ordered(a))renderMessage(x,inbox,true);for(const x of ordered(b))renderMessage(x,sent,false);
  if(!a.size)inbox.textContent=tr('받은 쪽지가 없습니다.','Aucun message.');
  if(!b.size)sent.textContent=tr('보낸 쪽지가 없습니다.','Aucun message.');
}
by<HTMLInputElement>('message-search')?.addEventListener('input',fillRecipients);
by<HTMLFormElement>('message-compose')?.addEventListener('submit',async e=>{e.preventDefault();
  const to=by<HTMLSelectElement>('message-recipient')?.value||'',body=by<HTMLTextAreaElement>('message-body')?.value.trim()||'';
  if(sending||!selectedAllowed)return say(tr('수신자의 쪽지 권한을 먼저 확인해 주세요.','Vérifiez d’abord le destinataire.'),true);
  if(!to||!body||body.length>2000)return say(tr('수신자와 내용을 확인해 주세요.','Vérifiez le destinataire et le message.'),true);
  sending=true;submitState();
  try{await addDoc(collection(db,'privateMessages'),{senderUid:uid,recipientUid:to,body,createdAt:serverTimestamp(),readAt:null});
    by<HTMLFormElement>('message-compose')?.reset();selectedAllowed=false;void checkRecipient();say(tr('쪽지가 발송되었습니다.','Message envoyé.'));await refresh().catch(error=>{console.warn(error);say(tr('쪽지는 발송되었지만 목록 갱신에 실패했습니다. 새로고침해 주세요.','Message envoyé, actualisation impossible. Rechargez la page.'),true);});
  }catch(err){console.error(err);say(tr('발송할 수 없습니다. 수신자의 권한 또는 전체 쪽지 설정이 변경되었는지 확인해 주세요.','Envoi refusé. Vérifiez les droits du destinataire et le réglage global.'),true);}finally{sending=false;submitState();}
});
if(import.meta.env.PUBLIC_ASICC_MEMBERS_ENABLED==='true')onAuthStateChanged(auth,async user=>{
  if(!user){location.replace(root?.dataset.loginUrl||'/');return;}
  try{await user.reload();await getIdToken(user,true);if(!user.emailVerified)throw Error('unverified');
    const me=await getDoc(doc(db,'members',user.uid));if(!me.exists()||me.data().status!=='approved')throw Error('inactive');
    uid=user.uid;role=me.data().role;projectLimited=projectException(me.data());
    if(!dmAllowed(me.data())){show('message-minor',true);show('message-content',false);say(tr('개인 쪽지 이용이 비활성화된 계정입니다. 운영진에게 문의해 주세요.','Compte élève ou type inconnu : messagerie indisponible.'));return;}
    await syncOwnAlias(db,uid,me.data()).catch(console.warn);
    const setting=await getDoc(doc(db,'siteSettings','messaging'));
    if(!setting.exists()||setting.data().enabled!==true){say(tr('쪽지 기능은 운영진이 준비 중입니다.','Messagerie en préparation.'));return;}
    const dir=await getDocs(collection(db,'publicNames'));
    recipients=dir.docs.map(d=>({uid:d.id,nickname:String(d.data().nickname||''),role:String(d.data().role||''),canReceiveDM:d.data().canReceiveDM===true})).filter(x=>!!x.nickname&&x.canReceiveDM);
    for(const entry of dir.docs){if(typeof entry.data().nickname==='string')names.set(entry.id,entry.data().nickname);}
    if(role==='admin'){
      const active=await getDocs(collection(db,'members'));
      recipients=active.docs.map(d=>({uid:d.id,nickname:String(d.data().nickname||d.data().name||''),role:String(d.data().role||''),canReceiveDM:dmAllowed(d.data())})).filter(x=>!!x.nickname&&x.canReceiveDM);
      for(const r of recipients)names.set(r.uid,r.nickname);
    }
    if(projectLimited){
      // The project code remains private. Filter contacts using the server's pair checks.
      const candidates=recipients.filter(x=>x.uid!==uid&&['member','special','admin'].includes(x.role));const eligible:typeof recipients=[];
      for(let start=0;start<candidates.length;start+=10){const slice=candidates.slice(start,start+10);const flags=await Promise.all(slice.map(x=>canContact(db,x.uid)));eligible.push(...slice.filter((_,i)=>flags[i]));}
      recipients=eligible;
    }
    const requested=new URLSearchParams(location.search).get('to');if(requested){const i=recipients.findIndex(x=>x.uid===requested);if(i>0)recipients.unshift(recipients.splice(i,1)[0]);}fillRecipients();const select=by<HTMLSelectElement>('message-recipient');if(requested&&select&&[...select.options].some(o=>o.value===requested)){select.value=requested;void checkRecipient();by<HTMLTextAreaElement>('message-body')?.focus();}else if(requested)say(tr('이 회원에게 쪽지를 보낼 수 없습니다.','Destinataire indisponible.'),true);show('message-content',true);
    by<HTMLElement>('message-advice')!.textContent=projectLimited?tr('프로젝트 승인 범위 내에서만 쪽지를 주고받을 수 있습니다.','Échanges limités au projet approuvé et aux administrateurs.'):role==='general'?tr('일반회원은 운영진에게만 발송할 수 있습니다. 운영진의 닉네임을 선택해 주세요.','Les membres généraux peuvent écrire uniquement aux administrateurs.'):tr('허용된 회원 간 연락에만 사용해 주세요.','Réservé aux échanges entre contacts autorisés.');
    await refresh();if(!new URLSearchParams(location.search).get('to')||by<HTMLSelectElement>('message-recipient')?.value)say('');
    const stop=onSnapshot(query(collection(db,'privateMessages'),where('recipientUid','==',uid)),()=>{void refresh().catch(console.warn);},error=>{console.warn(error);if(error.code==='permission-denied'){by('message-inbox')?.replaceChildren();by('message-sent')?.replaceChildren();show('message-content',false);show('message-minor',true);say(tr('쪽지 권한이 변경되었습니다. 새로고침해 주세요.','Vos droits ont changé. Rechargez la page.'),true);}});window.addEventListener('pagehide',stop,{once:true});
  }catch(e){console.error(e);say(tr('쪽지함을 불러오지 못했습니다.','Messagerie inaccessible.'),true);}
});
