import {getApps,initializeApp} from 'firebase/app';
import {getAuth,onAuthStateChanged,getIdToken} from 'firebase/auth';
import {getFirestore,collection,doc,getDoc,getDocFromServer,query,where,addDoc,updateDoc,serverTimestamp,onSnapshot} from 'firebase/firestore';
import {firebaseConfig} from '../../firebase-config';
import {formatParisDate} from './display-date';
import {mailboxOrder,mailboxPage} from './mailbox-view';
import {dmAllowed,syncOwnAlias,canContact,type MessageSource} from './member-access';
const root=document.querySelector<HTMLElement>('#message-root');
const fr=root?.dataset.lang==='fr',tr=(ko:string,french:string)=>fr?french:ko;
const by=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T|null;
const show=(id:string,v:boolean)=>{const n=by(id);if(n)n.hidden=!v;};
const text=(id:string,value:string)=>{const n=by(id);if(n)n.textContent=value;};
const result=(id:string,message:string,bad=false)=>{const n=by(id);if(n){n.hidden=!message;n.textContent=message;n.style.color=bad?'#b42318':'#23654b';}};
const node=(tag:string,content?:string)=>{const n=document.createElement(tag);if(content!==undefined)n.textContent=content;return n;};
const app=getApps().find(x=>x.name==='asicc-website')??initializeApp(firebaseConfig,'asicc-website');
const auth=getAuth(app),db=getFirestore(app);
type Message={id:string;senderUid:string;recipientUid:string;body:string;readAt?:unknown;recipientDeletedAt?:unknown;createdAt?:{toDate?:()=>Date}};
let uid='',selected:{to:string;source:MessageSource}|null=null,selectedAllowed=false,checkSerial=0,sending=false,generation=0;
let stopInbox:(()=>void)|undefined,stopSent:(()=>void)|undefined;
const names=new Map<string,Promise<string>>(),marking=new Set<string>();
type BoxName='inbox'|'sent';
const boxes:Record<BoxName,{items:Message[];page:number;open:string|null}>={inbox:{items:[],page:0,open:null},sent:{items:[],page:0,open:null}};
function switchBox(name:BoxName,focus=false){
  for(const key of ['inbox','sent'] as const){const active=key===name,tab=by<HTMLButtonElement>('mail-tab-'+key);show('mail-panel-'+key,active);if(tab){tab.classList.toggle('is-active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus();}}
}
for(const key of ['inbox','sent'] as const){const tab=by<HTMLButtonElement>('mail-tab-'+key);tab?.addEventListener('click',()=>switchBox(key));tab?.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();switchBox(e.key==='Home'?'inbox':e.key==='End'?'sent':key==='inbox'?'sent':'inbox',true);}});}
function resetBoxes(){for(const key of ['inbox','sent'] as const){boxes[key]={items:[],page:0,open:null};by('message-'+key)?.replaceChildren();by('mail-pages-'+key)?.replaceChildren();text('mail-count-'+key,'');}switchBox('inbox');}

const validId=(v:string)=>!!v&&v.length<=1500&&!v.includes('/');
function knownName(id:string){
  if(!validId(id))return Promise.resolve(tr('회원','Membre'));
  if(!names.has(id))names.set(id,getDoc(doc(db,'publicNames',id)).then(s=>String(s.data()?.nickname||tr('회원','Membre'))).catch(()=>tr('회원','Membre')));
  return names.get(id)!;
}
function submitState(){const btn=by<HTMLFormElement>('message-compose')?.querySelector<HTMLButtonElement>('button[type="submit"]');if(btn){btn.disabled=sending||!selectedAllowed;btn.textContent=sending?tr('발송 중…','Envoi…'):tr('쪽지 보내기','Envoyer');}const cancel=by<HTMLButtonElement>('message-cancel');if(cancel)cancel.disabled=sending;}
async function validSource(to:string,source:MessageSource){
  if(!validId(to)||!validId(source.post)||source.comment&&!validId(source.comment))return false;
  if(source.kind==='reply'){
    if(source.comment)return false;
    const snap=await getDocFromServer(doc(db,'privateMessages',source.post)),p=snap.data();return !!p&&p.recipientUid===uid&&p.senderUid===to&&!p.recipientDeletedAt;
  }
  if(source.kind!=='board'&&source.kind!=='learning')return false;
  const col=source.kind==='board'?'boardPosts':'learningResources';
  const post=(await getDocFromServer(doc(db,col,source.post))).data();
  if(!post||(source.kind==='board'?post.deleted===true:post.status!=='published'))return false;
  if(!source.comment)return post.authorUid===to;
  const comment=(await getDocFromServer(doc(db,col,source.post,'comments',source.comment))).data();return !!comment&&comment.deleted!==true&&comment.authorUid===to;
}
async function openCompose(to:string,source:MessageSource){
  if(sending)return;
  const serial=++checkSerial;selected=null;selectedAllowed=false;submitState();show('message-compose',true);
  const body=by<HTMLTextAreaElement>('message-body');if(body)body.value='';
  text('message-recipient-name',tr('확인 중…','Vérification…'));result('message-send-result','');text('message-recipient-state',tr('연락 권한 확인 중…','Vérification du contact…'));
  try{
    const allowed=await canContact(db,to)&&await validSource(to,source),name=allowed?await knownName(to):tr('연락할 수 없는 회원','Contact indisponible');
    if(serial!==checkSerial)return;selectedAllowed=allowed;selected=allowed?{to,source}:null;
    text('message-recipient-name',name);text('message-recipient-state',allowed?'':tr('이 회원에게 쪽지를 보낼 수 없습니다. 운영진에게 문의해 주세요.','Contact indisponible. Contactez l’administration.'));
    if(allowed)body?.focus();
  }catch(e){console.warn(e);if(serial===checkSerial)text('message-recipient-state',tr('연락 권한을 확인하지 못했습니다.','Vérification impossible.'));}
  finally{if(serial===checkSerial)submitState();}
  if(serial===checkSerial)by('message-compose')?.scrollIntoView({block:'start'});
}
by('message-cancel')?.addEventListener('click',()=>{if(sending)return;checkSerial++;selected=null;selectedAllowed=false;show('message-compose',false);submitState();if(location.search)history.replaceState(null,'',location.pathname);});
by<HTMLFormElement>('message-compose')?.addEventListener('submit',async e=>{
  e.preventDefault();if(sending||!selectedAllowed||!selected)return;
  const {to,source}=selected,body=by<HTMLTextAreaElement>('message-body')?.value.trim()||'';
  if(!body||body.length>2000){result('message-send-result',tr('쪽지 내용을 확인해 주세요.','Vérifiez le message.'),true);return;}
  sending=true;submitState();result('message-send-result','');
  try{
    // The server checks both current DM permission and the originating post/reply.
    await addDoc(collection(db,'privateMessages'),{senderUid:uid,recipientUid:to,body,source,createdAt:serverTimestamp(),readAt:null});
    const input=by<HTMLTextAreaElement>('message-body');if(input)input.value='';
    result('message-send-result',tr('쪽지가 발송되었습니다.','Message envoyé.'));
  }catch(err){console.error(err);result('message-send-result',tr('발송하지 못했습니다. 상대방의 권한 또는 게시글을 확인해 주세요.','Envoi impossible. Vérifiez les droits ou la publication.'),true);}
  finally{sending=false;submitState();}
});
function renderMessage(item:Message,box:HTMLElement,incoming:boolean,key:BoxName){
  const entry=node('article');entry.className='mail-entry';
  const partner=incoming?item.senderUid:item.recipientUid;
  const row=node('button') as HTMLButtonElement;row.type='button';row.className='mail-row mail-grid';
  const name=node('span',tr('회원','Membre'));name.className='mail-name';
  void knownName(partner).then(value=>{name.textContent=value;name.title=value;});
  const snippet=node('span',item.body.replace(/\s+/g,' ').trim());snippet.className='mail-snippet';
  const date=node('span',formatParisDate(item.createdAt));date.className='mail-date';row.append(name,snippet,date);
  if(!incoming){const state=node('span',item.readAt?tr('읽음','Lu'):tr('읽지 않음','Non lu'));state.className='mail-read';row.append(state);}
  const wrap=node('div');wrap.className='message-item';wrap.id=`mail-detail-${key}-${item.id}`;wrap.hidden=boxes[key].open!==item.id;
  row.setAttribute('aria-controls',wrap.id);row.setAttribute('aria-expanded',String(!wrap.hidden));
  row.onclick=()=>{const opening=boxes[key].open!==item.id;boxes[key].open=opening?item.id:null;
    // Close the other detail without replacing the focused row or losing keyboard position.
    for(const other of box.querySelectorAll<HTMLButtonElement>('.mail-row')){const detail=document.getElementById(other.getAttribute('aria-controls')||'');const open=other===row&&opening;if(detail)detail.hidden=!open;other.setAttribute('aria-expanded',String(open));}
  };
  const body=node('p',item.body);body.className='message-item-body';wrap.append(body);
  const actions=node('div');actions.className='message-actions';
  if(incoming){
    const reply=node('button',tr('답장','Répondre')) as HTMLButtonElement;reply.type='button';reply.className='btn btn-ghost';reply.onclick=()=>void openCompose(partner,{kind:'reply',post:item.id,comment:''});
    const remove=node('button',tr('삭제','Supprimer')) as HTMLButtonElement;remove.type='button';remove.className='btn btn-ghost member-danger';
    remove.onclick=async()=>{if(!confirm(tr('받은 쪽지함에서 이 쪽지를 삭제할까요?','Supprimer ce message de votre boîte de réception ?')))return;remove.disabled=true;try{await updateDoc(doc(db,'privateMessages',item.id),{recipientDeletedAt:serverTimestamp()});result('message-inbox-result',tr('쪽지가 삭제되었습니다.','Message supprimé.'));}catch(e){console.error(e);result('message-inbox-result',tr('삭제하지 못했습니다.','Suppression impossible.'),true);remove.disabled=false;}};
    actions.append(reply,remove);
  }
  const close=node('button',tr('닫기','Fermer')) as HTMLButtonElement;close.type='button';close.className='btn btn-ghost';close.onclick=()=>{boxes[key].open=null;wrap.hidden=true;row.setAttribute('aria-expanded','false');row.focus();};actions.append(close);wrap.append(actions);entry.append(row,wrap);box.append(entry);
}
function paintList(key:BoxName){const state=boxes[key],incoming=key==='inbox',box=by('message-'+key),nav=by('mail-pages-'+key);if(!box||!nav)return;
  const {page,count,rows}=mailboxPage(state.items,state.page);state.page=page;
  if(!rows.some(x=>x.id===state.open))state.open=null;
  box.replaceChildren();nav.replaceChildren();text('mail-count-'+key,`(${state.items.length})`);
  for(const item of rows)renderMessage(item,box,incoming,key);
  if(!rows.length){const empty=node('p',incoming?tr('받은 쪽지가 없습니다.','Aucun message reçu.'):tr('보낸 쪽지가 없습니다.','Aucun message envoyé.'));empty.className='mail-empty';box.append(empty);}
  if(count>1){const add=(label:string,next:number,disabled:boolean)=>{const button=node('button',label) as HTMLButtonElement;button.type='button';button.className='btn btn-ghost';button.disabled=disabled;button.onclick=()=>{state.page=next;state.open=null;paintList(key);by('mail-tab-'+key)?.focus();};nav.append(button);};add(tr('이전','Précédent'),page-1,page===0);nav.append(node('span',`${page+1} / ${count}`));add(tr('다음','Suivant'),page+1,page===count-1);}
}
function renderList(items:Message[],incoming:boolean){const key=incoming?'inbox':'sent';boxes[key].items=mailboxOrder(items,incoming);paintList(key);}
function markRead(items:Message[],seq:number){for(const item of items){if(item.readAt||item.recipientDeletedAt||marking.has(item.id))continue;marking.add(item.id);
  void updateDoc(doc(db,'privateMessages',item.id),{readAt:serverTimestamp()}).catch(async e=>{
    // Another tab may already have marked the message as read.
    try{const fresh=await getDocFromServer(doc(db,'privateMessages',item.id));if(fresh.data()?.readAt||fresh.data()?.recipientDeletedAt)return;}catch{}
    if(seq===generation){console.warn(e);result('message-inbox-result',tr('일부 쪽지의 읽음 처리를 완료하지 못했습니다. 새로고침해 주세요.','Lecture non enregistrée. Rechargez la page.'),true);}
  }).finally(()=>marking.delete(item.id));}}
function stop(){generation++;checkSerial++;stopInbox?.();stopSent?.();stopInbox=stopSent=undefined;}
function denied(){stop();show('message-content',false);show('message-minor',true);resetBoxes();text('message-state','');}
function watch(){const seq=++generation;
  const fail=(e:any)=>{if(seq!==generation)return;console.warn(e);if(e.code==='permission-denied')denied();else text('message-state',tr('쪽지함을 불러오지 못했습니다. 새로고침해 주세요.','Chargement impossible. Rechargez la page.'));};
  stopInbox=onSnapshot(query(collection(db,'privateMessages'),where('recipientUid','==',uid)),{includeMetadataChanges:true},snap=>{if(seq!==generation)return;const items=snap.docs.map(d=>({id:d.id,...d.data()} as Message));renderList(items,true);if(!snap.metadata.fromCache)markRead(items,seq);},fail);
  stopSent=onSnapshot(query(collection(db,'privateMessages'),where('senderUid','==',uid)),snap=>{if(seq===generation)renderList(snap.docs.map(d=>({id:d.id,...d.data()} as Message)),false);},fail);
}
async function init(user:NonNullable<typeof auth.currentUser>){stop();const seq=generation;names.clear();marking.clear();resetBoxes();selected=null;selectedAllowed=false;show('message-compose',false);show('message-content',false);show('message-minor',false);submitState();
  try{await user.reload();await getIdToken(user,true);if(!user.emailVerified)throw Error('unverified');
    const me=await getDoc(doc(db,'members',user.uid));if(seq!==generation)return;if(!me.exists()||me.data().status!=='approved')throw Error('inactive');uid=user.uid;
    if(!dmAllowed(me.data())){denied();return;}
    void syncOwnAlias(db,uid,me.data()).catch(console.warn);
    const setting=await getDoc(doc(db,'siteSettings','messaging'));if(seq!==generation)return;if(setting.data()?.enabled!==true){denied();return;}
    show('message-content',true);text('message-state','');watch();
    const params=new URLSearchParams(location.search),to=params.get('to'),kind=params.get('kind'),post=params.get('post'),comment=params.get('comment')||'';
    if(to&&post&&(kind==='board'||kind==='learning'))void openCompose(to,{kind,post,comment});
    else if(to)text('message-state',tr('게시글 작성자 또는 받은 쪽지에서 상대를 선택해 주세요.','Choisissez un auteur ou répondez à un message reçu.'));
  }catch(e){if(seq===generation){console.error(e);text('message-state',tr('쪽지함을 불러오지 못했습니다.','Messagerie inaccessible.'));}}
}
if(import.meta.env.PUBLIC_ASICC_MEMBERS_ENABLED==='true')onAuthStateChanged(auth,user=>{if(!user){stop();location.replace(root?.dataset.loginUrl||'/');return;}void init(user);});
window.addEventListener('pagehide',stop);window.addEventListener('pageshow',e=>{if(e.persisted&&auth.currentUser)void init(auth.currentUser);});
