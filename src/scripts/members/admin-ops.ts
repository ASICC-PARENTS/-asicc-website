/** Independent admin settings UI: never touches existing membership moderation code. */
import {getApps,initializeApp} from 'firebase/app';
import {getAuth,onAuthStateChanged,getIdToken} from 'firebase/auth';
import {getFirestore,collection,doc,getDoc,getDocs,query,where,setDoc,serverTimestamp} from 'firebase/firestore';
import {firebaseConfig} from '../../firebase-config';
const root=document.getElementById('asicc-admin');const fr=root?.dataset.lang==='fr';
const tr=(ko:string,french:string)=>fr?french:ko;
const by=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T|null;
const say=(v:string,bad=false)=>{const n=by<HTMLElement>('ops-status');if(n){n.textContent=v;n.style.color=bad?'#b42318':'';}};
const app=getApps().find(a=>a.name==='asicc-website')??initializeApp(firebaseConfig,'asicc-website');
const auth=getAuth(app),db=getFirestore(app);
let uid='',admin=false;
const initialBoard=[
  {id:'free',ko:'자유',fr:'Libre'}, {id:'give',ko:'무료나눔',fr:'Dons'},
  {id:'market',ko:'중고거래',fr:'Occasion'}, {id:'info',ko:'정보',fr:'Information'},
  {id:'question',ko:'질문',fr:'Question'}
];
const initialResources=[
  {id:'kindergarten',ko:'유치원',fr:'Maternelle'}, {id:'elementary',ko:'초등학교',fr:'Élémentaire'},
  {id:'middle',ko:'중학교',fr:'Collège'}, {id:'other',ko:'기타',fr:'Autres'}
];
type Category={id:string;ko:string;fr:string};
const stringify=(a:Category[])=>a.map(c=>`${c.id} | ${c.ko} | ${c.fr}`).join('\n');
const parse=(text:string)=>{
  const values=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(line=>{
    const [id,ko,fr,...extra]=line.split('|').map(s=>s.trim());
    if(extra.length||!id||!ko||!fr||!/^[a-z][a-z0-9-]{1,23}$/.test(id)||ko.length>25||fr.length>50)throw Error(`Invalid category: ${line}`);
    return {id,ko,fr};
  });
  if(values.length<1||values.length>20||new Set(values.map(v=>v.id)).size!==values.length)throw Error('Duplicate / invalid category IDs');
  return values;
};
async function readSettings(){
  for(const [docId,control,initial] of [
    ['boardCategories','ops-board-categories',initialBoard],['resourceCategories','ops-resource-categories',initialResources]
  ] as const){
    const snap=await getDoc(doc(db,'siteSettings',docId));const data=snap.data()?.items;
    const rows=(Array.isArray(data)&&data.length?data:initial).filter(x=>docId!=='resourceCategories'||!['common','general'].includes(x.id));
    const n=by<HTMLTextAreaElement>(control);if(n)n.value=stringify(rows);
  }
  const gallery=await getDoc(doc(db,'siteSettings','gallery'));
  const messaging=await getDoc(doc(db,'siteSettings','messaging'));
  const g=by<HTMLInputElement>('ops-gallery-open');if(g)g.checked=gallery.exists()&&gallery.data().isOpen===true;
  const m=by<HTMLInputElement>('ops-messaging-open');if(m)m.checked=messaging.exists()&&messaging.data().enabled===true;
}
async function saveCategories(kind:'board'|'resource'){
  if(!admin)return;
  const id=kind==='board'?'boardCategories':'resourceCategories';
  const control=kind==='board'?'ops-board-categories':'ops-resource-categories';
  try{
    const items=parse(by<HTMLTextAreaElement>(control)?.value||'');
    if(kind==='resource'&&items.some(x=>['common','general'].includes(x.id)))throw Error('공통·일반 분류는 제외하고 기타를 사용해 주세요.');
    if(kind==='board'&&(!items.some(x=>x.id==='info')||!items.some(x=>x.id==='question')))throw Error('정보 또는 질문 분류를 유지해 주세요.');
    await setDoc(doc(db,'siteSettings',id),{items,keys:items.map(x=>x.id),updatedBy:uid,updatedAt:serverTimestamp()});
    say(tr('분류 설정을 저장했습니다. 회원 화면을 새로고침하면 반영됩니다.','Catégories enregistrées. Actualisez le site.'));
  }catch(e){console.error(e);say(tr('형식 또는 권한 오류: ','Erreur : ')+String(e),true);}
}
by<HTMLButtonElement>('ops-save-board-categories')?.addEventListener('click',()=>void saveCategories('board'));
by<HTMLButtonElement>('ops-save-resource-categories')?.addEventListener('click',()=>void saveCategories('resource'));
by<HTMLButtonElement>('ops-save-gallery')?.addEventListener('click',async()=>{
  if(!admin)return;const isOpen=by<HTMLInputElement>('ops-gallery-open')?.checked===true;
  if(isOpen&&!confirm(tr('갤러리를 회원에게 공개합니다. 초상권 정책 확정과 원본 보관 준비를 확인했나요?','Confirmez-vous l’ouverture de la galerie après vérification des autorisations ?')))return;
  try{await setDoc(doc(db,'siteSettings','gallery'),{isOpen,updatedBy:uid,updatedAt:serverTimestamp()});say(tr('갤러리 설정을 저장했습니다.','Galerie enregistrée.'));}catch(e){console.error(e);say(tr('저장 실패: Firebase 규칙을 확인하세요.','Enregistrement impossible.'),true);}
});
by<HTMLButtonElement>('ops-save-toggles')?.addEventListener('click',async()=>{
  if(!admin)return;const enabled=by<HTMLInputElement>('ops-messaging-open')?.checked===true;
  try{await setDoc(doc(db,'siteSettings','messaging'),{enabled,updatedBy:uid,updatedAt:serverTimestamp()});window.dispatchEvent(new CustomEvent('asicc-messaging-setting',{detail:enabled}));say(tr('쪽지 설정을 저장했습니다.','Messagerie enregistrée.'));}catch(e){console.error(e);say(tr('저장 실패: Firebase 규칙을 확인하세요.','Enregistrement impossible.'),true);}
});
async function showInbox(){
  const target=by<HTMLElement>('ops-inbox');if(!target)return;
  target.replaceChildren();
  try{
    const [upgrades,suggestions,images,withdrawals,nameChanges]=await Promise.all([
      getDocs(collection(db,'upgradeRequests')),
      getDocs(collection(db,'suggestions')),
      getDocs(query(collection(db,'galleryItems'),where('status','==','pending'))),
      getDocs(collection(db,'memberWithdrawalRequests')),
      getDocs(collection(db,'nameChangeRequests'))
    ]);
    const lists=[
      {title:tr('승급 심사','Demandes de statut'),count:upgrades.docs.filter(d=>d.data().status==='pending').length,href:'#requests-heading'},
      {title:tr('건의·문의','Suggestions'),count:suggestions.docs.filter(d=>['received','reviewing'].includes(d.data().status)).length,href:'#suggestions-heading'},
      {title:tr('사진 검토','Médias à vérifier'),count:images.docs.filter(d=>d.data().status==='pending').length,href:'../gallery/?view=review'},
      {title:tr('탈퇴 요청','Demandes de départ'),count:withdrawals.docs.filter(d=>d.data().status==='pending').length,href:'#members-heading'},
      {title:tr('실명 변경 요청','Corrections de nom'),count:nameChanges.docs.filter(d=>d.data().status==='pending').length,href:'#name-requests-heading'}
    ];
    for(const item of lists){const a=document.createElement('a');a.href=item.href;a.className='btn btn-ghost';a.textContent=`${item.title}: ${item.count}`;target.append(a);}
  }catch(e){console.error(e);target.textContent=tr('요청 목록을 읽지 못했습니다.','Impossible de charger les demandes.');}
}
if(import.meta.env.PUBLIC_ASICC_MEMBERS_ENABLED==='true')onAuthStateChanged(auth,async user=>{
  if(!user)return;
  try{await user.reload();await getIdToken(user,true);if(!user.emailVerified)return;
    const snap=await getDoc(doc(db,'members',user.uid));if(!snap.exists()||snap.data().status!=='approved'||snap.data().role!=='admin')return;
    uid=user.uid;admin=true;await readSettings();await showInbox();
  }catch(e){console.error(e);say(tr('운영 설정을 표시할 수 없습니다.','Paramètres indisponibles.'),true);}
});
