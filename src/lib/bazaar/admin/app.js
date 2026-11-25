import '../shop-view.css';
import {bindStorageLabels,changeCartQuantity,quantityCap,renderShopEvent,renderShopProducts} from '../shop-view';
import {onAuthStateChanged} from 'firebase/auth';
import {adminAction,bazaarAuth,showBazaarTestLogin} from '../api';
import {estimateEvent,eventFormFields,eventViewModel,parisToIso,productOrderSummary,productPayload,productViewModel,validManualPhone} from './data';
import {mountMailManager,showOrderMail} from './mail';
import {observeAdminLocale} from './i18n';
import {validRefundIban} from '../../../../firebase-functions-bazaar/bazaar/iban.mjs';
import {evidenceControls} from './evidence';

(function(){'use strict';
const root=document.querySelector('#approved-admin');
const page=root.dataset.page,fr=root.dataset.lang==='fr',$=s=>root.querySelector(s),app=$('#app');
observeAdminLocale(root,fr);
bindStorageLabels(root);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>(Number(n)||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
const clone=x=>structuredClone(x);
const model={catalog:[],active:null,draft:null,drafts:[],past:[],events:[],view:'empty',history:0};
let catalogRevision=0,busy=false,authVersion=0;
const params=new URLSearchParams(location.search);
const selectedEvent=()=>model.view==='past'?model.past[model.history]:model.view==='draft'?model.draft:model.view==='active'?model.active:null;
const current=()=>selectedEvent()?.status==='past';
const request=(op,fields={})=>adminAction({op,...fields});
const newId=()=> 'custom-'+crypto.randomUUID().replaceAll('-','');
function url(screen='',eventId=selectedEvent()?.id) {
 const path=root.dataset.base+(screen?screen+'/':'');
 return path+(eventId?'?event='+encodeURIComponent(eventId):'');
}
function link(screen){return esc(url(screen));}
async function run(button, work){
 if(busy)return;
 busy=true;
 if(button)button.disabled=true;
 try{await work();}catch(error){
  const message=error.message||'처리하지 못했습니다. 다시 시도해 주세요.';
  if(!$('#modal').hidden){
   const body=$('#modal-foot');let issue=body.querySelector('[data-operation-error]');
   if(!issue){issue=document.createElement('p');issue.className='notice warning';issue.dataset.operationError='';issue.setAttribute('role','alert');body.prepend(issue);}
   issue.textContent=message;
  }else alert(message);
 }
 finally{busy=false;if(button)button.disabled=false;}
}
async function load(){
 const version=authVersion;
 const listing=await request('listEvents');
 const [catalog,latest]=await Promise.all([request('getCatalog'),request('dashboard')]);
 if(version!==authVersion)return;
 model.catalog=catalog.items.map(productViewModel);catalogRevision=catalog.revision;
 latestEventId=latest.event.eventId;
 model.active=latest.event.status==='published'?eventViewModel(latest.event,latest.products,latest.orders):null;
 model.events=listing.events;
 model.past=listing.events.filter(e=>e.status==='closed').map(e=>({id:e.id,name:e.nameKo,round:e.serial}));
 model.drafts=listing.drafts;
 const id=params.get('event');
 const past=model.past.findIndex(e=>e.id===id);
 const draft=model.drafts.find(e=>e.id===id);
 if(past>=0){
  const record=await request('dashboard',{eventId:id});
  if(version!==authVersion)return;
  model.past[past]=eventViewModel(record.event,record.products,record.orders);
  model.history=past;model.view='past';
 }else if(draft){
  const {draft:record}=await request('getDraft',{id});
  if(version!==authVersion)return;
  model.draft=eventViewModel(record.event,record.items);
  model.draft.updatedAt=record.updatedAt;model.view='draft';
 }else if(id&&id!==model.active?.id){
  throw new Error('선택한 행사를 찾을 수 없습니다. 관리자 메인에서 다시 선택해 주세요.');
 }else model.view=model.active?'active':'empty';
 if(page==='settlement'&&selectedEvent()?.status!=='draft'&&selectedEvent()){
  const {documents}=await request('listPurchaseOrders',{eventId:selectedEvent().id});
  if(version!==authVersion)return;
  for(const doc of documents){
   selectedEvent().poDrafts[doc.vendor]=doc.lines.map(({priceCents,amountCents,...line})=>({...line,price:priceCents/100,amount:amountCents/100}));
   selectedEvent().poMeta[doc.vendor]={...doc.info,revision:doc.revision,confirmed:doc.confirmed,savedAt:doc.updatedAt};
  }
  eventFinancialRecord=await request('eventFinancials',{eventId:selectedEvent().id});
 }
 if(page==='settlement'&&selectedEvent()?.status==='draft')eventFinancialRecord=await request('eventFinancials',{eventId:selectedEvent().id,planned:true});
 $('#admin-actions').hidden=false;
 if(page==='orders'&&store.loadedOrderView!==ordersStateKey()){
  store.loadedOrderView=ordersStateKey();
  try{const saved=JSON.parse(localStorage.getItem(ordersStateKey())||'{}');store.search=saved.search||'';store.orderFilter=saved.filter||'all';store.sortKey=saved.key||'date';store.sortAsc=saved.asc===true;}catch{}
 }
 rerender();
}
const store={search:'',orderFilter:'all',orderSort:'new',orderView:'orders',productOrderSort:'name',settleScope:'confirmed',vendor:'업체 A',
 get catalog(){return model.catalog;},get products(){return selectedEvent()?.products??[];},
 get orders(){return selectedEvent()?.orders??[];},get poDrafts(){return selectedEvent()?.poDrafts??{};},
 get mode(){return model.view;},set mode(value){model.view=value==='active'&&!model.active?'empty':value;},
 get history(){return model.history;},
};
let eventFinancialRecord={revision:0,expenses:[],finalizedAt:null};
const finance=n=>Math.round((Number(n)||0)*100)/100;
const defaults=p=>({...clone(p),boxes:'',limitMode:'unlimited',manualLimit:''});
const allocated=p=>store.orders.filter(o=>o.status!=='canceled').reduce((sum,o)=>sum+o.items.reduce((n,i)=>n+(i[3]===p.id?Number(i[1]):0),0),0);
const statuses={unpaid:['송금 신고 없음','unpaid'],reported:['송금 신고 접수','reported'],partial:[fr?'Paiement partiel':'부분 입금','reported'],confirmed:['입금 확인 완료','confirmed'],canceled:['취소','canceled']};
function total(o){return o.payment?o.payment.due/100:o.items.reduce((s,x)=>s+x[1]*x[2],0)}
function stats(){let valid=store.orders.filter(x=>x.status!=='canceled'),confirmed=store.orders.filter(x=>x.status==='confirmed');return [['총 주문',valid.length+'건'],['총 주문금액',money(valid.reduce((s,x)=>s+total(x),0))],['입금 확인액',money(confirmed.reduce((s,x)=>s+total(x),0))],['입금 확인 대기',store.orders.filter(x=>['reported','unpaid'].includes(x.status)).length+'건']];}
function metrics(xs){return '<div class="metrics">'+xs.map(x=>'<div class="metric"><span>'+x[0]+'</span><strong>'+x[1]+'</strong>'+(x[2]?'<small>'+x[2]+'</small>':'')+'</div>').join('')+'</div>'}
const dateLabel=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat(fr?'fr-FR':'ko-KR',{
 timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short',hourCycle:'h23'
}).format(new Date(value)):'—';
const publicEventPath=id=>root.dataset.base.replace(/admin\/$/,'')+'?event='+encodeURIComponent(id);
function eventHead(e=selectedEvent(),summary=false){
 if(!e)return '';
 const draft=e.status==='draft',past=e.status==='past';
 const label=draft?(fr?'Brouillon':'임시저장'):past?(fr?'Terminé':'종료'):(fr?'Publié':'발행');
 const title=esc((fr?e.raw.nameFr:e.raw.nameKo)||e.name);
 const control=(action,ko,french,style='neutral')=>'<button class="btn '+style+'" data-action="'+action+'">'+(fr?french:ko)+'</button>';
 const actions=summary?'':(
  (past?'':control('edit-draft','행사 정보 수정','Modifier les informations'))+
  control('mail-settings','이메일 설정','Paramètres des e-mails')+
  '<a class="btn neutral" href="'+esc(publicEventPath(e.id))+'" target="_blank" rel="noopener">'+(fr?'Voir la page de commande':'구매페이지 보기')+'</a>'+
  '<details class="event-link-menu"><summary class="btn neutral">'+(fr?'Copier un lien':'링크 복사')+'</summary><div class="actions">'+control('copy-banner','배너 링크 복사','Copier le lien de la bannière')+control('copy-event','공개 주소 복사','Copier l’adresse publique')+'</div></details>'+
  (past?control('closed-export','행사 자료 다운로드','Télécharger les données')+control('closed-archive','보관 / 복원','Archiver / restaurer')+control('closed-delete','행사 기록 삭제','Supprimer les données','danger'):'')+
  (draft?control('delete-draft','임시저장 삭제','Supprimer le brouillon','danger'):past?'':'<span class="event-end-action">'+control('end-event','행사 종료','Clore le bazar','neutral')+'</span>'));
 return '<section class="panel pad event-header">'+(summary?'':'<a class="event-back" href="'+esc(url('',null))+'">← '+(fr?'Retour aux bazars':'바자회 목록으로 돌아가기')+'</a>')+'<div class="toolbar"><h2>'+title+'</h2><span class="status">'+label+'</span></div>'+
  '<div class="info-row"><span>'+(fr?'Clôture des commandes':'주문 마감')+' <b>'+esc(dateLabel(e.raw.orderCutoff))+'</b></span><span>'+
  (fr?'Date limite de virement':'송금 마감')+' <b>'+esc(dateLabel(e.raw.transferCutoff))+'</b></span></div>'+
  (summary?metrics(stats()):'<div class="actions event-actions">'+actions+'</div><p role="status" data-copy-status></p>')+'</section>';
}
function tabs(){return '<nav class="tabs" aria-label="관리 탭"><a href="'+link('products')+'" class="'+(page==='products'?'active':'')+'">제품관리</a><a href="'+link('orders')+'" class="'+(page==='orders'?'active':'')+'">주문관리</a><a href="'+link('settlement')+'" class="'+(page==='settlement'?'active':'')+'">정산관리</a></nav>'}
function banner(msg,cls=''){return '<div class="notice '+cls+'">'+msg+'</div>'}
function modal(title,caption,body,foot){$('#modal-title').textContent=title;$('#modal-caption').textContent=caption||'';$('#modal-body').innerHTML=body;$('#modal-foot').innerHTML=foot||'<button class="btn neutral" data-action="close">닫기</button>';const footer=$('#modal-foot');const primary=[...footer.children].filter(el=>el.matches('.primary'));footer.prepend(...primary);$('#modal').hidden=false;if($('#column-list'))enableColumnDrag();}
const modalWrap=$('#modal'),modalPanel=modalWrap.querySelector('.modal'),modalHandle=modalPanel.querySelector('.modal-h');
let dialogDrag;
modalHandle.addEventListener('pointerdown',event=>{
 if(event.button!==0||!matchMedia('(min-width: 781px)').matches||event.target.closest('button,a,input,select,textarea'))return;
 const box=modalPanel.getBoundingClientRect();
 dialogDrag={id:event.pointerId,dx:event.clientX-box.left,dy:event.clientY-box.top};
 modalHandle.setPointerCapture(event.pointerId);
 event.preventDefault();
});
modalHandle.addEventListener('pointermove',event=>{
 if(dialogDrag?.id!==event.pointerId)return;
 const width=modalPanel.offsetWidth,height=modalPanel.offsetHeight;
 modalPanel.style.left=Math.min(innerWidth-100,Math.max(100-width,event.clientX-dialogDrag.dx))+'px';
 modalPanel.style.top=Math.min(innerHeight-60,Math.max(0,event.clientY-dialogDrag.dy))+'px';
 modalPanel.classList.add('modal-moved');
});
for(const type of ['pointerup','pointercancel','lostpointercapture'])modalHandle.addEventListener(type,()=>{dialogDrag=null;});
modalWrap.addEventListener('wheel',event=>{
 if(event.target!==modalWrap||!matchMedia('(min-width: 781px)').matches)return;
 const sheet=app.querySelector('.sheet');
 if(sheet&&event.deltaX)sheet.scrollLeft+=event.deltaX;
 window.scrollBy(0,event.deltaY);
 event.preventDefault();
},{passive:false});
function closeModal(){modalWrap.hidden=true;modalPanel.classList.remove('modal-moved');}
$('#modal-close').onclick=closeModal;
function pastModal(){
 if(!model.past.length){modal('지난 바자회 선택','','<p>저장된 지난 행사가 없습니다.</p>');return;}
 modal('지난 바자회 선택','지난 행사는 기록 조회용이며 상품 원본은 유지됩니다.',
 '<div class="past-select"><button class="btn neutral" data-action="past-prev" aria-label="이전 회차">‹</button><select class="select" id="past-selector" aria-label="지난 바자회">'+model.past.map((e,i)=>'<option value="'+i+'">'+e.round+'회 · '+esc(e.name)+'</option>').join('')+'</select><button class="btn neutral" data-action="past-next" aria-label="다음 회차">›</button></div>',
 '<button class="btn primary" data-action="open-past">확인</button>');
 $('#past-selector').value=store.history;
}
const parisInput=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(new Date(value)).replace(' ','T');
function draftModal(resume=false){
 const existing=resume?selectedEvent():null, active=existing?.status==='active';
 const field=(id,label,value,type='text')=>'<label class="field">'+label+'<input type="'+type+'" id="'+id+'" value="'+esc(value||'')+'"></label>';
 const area=(id,label,value,max)=>'<label class="field wide">'+label+'<textarea id="'+id+'" maxlength="'+max+'">'+esc(value||'')+'</textarea></label>';
 const date=(id,label,value)=>'<div><b>'+label+' (파리)</b><div class="actions">'+field(id+'-date','날짜',value?.slice(0,10),'date')+field(id+'-time','시간',value?.slice(11,16),'time')+'</div></div>';
 modal(existing?'행사 설정':'새 바자회 만들기','행사 기본 정보 및 구매자 안내',
 '<div class="form-grid">'+(!existing?'<label class="field wide">지난 바자회 상품 복사<select class="select" id="copy-products-from"><option value="">복사하지 않음</option>'+model.past.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.round+'회 · '+p.name)+'</option>').join('')+'</select></label>':'')+field('event-name','행사명 · 한국어',existing?.name)+field('event-name-fr','행사명 · 프랑스어',existing?.raw.nameFr)+area('event-intro-ko','행사 소개 · 한국어',existing?.raw.introKo,1000)+area('event-intro-fr','행사 소개 · 프랑스어',existing?.raw.introFr,1000)+date('event-opening',fr?'Ouverture des commandes':'주문 시작',existing?.raw.orderStartsAt?parisInput(existing.raw.orderStartsAt):'')+date('event-order','주문 마감',existing?.orderDeadline)+date('event-transfer','송금 마감',existing?.transferDeadline)+date('event-pickup',fr?'Date et heure du retrait':'픽업 날짜 및 시간',existing?.raw.pickupAt?parisInput(existing.raw.pickupAt):'')+field('event-pickup-place',fr?'Lieu du retrait':'픽업 장소',existing?.raw.pickupPlace)+area('event-pickup-ko','픽업 안내 · 한국어',existing?.pickupKo,500)+area('event-pickup-fr','픽업 안내 · 프랑스어',existing?.pickupFr,500)+field('event-payment-hours',fr?'Délai par commande (heures)':'개인별 송금 기한 (시간)',existing?.raw.paymentHours??24,'number')+field('event-beneficiary','수취인',existing?.raw.beneficiary)+field('event-iban','IBAN (FR · 27자리)',existing?.raw.iban)+'</div>',
 '<button class="btn neutral" data-action="close">취소</button>'+(existing?.status==='draft'?'<button class="btn neutral" data-action="preview-draft-form">미리보기</button>':'')+'<button class="btn primary" data-action="create-draft">'+(active?'설정 저장':'임시저장')+'</button>');
 $('#event-name').dataset.edit=String(!!existing);
 $('#event-iban').addEventListener('input',ev=>{ev.target.value=ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,27).match(/.{1,4}/g)?.join(' ')||'';});
}
function eventList(filter='all'){
 const drafts=model.drafts.map(d=>({...d,eventId:d.id,status:'draft'}));
 const all=[...model.events,...drafts];
 const controls=[['all','전체','Tous'],['draft','임시저장','Brouillons'],['published','진행 중','En cours'],['completed','종료','Terminés'],['archived','보관','Archivés']];
 const matches=(event,key)=>key==='archived'?!!event.hiddenAt:!event.hiddenAt&&(key==='all'||event.status===(key==='completed'?'closed':key));
 const columns=[
  ['name',fr?'Bazar':'행사명'],['status',fr?'État':'상태'],['manage',fr?'Gestion':'관리'],['createdAt',fr?'Création':'생성일'],
  ['orderStartsAt',fr?'Ouverture':'주문 시작일'],['orderCutoff',fr?'Clôture':'주문 마감일'],
  ['endedAt',fr?'Fin du bazar':'종료일']
 ];
 const sort=columns.some(([key])=>key===params.get('sort'))?params.get('sort'):'createdAt';
 const direction=params.get('direction')==='asc'?1:-1;
 const eventName=e=>(fr?e.nameFr:e.nameKo)||e.nameKo||'ASICC';
 const metric=(e,key)=>key==='name'||key==='manage'?eventName(e):e[key]||'';
 const compactDate=value=>{
  if(!Number.isFinite(Date.parse(value)))return '—';
  const formatted=new Intl.DateTimeFormat(fr?'fr-FR':'ko-KR',{timeZone:'Europe/Paris',year:'2-digit',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const part=type=>formatted.find(p=>p.type===type)?.value;
  return fr?[part('day'),part('month'),part('year')].join('/'):[part('year'),part('month'),part('day')].join('.');
 };
 const shown=all.filter(event=>matches(event,filter)).sort((a,b)=>{
  const first=metric(a,sort),second=metric(b,sort);
  if(!first||!second)return Number(!first)-Number(!second);
  return direction*String(first).localeCompare(String(second),fr?'fr':'ko');
 });
 const actions='<button class="btn neutral" data-action="new-event">＋ '+(fr?'Créer un bazar':'새 바자회 만들기')+'</button>'+
  '<a class="btn neutral" href="'+esc(url('products','')+'?catalog=1')+'">'+(fr?'Catalogue principal':'기본 상품 목록 관리')+'</a>';
 const filters=controls.map(([key,ko,french])=>'<button class="filter '+(filter===key?'active':'')+'" data-action="event-filter" data-value="'+key+'">'+(fr?french:ko)+' ('+all.filter(e=>matches(e,key)).length+')</button>').join('');
 const rows=shown.map(e=>{
  const label=e.status==='draft'?(fr?'Brouillon':'임시저장'):e.status==='closed'?(fr?'Terminé':'종료'):(fr?'En cours':'진행 중');
  return '<tr><td>'+esc(eventName(e))+'</td><td><span class="event-state '+(e.status==='published'?'in-progress':'')+'">'+label+'</span></td>'+
   '<td><a class="linkbtn" href="'+esc(url('products',e.id||e.eventId))+'">'+(fr?'Ouvrir':'바로가기')+'</a></td>'+
   columns.slice(3).map(([key])=>'<td>'+esc(compactDate(e[key]))+'</td>').join('')+'</tr>';
 }).join('');
 const headers=columns.map(([key,label])=>{
  const query=new URLSearchParams(params);query.set('sort',key);query.set('direction',sort===key&&direction===1?'desc':'asc');
  const state=sort===key?(direction===1?'ascending':'descending'):'none';
  return '<th scope="col" aria-sort="'+state+'"><a href="?'+esc(query.toString())+'">'+esc(label)+(sort===key?(direction===1?' ↑':' ↓'):'')+'</a></th>';
 }).join('');
 return '<section class="panel pad" id="event-list"><div class="toolbar"><h2>'+(fr?'Tous les bazars':'전체 바자회')+
  '</h2><div class="actions">'+actions+'</div></div><div class="filters">'+filters+'</div>'+
  (rows?'<div class="sheet"><table class="event-list-table"><thead><tr>'+headers+'</tr></thead><tbody>'+rows+'</tbody></table></div>':
   '<p>'+(fr?'Aucun bazar à afficher.':'표시할 행사가 없습니다.')+'</p>')+'</section>';
}
function renderMain(){
 const event=selectedEvent();
 if(params.has('event')&&event){
  location.replace(url('products',event.id));return;
 }
 const eventSummary=model.active?eventHead(model.active,true):'<section class="panel pad"><p>'+
  (fr?'Aucun bazar n’est en cours.':'현재 진행 중인 바자회가 없습니다.')+'</p></section>';
 app.innerHTML=eventSummary+eventList(params.get('status')||'all');
}
let productView=new URLSearchParams(location.search).has('catalog')?'catalog':'event',productFilter='',productDirty=false;
const visibleProducts=()=>productView==='catalog'?store.catalog:store.products.filter(p=>p.active||p.stopped);
function markProductDirty(){productDirty=true;const el=$('#product-status');if(el){el.textContent=fr?'● Modifications non enregistrées':'● 수정 중 · 저장되지 않음';el.style.color='var(--amber)';}}
root.addEventListener('click',event=>{
 const link=event.target.closest('a[href]');
 if(!productDirty||!link||link.target==='_blank'||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
 if(!confirm(fr?'Quitter sans enregistrer les modifications ?':'저장하지 않은 변경사항을 버리고 이동할까요?')){event.preventDefault();return;}
 productDirty=false;
},true);
window.addEventListener('beforeunload',e=>{if(productDirty){e.preventDefault();e.returnValue='';}});
function unit(p){return Number(p.pack)>0?Number(p.buy)/Number(p.pack):0}
function roi(p){return unit(p)>0&&p.sale!==''?((p.sale/unit(p)-1)*100).toFixed(2):''}
function updateCalculatedPrice(p,margin){if(!Number.isFinite(margin)||unit(p)<=0)return false;p.sale=finance(unit(p)*(1+margin/100));return true}
function lim(p){if(p.limitMode==='unlimited')return Infinity;return p.limitMode==='manual'?(Number(p.manualLimit)||0):(Number(p.boxes)||0)*(Number(p.pack)||0)}

function limitDisplay(product){
 if(product.limitMode==='unlimited')return fr?'Sans limite':'제한 없음';
 if(product.limitMode==='manual')return product.manualLimit;
 return product.boxes===''||product.pack===''?'':Number(product.boxes)*Number(product.pack);
}
function supplierOptions(p){
 const names=[...new Set([...store.catalog,...store.products].map(x=>String(x.vendor||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
 return (p.vendor?'':'<option value="" selected>'+(fr?'Choisir un fournisseur':'업체 선택')+'</option>')+names.map(name=>'<option value="'+esc(name)+'"'+(name===p.vendor?' selected':'')+'>'+esc(name)+'</option>').join('')+'<option value="__asicc_new_supplier__">＋ '+(fr?'Ajouter un fournisseur':'새 업체 추가…')+'</option>';
}
function storageOptions(p){
 const names=['','상온','냉장','냉동'];if(p.storage&&!names.includes(p.storage))names.push(p.storage);const labels=fr?{'상온':'Température ambiante','냉장':'Réfrigéré','냉동':'Congelé'}:{};
 return names.map(name=>'<option value="'+esc(name)+'"'+(name===p.storage?' selected':'')+'>'+esc(labels[name]||name||'—')+'</option>').join('');
}
const productColumnLabels=['순서','사진','상품명 · 한국어','상품명 · 프랑스어','상품 설명','공급업체','매입가/박스 TTC €','박스당 수량','개당 원가','개당 판매가 €','수익률 %','수량 설정 방식','발주 예정 박스','최대 판매수량','보관방법','관리'];
const productColumns=['sort','photo','title-ko','title-fr','description','supplier','buy-box','box-qty','unit-cost','sell-price','margin','limit-mode','planned-boxes','limit','storage','actions'].map((id,index)=>[id,productColumnLabels[index]]);
const shownProducts=()=>visibleProducts().filter(x=>(x.ko+' '+x.fr+' '+x.vendor).toLowerCase().includes(productFilter.toLowerCase()));
function tableProducts(){const ps=shownProducts();const catalog=productView==='catalog';return '<p class="notice">'+(fr?'Tous les prix sont TTC.':'모든 가격은 TTC 기준입니다.')+'</p><div class="sheet"><table style="min-width:1390px"><colgroup>'+[58,52,160,150,82,120,117,105,117,107,108,110,127,107,85,98].map(x=>'<col style="width:'+x+'px">').join('')+'</colgroup><thead><tr>'+productColumns.map(([id,label])=>'<th data-column-id="'+id+'">'+(fr?({sort:'Ordre',photo:'Photo','title-ko':'Nom · coréen','title-fr':'Nom · français',description:'Description',supplier:'Fournisseur','buy-box':'Coût/boîte TTC €','box-qty':'Unités/boîte','unit-cost':'Coût unitaire','sell-price':'Prix de vente €',margin:'Marge %','planned-boxes':'Boîtes à commander','limit-mode':'Mode de quantité',limit:'Quantité maximale',storage:'Conservation',actions:'Actions'}[id]||label):label)+'</th>').join('')+'</tr></thead><tbody>'+ps.map((p,index)=>'<tr data-row="'+p.id+'" class="'+(p.stopped?'sales-stopped':'')+'" '+(!catalog?'data-sort-row="'+p.id+'"':'')+'><td>'+(!catalog?'<div class="sort-controls"><button class="linkbtn mobile-sort" data-action="product-up" data-id="'+p.id+'" aria-label="'+(fr?'Monter':'위로')+'" '+(index===0||current()?'disabled':'')+'>↑</button><button class="linkbtn mobile-sort" data-action="product-down" data-id="'+p.id+'" aria-label="'+(fr?'Descendre':'아래로')+'" '+(index===ps.length-1||current()?'disabled':'')+'>↓</button><span class="drag-handle desktop-sort" title="'+(fr?'Faire glisser pour réordonner':'드래그하여 순서 변경')+'">⠿</span></div>':String(index+1))+'</td><td><button class="thumb" data-action="edit-photo" data-id="'+p.id+'" title="사진 편집">'+(p.photo?'<img src="'+esc(p.photo)+'" alt="" width="32">':'＋')+'</button></td>'+['ko','fr','desc','vendor','buy','pack'].map(f=>f==='desc'?'<td><button class="linkbtn" data-action="edit-product" data-id="'+p.id+'">'+(fr?'Modifier':'설명')+' ✎</button></td>':f==='vendor'?'<td><select class="select" style="width:100%;max-width:120px;padding:7px" data-prod="'+p.id+'" data-key="vendor">'+supplierOptions(p)+'</select></td>':'<td><input class="cell" data-prod="'+p.id+'" data-key="'+f+'" '+(['buy','pack'].includes(f)?'type="number" step="any" min="0"':'type="text"')+' value="'+esc(p[f])+'">'+(p.stopped&&f===(fr?'fr':'ko')?'<small class="sales-state">'+(fr?'Vente suspendue':'판매 중지')+'</small>':'')+'</td>').join('')+'<td data-derived="unit" data-id="'+p.id+'">'+(unit(p)?money(unit(p)):'—')+'</td><td><input class="cell" type="number" step="0.01" min="0.01" data-key="sale" data-prod="'+p.id+'" value="'+esc(p.sale)+'"></td><td><input class="cell '+(Number(roi(p))<0?'negative-margin':'')+'" type="number" step="0.01" data-prod="'+p.id+'" data-key="roi" value="'+roi(p)+'" '+(unit(p)<=0?'disabled placeholder="'+(fr?'Indisponible':'계산 불가')+'"':'')+'></td><td><select class="select" style="padding:7px;max-width:112px" data-prod="'+p.id+'" data-key="limitMode"><option value="auto" '+(p.limitMode==='auto'?'selected':'')+'>'+ (fr?'Calcul automatique':'자동 계산')+'</option><option value="manual" '+(p.limitMode==='manual'?'selected':'')+'>'+(fr?'Saisie manuelle':'수동 입력')+'</option><option value="unlimited" '+(p.limitMode==='unlimited'?'selected':'')+'>'+ (fr?'Sans limite':'제한 없음')+'</option></select></td><td><input class="cell" type="number" step="1" min="0" data-prod="'+p.id+'" data-key="boxes" value="'+(p.boxes??'')+'"></td><td><input class="cell" type="'+(p.limitMode==='unlimited'?'text':'number')+'" step="1" min="0" data-prod="'+p.id+'" data-key="manualLimit" value="'+esc(limitDisplay(p))+'" '+(p.limitMode!=='manual'?'disabled':'')+'></td><td><select class="select" style="width:100%;max-width:125px;padding:7px" data-prod="'+p.id+'" data-key="storage">'+storageOptions(p)+'</select></td><td><button class="linkbtn" data-action="'+(!catalog&&selectedEvent()?.status==='active'&&(p.stopped||p.hasOrderHistory||allocated(p)>0)?'product-sales':'delete-product')+'" data-id="'+p.id+'">'+(catalog?(fr?'Supprimer':'삭제'):p.stopped?(fr?'Reprendre les ventes':'판매 재개'):(allocated(p)>0||p.hasOrderHistory)?(fr?'Arrêter les ventes':'판매 중지'):(fr?'Supprimer':'삭제'))+'</button></td></tr>').join('')+'</tbody></table></div><p class="muted tiny" style="margin-top:8px">'+(fr?'Utilisez la poignée pour réordonner.':'PC에서는 손잡이를 드래그하고, 모바일에서는 화살표로 진열 순서를 변경하세요')+'</p>'}
function renderProducts(){const catalog=productView==='catalog',draft=!catalog&&selectedEvent()?.status==='draft';app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><div class="toolbar"><div><h2>'+(catalog?(fr?'Catalogue principal':'기본 상품 목록 관리'):(fr?'Gestion des produits':'이번 바자회 상품 관리'))+'</h2><p class="muted small">'+(catalog?(fr?'Modifiez les produits de référence sans affecter les événements créés.':'상시 원본 관리 · 필요한 상품을 행사에서 선택하여 가져오기'):esc(selectedEvent()?.name||'')+(fr?' · copie indépendante pour cet événement':'에만 적용되는 상품 사본'))+'</p></div><div class="actions">'+(catalog?'<button class="btn neutral" data-action="switch-event">← '+(fr?'Événement':'이번 바자회로')+'</button>':'<button class="btn neutral" data-action="switch-catalog">⚙ '+(fr?'Catalogue principal':'기본 상품 목록 관리')+'</button>')+'</div></div>'+banner(catalog?'<b>'+(fr?'Catalogue principal':'원본 상품 관리')+'</b> · '+(fr?'Les modifications ne changent pas les événements existants.':'기본 목록을 수정해도 이미 생성된 바자회의 상품에는 영향을 주지 않습니다.'):'<b>'+(fr?'Copie propre à l’événement':'이번 행사 전용 복사본')+'</b> · '+(fr?'Les modifications restent propres à cet événement.':'여기서 수정하는 모든 상품 정보는 기본 상품 목록에 반영되지 않습니다.'))+'<div class="toolbar"><div class="actions"><input id="product-search" class="search" value="'+esc(productFilter)+'" placeholder="'+(fr?'Rechercher un produit ou fournisseur':'상품 또는 공급업체 검색')+'"><span class="muted small">'+visibleProducts().length+(fr?' produits':'종')+'</span></div><div class="actions">'+(catalog?'<button class="btn neutral" data-action="add-product">＋ '+(fr?'Ajouter un produit':'상품 추가')+'</button>':'<button class="btn neutral" data-action="import">＋ '+(fr?'Importer des produits':'상품 가져오기')+'</button>')+'<button class="btn neutral columns-mobile" data-action="column-settings">'+(fr?'Colonnes':'열 설정')+'</button><button class="btn neutral columns-desktop" data-action="column-reset">'+(fr?'Réinitialiser les colonnes':'열 초기화')+'</button></div></div>'+tableProducts()+'<div class="footbar"><div class="actions">'+
 (catalog||draft?'<button class="btn primary" data-action="save-product">'+(fr?'Enregistrer':'저장')+'</button>':'')+
 '<button class="btn neutral" data-action="refresh-products">'+(fr?'Actualiser':'새로고침')+'</button>'+'<span id="product-status" class="muted small">'+(productDirty?'● '+(fr?'Modifications non enregistrées':'수정 중 · 저장되지 않음'):'✓ '+(fr?'Enregistré':'저장 완료'))+'</span>'+
 '</div><div class="actions">'+(!catalog?
 '<button class="btn neutral" data-action="preview-shop">'+(fr?'Aperçu':'미리보기')+'</button>'+
 (draft?'<button class="btn primary" data-action="products-publish">'+(fr?'Publier':'발행')+'</button>':
 current()?'':'<button class="btn primary" data-action="save-product">'+(fr?'Publier les changements':'변경사항 반영')+'</button>'):'')+'</div></div></section>'}
const colKey=(view=page==='orders'?'orders':productView)=> 'asicc-bazaar-cols-'+(bazaarAuth.currentUser?.uid||'anonymous')+'-'+view;
function getColumnPrefs(key=colKey()){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
function applyColumns(table=app.querySelector('.sheet table'),key=colKey(),redraw=rerender){
 if(!table||!table.querySelector('colgroup'))return;
 const headers=[...table.querySelectorAll('thead th')],cols=[...table.querySelectorAll('colgroup col')],rows=[...table.rows];
 const names=headers.map((h,i)=>h.dataset.columnId||`column-${i}`),stored=getColumnPrefs(key);
 const order=(stored?.order||names).filter(n=>names.includes(n));for(const name of names)if(!order.includes(name))order.push(name);
 const indices=order.map(n=>names.indexOf(n));
 for(const row of rows){const cells=[...row.cells];for(const i of indices){const cell=cells[i];row.append(cell);cell.hidden=stored?.hidden?.includes(names[i])||false;}}
 const group=table.querySelector('colgroup');
 for(const i of indices){group.append(cols[i]);const name=names[i];cols[i].style.display=stored?.hidden?.includes(name)?'none':'';if(stored?.widths?.[name])cols[i].style.width=stored.widths[name]+'px';}
 const total=cols.reduce((n,c)=>n+(c.style.display==='none'?0:parseInt(c.style.width)||90),0);table.style.minWidth=total+'px';
 const pinned=(stored?.pinned||[]).filter(n=>order.includes(n)&&!stored?.hidden?.includes(n));let left=0;
 for(const name of pinned){const i=names.indexOf(name),width=parseInt(cols[i].style.width)||90;for(const row of rows){const cell=row.cells[indices.indexOf(i)];if(cell){cell.style.position='sticky';cell.style.left=left+'px';cell.style.zIndex=row.parentElement.tagName==='THEAD'?'5':'2';}}left+=width;}
  headers.forEach((h,i)=>{h.draggable=true;h.dataset.columnName=names[i];h.ondragstart=ev=>{if(ev.target.closest('[data-col-resize]')){ev.preventDefault();return;}ev.dataTransfer.setData('text/plain',names[i]);ev.dataTransfer.effectAllowed='move';h.classList.add('column-dragging');};h.ondragend=()=>{h.classList.remove('column-dragging');headers.forEach(x=>x.classList.remove('column-drop-before','column-drop-after'));};h.ondragover=ev=>{if(ev.dataTransfer.types.includes('text/plain')){ev.preventDefault();headers.forEach(x=>x.classList.remove('column-drop-before','column-drop-after'));h.classList.add(ev.clientX<h.getBoundingClientRect().left+h.offsetWidth/2?'column-drop-before':'column-drop-after');}};h.ondragleave=()=>h.classList.remove('column-drop-before','column-drop-after');h.ondrop=ev=>{ev.preventDefault();const from=ev.dataTransfer.getData('text/plain'),to=names[i];if(!from||from===to)return;const pref=getColumnPrefs(key)||{};const sequence=(pref.order||names).filter(name=>names.includes(name));for(const name of names)if(!sequence.includes(name))sequence.push(name);const source=sequence.indexOf(from);if(source<0)return;sequence.splice(source,1);let target=sequence.indexOf(to);if(target<0)return;if(ev.clientX>=h.getBoundingClientRect().left+h.offsetWidth/2)target++;sequence.splice(target,0,from);pref.order=sequence;localStorage.setItem(key,JSON.stringify(pref));redraw();};h.oncontextmenu=ev=>{ev.preventDefault();showColumnMenu(ev,names[i],table,key,redraw);};if(h.querySelector('[data-col-resize]'))return;const grip=document.createElement('span');grip.dataset.colResize='';grip.title=fr?'Glisser pour redimensionner · double-clic pour ajuster':'드래그하여 열 너비 조절 · 더블클릭 자동 맞춤';grip.setAttribute('aria-label',fr?'Redimensionner la colonne':'열 너비 조절');h.append(grip);grip.addEventListener('dblclick',()=>fitColumn(table,names[i],key));grip.addEventListener('pointerdown',ev=>{ev.preventDefault();const start=ev.clientX,width=cols[i].getBoundingClientRect().width;grip.setPointerCapture(ev.pointerId);const move=moveEvent=>{const next=Math.max(50,Math.min(500,width+moveEvent.clientX-start));cols[i].style.width=next+'px';};const up=()=>{grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',up);const pref=getColumnPrefs(key)||{};pref.widths={...(pref.widths||{}),[names[i]]:parseInt(cols[i].style.width)||100};localStorage.setItem(key,JSON.stringify(pref));};grip.addEventListener('pointermove',move);grip.addEventListener('pointerup',up,{once:true});});});
}
function fitColumn(table,name,key=colKey()){const headers=[...table.querySelectorAll('thead th')],index=headers.findIndex(h=>h.dataset.columnName===name);if(index<0)return;const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)return;let width=0;for(const row of table.rows){const cell=row.cells[index];if(!cell)continue;ctx.font=getComputedStyle(cell).font;const input=cell.querySelector('input,select');const value=input?(input.value||input.options?.[input.selectedIndex]?.text||''):cell.innerText;width=Math.max(width,ctx.measureText(value||cell.innerText||'').width+28);}width=Math.max(50,Math.min(500,Math.ceil(width)));const cols=[...table.querySelectorAll('colgroup col')];const visibleIndex=index;if(cols[visibleIndex])cols[visibleIndex].style.width=width+'px';const pref=getColumnPrefs(key)||{};pref.widths={...(pref.widths||{}),[name]:width};localStorage.setItem(key,JSON.stringify(pref));}
let columnMenuContext;
function showColumnMenu(event,name,table,key,redraw){columnMenuContext={name,table,key,redraw};let menu=document.querySelector('#bazaar-column-menu');if(!menu){menu=document.createElement('div');menu.id='bazaar-column-menu';menu.className='column-context-menu';document.body.append(menu);}const prefs=getColumnPrefs(key)||{},pinned=prefs.pinned||[],hidden=prefs.hidden||[],titles=Object.fromEntries(productColumns.map(([id,label])=>[id,fr?({'sort':'Ordre','photo':'Photo','title-ko':'Nom · coréen','title-fr':'Nom · français',description:'Description',supplier:'Fournisseur','buy-box':'Coût/boîte TTC €','box-qty':'Unités/boîte','unit-cost':'Coût unitaire','sell-price':'Prix de vente €',margin:'Marge %','planned-boxes':'Boîtes à commander','limit-mode':'Mode de quantité',limit:'Quantité maximale',storage:'Conservation',actions:'Actions'}[id]||label):label]));menu.innerHTML='<button data-col-menu="hide">'+(fr?'Masquer la colonne':'열 숨기기')+'</button><button data-col-menu="pin">'+(pinned.includes(name)?(fr?'Libérer la colonne':'열 고정 해제'):(fr?'Figer la colonne':'열 고정'))+'</button><button data-col-menu="fit">'+(fr?'Ajuster la largeur':'너비 자동 조절')+'</button>'+(hidden.length?'<select aria-label="'+(fr?'Colonne masquée':'숨긴 열')+'" data-hidden-column>'+hidden.map(id=>'<option value="'+esc(id)+'">'+esc(titles[id]||id)+'</option>').join('')+'</select><button data-col-menu="restore">'+(fr?'Restaurer cette colonne':'선택 열 다시 표시')+'</button>':'');menu.style.left=event.clientX+'px';menu.style.top=event.clientY+'px';menu.hidden=false;}
document.addEventListener('click',event=>{const button=event.target.closest('[data-col-menu]'),menu=document.querySelector('#bazaar-column-menu');if(button&&menu&&columnMenuContext){const context=columnMenuContext,pref=getColumnPrefs(context.key)||{},name=button.dataset.colMenu==='restore'?menu.querySelector('[data-hidden-column]')?.value:context.name;if(button.dataset.colMenu==='hide')pref.hidden=[...new Set([...(pref.hidden||[]),name])];if(button.dataset.colMenu==='restore')pref.hidden=(pref.hidden||[]).filter(id=>id!==name);if(button.dataset.colMenu==='pin')pref.pinned=pref.pinned?.includes(name)?pref.pinned.filter(x=>x!==name):[...(pref.pinned||[]),name];if(button.dataset.colMenu==='fit'){fitColumn(context.table,name,context.key);if(menu)menu.hidden=true;return;}localStorage.setItem(context.key,JSON.stringify(pref));if(menu)menu.hidden=true;context.redraw();return;}if(menu&&!event.target.closest('#bazaar-column-menu'))menu.hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=document.querySelector('#bazaar-column-menu');if(menu)menu.hidden=true;}});
function enableColumnDrag(){const list=$('#column-list');if(!list)return;for(const row of list.children)row.draggable=true;let dragged=null;list.addEventListener('dragstart',e=>{const row=e.target.closest('[data-column]');if(row)dragged=row;});list.addEventListener('dragover',e=>{if(e.target.closest('[data-column]')&&dragged)e.preventDefault();});list.addEventListener('drop',e=>{const row=e.target.closest('[data-column]');if(!row||!dragged||row===dragged)return;e.preventDefault();const rect=row.getBoundingClientRect();list.insertBefore(dragged,e.clientY<rect.top+rect.height/2?row:row.nextSibling);});}
function columnSettings(){
 const table=app.querySelector('.sheet table'),headers=[...table.querySelectorAll('thead th')],cols=[...table.querySelectorAll('colgroup col')];
 const pref=getColumnPrefs();modal(fr?'Paramètres des colonnes':'상품표 열 설정',fr?'Affichage, gel, ordre et largeur, enregistrés pour cet administrateur sur cet appareil.':'표시, 고정, 순서와 너비를 바꿉니다. 이 기기의 운영진 계정별로 저장됩니다.','<div id="column-list">'+headers.map((h,i)=>{const id=h.dataset.columnId;return '<div class="modal-row" data-column="'+esc(id)+'"><label><input type="checkbox" data-column-visible '+(!h.hidden?'checked':'')+'> '+esc(h.textContent)+'</label><div class="actions"><label class="tiny"><input type="checkbox" data-column-pinned '+(pref?.pinned?.includes(id)?'checked':'')+'>'+(fr?' Figer':' 고정')+'</label><input aria-label="'+(fr?'Largeur':'너비')+'" type="number" min="50" max="500" value="'+(parseInt(cols[i].style.width)||100)+'" style="width:75px" data-column-width> px <button class="btn neutral" data-action="column-up" aria-label="'+(fr?'Monter':'위로')+'">↑</button><button class="btn neutral" data-action="column-down" aria-label="'+(fr?'Descendre':'아래로')+'">↓</button></div></div>';}).join('')+'</div>','<button class="btn neutral" data-action="column-reset">'+(fr?'Réinitialiser':'초기화')+'</button><button class="btn neutral" data-action="close">'+(fr?'Annuler':'취소')+'</button><button class="btn primary" data-action="column-save">'+(fr?'Appliquer':'적용')+'</button>');
}
function editProduct(id,photo=false){
 const p=(productView==='catalog'?store.catalog:store.products).find(p=>p.id===id);if(!p)return;
 const content=photo?'<div class="form-grid">'+(p.photo?'<img width="100" src="'+esc(p.photo)+'" alt="">':'')+'<label class="field wide">사진 업로드<input id="edit-photo" type="file" accept="image/jpeg,image/png,image/webp"></label><label class="field wide">사진 URL<input id="photo-url" value="'+esc(p.photo)+'"></label><label><input id="photo-remove" type="checkbox"> 사진 삭제</label></div>':'<div class="form-grid"><label class="field wide">설명 · 한국어<textarea id="edit-kod">'+esc(p.koDesc)+'</textarea></label><label class="field wide">Description · français<textarea id="edit-frd">'+esc(p.frDesc)+'</textarea></label></div>';
 modal(p.ko+' · '+(photo?'사진':'상품 설명'),p.fr,content,'<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="save-product-detail" data-id="'+p.id+'">수정 적용</button>');
}
let importPastProducts=[];
function importModal(){let items=store.catalog.filter(c=>!store.products.some(x=>x.id===c.id&&x.active));modal(fr?'Importer depuis le catalogue':'기본 상품 목록에서 가져오기',fr?'Sélectionnez les produits à copier dans cet événement.':'체크박스로 여러 상품을 한 번에 행사에 복사할 수 있습니다.',items.length?'<label class="modal-row"><input type="checkbox" data-import-all> <b>'+(fr?'Tout sélectionner / désélectionner':'전체 선택 / 해제')+'</b></label><p class="muted small" data-import-count>'+(fr?'0 produit sélectionné':'선택 상품 0개')+'</p>'+items.map(p=>'<label class="modal-row"><input type="checkbox" data-import="'+p.id+'"><span>'+p.emoji+' <b>'+esc(p.ko)+'</b> · '+esc(p.fr)+'</span><b>'+money(p.sale)+'</b></label>').join(''):banner(fr?'Tous les produits du catalogue ont déjà été importés.':'기본 목록 상품을 모두 가져왔습니다.'),'<button class="btn neutral" data-action="import-past-open">'+(fr?'Importer depuis un événement passé':'지난 행사에서 가져오기')+'</button><button class="btn neutral" data-action="close">'+(fr?'Annuler':'취소')+'</button><button class="btn primary" data-action="import-apply">'+(fr?'Importer les produits sélectionnés':'선택 상품 가져오기')+'</button>')}
async function importPastModal(eventId=''){
 const eligible=model.past.filter(e=>e.id);
 if(!eligible.length){modal('지난 행사에서 가져오기','','<p>저장된 지난 행사가 없습니다.</p>');return;}
 const selected=eligible.find(e=>e.id===eventId)||eligible[0];
 const source=await request('dashboard',{eventId:selected.id});
 const products=(source.products||[]).filter(p=>p.active!==false);importPastProducts=products;
 const body='<label class="field">'+(fr?'Événement passé':'지난 행사')+'<select class="select" id="import-past-event">'+eligible.map(e=>'<option value="'+esc(e.id)+'" '+(e.id===selected.id?'selected':'')+'>'+esc((e.round||'회')+' · '+(e.nameKo||e.name||'바자회'))+'</option>').join('')+'</select></label><div class="actions"><label><input type="checkbox" data-import-all> '+(fr?'Tout sélectionner / désélectionner':'전체 선택 / 해제')+'</label><span class="muted small" data-import-count>'+(fr?'0 produit sélectionné':'선택 상품 0개')+'</span></div>'+ (products.length?products.map(p=>'<label class="modal-row"><input type="checkbox" data-import="'+esc(p.id)+'"><span><b>'+esc(p.ko||p.nameKo||'')+'</b> · '+esc(p.fr||p.nameFr||'')+'</span><b>'+money(p.sale??p.price??0)+'</b></label>').join(''):banner(fr?'Aucun produit disponible à importer.':'가져올 수 있는 상품이 없습니다.'));
 modal(fr?'Importer depuis un événement passé':'지난 행사에서 가져오기',fr?'Seules les données produit sont copiées. Les commandes, clients, paiements et comptes ne le sont pas.':'상품 정보만 행사 전용 사본으로 복사합니다. 주문, 고객, 입금 및 정산 기록은 복사하지 않습니다.',body,'<button class="btn neutral" data-action="import-back">'+(fr?'Catalogue':'기본 목록')+'</button><button class="btn neutral" data-action="close">'+(fr?'Annuler':'취소')+'</button><button class="btn primary" data-action="import-past-apply" data-event-id="'+esc(selected.id)+'">'+(fr?'Importer les produits sélectionnés':'선택 상품 가져오기')+'</button>');
}
function productChange(el){
 const arr=productView==='catalog'?store.catalog:store.products,p=arr.find(x=>x.id===el.dataset.prod);if(!p)return;
 const k=el.dataset.key;if(productView==='catalog'&&['boxes','manualLimit','limitMode'].includes(k))return;
 let val=el.value;
 if(k==='vendor'&&val==='__asicc_new_supplier__'){
  const entered=prompt('새 공급업체명을 입력해 주세요 (최대 120자).');
  if(entered===null||!entered.trim()){el.value=p.vendor||'';return;}
  val=entered.trim().normalize('NFC');const found=[...store.catalog,...store.products].find(x=>x.vendor?.normalize('NFC').toLowerCase()===val.toLowerCase());if(found)val=found.vendor;
  if(val.length>120){alert('공급업체명은 120자 이내로 입력해 주세요.');el.value=p.vendor||'';return;}
 }
 const numeric=['buy','pack','boxes','manualLimit','roi','sale'].includes(k);
 if(numeric&&val!=='')val=Number(val);
 const candidate={...p,[k]:val};
 if(productView==='event'&&['pack','boxes','manualLimit','limitMode'].includes(k)&&lim(candidate)<allocated(p)){
  $('#product-status').textContent='이미 접수한 주문 수량보다 판매한도를 낮출 수 없습니다.';el.value=k==='manualLimit'?lim(p):p[k];return;
 }
 if(k==='roi'){
  if(val!==''&&unit(p)>0)updateCalculatedPrice(p,val);
 }else{
  p[k]=typeof val==='number'&&['buy','sale'].includes(k)?finance(val):val;
  if(k==='buy')p.boxHt=null;
 }
 const row=el.closest('[data-row]');if(!row)return;
 const unitcell=row.querySelector('[data-derived=unit]');if(unitcell)unitcell.textContent=unit(p)>0?money(unit(p)):'—';
 const margin=row.querySelector('[data-key=roi]');
 if(k!=='roi')margin.value=p.sale===''||unit(p)<=0?'':roi(p);
 margin.disabled=unit(p)<=0;
 margin.placeholder=unit(p)>0?'':(fr?'Indisponible':'계산 불가');
 margin.classList.toggle('negative-margin',Number(margin.value)<0);
 const price=row.querySelector('[data-key=sale]');if(k!=='sale')price.value=p.sale;
 const limit=row.querySelector('[data-key=manualLimit]');
 if(productView==='event'){
  limit.disabled=p.limitMode!=='manual';
  limit.type=p.limitMode==='unlimited'?'text':'number';
  if(k!=='manualLimit')limit.value=limitDisplay(p);
 }
 if(k==='vendor'){
  markProductDirty();const oldSheet=app.querySelector('.sheet'),left=oldSheet?.scrollLeft||0,top=oldSheet?.scrollTop||0;
  renderProducts();applyColumns();const nextSheet=app.querySelector('.sheet');if(nextSheet){nextSheet.scrollLeft=left;nextSheet.scrollTop=top;}
 }
 el.classList.remove('invalid');markProductDirty();
}
const orderSources={web:'웹 주문',phone:'전화 주문',additional:'추가 구매'};
const canManageOrder=()=>selectedEvent()?.status!=='draft'&&canReconcile()&&!selectedEvent().raw.finalizedAt;
function orderSource(order){return orderSources[order.source]||orderSources.web;}
function orderViewTabs(){return '<div class="filters order-view-tabs"><button class="filter '+(store.orderView==='orders'?'active':'')+'" data-action="order-view" data-value="orders">주문별 내역</button><button class="filter '+(store.orderView==='products'?'active':'')+'" data-action="order-view" data-value="products">제품별 주문 현황</button></div>'}
function productOrderRows(){return productOrderSummary(store.products,store.orders).sort((a,b)=>store.productOrderSort==='qty'?b.qty-a.qty:store.productOrderSort==='amount'?b.amountCents-a.amountCents:(fr?a.fr:a.ko).localeCompare(fr?b.fr:b.ko,fr?'fr':'ko'))}
function renderProductOrders(){
 const rows=productOrderRows();
 const t=language;
 app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><div class="toolbar"><div><h2>주문관리</h2><p class="muted small">취소 주문을 제외하고 주문 당시 판매가격으로 집계합니다.</p></div><button class="btn neutral" data-action="product-orders-excel">제품별 주문 현황 Excel</button><button class="btn neutral" data-action="pickup-excel">'+t('상품 수령 목록 Excel','Retraits (Excel)')+'</button></div>'+orderViewTabs()+'<div class="toolbar"><select class="select" id="product-order-sort"><option value="name">상품명순</option><option value="qty">주문량 높은 순</option><option value="amount">주문금액 높은 순</option></select><span class="muted tiny">상품 '+rows.length+'개 · 유효 주문 '+store.orders.filter(o=>o.status!=='canceled').length+'건</span></div><div class="sheet"><table style="min-width:940px"><colgroup><col style="width:86px"><col style="width:280px"><col style="width:150px"><col style="width:150px"><col style="width:170px"></colgroup><thead><tr><th>사진</th><th>상품명</th><th>현재 판매단가</th><th>'+t('최초 수량','Quantité initiale')+'</th><th>'+t('취소 수량','Quantité annulée')+'</th><th>'+t('유효 수량','Quantité active')+'</th><th>누적 주문금액</th></tr></thead><tbody>'+rows.map(p=>'<tr data-action="product-order-detail" data-id="'+esc(p.id)+'" style="cursor:pointer"><td>'+(p.photo?'<img src="'+esc(p.photo)+'" alt="" class="thumb" style="object-fit:cover">':'<div class="thumb">📦</div>')+'</td><td><b>'+esc((fr?p.fr:p.ko)||p.ko||p.fr||'상품')+'</b><div class="muted tiny">주문 '+p.orders.length+'건 · 상세 보기 ›</div></td><td>'+ (p.price==null?'—':money(p.price))+'</td><td>'+p.initialQty+'</td><td class="canceled-line">'+p.canceledQty+'</td><td><b>'+p.qty+'</b></td><td><b>'+money(p.amountCents/100)+'</b></td></tr>').join('')+'</tbody><tfoot><tr><th colspan="3">합계</th><th>'+rows.reduce((n,p)=>n+p.initialQty,0)+'</th><th>'+rows.reduce((n,p)=>n+p.canceledQty,0)+'</th><th>'+rows.reduce((n,p)=>n+p.qty,0)+'</th><th>'+money(rows.reduce((n,p)=>n+p.amountCents,0)/100)+'</th></tr></tfoot></table></div></section>';
 $('#product-order-sort').value=store.productOrderSort;
}
function productOrderDetail(id){const p=productOrderRows().find(row=>row.id===id);if(!p)return;modal((fr?p.fr:p.ko)||p.ko||p.fr||'상품 주문 상세','주문 당시 판매가격으로 계산된 누적 매출',p.orders.length?p.orders.map(o=>'<div class="modal-row"><span><b>'+esc(o.name)+'</b><div class="muted tiny">'+esc(o.ref)+'</div></span><span>'+o.qty+'개 · '+money(o.amountCents/100)+'</span></div>').join(''):'<p>주문이 없는 상품입니다.</p>','<button class="btn neutral" data-action="close">닫기</button>')}
function orderWorkbook(name,headers,rows){
 const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([headers,...rows]);
 sheet['!cols']=headers.map(label=>({wch:Math.max(17,Math.min(42,label.length*2+6))}));
 XLSX.utils.book_append_sheet(book,sheet,'ASICC');
 XLSX.writeFile(book,name+'.xlsx');
}
function exportProductOrders(){
 const t=language;
 orderWorkbook('ASICC-product-orders',[t('상품명','Produit'),t('판매가 EUR','Prix EUR'),
  t('최초 수량','Quantité initiale'),t('취소 수량','Quantité annulée'),t('유효 수량','Quantité active'),t('유효 상품 합계 EUR','Total articles EUR')],
  productOrderRows().map(row=>[(fr?row.fr:row.ko)||row.ko||row.fr,row.price,row.initialQty,row.canceledQty,row.qty,row.amountCents/100]));
}
function exportPickupOrders(){
 const t=language;
 orderWorkbook('ASICC-pickup',[t('주문번호','Référence'),t('주문자','Nom'),t('상품','Produit'),t('수령 수량','Quantité à retirer')],
  store.orders.filter(order=>order.status==='confirmed').flatMap(order=>order.items.map(item=>[
   order.ref,order.name,(fr?item[4]?.titleFr:item[0])||item[0],item[1],
  ])));
}
function exportOrderList(){
 const t=language;
 const quantity=items=>(items||[]).reduce((n,item)=>n+item.qty,0);
 orderWorkbook('ASICC-orders',[t('주문번호','Référence'),t('주문자','Nom'),t('최초 수량','Quantité initiale'),t('유효 수량','Quantité active'),
  t('취소 수량','Quantité annulée'),t('최초 주문금액','Montant initial'),t('현재 주문금액','Montant actuel'),t('실제 입금','Encaissement'),
  t('환불 대기','Remboursement dû'),t('환불 완료','Remboursé'),t('실제 순입금','Solde net'),t('추가 입금','Complément dû'),t('결제 상태','État de paiement')],
  filteredOrders().map(order=>{const p=order.payment;return [order.ref,order.name,quantity(order.originalItems),
   order.status==='canceled'?0:order.items.reduce((n,row)=>n+row[1],0),quantity(order.canceledItems),...[
    p?.original,p?.due,p?.deposited,p?.reservedRefund,p?.refunded,p?.net,order.bankConfirmedAt?p?.additionalDue:0,
   ].map(n=>(n||0)/100),p?.state||order.status];}));
}

const orderColumns=['ref','name','date','deadline','phone','email','items','amount','refund','reported','paid','note','status','manage'];
const ordersStateKey=()=>colKey()+'-view-'+(selectedEvent()?.id||'');
const persistOrdersView=()=>localStorage.setItem(ordersStateKey(),JSON.stringify({search:store.search,filter:store.orderFilter,key:store.sortKey,asc:store.sortAsc}));
function orderSortValue(order,key){
 const vals={ref:order.ref,name:order.name,date:order.date,deadline:order.paymentDeadline,phone:order.phone,email:order.email,
  items:order.items.length,amount:total(order),refund:order.payment?.refunded||0,reported:order.reportedAt,paid:order.verifiedAt,note:order.memo,status:order.status};
 return vals[key]??'';
}
function compareOrders(a,b){
 const key=store.sortKey||'date',first=orderSortValue(a,key),second=orderSortValue(b,key);
 const delta=typeof first==='number'?first-second:String(first).localeCompare(String(second),fr?'fr':'ko',{numeric:true});
 return (store.sortAsc?1:-1)*delta;
}
const orderFields=['주문번호','주문자','주문일시',fr?'Échéance de paiement':'개인별 송금 마감','연락처','이메일','상품 주문내역','총 주문액',fr?'Remboursement':'환불액','송금 신고','은행 입금 확인','비고','주문 상태','관리'];
const paymentOverdue=o=>o.status==='unpaid'&&Date.parse(o.paymentDeadline)<Date.now();
function filteredOrders(){return store.orders.filter(o=>(store.orderFilter==='all'||(store.orderFilter==='overdue'?paymentOverdue(o):store.orderFilter==='pending'?o.status==='reported':o.status===store.orderFilter))&&[o.ref,o.name,o.phone,o.email,o.memo,orderSource(o),o.parentOrderRef,...o.items.map(i=>i[0])].join(' ').toLowerCase().includes(store.search.toLowerCase())).sort(compareOrders)}
function renderOrders(){let ls=filteredOrders();const filters=[['all','전체'],['pending','송금 신고 · 확인 대기'],['unpaid','송금 신고 없음'],['overdue',fr?'Virement non signalé à temps':'송금 기한 초과'],['partial',fr?'Paiement partiel':'부분 입금'],['confirmed','입금 확인'],['canceled','취소']];app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><div class="toolbar"><div><h2>주문관리</h2><p class="muted small">PC는 엑셀형 주문표 · 모바일은 카드형 주문 목록</p></div><div class="actions"><span class="muted small">주문 1건당 1행</span>'+(canManageOrder()?'<button class="btn primary" data-action="manual-order">＋ 전화 주문·추가 구매</button>':'')+'</div></div>'+banner('<b>은행 입금 확인 대기 '+store.orders.filter(o=>o.status==='reported').length+'건</b> · 고객의 송금 신고만으로 주문이 확정되지 않습니다.','warning')+'<div class="toolbar"><div class="actions"><input class="search" id="order-search" placeholder="이름 · 주문번호 · 연락처 · 비고 검색" value="'+esc(store.search)+'"><label class="mobile-order-sort">'+(fr?'Trier':'정렬')+'<select id="order-mobile-sort">'+orderFields.slice(0,-1).map((label,i)=>'<option value="'+orderColumns[i]+'">'+label+'</option>').join('')+'</select></label><button class="btn neutral columns-desktop" data-action="column-reset">'+(fr?'Réinitialiser les colonnes':'열 초기화')+'</button></div><span class="muted tiny">전체 '+store.orders.length+'건</span></div><div class="filters">'+filters.map(([f,t])=>'<button class="filter '+(f===store.orderFilter?'active':'')+'" data-action="order-filter" data-value="'+f+'">'+t+' ('+store.orders.filter(o=>f==='all'||(f==='overdue'?paymentOverdue(o):f==='pending'?o.status==='reported':o.status===f)).length+')</button>').join('')+'</div><div class="sheet"><table style="min-width:1470px"><colgroup>'+[110,110,95,110,126,160,195,105,115,118,125,90,112,105].map(x=>'<col style="width:'+x+'px">').join('')+'</colgroup><thead><tr>'+orderFields.map((x,i)=>'<th data-column-id="'+orderColumns[i]+'"'+(store.sortKey===orderColumns[i]?' aria-sort="'+(store.sortAsc?'ascending':'descending')+'"':'')+'>'+(i===orderFields.length-1?x:'<button class="column-sort" data-action="order-sort-column" data-key="'+orderColumns[i]+'">'+x+(store.sortKey===orderColumns[i]?(store.sortAsc?' ↑':' ↓'):'')+'</button>')+'</th>').join('')+'</tr></thead><tbody>'+ls.map(o=>{const st=statuses[o.status];return '<tr><td class="sticky-one"><b style="color:var(--wine)">'+esc(o.ref)+'</b><div class="muted tiny">'+orderSource(o)+'</div></td><td class="sticky-two"><b>'+esc(o.name)+'</b></td><td class="tiny">'+esc(o.date)+'</td><td class="'+(paymentOverdue(o)?'negative-margin':'')+'">'+esc(dateLabel(o.paymentDeadline))+'</td><td>'+esc(o.phone)+'</td><td class="tiny">'+esc(o.email)+'</td><td>'+orderLines(o)+'</td><td>'+orderAmounts(o)+'</td><td>'+(o.payment?.refunded?money(o.payment.refunded/100):'—')+refundAmountNotes(o)+'</td><td><span class="state '+(o.status==='reported'||o.status==='confirmed'?'reported':'unpaid')+'">'+(o.status==='reported'||o.status==='confirmed'?'신고 완료':'미신고')+'</span>'+transferControl(o)+'</td><td>'+(o.status==='confirmed'?'<span class="state confirmed">'+language('✓ 확인 완료','✓ Paiement reçu')+'</span><br>'+money(o.payment.deposited/100):o.status==='partial'?'<span class="state reported">'+money(o.payment.deposited/100)+' / '+money(o.payment.due/100)+'</span><br><button class="linkbtn" data-action="deposit-add" data-id="'+esc(o.id)+'">'+language('추가 입금','Complément')+'</button>':o.status==='canceled'?'—':'<button class="linkbtn dark" data-action="confirm" data-id="'+o.id+'">입금 확인</button>')+'</td><td>'+(o.memo?'<button class="linkbtn warn" data-action="order-detail" data-id="'+o.id+'">● 비고 있음</button>':'—')+'</td><td><span class="state '+st[1]+'">'+st[0]+'</span></td><td><button class="linkbtn" data-action="order-detail" data-id="'+o.id+'">상세 보기</button></td></tr>'}).join('')+'</tbody></table></div><div class="order-cards">'+ls.map(o=>'<div class="order-card" data-action="order-detail" data-id="'+o.id+'"><div class="toolbar"><div><b style="color:var(--wine)">'+esc(o.ref)+'</b><div class="muted tiny">'+orderSource(o)+'</div><p style="margin-top:4px"><b>'+esc(o.name)+'</b></p></div><span class="state '+o.status+'">'+statuses[o.status][0]+'</span></div><div class="toolbar" style="margin-top:11px"><strong>'+money(total(o))+'</strong><span class="muted small">'+esc(o.date)+' · '+esc(dateLabel(o.paymentDeadline))+(o.memo?' · 📝 비고':'')+' ›</span></div></div>').join('')+'</div><div class="footbar"><span class="muted small">표시 '+ls.length+'건 · 접수된 주문의 정정은 운영진이 사유와 이력을 남겨 처리합니다.</span></div></section>';$('#order-mobile-sort').value=store.sortKey||'date'}
function transferControl(order){
 if(order.status==='canceled'||order.bankConfirmedAt||!canManageOrder())return '';
 if(order.status==='reported'&&order.transferReportSource!=='admin')return '';
 return '<br><button class="linkbtn" data-action="transfer-admin" data-id="'+esc(order.id)+'">'+(order.status==='reported'?language('대리 신고 정정','Retirer le signalement'):language('송금 신고','Signaler le virement'))+'</button>';
}
function refundAmountNotes(order){
 const p=order.payment;if(!p)return '';
 return (p.reservedRefund?'<br><small>'+language('대기','En attente')+' '+money(p.reservedRefund/100)+'</small>':'')+
  (p.refundDue>p.reservedRefund?'<br><small>'+language(p.overpayment?'초과 입금':'반환 필요',p.overpayment?'Trop-perçu':'À rembourser')+' '+money((p.refundDue-p.reservedRefund)/100)+'</small>':'');
}
function orderLines(order){
 const valid=order.status==='canceled'?[]:order.items;
 return valid.map(item=>'<div>'+esc(fr?(item[4]?.titleFr||item[0]):item[0])+' × '+item[1]+'</div>').join('')+
  (order.canceledItems||[]).map(item=>'<div class="canceled-line"><del>'+esc(fr?item.titleFr:item.titleKo)+' × '+item.qty+
   '</del>'+(order.payment?.reservedRefund>0?' · '+language('환불 대기','Remboursement en attente'):
    order.payment?.refundDue>0?' · '+language('환불 필요','À rembourser'):order.payment?.refunded>0?' · '+language('환불 완료','Remboursé'):'')+'</div>').join('');
}
function orderAmounts(order){
 const payment=order.payment;
 return payment&&payment.original!==payment.due?'<small class="muted"><del>'+money(payment.original/100)+'</del></small><br><b>'+money(payment.due/100)+'</b>':'<b>'+money(total(order))+'</b>';
}
function orderModal(id){
 const order=store.orders.find(row=>row.id===id);if(!order)return;
 const payment=order.payment,t=language;
 const amounts=payment?[
  [t('최초 주문금액','Montant initial'),payment.original],[t('현재 유효 주문금액','Montant actuel'),payment.due],
  [t('실제 입금액','Montant encaissé'),payment.deposited],[t('환불 대기액','Remboursement en attente'),payment.reservedRefund],
  [t('미등록 반환 필요액','Remboursement à enregistrer'),Math.max(0,payment.refundDue-payment.reservedRefund)],
  [t('실제 환불 완료액','Montant remboursé'),payment.refunded],[t('실제 순입금액','Montant net reçu'),payment.net],
  [t('추가 입금 필요액','Complément à verser'),order.bankConfirmedAt?payment.additionalDue:0],
 ]:[];
 const rows=amounts.map(([label,value])=>'<div class="modal-row"><span>'+label+'</span><b>'+money(value/100)+'</b></div>').join('');
 const cancel=order.status!=='canceled'&&(order.bankConfirmedAt||canReconcile())?
  '<button class="btn neutral" data-action="'+(order.bankConfirmedAt?'order-payments':'cancel-order')+'" data-id="'+esc(id)+'">'+t('주문 취소','Annuler la commande')+'</button>':'';
 modal(t('주문 상세','Détail de la commande'),order.ref+' · '+order.name,
  '<article class="order-print-body"><p>ASICC · '+esc(selectedEvent()?.name)+'</p><h3>'+esc(order.ref)+'</h3>'+
  '<p>'+esc(order.name)+' · '+esc(order.date)+'</p><p>'+esc(orderSource(order))+'</p>'+
  '<h3>'+t('상품 주문내역','Articles de la commande')+'</h3>'+orderLines(order)+
  '<h3>'+t('입금 및 환불 내역','Paiements et remboursements')+'</h3>'+rows+
  '</article>'+(order.memo?'<p>'+esc(order.memo)+'</p>':''),
  orderTools(order)+'<button class="btn neutral" data-action="print-order">'+t('주문서 출력','Imprimer la commande')+'</button>'+
  cancel+'<button class="btn neutral" data-action="close">'+t('닫기','Fermer')+'</button>');
}
function orderTools(order){
 let buttons='';
 if(canManageOrder()&&order.status!=='canceled'){
  buttons+='<button class="btn primary" data-action="order-correct" data-id="'+esc(order.id)+'">'+language('주문 수정','Modifier')+'</button>';
  buttons+='<button class="btn neutral" data-action="manual-order" data-id="'+esc(order.id)+'">'+language('추가 주문','Commande complémentaire')+'</button>';
 }
 if(order.bankConfirmedAt)buttons+='<button class="btn neutral" data-action="refund-open" data-id="'+esc(order.id)+'">'+language('환불 등록','Remboursement')+'</button>';
 if(order.bankConfirmedAt)buttons+='<button class="btn neutral" data-action="order-payments" data-id="'+esc(order.id)+'">'+(fr?'Paiements et remboursements':'입금·환불 기록')+'</button>';
 if(order.bankConfirmedAt)buttons+='<button class="btn primary" data-action="deposit-add" data-id="'+esc(order.id)+'">'+language('추가 입금 등록','Enregistrer un virement supplémentaire')+'</button>';
 if(order.revision)buttons+='<button class="btn neutral" data-action="order-history" data-id="'+esc(order.id)+'">'+language('정정 이력','Historique')+'</button>';
 return buttons;
}
let manualRequest;
const language=(ko,french)=>fr?french:ko;
function manualOrderModal(parentId,values={}){
 const original=store.orders.find(o=>o.id===parentId);
 const products=store.products.filter(p=>p.active&&p.sale!=='');
 const t=language;
 if(!products.length){alert(t('등록할 수 있는 판매 상품이 없습니다.','Aucun produit disponible.'));return;}
 const inputs=products.map(p=>{
  const available=Number.isFinite(lim(p))?Math.max(0,lim(p)-(p.soldQty??allocated(p))):100;
  const quantity=values.items?.find(item=>item.id===p.id)?.qty??0;
  return '<label class="modal-row"><span>'+esc(fr?p.fr:p.ko)+' · '+money(p.sale)+'</span>'+
   '<input class="cell" type="number" min="0" max="'+Math.min(100,available)+'" step="1" value="'+quantity+'" data-manual-item="'+esc(p.id)+
   '" data-price="'+Math.round(p.sale*100)+'"></label>';
 }).join('');
 modal(t('전화 주문·추가 구매 등록','Commande téléphonique ou complémentaire'),selectedEvent().name,
  (original?'<p>'+t('연결 주문','Commande liée')+' · '+esc(original.ref)+'</p>':'')+
  '<div class="form-grid"><label class="field">'+t('주문 유형','Type de commande')+'<select id="manual-source" '+(original?'disabled':'')+'>'+
  (original?'':'<option value="phone">'+t('전화 주문','Commande téléphonique')+'</option>')+
  '<option value="additional">'+t('추가 구매','Commande complémentaire')+'</option></select></label>'+
  '<label class="field">'+t('안내 언어','Langue')+'<select id="manual-lang"><option value="ko">한국어</option><option value="fr">Français</option></select></label>'+
  '<label class="field">'+t('주문자','Nom')+'<input id="manual-name" maxlength="100" value="'+esc(values.name??original?.name)+'"></label>'+
  '<label class="field">'+t('전화번호','Téléphone')+'<input type="tel" id="manual-phone" maxlength="40" value="'+esc(values.phone??original?.phone)+'"></label>'+
  '<label class="field">'+t('이메일 (선택)','E-mail (facultatif)')+'<input type="email" id="manual-email" maxlength="200" value="'+esc(values.email)+'"></label>'+
  '<label class="field">'+t('전달 사항 (선택)','Remarque (facultative)')+'<textarea id="manual-note" maxlength="500">'+esc(values.pickupNote)+'</textarea></label></div>'+
  '<h3>'+t('상품 및 수량','Produits et quantités')+'</h3>'+inputs+'<p id="manual-total" role="status"></p><div id="manual-errors" role="alert"></div>',
  '<button class="btn primary" data-action="manual-order-review" data-id="'+esc(original?.id)+'">'+t('확인','Vérifier')+'</button>'+
  '<button class="btn neutral" data-action="close">'+t('취소','Annuler')+'</button>');
 $('#manual-source').value=values.source??(original?'additional':'phone');
 $('#manual-lang').value=values.lang??(fr?'fr':'ko');
 updateManualTotal();
}
function updateManualTotal(){
 const label=$('#manual-total');if(!label)return;
 const rows=[...root.querySelectorAll('[data-manual-item]')];
 const count=rows.reduce((n,row)=>n+(Number(row.value)||0),0);
 const cents=rows.reduce((n,row)=>n+(Number(row.value)||0)*Number(row.dataset.price),0);
 label.textContent=language('총 수량 ','Quantité totale : ')+count+' · '+money(cents/100);
}
modalWrap.addEventListener('input',event=>{if(event.target.matches('[data-manual-item]'))updateManualTotal();});
function reviewManualOrder(parentId){
 const t=language,problems=[];
 const flag=(node,msg)=>{node.classList.add('invalid');problems.push({node,msg});};
 root.querySelectorAll('#modal .invalid').forEach(node=>node.classList.remove('invalid'));
 const name=$('#manual-name'),phone=$('#manual-phone'),email=$('#manual-email');
 if(name.value.trim().length<2)flag(name,t('주문자 이름을 확인해 주세요.','Vérifiez le nom.'));
 if(!validManualPhone(phone.value))flag(phone,t('전화번호를 확인해 주세요.','Vérifiez le téléphone.'));
 if(!email.validity.valid)flag(email,t('이메일 형식을 확인해 주세요.','Vérifiez le format de l’e-mail.'));
 const nodes=[...root.querySelectorAll('[data-manual-item]')];
 const items=[];
 for(const node of nodes){
  const qty=Number(node.value);
  if(node.validity.badInput||!Number.isInteger(qty)||qty<0||qty>100)flag(node,t('상품 수량은 0~100의 정수여야 합니다.','Saisissez une quantité entière de 0 à 100.'));
  else if(qty>Number(node.max))flag(node,t('판매 가능 수량을 초과했습니다.','Quantité supérieure au stock disponible.'));
  if(qty>0)items.push({id:node.dataset.manualItem,qty,priceCents:Number(node.dataset.price)});
 }
 if(!items.length&&nodes.length)flag(nodes[0],t('상품을 하나 이상 선택하세요.','Sélectionnez au moins un produit.'));
 if(problems.length){$('#manual-errors').innerHTML='<ul>'+problems.map(issue=>'<li>'+esc(issue.msg)+'</li>').join('')+'</ul>';problems[0].node.focus();return;}
 const data={eventId:selectedEvent().id,source:$('#manual-source').value,parentId,name:name.value.trim(),phone:phone.value.trim(),
  email:email.value.trim(),lang:$('#manual-lang').value,pickupNote:$('#manual-note').value,items};
 const signature=JSON.stringify(data);
 if(manualRequest?.signature!==signature)manualRequest={signature,id:crypto.randomUUID().replaceAll('-',''),data};
 const total=items.reduce((n,line)=>n+line.qty*line.priceCents,0);
 const rows=items.map(line=>{const product=store.products.find(p=>p.id===line.id);return '<tr><td>'+esc(fr?product.fr:product.ko)+'</td><td>'+money(line.priceCents/100)+'</td><td>'+line.qty+'</td><td>'+money(line.qty*line.priceCents/100)+'</td></tr>';});
 modal(t('주문 내용 확인','Vérifier la commande'),orderSources[data.source],
  '<p>'+esc(data.name)+' · '+esc(data.phone)+' · '+esc(data.email||'—')+'</p><p>'+esc(data.pickupNote)+'</p>'+
  '<table><thead><tr>'+[t('상품','Produit'),t('단가','Prix unitaire'),t('수량','Quantité'),t('금액','Montant')].map(text=>'<th scope="col">'+text+'</th>').join('')+
  '</tr></thead><tbody>'+rows.join('')+'</tbody></table><p><strong>'+t('총 주문금액','Total')+' · '+money(total/100)+'</strong></p>',
  '<button class="btn primary" data-action="manual-order-submit">'+t('주문','Commander')+'</button>'+
  '<button class="btn neutral" data-action="manual-order-back">'+t('취소','Annuler')+'</button>');
}
async function submitManualOrder(){
 if(!manualRequest||manualRequest.data.eventId!==selectedEvent()?.id)return;
 await request('createManualOrder',{...manualRequest.data,requestId:manualRequest.id});
 manualRequest=null;
 closeModal();await load();
}
let paymentRequest,refundRequest;
const refundKinds=()=>[['items',language('상품 취소','Annulation de produits')],['price',language('가격 조정','Ajustement du prix')],
 ['overpayment',language('초과 입금 반환','Retour d’un trop-perçu')],['balance',language('기존 환불 차액','Solde à rembourser')]];
function showFieldIssues(fields){
 const body=$('#modal-body');
 body.querySelectorAll('[data-field-error]').forEach(node=>node.remove());
 body.querySelectorAll('[aria-invalid="true"]').forEach(node=>node.removeAttribute('aria-invalid'));
 const invalid=fields.filter(([element,message])=>element&&message);
 for(const [element,message] of invalid){
  const hint=document.createElement('small');hint.dataset.fieldError='';hint.setAttribute('role','alert');
  hint.textContent=message;element.setAttribute('aria-invalid','true');element.after(hint);
 }
 invalid[0]?.[0].focus();
 return invalid.length>0;
}
async function refundModal(id){
 const t=language,eligible=store.orders.filter(o=>o.bankConfirmedAt),order=eligible.find(o=>o.id===id);
 if(!order){
  modal(t('환불 등록','Enregistrer un remboursement'),'','<label class="field">'+t('주문서 불러오기','Sélectionner une commande')+
   '<select id="refund-select"><option value="">—</option>'+eligible.map(o=>'<option value="'+esc(o.id)+'">'+esc(o.ref+' · '+o.name)+'</option>').join('')+'</select></label>',
   '<button class="btn primary" data-action="refund-select">'+t('주문서 불러오기','Ouvrir la commande')+'</button><button class="btn neutral" data-action="close">'+t('닫기','Fermer')+'</button>');
  return;
 }
 const {refunds}=await request('orderRefunds',{id,eventId:selectedEvent().id});
 const currency=value=>money(value/100);
 const history=refunds.map(row=>'<div class="modal-row"><div><b>'+esc(row.id.slice(0,8))+' · '+esc(refundKinds().find(([kind])=>kind===row.kind)?.[1]||row.kind)+
  ' · '+esc(currency(row.amountCents))+'</b><p>'+esc(row.reason)+' · '+esc(row.operator)+' · '+esc(dateLabel(row.completedAt||row.createdAt))+'</p><p>'+
  (row.status==='pending'?t('환불 대기','En attente'):row.status==='completed'?t('환불 완료','Remboursé'):t('대기 취소','Réservation annulée'))+'</p></div>'+
  (row.status==='pending'?'<button class="btn primary" data-action="refund-complete-form" data-id="'+esc(id)+'" data-refund="'+esc(row.id)+'">'+t('완료 기록','Enregistrer le remboursement effectué')+'</button>'+
  '<button class="btn neutral" data-action="refund-void" data-id="'+esc(id)+'" data-refund="'+esc(row.id)+'">'+t('대기 취소','Annuler la réservation')+'</button>':'')+'</div>').join('');
 const fields=(id,label,type='text',required=false)=>'<label class="field">'+label+(required?' <b class="negative-margin">*</b>':' <small>'+t('선택','Facultatif')+'</small>')+
  '<input type="'+type+'" '+(type==='number'?'min="0.01" step="0.01" ':'')+(required?'required ':'')+'id="'+id+'"></label>';
 const rows=order.status==='canceled'?[]:order.items;
 const lineBody=rows.map(([name,qty,price,key,item])=>'<tr><td>'+esc(fr?(item.titleFr||name):name)+'</td><td>'+currency(Math.round(price*100))+'</td><td>'+qty+'</td>'+
  '<td><input aria-label="'+esc(name)+'" class="cell" type="number" min="0" max="'+qty+'" step="1" value="0" data-refund-item="'+esc(key)+'" data-price="'+Math.round(price*100)+'"></td></tr>').join('');
 const payment=order.payment;
 modal(t('환불 등록','Enregistrer un remboursement'),order.ref+' · '+order.name,
  '<div class="refund-form">'+metrics([[t('현재 유효 주문금액','Montant actuel'),currency(payment.due)],
   [t('실제 입금액','Encaissements'),currency(payment.deposited)]])+
   (payment.refunded?'<p>'+t('기존 환불액','Déjà remboursé')+' · '+currency(payment.refunded)+'</p>':'')+
   (payment.reservedRefund?'<p>'+t('환불 대기','En attente')+' · '+currency(payment.reservedRefund)+'</p>':'')+
   '<details><summary>'+t('상세 결제정보','Détails du paiement')+'</summary><p>'+t('최초 주문금액','Montant initial')+' · '+currency(payment.original)+
   ' · '+t('반환 필요액','Reste à rembourser')+' '+currency(payment.refundDue)+'</p></details>'+history+
  '<div class="form-grid"><label class="field">'+t('환불 유형','Type')+'<select id="refund-kind">'+refundKinds().filter(([kind])=>order.status!=='canceled'||!['items','price'].includes(kind)).map(([kind,label])=>'<option value="'+kind+'">'+label+'</option>').join('')+'</select></label></div>'+
  '<section id="refund-lines"><table><thead><tr>'+[t('상품','Produit'),t('주문 단가','Prix à la commande'),t('현재 유효 수량','Quantité actuelle'),t('취소 수량','Quantité annulée')].map(label=>'<th scope="col">'+label+'</th>').join('')+
  '</tr></thead><tbody>'+lineBody+'</tbody></table><p id="refund-calculated"></p><label><input type="checkbox" id="refund-restore"> '+t('회수한 상품 재고 복원','Remettre les articles récupérés en stock')+'</label></section>'+
  '<div class="form-grid">'+fields('refund-amount',t('환불액 (€)','Montant (€)'),'number',true)+fields('refund-difference',t('자동 계산과 차이 사유','Motif de l’écart'),'text',true)+
  fields('refund-reason',t('내부 환불 사유','Motif interne'),'text',true)+fields('refund-public-reason',t('고객 공개 사유','Motif communiqué au client'))+
  '<label class="field">'+t('환불 방식','Mode')+'<select id="refund-method"><option value="bank">'+t('계좌이체','Virement')+'</option><option value="cash">'+t('현금','Espèces')+'</option><option value="other">'+t('기타','Autre')+'</option></select></label>'+
  fields('refund-operator',t('담당자','Responsable'),'text',true)+
  '<div id="refund-bank">'+fields('refund-beneficiary',t('예금주','Titulaire du compte'))+fields('refund-iban','IBAN')+
  '<p class="muted small">'+t('예금주명과 IBAN을 정확하게 확인해 주세요. 고객이 제공한 잘못된 계좌정보로 인해 오입금이 발생할 경우 금액의 회수 및 재환불을 보장할 수 없습니다. 협회의 법적 의무는 유지됩니다.',
   'Veuillez vérifier attentivement le nom du titulaire du compte et l’exactitude de l’IBAN. En cas de coordonnées erronées fournies par le client, la récupération des fonds et un nouveau remboursement ne peuvent être garantis. Les obligations légales de l’association restent applicables.')+'</p></div>'+
  fields('refund-note',t('내부 비고','Note interne'))+'</div></div>',
  '<button class="btn primary" data-action="refund-save" data-id="'+esc(id)+'">'+t('환불 등록','Enregistrer le remboursement')+'</button>'+
  '<button class="btn neutral" data-action="close">'+t('취소','Annuler')+'</button>');
 $('#refund-operator').value=bazaarAuth.currentUser?.displayName||'';
 if(payment.refundDue>payment.reservedRefund){$('#refund-kind').value='balance';$('#refund-amount').value=(payment.refundDue-payment.reservedRefund)/100;}
 updateRefundForm(false);
}
function updateRefundForm(fill){
 const kind=$('#refund-kind'),lines=$('#refund-lines');if(!kind||!lines)return;
 const active=kind.value==='items';
 lines.hidden=!active;
 $('#refund-bank').hidden=$('#refund-method').value!=='bank';
 const calculated=[...root.querySelectorAll('[data-refund-item]')].reduce((sum,node)=>sum+Number(node.value)*Number(node.dataset.price),0);
 $('#refund-calculated').textContent=language('자동 계산 ','Montant calculé : ')+money(calculated/100);
 if(fill&&active)$('#refund-amount').value=calculated/100;
 const difference=$('#refund-difference'),differs=active&&Math.round($('#refund-amount').valueAsNumber*100)!==calculated;
 difference.closest('label').hidden=!differs;
 difference.required=differs;
}
modalWrap.addEventListener('input',event=>{
 if(event.target.matches('[data-refund-item],#refund-kind,#refund-method,#refund-amount'))updateRefundForm(event.target.matches('[data-refund-item],#refund-kind'));
});
async function saveRefund(id){
 const order=store.orders.find(o=>o.id===id),value=key=>$('#refund-'+key)?.value.trim()||'';
 const kind=value('kind'),method=value('method');
 const items=kind==='items'?[...root.querySelectorAll('[data-refund-item]')].filter(node=>Number(node.value)>0).map(node=>({id:node.dataset.refundItem,qty:Number(node.value)})):[];
 const data={id,eventId:selectedEvent().id,revision:order.revision,kind,method,operator:value('operator'),reason:value('reason'),
  publicReason:value('public-reason'),note:value('note'),iban:method==='bank'?value('iban'):'',beneficiary:method==='bank'?value('beneficiary'):'',
  amountCents:Math.round(Number(value('amount'))*100),differenceReason:value('difference'),restoreStock:kind==='items'&&$('#refund-restore').checked,items,confirm:true};
 const quantities=[...root.querySelectorAll('[data-refund-item]')];
 const t=language;
 if(showFieldIssues([
  ...quantities.map(node=>[node,kind==='items'&&!node.validity.valid?t('유효 수량 이내의 정수를 입력하세요.','Saisissez une quantité entière disponible.'):'']),
  [$('#refund-kind'),kind==='items'&&!items.length?t('취소할 상품과 수량을 선택하세요.','Sélectionnez les produits et quantités à annuler.'):''],
  [$('#refund-amount'),data.amountCents<=0||!$('#refund-amount').validity.valid?t('0보다 큰 환불액을 입력하세요.','Saisissez un montant positif.'):''],
  [$('#refund-difference'),$('#refund-difference').required&&!data.differenceReason?t('금액 차이의 사유를 입력하세요.','Indiquez le motif de l’écart.'):''],
  [$('#refund-reason'),!data.reason?t('환불 사유를 입력하세요.','Indiquez le motif du remboursement.'):''],
  [$('#refund-operator'),!data.operator?t('담당자를 입력하세요.','Indiquez le responsable.'):''],
  [$('#refund-iban'),data.iban&&!validRefundIban(data.iban.replace(/\s/g,'').toUpperCase())?t('지원 국가, 길이와 IBAN 검증 번호를 확인하세요.','Vérifiez le pays pris en charge, la longueur et la clé IBAN.'):''],
 ]))return;
 const canceled=items.reduce((sum,item)=>sum+item.qty,0);
 if(!confirm(order.ref+' · '+language('취소 수량 ','Quantité annulée : ')+canceled+' · '+money(data.amountCents/100)+' · '+(data.restoreStock?language('재고 복원','Remise en stock'):language('재고 복원 없음','Sans remise en stock'))+' · '+language('환불 대기','En attente')))return;
 const signature=JSON.stringify(data);
 if(refundRequest?.signature!==signature)refundRequest={signature,id:crypto.randomUUID().replaceAll('-','')};
 await request('createRefund',{...data,requestId:refundRequest.id});refundRequest=null;
 closeModal();await load();
 const notice=document.createElement('p');notice.className='notice';notice.setAttribute('role','status');
 notice.textContent=t('환불을 대기 상태로 등록했습니다.','Le remboursement a été enregistré en attente.');
 app.prepend(notice);
}
function completeRefundForm(id,key){
 const t=language;
 modal(t('실제 환불 완료 기록','Enregistrer le remboursement effectué'),'',
  '<label class="field">'+t('실제 은행 환불 일시 (파리)','Date et heure du remboursement (Paris)')+' <b class="negative-margin">*</b><input id="refund-actual" type="datetime-local" required></label>'+
  '<label class="field">'+t('실제 환불 담당자','Responsable')+' <b class="negative-margin">*</b><input id="refund-actual-operator" maxlength="120" required></label>'+
  '<label class="field">'+t('은행 참조 (선택)','Référence bancaire (facultative)')+'<input id="refund-actual-reference" maxlength="160"></label>',
  '<button class="btn primary" data-action="refund-finish" data-id="'+esc(id)+'" data-refund="'+esc(key)+'">'+t('완료 기록','Enregistrer')+'</button><button class="btn neutral" data-action="close">'+t('취소','Annuler')+'</button>');
}

const refundStatus=state=>({
 pending:language('환불 대기','En attente'),completed:language('환불 완료','Remboursé'),void:language('등록 취소','Annulé'),
})[state]||state;
async function refundTable(){
 const t=language,eventId=selectedEvent().id;
 const ids=store.orders.filter(order=>order.hasRefundRecords).map(order=>order.id);
 const records=[];
 for(let start=0;start<ids.length;start+=12){
  const page=await request('eventRefunds',{eventId,ids:ids.slice(start,start+12)});
  records.push(...page.refunds);
 }
 const fields=[
  [t('환불번호','Réf. remboursement'),r=>r.id],[t('주문번호','Commande'),r=>r.orderRef],[t('주문자','Client'),r=>r.name],
  [t('환불 유형','Type'),r=>refundKinds().find(([kind])=>kind===r.kind)?.[1]||r.kind],
  [t('대상 상품','Produits'),r=>r.items.map(item=>(fr?item.titleFr:item.titleKo)+' × '+item.qty).join(', ')],
  [t('환불액 (€)','Montant (€)'),r=>r.amountCents/100],[t('방식','Mode'),r=>r.method],
  [t('담당자','Responsable'),r=>r.operator],[t('등록일시','Création'),r=>r.createdAt],
  [t('완료일시','Exécution'),r=>r.completedAt||''],[t('상태','État'),r=>refundStatus(r.status)],
 ];
 const filters='<div class="actions"><input type="search" id="refund-filter" placeholder="'+t('주문번호, 주문자, 담당자','Commande, client, responsable')+
  '"><select id="refund-status"><option value="">'+t('모든 상태','Tous les états')+'</option>'+['pending','completed','void'].map(value=>
   '<option value="'+value+'">'+refundStatus(value)+'</option>').join('')+'</select><input type="date" id="refund-date" aria-label="'+t('등록일','Date de création')+'"></div>';
 modal(t('행사 환불 관리','Remboursements du bazar'),selectedEvent().name,filters+'<div class="sheet" id="refund-sheet"></div>',
  '<button class="btn primary" id="refund-export">Excel</button><button class="btn neutral" data-action="close">'+t('닫기','Fermer')+'</button>');
 let key=8,asc=false;
 const parisDate=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris'});
 const rows=()=>{
  const search=$('#refund-filter').value.trim().toLowerCase(),status=$('#refund-status').value,date=$('#refund-date').value;
  return records.filter(r=>(!status||r.status===status)&&(!date||parisDate.format(new Date(r.createdAt))===date)&&
   [r.orderRef,r.name,r.operator].join(' ').toLowerCase().includes(search)).sort((a,b)=>{
   const x=fields[key][1](a),y=fields[key][1](b);
   return (asc?1:-1)*(typeof x==='number'?x-y:String(x).localeCompare(String(y),fr?'fr':'ko'));
  });
 };
 const draw=()=>{
  $('#refund-sheet').innerHTML='<table><colgroup>'+fields.map(()=>'<col style="width:125px">').join('')+'<col style="width:82px"></colgroup><thead><tr>'+fields.map(([label],i)=>'<th data-column-id="'+['id','order','buyer','kind','items','amount','method','actor','created','completed','status'][i]+'"><button class="linkbtn" data-refund-sort="'+i+'">'+esc(label)+
   (key===i?(asc?' ↑':' ↓'):'')+'</button></th>').join('')+'<th>'+t('관리','Gestion')+'</th></tr></thead><tbody>'+rows().map(r=>
   '<tr>'+fields.map(([,value],i)=>'<td>'+esc([8,9].includes(i)?dateLabel(value(r)):value(r))+'</td>').join('')+
   '<td><button class="linkbtn" data-action="refund-detail" data-id="'+esc(r.orderId)+'" data-refund="'+esc(r.id)+'">'+t('상세','Détails')+'</button></td></tr>').join('')+'</tbody></table>';
  applyColumns($('#refund-sheet table'),colKey('refunds'),draw);
 };
 for(const id of ['refund-filter','refund-status','refund-date'])$('#'+id).addEventListener('input',draw);
 $('#refund-sheet').addEventListener('click',event=>{
  const sort=event.target.closest('[data-refund-sort]');if(!sort)return;
  const next=Number(sort.dataset.refundSort);asc=key===next?!asc:true;key=next;draw();
 });
 $('#refund-export').addEventListener('click',()=>orderWorkbook('ASICC-refunds',fields.map(([label])=>label),rows().map(r=>fields.map(([,read])=>read(r)))));
 draw();
}

async function refundDetail(id,key){
 const t=language,{refund:row,edits,orderChange}=await request('refundAudit',{id,eventId:selectedEvent().id,refundId:key});
 if(!row)return;
 const eligible=['pending','completed'].includes(row.status);
 const action=(name,label,style='neutral')=>'<button class="btn '+style+'" data-action="'+name+'" data-id="'+esc(id)+'" data-refund="'+esc(key)+'">'+label+'</button>';
 modal(t('환불 상세','Détail du remboursement'),row.id,
  '<p>'+esc(refundStatus(row.status))+' · '+money(row.amountCents/100)+'</p><p>'+esc(row.reason)+'</p><p>'+esc(row.method)+' · '+esc(row.operator)+
  '</p><p>'+esc([row.beneficiary,row.iban,row.reference].filter(Boolean).join(' · '))+'</p>'+
  '<p>'+t('등록 계정','Compte de saisie')+' · '+esc(row.createdBy)+'</p>'+
  (orderChange?'<p>'+t('주문금액 변경','Modification de la commande')+' · '+money(orderChange.before.totalCents/100)+' → '+money(orderChange.after.totalCents/100)+'</p>':'')+
  (edits.length?'<details><summary>'+t('정정 이력','Historique des corrections')+'</summary><ul>'+edits.map(edit=>'<li>'+
   esc(dateLabel(edit.at))+' · '+esc(edit.by)+' · '+esc(edit.reason)+' · '+money(edit.before.amountCents/100)+' → '+money(edit.after.amountCents/100)+'</li>').join('')+'</ul></details>':''),
  (row.status==='pending'?action('refund-complete-form',t('환불 완료','Confirmer le remboursement'),'primary'):'')+
  (eligible?action('refund-edit-form',row.status==='pending'?t('수정','Modifier'):t('정정','Corriger')):'')+
  (row.status==='pending'?action('refund-void',t('등록 취소','Annuler l’enregistrement')):'')+
  (row.status==='pending'&&row.kind==='items'?action('refund-void-restore',t('등록 취소 및 상품 복원','Annuler et rétablir les articles')):'')+
  action('refund-table',t('환불 목록','Liste des remboursements')));
}

async function refundEdit(id,key){
 const t=language,{refunds}=await request('orderRefunds',{id,eventId:selectedEvent().id});
 const row=refunds.find(r=>r.id===key);
 if(!row||!['pending','completed'].includes(row.status))return;
 modal(t('환불 정보 정정','Corriger le remboursement'),key,
  '<label class="field">'+t('환불액 (€)','Montant (€)')+'<input type="number" id="refund-edit-amount" min="0.01" step="0.01" required value="'+row.amountCents/100+'"></label>'+
  '<label class="field">'+t('담당자','Responsable')+'<input id="refund-edit-operator" maxlength="120" required value="'+esc(row.operator)+'"></label>'+
  '<label class="field">'+t('은행 참조 (선택)','Référence bancaire (facultative)')+'<input id="refund-edit-reference" maxlength="160" value="'+esc(row.reference)+'"></label>'+
  (row.method==='bank'?'<label class="field">'+t('예금주 (선택)','Titulaire (facultatif)')+'<input id="refund-edit-beneficiary" maxlength="120" value="'+esc(row.beneficiary)+'"></label>'+
   '<label class="field">IBAN <input id="refund-edit-iban" maxlength="45" value="'+esc(row.iban)+'"></label>':'')+
  '<label class="field">'+t('정정 사유','Motif de la correction')+'<input id="refund-edit-reason" maxlength="500" required></label>',
  '<button class="btn primary" id="refund-edit-save">'+t('정정 저장','Enregistrer la correction')+'</button><button class="btn neutral" data-action="close">'+t('취소','Annuler')+'</button>');
 $('#refund-edit-save').addEventListener('click',ev=>{
  const amount=$('#refund-edit-amount'),operator=$('#refund-edit-operator'),reason=$('#refund-edit-reason');
  if(![amount,operator,reason].every(node=>node.reportValidity()))return;
  const data={id,eventId:selectedEvent().id,requestId:key,editRevision:row.editRevision??0,confirm:true,
   amountCents:Math.round(amount.valueAsNumber*100),operator:operator.value,reason:reason.value,reference:$('#refund-edit-reference').value,
   iban:$('#refund-edit-iban')?.value,beneficiary:$('#refund-edit-beneficiary')?.value};
  const signature=JSON.stringify(data);
  if(refundRequest?.signature!==signature)refundRequest={signature,id:crypto.randomUUID().replaceAll('-','')};
  void run(ev.currentTarget,async()=>{await request('editRefund',{...data,auditId:refundRequest.id});refundRequest=null;await load();await refundDetail(id,key);});
 });
}

async function openOrderPayments(id){
 const order=store.orders.find(o=>o.id===id);
 if(!order)return;
 const {payment,records}=await request('orderPayments',{id,eventId:selectedEvent().id});
 const t=(ko,french)=>fr?french:ko;
 const fields=[[t('최초 주문금액','Montant initial'),payment.original],[t('현재 주문금액','Montant actuel'),payment.due],
  [t('실제 누적 입금액','Encaissements cumulés'),payment.deposited],[t('실제 누적 환불액','Remboursements cumulés'),payment.refunded],
  [t('환불 필요 금액','Reste à rembourser'),payment.refundDue],[t('추가 입금 필요 금액','Reste à encaisser'),payment.additionalDue]];
 const list=records.map(row=>'<p>'+esc(dateLabel(row.at))+' · '+(row.type==='refund'?t('환불','Remboursement'):
  row.type==='depositCorrection'?t('입금 정정','Correction du virement'):t('입금','Virement'))+
  ' · '+money((row.correctedAmountCents??row.amountCents)/100)+' · '+esc([row.actualDate,row.payer,row.operator,row.by,row.reason,row.reference,row.note].filter(Boolean).join(' · '))+
  (row.type==='deposit'?'<button class="linkbtn" data-action="deposit-edit" data-id="'+esc(id)+'" data-entry="'+esc(row.id)+'">'+t('정정','Corriger')+'</button>':'')+'</p>').join('');
 const type=payment.refundDue?'refund':null;
 const form=type?'<label class="field">'+t('실제 처리 금액 (€)','Montant réellement traité (€)')+
  '<input id="ledger-amount" type="number" min="0.01" step="0.01" value="'+(payment.refundDue||payment.additionalDue)/100+'"></label>'+
  '<label class="field">'+t('사유','Motif')+'<input id="ledger-reason" maxlength="500"></label>'+
  '<label class="field">'+t('은행 참조 (선택)','Référence bancaire (facultative)')+'<input id="ledger-reference" maxlength="160"></label>':'';
 const cancellation=order.status==='canceled'?'':'<hr><label class="field">'+t('전체 취소 사유','Motif de l’annulation totale')+
  '<input id="paid-cancel-reason" maxlength="500"></label>'+(selectedEvent()?.status==='active'?
   '<label><input type="checkbox" id="paid-cancel-restore"> '+t('회수한 수량을 판매 재고에 복원','Remettre les unités récupérées en stock')+'</label>':'')+
  '<button class="btn neutral" data-action="paid-cancel" data-id="'+esc(id)+'">'+t('입금된 주문 전체 취소','Annuler la commande payée')+'</button>';
 modal(t('입금·환불 기록','Paiements et remboursements'),esc(order.ref),metrics(fields.map(([name,value])=>[name,money(value/100)]))+list+form+cancellation,
  '<button class="btn neutral" data-action="close">'+t('닫기','Fermer')+'</button>'+
  (type?'<button class="btn primary" data-action="ledger-record" data-id="'+esc(id)+'" data-kind="'+type+'">'+
   (type==='refund'?t('완료된 은행 환불 기록','Enregistrer le remboursement effectué'):t('확인된 추가 입금 기록','Enregistrer le virement vérifié'))+'</button>':''));
}
async function recordPayment(button){
 const data={id:button.dataset.id,eventId:selectedEvent().id,type:button.dataset.kind,amountCents:Math.round(Number($('#ledger-amount').value)*100),
  reason:$('#ledger-reason').value.trim(),reference:$('#ledger-reference').value.trim()};
 if(!data.reason||data.amountCents<=0)throw new Error(fr?'Vérifiez le montant et le motif.':'금액과 사유를 입력해 주세요.');
 if(!confirm(fr?'Confirmer que cette opération bancaire a bien été effectuée ?':'실제 은행 거래를 확인했습니까?'))return;
 const signature=JSON.stringify(data);
 if(paymentRequest?.signature!==signature)paymentRequest={signature,id:crypto.randomUUID().replaceAll('-','')};
 await request('recordOrderPayment',{...data,requestId:paymentRequest.id});
 paymentRequest=null;
 await load();
 await openOrderPayments(data.id);
}

async function editDeposit(id,entry){
 const {records}=await request('orderPayments',{id,eventId:selectedEvent().id});
 const row=records.find(record=>record.id===entry&&record.type==='deposit');
 if(!row)return;
 const t=language,cents=row.correctedAmountCents??row.amountCents;
 modal(t('입금 기록 정정','Corriger le virement'),dateLabel(row.at),
  '<label class="field">'+t('정정된 입금액 (€)','Montant corrigé (€)')+'<input id="deposit-edit-amount" type="number" min="0" step="0.01" required value="'+cents/100+'"></label>'+
  '<label class="field">'+t('정정 사유','Motif de la correction')+'<input id="deposit-edit-reason" maxlength="500" required></label>',
  '<button class="btn primary" id="deposit-edit-save">'+t('정정 저장','Enregistrer la correction')+'</button>'+
  '<button class="btn neutral" data-action="close">'+t('취소','Annuler')+'</button>');
 $('#deposit-edit-save').addEventListener('click',event=>{
  const amount=$('#deposit-edit-amount'),reason=$('#deposit-edit-reason');
  if(!amount.reportValidity()||!reason.reportValidity())return;
  const data={id,eventId:selectedEvent().id,paymentId:entry,beforeCents:cents,amountCents:Math.round(amount.valueAsNumber*100),reason:reason.value};
  const signature=JSON.stringify(data);
  if(paymentRequest?.signature!==signature)paymentRequest={signature,id:crypto.randomUUID().replaceAll('-','')};
  void run(event.currentTarget,async()=>{await request('correctDeposit',{...data,requestId:paymentRequest.id});paymentRequest=null;await load();await openOrderPayments(id);});
 });
}

function depositModal(id,initial=false){
 const order=store.orders.find(row=>row.id===id);
 if(!order||initial===Boolean(order.bankConfirmedAt))return;
 const t=language,p=order.payment;
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris'}).format(new Date());
 const seed=initial?p.due:p.additionalDue;
 const optional=(id,label,max)=>'<label class="field">'+label+'<input id="'+id+'" maxlength="'+max+'"></label>';
 modal(initial?t('실제 입금 등록','Enregistrer le virement reçu'):t('추가 입금 등록','Enregistrer un virement supplémentaire'),
  order.ref+' · '+order.name,metrics([[t('현재 주문금액','Montant actuel'),money(p.due/100)],
   [t('누적 입금액','Encaissements cumulés'),money(p.deposited/100)],[t('추가 입금 필요액','Reste à encaisser'),money(p.additionalDue/100)]])+
  '<div class="form-grid"><label class="field">'+t('실제 입금액 (€)','Montant reçu (€)')+' <b class="negative-margin">*</b>'+
  '<input id="deposit-amount" type="number" min="0.01" step="0.01" required value="'+(seed?seed/100:'')+'"></label>'+
  '<label class="field">'+t('실제 입금일 (선택)','Date du virement (facultative)')+'<input id="deposit-date" type="date" value="'+today+'"></label>'+
  optional('deposit-payer',t('입금자명 (선택)','Nom du payeur (facultatif)'),120)+
  optional('deposit-operator',t('입금 확인 담당자 (선택)','Responsable (facultatif)'),120)+
  optional('deposit-reference',t('은행 거래 참조번호 (선택)','Référence bancaire (facultative)'),160)+
  optional('deposit-note',t('비고 (선택)','Note (facultative)'),500)+'</div><p id="deposit-totals" role="status"></p>',
  '<button class="btn primary" data-action="deposit-save">'+(initial?t('입금 확인','Confirmer le virement'):t('입금 등록','Enregistrer le virement'))+
  '</button><button class="btn neutral" data-action="close">'+t('취소','Annuler')+'</button>');
 const input=$('#deposit-amount');
 const amount=()=>Math.round(input.valueAsNumber*100);
 const update=()=>{
  const cents=amount();
  if(!Number.isSafeInteger(cents)||cents<=0){$('#deposit-totals').textContent='';return;}
  const remaining=p.due-(p.net+cents);
  $('#deposit-totals').textContent=t('등록 후 누적 입금액','Encaissements après enregistrement')+' '+money((p.deposited+cents)/100)+' · '+
   (remaining<0?t('초과 입금액','Trop-perçu'):t('남은 입금 필요액','Reste à encaisser'))+' '+money(Math.abs(remaining)/100);
 };
 input.addEventListener('input',update);update();
 modalWrap.querySelector('[data-action="deposit-save"]').addEventListener('click',event=>{
  if(!input.reportValidity())return;
  const data={id,eventId:selectedEvent().id,amountCents:amount(),actualDate:$('#deposit-date').value,payer:$('#deposit-payer').value,
   operator:$('#deposit-operator').value,reference:$('#deposit-reference').value,note:$('#deposit-note').value};
  const signature=JSON.stringify([initial,data]);
  if(paymentRequest?.signature!==signature)paymentRequest={signature,id:crypto.randomUUID().replaceAll('-','')};
  void run(event.currentTarget,async()=>{
   const result=await request(initial?'bankConfirm':'recordOrderPayment',{...data,requestId:paymentRequest.id,
    ...(initial?{}:{type:'deposit',overpayment:true})});
   paymentRequest=null;
   closeModal();await load();
   if(result.needsReview)alert(t('최종 대조 후 입금 검토 대상으로 기록했습니다.','Le virement a été transmis pour vérification.'));
  });
 });
}
function correctionModal(id){
 const order=store.orders.find(o=>o.id===id);
 if(!order||!canManageOrder()||order.status==='canceled')return;
 modal('관리자 주문 정정',order.ref,
  banner('불가피한 정정에만 사용하세요. 기존 품목의 수량을 바꾸면 사유와 변경 전후 내역이 남습니다.','warning')+
  order.items.map(([name,qty,price,itemId])=>'<label class="modal-row"><span>'+esc(name)+' · '+money(price)+'</span><input class="cell" style="max-width:100px" type="number" min="0" max="100" step="1" value="'+qty+'" data-order-quantity="'+esc(itemId)+'"></label>').join('')+
  store.products.filter(p=>p.active&&Number(p.sale)>0&&!order.items.some(item=>item[3]===p.id)).map(p=>
    '<label class="modal-row"><span>'+esc(fr?p.fr:p.ko)+' · '+money(p.sale)+'</span><input class="cell" type="number" min="0" max="100" value="0" data-order-quantity="'+esc(p.id)+'"></label>'
  ).join('')+(order.bankConfirmedAt?'<label><input type="checkbox" id="correction-restore"> '+(fr?'Remettre les unités récupérées en stock':'회수한 수량을 판매 재고에 복원')+'</label>':'')+
  '<label class="field">정정 사유<textarea id="order-correction-reason" maxlength="500" required></textarea></label>',
  '<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="order-correct-save" data-id="'+esc(id)+'">정정 저장</button>');
}
async function saveCorrection(id){
 const order=store.orders.find(o=>o.id===id);
 if(!order||!canManageOrder())return;
 const reason=$('#order-correction-reason').value.trim();
 if(!reason)throw new Error('정정 사유를 입력해 주세요.');
 const items=[...root.querySelectorAll('[data-order-quantity]')].map(el=>({id:el.dataset.orderQuantity,qty:Number(el.value)})).filter(item=>item.qty!==0||order.items.some(row=>row[3]===item.id));
 if(!confirm('이 주문을 정정할까요? 원본과 정정 사유가 보관됩니다.'))return;
 await request('correctOrder',{id,eventId:selectedEvent().id,revision:order.revision,reason,items,restoreStock:$('#correction-restore')?.checked??false,confirm:true});
 closeModal();await load();orderModal(id);
}
async function showOrderHistory(id){
 const order=store.orders.find(o=>o.id===id);
 if(!order)return;
 const {history}=await request('orderCorrections',{id,eventId:selectedEvent().id});
 const describe=state=>esc(state.items.map(item=>item.titleKo+' × '+item.qty).join(' · '))+' / '+money(state.totalCents/100);
 modal('주문 정정 이력',order.ref,history.map(h=>'<section class="panel pad"><h3>정정 '+h.revision+'회</h3>'+
  '<p>'+esc(h.at)+' · '+esc(h.by)+'</p><p>'+esc(h.reason)+'</p><p>정정 전: '+describe(h.before)+'</p><p>정정 후: '+describe(h.after)+'</p></section>').join('')||'<p>정정 이력이 없습니다.</p>');
}
function accepted(){return store.orders.filter(o=>store.settleScope==='confirmed'?o.status==='confirmed':o.status!=='canceled')}
function demands(){
 const records=new Map();
 for(const order of accepted())for(const item of order.items){
  const snapshot=item[4];
  const p=selectedEvent().products.find(product=>product.id===item[3]);
  const vendor=snapshot?.supplier||p?.vendor||'공급업체 미지정';
  const pack=snapshot?.packQty??p?.pack??0;
  const buy=snapshot?.boxPriceTtcCents??Math.round((p?.buy??0)*100);
  const supplierKey=vendor==='K커머셜'?'k':vendor==='누리커넥트'?'n':'u';
  const id=[item[3],supplierKey,pack,buy].join('-');
  const row=records.get(id)||{id,ko:item[0],vendor,pack,buy:buy/100,ordered:0,revenue:0};
  row.ordered+=item[1];
  row.revenue=finance(row.revenue+item[1]*item[2]);
  records.set(id,row);
 }
 return [...records.values()].map(p=>({...p,minimum:p.pack>0?Math.ceil(p.ordered/p.pack):0}));
}
function vendors(){return [...new Set([...demands().map(p=>p.vendor),...Object.keys(store.poDrafts)])]}
function makePO(v){const key=v;if(store.settleScope!=='confirmed'||!store.poDrafts[key])return demands().filter(p=>p.vendor===v).map(p=>({id:p.id,name:p.ko,ordered:p.ordered,per:p.pack,qty:p.minimum,unit:'박스',price:p.buy,amount:Math.round(p.minimum*p.buy*100)/100,manual:false}));return store.poDrafts[key]}
function poTotal(v){return makePO(v).reduce((s,p)=>s+(Number(p.amount)||0),0)}
function vendorSales(v){return demands().filter(p=>p.vendor===v).reduce((s,p)=>s+p.revenue,0)}
function eventCashTotals(){
 const source=store.orders.map(order=>order.payment).filter(Boolean);
 return source.reduce((total,payment)=>({
  deposited:total.deposited+payment.deposited,refunded:total.refunded+payment.refunded,
  net:total.net+payment.net,refundDue:total.refundDue+payment.refundDue,additionalDue:total.additionalDue+(payment.deposited>0?payment.additionalDue:0)
 }),{deposited:0,refunded:0,net:0,refundDue:0,additionalDue:0});
}
function cashRows(){
 const cash=eventCashTotals(),t=(ko,french)=>fr?french:ko;
 return [[t('실제 누적 입금','Encaissements cumulés'),cash.deposited],[t('실제 누적 환불','Remboursements cumulés'),cash.refunded],
  [t('실제 순입금','Encaissements nets'),cash.net],[t('환불 대기','Reste à rembourser'),cash.refundDue],
  [t('추가 입금 대기','Compléments attendus'),cash.additionalDue]].map(([label,cents])=>[label,cents/100]);
}
function accountingEvidence(){
 const names=vendors();
 return evidenceControls({event:selectedEvent().id,record:eventFinancialRecord,vendors:names.filter(name=>poMeta(name).revision>0),
  expected:names.reduce((sum,vendor)=>sum+poTotal(vendor),0),request,modal,close:closeModal,run,refresh:load,t:language,esc,money});
}
function financialBoard(estimatedSales,estimatedBuy){
 const t=language,snapshot=eventFinancialRecord.finalizedAt&&eventFinancialRecord.snapshot;
 const expenses=snapshot?.expenses||eventFinancialRecord.expenses||[];
 const expenseTotal=expenses.reduce((n,item)=>n+(item.amountCents||0),0)/100;
 const locked=!!eventFinancialRecord.finalizedAt,confirmedCosts=!!eventFinancialRecord.purchaseCostsConfirmedAt;
 const sales=snapshot?snapshot.salesCents/100:estimatedSales;
 const buy=snapshot?snapshot.purchaseCents/100:confirmedCosts?accountingEvidence().actual/100:estimatedBuy;
 const gross=finance(sales-buy),net=finance(gross-expenseTotal),margin=sales?net/sales*100:0;
 const confirmed=!!snapshot||confirmedCosts;
 const status=locked?t('정산 확정','Résultat arrêté'):t('정산 미확정','Résultat provisoire');
 const figures=[[t('총매출액','Chiffre d’affaires'),money(sales)],
  [confirmed?t('상품 매입비용 TTC','Achats TTC'):t('예상 매입비용 TTC','Achats estimés TTC'),money(-buy)],
  [t('매출총이익','Marge brute'),confirmed||buy?money(gross):'—'],
  [t('기타 지출','Autres dépenses'),money(-expenseTotal)],
  [t('순수익','Résultat net'),confirmed||buy?money(net):'—'],
  [t('순수익률','Taux de marge nette'),sales&&(confirmed||buy)?margin.toFixed(1)+' %':'—']];
 const details=figures.map(([label,value])=>'<tr><th scope="row">'+label+'</th><td style="text-align:right">'+value+'</td></tr>').join('');
 const estimate=confirmed?'':'<p class="notice">'+t('매입 증빙이 확정되기 전에는 예상 정산으로 표시됩니다.','Le résultat reste provisoire avant la confirmation des justificatifs.')+'</p>';
 const buttons=(locked?'<button class="btn primary" data-action="settlement-reopen">'+t('결산 정정','Corriger le résultat')+'</button>':
  '<button class="btn primary" data-action="settlement-finalize">'+t('수익 결산 확정','Arrêter le résultat')+'</button>')+
  '<button class="btn neutral" data-action="profit-excel">Excel</button><button class="btn neutral" data-action="profit-pdf">PDF</button>';
 const lines=expenses.map(item=>'<tr><td>'+esc(item.name)+'</td><td style="text-align:right">'+money(item.amountCents/100)+
  '</td><td><button class="linkbtn" data-action="expense-edit" data-id="'+esc(item.id)+'" '+(locked?'disabled':'')+'>'+t('수정','Modifier')+'</button>'+
  ' <button class="linkbtn warn" data-action="expense-delete" data-id="'+esc(item.id)+'" '+(locked?'disabled':'')+'>'+t('삭제','Supprimer')+'</button></td></tr>').join('');
 return '<section class="panel pad bazaar-financial-board"><div class="toolbar"><h3>'+t('수익 결산','Résultat financier')+
  '</h3><span class="status">'+status+'</span></div>'+estimate+metrics([[t('총매출액','Chiffre d’affaires'),money(sales)],
   [t('총지출','Dépenses totales'),confirmed||buy?money(buy+expenseTotal):'—'],[t('순수익','Résultat net'),figures[4][1]]])+
  '<div class="sheet"><table><tbody>'+details+'</tbody></table></div><details><summary>'+t('실제 입출금','Encaissements et remboursements')+
  '</summary>'+metrics(cashRows().map(([label,value])=>[label,money(value)]))+'</details><div class="toolbar">'+
  '<h3>'+t('기타 지출 항목','Autres dépenses')+'</h3><button class="btn primary" data-action="expense-add" '+(locked?'disabled':'')+
  '>'+t('지출 추가','Ajouter une dépense')+'</button></div><div class="sheet"><table><thead><tr><th>'+t('항목명','Libellé')+
  '</th><th>'+t('금액','Montant')+'</th><th>'+t('관리','Gestion')+'</th></tr></thead><tbody>'+lines+'</tbody></table></div>'+
  '<div class="actions">'+buttons+'</div></section>';
}
function expenseModal(id){const row=(eventFinancialRecord.expenses||[]).find(x=>x.id===id);modal(row?'기타 지출 수정':'기타 지출 추가','현재 선택한 행사에만 저장됩니다.','<div class="form-grid"><label class="field wide">항목명<input id="expense-name" maxlength="120" value="'+esc(row?.name||'')+'"></label><label class="field wide">금액 TTC (€)<input id="expense-amount" type="number" min="0.01" max="1000000" step="0.01" value="'+(row?row.amountCents/100:'')+'"></label></div>','<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="expense-save" data-id="'+esc(row?.id||'')+'">저장</button>')}
async function persistExpenses(expenses){eventFinancialRecord=await request('saveEventExpenses',{eventId:selectedEvent().id,planned:selectedEvent().status==='draft',revision:eventFinancialRecord.revision,expenses});closeModal();rerender();}
function renderEstimate(){
 const expenses=eventFinancialRecord.expenses||[],estimate=estimateEvent(store.products,expenses);
 const t=(ko,french)=>fr?french:ko;
 const euro=value=>value==null?t('미확정','À déterminer'):money(value);
 const values=[[t('예상 최대 매출액','Chiffre d’affaires maximal prévu'),euro(estimate.sales)],
  [t('예상 매입금액 TTC','Achats prévus TTC'),euro(estimate.buy)],
  [t('예상 매출총이익','Marge brute prévue'),euro(estimate.gross)],
  [t('기타 예상 비용','Autres coûts prévus'),euro(estimate.other)],
  [t('예상 순이익','Résultat net prévu'),euro(estimate.net)],
  [t('예상 수익률','Taux de marge nette prévu'),estimate.margin==null?'—':(estimate.margin*100).toFixed(1)+' %']];
 const columns=[t('상품','Produit'),t('예상 판매수량','Quantité prévue'),t('발주 예정 박스','Boîtes prévues'),
  t('박스당 수량','Unités par boîte'),t('박스 매입가 TTC','Coût TTC par boîte'),...values.slice(0,3).map(([title])=>title)];
 const rows=estimate.rows.map(({p,limit,boxes,pack,cost,buy,sales,gross,short})=>'<tr>'+
  [esc((fr?p.fr:p.ko)||p.ko||p.fr)+(short?' <strong>'+t('예정 매입수량 부족','Quantité d’achat insuffisante')+'</strong>':''),
   limit??'—',boxes??'—',pack??'—',euro(cost),euro(sales),euro(buy),euro(gross)].map(value=>'<td>'+value+'</td>').join('')+'</tr>').join('');
 const costs=expenses.map(row=>'<li>'+esc(row.name)+' · '+money(row.amountCents/100)+
  ' <button class="linkbtn" data-action="expense-edit" data-id="'+esc(row.id)+'">'+t('수정','Modifier')+'</button>'+
  ' <button class="linkbtn warn" data-action="expense-delete" data-id="'+esc(row.id)+'">'+t('삭제','Supprimer')+'</button></li>').join('');
 app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><h2>'+t('발행 전 예상 정산','Prévision avant publication')+'</h2>'+
  '<p>'+t('상품과 예상 비용을 기준으로 계산한 값입니다. 미확정 항목은 합계에도 미확정으로 표시됩니다.',
   'Calcul fondé sur les produits et coûts prévus. Un poste indéterminé rend son total indéterminé.')+'</p>'+metrics(values)+
  '<div class="sheet"><table><thead><tr>'+columns.map(column=>'<th scope="col">'+column+'</th>').join('')+
  '</tr></thead><tbody>'+rows+'</tbody></table></div><ul>'+costs+'</ul>'+
  '<button class="btn neutral" data-action="expense-add">'+t('예상 비용 추가','Ajouter un coût prévu')+'</button></section>';
}
function profitExportRows(){
 const snapshot=eventFinancialRecord.finalizedAt&&eventFinancialRecord.snapshot;
 if(snapshot)return {sales:snapshot.salesCents/100,buy:snapshot.purchaseCents/100,other:snapshot.expenseCents/100,
  gross:(snapshot.salesCents-snapshot.purchaseCents)/100,net:snapshot.profitCents/100,margin:(snapshot.margin??0)*100,expenses:snapshot.expenses};
 const sales=accepted().reduce((n,o)=>n+total(o),0);
 const buy=eventFinancialRecord.purchaseCostsConfirmedAt?accountingEvidence().actual/100:vendors().reduce((n,v)=>n+poTotal(v),0);
 const expenses=eventFinancialRecord.expenses||[],other=expenses.reduce((n,x)=>n+x.amountCents,0)/100,gross=finance(sales-buy),net=finance(gross-other);
 return {sales,buy,other,gross,net,margin:sales?net/sales*100:0,expenses};
}
function exportProfitExcel(){const x=profitExportRows(),rows=[['ASICC 전체 바자회 수익 결산'],['행사',selectedEvent()?.name||''],['집계 범위',store.settleScope==='confirmed'?'입금 확인 주문':'취소 제외 전체 주문'],[],['항목','금액 EUR','비율'],['총매출액',x.sales,null],['상품 매입비용 TTC',x.buy,null],['매출총이익',x.gross,null],['기타 지출',x.other,null],['순수익',x.net,null],['순수익률',null,x.margin/100],...cashRows(),[],['기타 지출 항목','금액 EUR'],...x.expenses.map(e=>[e.name,e.amountCents/100])];const sheet=XLSX.utils.aoa_to_sheet(rows);sheet['!cols']=[{wch:36},{wch:20},{wch:16}];const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'수익 결산');XLSX.writeFile(book,'ASICC-바자회-수익결산.xlsx')}
function exportProfitPdf(){const x=profitExportRows(),pdf=new jspdf.jsPDF();const canvas=document.createElement('canvas');canvas.width=1240;canvas.height=1754;const ctx=canvas.getContext('2d');if(!ctx)return;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#81364d';ctx.font='bold 42px system-ui';ctx.fillText('ASICC · 전체 바자회 수익 결산',70,90);ctx.fillStyle='#29262a';ctx.font='26px system-ui';ctx.fillText(selectedEvent()?.name||'',70,145);ctx.font='24px system-ui';const values=[['총매출액',money(x.sales)],['상품 매입비용 TTC',money(x.buy)],['매출총이익',money(x.gross)],['기타 지출',money(x.other)],['순수익',money(x.net)],['순수익률',x.sales?x.margin.toFixed(1)+'%':'—'],...cashRows().map(([name,value])=>[name,money(value)])];let y=220;for(const [label,value] of values){ctx.fillText(label,80,y);ctx.textAlign='right';ctx.fillText(value,1150,y);ctx.textAlign='left';ctx.strokeStyle='#ded6d4';ctx.beginPath();ctx.moveTo(70,y+18);ctx.lineTo(1170,y+18);ctx.stroke();y+=72;}y+=42;ctx.font='bold 28px system-ui';ctx.fillText('기타 지출 항목',70,y);y+=55;ctx.font='23px system-ui';for(const expense of x.expenses){if(y>1650){pdf.addImage(canvas.toDataURL('image/png'),'PNG',0,0,210,297);pdf.addPage();ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#29262a';y=90;}ctx.fillText(expense.name,80,y);ctx.textAlign='right';ctx.fillText(money(expense.amountCents/100),1150,y);ctx.textAlign='left';y+=48;}pdf.addImage(canvas.toDataURL('image/png'),'PNG',0,0,210,297);pdf.save('ASICC-바자회-수익결산.pdf')}
const closedPurchaseWarning='종료된 행사의 발주 내역을 수정합니다. 이미 업체에 보낸 발주서가 있으면 변경사항을 별도로 전달하세요. 고객 주문과 입금 기록은 그대로 유지됩니다.';
function canEditPurchase(){
 const event=selectedEvent();
 return !!event&&store.settleScope==='confirmed'&&(current()||event===model.active&&!poMeta(store.vendor).confirmed);
}
function closedPurchaseControls(){
 if(!current())return '';
 return banner(esc(closedPurchaseWarning),'warning')+
  (store.settleScope==='confirmed'?'<div class="actions"><button class="btn neutral" data-action="po-new-vendor">＋ 업체 발주서 추가</button></div>':'');
}
function addPurchaseVendor(){
 modal('업체 발주서 추가','종료 후 추가 발주',
  banner(esc(closedPurchaseWarning),'warning')+'<label class="field">공급업체명<input id="po-vendor-name" maxlength="120"></label>',
  '<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="po-vendor-save">추가</button>');
 $('#po-vendor-name').focus();
}
function renderSettlement(){let ds=demands(),vs=vendors(),sumBuy=vs.reduce((s,v)=>s+poTotal(v),0),sumSales=ds.reduce((s,p)=>s+p.revenue,0);if(!vs.includes(store.vendor))store.vendor=vs[0]||'';if(!vs.length){app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><h2>정산관리</h2>'+closedPurchaseControls()+banner('집계할 주문이 없습니다.')+'<div class="actions"><button class="btn neutral" data-action="scope" data-value="confirmed">입금 확인 주문</button><button class="btn neutral" data-action="scope" data-value="all">전체 유효 주문</button></div></section>';return;}app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><div class="toolbar"><div><h2>정산관리</h2><p class="muted small">업체별 정산 · 발주서 품목/수량/매입가 직접 수정</p></div><span class="muted small">고객 주문 원본과 발주서는 별개</span></div>'+closedPurchaseControls()+'<div class="notice"><div class="toolbar"><b>집계 기준</b><div class="actions"><button class="filter '+(store.settleScope==='confirmed'?'active':'')+'" data-action="scope" data-value="confirmed">입금 확인 주문</button><button class="filter '+(store.settleScope==='all'?'active':'')+'" data-action="scope" data-value="all">전체 유효 주문</button></div></div><p class="muted tiny" style="margin-top:8px">'+(store.settleScope==='confirmed'?'운영진이 은행 입금을 확인한 주문을 기준으로 합니다.':'취소 주문을 제외하고 미입금 주문까지 포함한 예상 수요입니다.')+'</p></div>'+metrics([['집계 주문',accepted().length+'건'],['고객 판매액',money(sumSales)],['업체 발주액',money(sumBuy)],['예상 매출총이익',money(sumSales-sumBuy)]])+'<h3 style="margin:21px 0 11px">업체별 발주 현황</h3><div class="supplier-grid">'+vs.map(v=>{let rr=demands().filter(p=>p.vendor===v);return '<div class="vendor-box '+(store.vendor===v?'active':'')+'"><div class="toolbar"><h3>'+esc(v)+'</h3><button class="linkbtn" data-action="vendor" data-value="'+esc(v)+'">'+(store.vendor===v?'선택됨':'상세·발주')+'</button></div><div class="vendor-stats"><div><span>상품 주문수량</span><b>'+rr.reduce((s,p)=>s+p.ordered,0)+'개</b></div><div><span>발주 수량</span><b>'+esc(quantityByUnit(makePO(v)))+'</b></div><div><span>매입액 TTC</span><b>'+money(poTotal(v))+'</b></div><div><span>판매액</span><b>'+money(vendorSales(v))+'</b></div><div><span>예상 차액</span><b>'+money(vendorSales(v)-poTotal(v))+'</b></div></div></div>'}).join('')+'</div><div class="panel pad" style="margin-top:20px"><div class="toolbar"><div><h3>'+esc(store.vendor)+' · 구매발주서 편집</h3><p class="muted small">'+(poMeta(store.vendor).confirmed?(current()?'확정 · 종료 후 수정 가능':'확정 · 읽기 전용'):poMeta(store.vendor).savedAt?'저장된 초안':'작성 중')+' · 집계와 발주서 차이 '+money(poTotal(store.vendor)-finance(demands().filter(p=>p.vendor===store.vendor).reduce((sum,p)=>sum+p.minimum*p.buy,0)))+'</p><p class="muted small">전화주문·추가 구매를 위해 품목, 수량, 단가, 소계를 직접 변경할 수 있습니다.</p></div><button class="btn primary" data-action="po-add">＋ 발주 품목 추가</button></div><div class="sheet" style="max-height:460px"><table style="min-width:900px"><colgroup><col style="width:210px"><col style="width:115px"><col style="width:110px"><col style="width:125px"><col style="width:125px"><col style="width:85px"></colgroup><thead><tr><th>품목 / 구분</th><th>발주수량</th><th>단위</th><th>매입단가 TTC</th><th>품목 소계 TTC</th><th>관리</th></tr></thead><tbody>'+makePO(store.vendor).map(p=>'<tr><td><input class="cell" value="'+esc(p.name)+'" data-po="'+esc(p.id)+'" data-key="name"><div class="muted tiny">'+(p.manual?'수동 추가':'주문 수량 '+p.ordered+'개 · '+p.per+'개/박스')+poWarning(p)+'</div></td><td><input type="number" min="0" step="1" class="cell" value="'+p.qty+'" data-po="'+p.id+'" data-key="qty"></td><td><select class="select" style="width:100%;padding:7px" data-po="'+p.id+'" data-key="unit">'+['박스','개','봉','세트'].map(u=>'<option '+(p.unit===u?'selected':'')+'>'+u+'</option>').join('')+'</select></td><td><input type="number" min="0" step="0.01" class="cell" value="'+p.price+'" data-po="'+p.id+'" data-key="price"></td><td><input type="number" min="0" step="0.01" class="cell" value="'+p.amount+'" data-po="'+p.id+'" data-key="amount"></td><td><button class="linkbtn" data-action="po-del" data-id="'+p.id+'">삭제</button></td></tr>').join('')+'</tbody></table></div><div class="summary-bar"><span><b>'+esc(store.vendor)+'</b> 총 발주금액 TTC</span><strong id="po-edit-total">'+money(poTotal(store.vendor))+'</strong></div><div class="actions" style="justify-content:flex-end"><button class="btn neutral" data-action="po-reset">자동 산출로 초기화</button><button class="btn neutral" data-action="po-settings">발주 정보 편집</button><button class="btn neutral" data-action="po-save">'+(current()&&poMeta(store.vendor).confirmed?'수정사항 저장':'발주서 초안 저장')+'</button>'+(poMeta(store.vendor).confirmed?'':'<button class="btn neutral" data-action="po-confirm">발주서 확정</button>')+'<button class="btn neutral" data-action="one-pdf">PDF</button><button class="btn neutral" data-action="one-excel">Excel</button><button class="btn primary" data-action="po-preview">구매발주서 미리보기</button></div></div>'+banner('고객 판매 실적과 발주서는 별도로 보존합니다. 구매발주서의 수동 변경이 고객 주문액이나 상품 원본을 수정하지 않습니다.')+'<div class="panel pad"><div class="toolbar"><div><h3>전체 업체 구매발주서</h3><p class="muted small">공급업체용 자료에는 고객정보와 판매금액이 포함되지 않습니다.</p></div><button class="btn neutral" data-action="all-po">전체 업체 검토</button><button class="btn neutral" data-action="all-pdf">전체 PDF</button><button class="btn neutral" data-action="all-excel">전체 Excel</button></div></div></section>'}
function assertConfirmedScope(){if(store.settleScope!=='confirmed')throw new Error('발주서를 다운로드하려면 입금 확인 주문으로 전환해 주세요.');}
function editablePO(vendor){return store.poDrafts[vendor]??=makePO(vendor);}
function poChange(el){
 const p=editablePO(store.vendor).find(p=>p.id===el.dataset.po);
 if(!p)return;
 const key=el.dataset.key;
 const value=['qty','price','amount'].includes(key)?Math.max(0,Number(el.value)||0):el.value;
 p[key]=value;
 const row=el.closest('tr');
 if(key==='qty'||key==='price'){
  p.amount=finance(p.qty*p.price);
  row.querySelector('[data-key=amount]').value=p.amount;
 }else if(key==='amount'&&p.qty>0){
  p.price=Math.round(p.amount/p.qty*10000)/10000;
  row.querySelector('[data-key=price]').value=p.price;
 }
 $('#po-edit-total').textContent=money(poTotal(store.vendor));
}
function previewPO(v){let ps=makePO(v),meta=poMeta(v);modal('구매발주서 / Bon de commande',v,'<div class="po-preview"><div class="toolbar"><div><div class="brand" style="font-size:17px;color:var(--wine)">ASICC</div><p class="tiny muted">Association de la Section Internationale Coréenne à Courbevoie</p><p class="tiny">contact@asicc-parents.fr</p></div><div class="small" style="text-align:right">발주처: ASICC<br>공급업체: <b>'+esc(v)+'</b><br>발주번호: '+esc(meta.number)+'<br>발주일: '+esc(meta.date||'')+'</div></div><h2 style="margin-top:26px">BON DE COMMANDE<br><small style="font-size:12px;letter-spacing:0;font-weight:500">구매발주서</small></h2><p>'+metadata.slice(2).filter(([key])=>meta[key]).map(([key,label])=>esc(label)+': '+esc(meta[key])).join('<br>')+'</p><table><thead><tr><th>품목</th><th>수량</th><th>단위</th><th>매입 단가 TTC</th><th>합계 TTC</th></tr></thead><tbody>'+ps.map(p=>'<tr><td>'+esc(p.name)+'</td><td>'+p.qty+'</td><td>'+esc(p.unit)+'</td><td>'+money(p.price)+'</td><td><b>'+money(p.amount)+'</b></td></tr>').join('')+'</tbody></table><div class="summary-bar"><b>총 매입액 TTC</b><strong>'+money(poTotal(v))+'</strong></div><div class="notice">납품 주소·예정일·담당자·SIRET는 확인된 공식 정보로 실제 생성할 때 입력합니다.<br>공급업체용 문서에 고객 판매가격·협회 수익률·고객 개인정보를 포함하지 않습니다.</div></div>','<button class="btn neutral" data-action="close">수정 화면으로</button><button class="btn neutral" data-action="one-pdf">PDF 다운로드</button><button class="btn neutral" data-action="one-excel">Excel 다운로드</button>')}
function addPOModal(){modal('발주 품목 추가',store.vendor+' · 수동 추가','<div class="form-grid"><label class="field wide">품목명<input id="po-new-name" placeholder="예: 추가 구매 김치"></label><label class="field">발주수량<input id="po-new-qty" type="number" min="1" value="1"></label><label class="field">단위<select id="po-new-unit"><option>박스</option><option>개</option><option>봉</option><option>세트</option></select></label><label class="field">매입 단가 TTC (€)<input id="po-new-price" type="number" min="0" step="0.01" value="0"></label></div>','<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="po-add-save">발주서에 추가</button>')}
let settlementTab=params.get('settle')||'purchases';
function settlementTabs(){
 const tabs=[['purchases',language('발주관리','Commandes fournisseurs')],['cash',language('입금·환불 현황','Paiements et remboursements')],
  ['profit',language('수익 결산','Résultat financier')]];
 return '<nav class="tabs">'+tabs.map(([key,text])=>'<button class="filter '+(settlementTab===key?'active':'')+'" data-action="settlement-tab" data-tab="'+key+'">'+text+'</button>').join('')+'</nav>';
}
function cashSettlement(){
 const t=language;
 const groups=[
  ['paid',t('입금 완료','Payées'),o=>o.status==='confirmed',o=>o.payment.due],
  ['unpaid',t('미입금','Impayées'),o=>o.payment?.state==='unpaid',o=>o.payment.additionalDue],
  ['additional',t('추가 입금 대기','Compléments attendus'),o=>o.status==='partial',o=>o.payment.additionalDue],
  ['pending',t('환불 대기','Remboursements en attente'),o=>o.payment?.reservedRefund>0,o=>o.payment.reservedRefund],
  ['unreserved',t('미등록 반환 필요','Remboursements à enregistrer'),o=>o.payment?.refundDue>o.payment?.reservedRefund,o=>o.payment.refundDue-o.payment.reservedRefund],
  ['refunded',t('환불 완료','Remboursements effectués'),o=>o.payment?.refunded>0,o=>o.payment.refunded],
 ];
 return metrics(cashRows().map(([label,value])=>[label,money(value)]))+groups.map(([key,label,filter,measure])=>{
  const orders=store.orders.filter(filter);
  const rows=orders.map(order=>'<tr><td>'+esc(order.ref)+'</td><td>'+esc(order.name)+'</td><td>'+money(measure(order)/100)+'</td>'+
   '<td class="'+(paymentOverdue(order)?'negative-margin':'')+'">'+esc(dateLabel(order.paymentDeadline))+'</td>'+
   '<td><button class="linkbtn" data-action="order-detail" data-id="'+esc(order.id)+'">'+t('상세 보기','Détails')+'</button></td></tr>');
  return '<details class="panel pad" data-cash-group="'+key+'"><summary>'+label+' · '+orders.length+' · '+money(orders.reduce((n,o)=>n+measure(o),0)/100)+'</summary>'+
   '<div class="sheet"><table><tbody>'+rows.join('')+'</tbody></table></div></details>';
 }).join('')+'<div class="actions"><button class="btn primary" data-action="refund-open">'+t('환불 등록','Enregistrer un remboursement')+'</button>'+
  '<button class="btn neutral" data-action="refund-table">'+t('행사 환불 관리','Remboursements du bazar')+'</button></div>';
}
function rerender(){
 const sheet=['products','orders'].includes(page)&&app.querySelector('.sheet');
 const scroll=sheet&&{left:sheet.scrollLeft,top:sheet.scrollTop,x:window.scrollX,y:window.scrollY};
 const restoreSheet=()=>{if(scroll){const next=app.querySelector('.sheet');if(next){next.scrollLeft=scroll.left;next.scrollTop=scroll.top;}window.scrollTo(scroll.x,scroll.y);}};
 if(page==='main'||(!selectedEvent()&&!(page==='products'&&productView==='catalog'))){renderMain();return;}
 if(page==='products'){
  renderProducts();applyColumns();
  if(scroll){const next=app.querySelector('.sheet');if(next){next.scrollLeft=scroll.left;next.scrollTop=scroll.top;}window.scrollTo(scroll.x,scroll.y);}
 }
 if(page==='orders'){
  if(store.orderView==='products')renderProductOrders();
  else {renderOrders();applyColumns();restoreSheet();app.querySelector('.tabbody')?.insertAdjacentHTML('afterbegin',orderViewTabs());}
  const ev=selectedEvent();const bar=document.createElement('div');bar.className='footbar';bar.innerHTML='<div class="actions"><button class="btn neutral" data-action="refresh-orders">새로고침</button><button class="btn neutral" data-action="csv-orders">주문 CSV 다운로드</button><button class="btn neutral" data-action="order-list-excel">'+language('주문 목록 Excel','Commandes (Excel)')+'</button></div>'+(canReconcile()&&ev.status!=='draft'&&!ev.raw.reconciledAt?'<button class="btn danger" data-action="finalize-unpaid">최종 입금 대조 · 미입금 일괄 취소</button>':'');app.querySelector('.tabbody').append(bar);
 }
 if(page==='settlement'){
  if(selectedEvent()?.status==='draft'){renderEstimate();return;}
  if(settlementTab==='cash'||settlementTab==='profit'){
   const sales=accepted().reduce((n,o)=>n+total(o),0),buy=vendors().reduce((n,v)=>n+poTotal(v),0);
   app.innerHTML=eventHead()+tabs()+settlementTabs()+'<section class="tabbody">'+(settlementTab==='cash'?cashSettlement():financialBoard(sales,buy))+'</section>';
   if(settlementTab==='profit')app.querySelector('.tabbody')?.insertAdjacentHTML('beforeend',accountingEvidence().panel('expense'));
  }else{
   renderSettlement();
   app.querySelector('.tabbody')?.insertAdjacentHTML('beforebegin',settlementTabs());
   app.querySelector('.tabbody')?.insertAdjacentHTML('beforeend',accountingEvidence().panel('purchase'));
   const table=app.querySelector('.tabbody .sheet table');if(table)applyColumns(table,colKey('purchase-orders'),rerender);
  }
 }
 if(page==='orders'&&selectedEvent()?.status==='draft'){app.querySelectorAll('[data-action=manual-order]').forEach(b=>b.disabled=true);}
 if(page==='products'&&productView==='catalog')app.querySelectorAll('[data-key=boxes],[data-key=manualLimit],[data-key=limitMode]').forEach(el=>el.disabled=true);
 if(page==='products'&&current()&&productView!=='catalog'||page==='settlement'&&!canEditPurchase()){
  app.querySelectorAll(page==='products'?'[data-prod],[data-toggle],[data-action=delete-product],[data-action=edit-product],[data-action=edit-photo],[data-action=import],[data-action=reorder-products],[data-action=save-product]':
   '[data-po],[data-action=po-add],[data-action=po-del],[data-action=po-reset],[data-action=po-settings],[data-action=po-save],[data-action=po-confirm]').forEach(el=>el.disabled=true);
 }
}
app.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;
if(handleScreenAction(a,b))return;
if(a==='refund-table'){void run(b,refundTable);return;}
if(a==='deposit-add'){depositModal(b.dataset.id);return;}
if(a==='evidence-list'){accountingEvidence().view(b.dataset.scope);return;}
if(a==='evidence-zip'){void run(b,()=>accountingEvidence().exportAll());return;}
if(a==='evidence-confirm'){
 if(confirm(language('등록한 증빙을 기준으로 실제 매입비용을 확정할까요?','Confirmer le coût réel à partir des justificatifs ?')))
  void run(b,async()=>{await request('confirmPurchaseCosts',{eventId:selectedEvent().id,revision:eventFinancialRecord.revision,confirm:true});await load();});
 return;
}
if(a==='product-sales'){
 const event=selectedEvent(),product=store.products.find(row=>row.id===b.dataset.id);
 if(event?.status!=='active'||!product||current())return;
 if(productDirty){alert(language('먼저 변경사항을 반영하거나 새로고침하세요.','Appliquez les modifications ou actualisez la page.'));return;}
 const visible=product.stopped===true;
 if(!visible&&!confirm(language('이 상품의 추가 판매를 중지하시겠습니까? 기존 주문내역은 유지됩니다.','Suspendre les ventes de ce produit ? Les commandes existantes seront conservées.')))return;
 void run(b,async()=>{await request('setProductSales',{id:product.id,eventId:event.id,revision:event.raw.productRevision??0,visible});await load();});return;
}
if(a==='order-view'){store.orderView=b.dataset.value==='products'?'products':'orders';rerender();return;}
if(a==='product-order-detail'){productOrderDetail(b.dataset.id);return;}
if(a==='product-orders-excel'){exportProductOrders();return;}
if(a==='expense-add'){expenseModal();return;}
if(a==='expense-edit'){expenseModal(b.dataset.id);return;}
if(a==='expense-save')run(b,async()=>{const name=$('#expense-name').value.trim(),amount=Number($('#expense-amount').value);if(!name||name.length>120||!Number.isFinite(amount)||amount<=0||amount>1000000)throw new Error('항목명과 금액을 확인해 주세요.');const id=b.dataset.id||crypto.randomUUID();const expenses=[...(eventFinancialRecord.expenses||[])].filter(x=>x.id!==id);expenses.push({id,name,amountCents:Math.round(amount*100)});await persistExpenses(expenses);});
if(a==='expense-delete'){const row=(eventFinancialRecord.expenses||[]).find(x=>x.id===b.dataset.id);if(row&&confirm(row.name+' 지출을 삭제할까요?'))run(b,()=>persistExpenses((eventFinancialRecord.expenses||[]).filter(x=>x.id!==row.id)));}
if(a==='settlement-finalize')run(b,async()=>{if(!confirm('현재 매출·매입·기타 지출 내역으로 수익 결산을 확정할까요? 행사 종료/입금 대조 상태는 변경하지 않습니다.'))return;eventFinancialRecord=await request('finalizeEventFinancials',{eventId:selectedEvent().id,action:'finalize',confirm:true});rerender();});
if(a==='settlement-reopen')run(b,async()=>{
 const reason=prompt(language('결산 정정 사유를 입력하세요.','Indiquez le motif de la correction du résultat.'))?.trim();
 if(!reason)return;
 eventFinancialRecord=await request('finalizeEventFinancials',{eventId:selectedEvent().id,action:'reopen',confirm:true,reason});rerender();
});
if(a==='profit-excel'){exportProfitExcel();return;}
if(a==='profit-pdf'){exportProfitPdf();return;}
if(a==='mode-active')location.href=url('','');if(a==='show-past')pastModal();if(a==='new-event')draftModal();
if(a==='switch-catalog'){if(productDirty){alert('변경사항을 저장하거나 새로고침한 뒤 목록을 변경하세요.');return;}productView='catalog';productFilter='';rerender();}if(a==='switch-event'){if(productDirty){alert('변경사항을 저장하거나 새로고침한 뒤 목록을 변경하세요.');return;}if(!selectedEvent()){location.href=url('','');return;}productView='event';productFilter='';rerender();}if(a==='edit-product'&&(productView==='catalog'||!current()))editProduct(b.dataset.id);if(a==='edit-photo'&&(productView==='catalog'||!current()))editProduct(b.dataset.id,true);if(a==='import'&&!current())importModal();if(a==='delete-product'&&(productView==='catalog'||!current())){const ar=productView==='catalog'?store.catalog:store.products;const p=ar.find(x=>x.id===b.dataset.id);if(p&&confirm(p.ko+' 상품을 '+(productView==='catalog'?'기본 상품 목록':'이번 바자회')+'에서 삭제할까요?')){if(productView==='event'&&(allocated(p)>0||p.hasOrderHistory))p.active=false;else ar.splice(ar.indexOf(p),1);markProductDirty();rerender();}}
if(a==='add-product'){
 const ar=productView==='catalog'?store.catalog:store.products;
 const p={id:newId(),ko:'',fr:'',koDesc:'',frDesc:'',vendor:'',buy:'',sale:'',pack:1,storage:'상온',photo:'',photoPath:'',emoji:'📦',active:false,boxes:'',manualLimit:'',limitMode:'unlimited'};
 if(productView!=='catalog')return;modal('새 상품 등록','한국어와 프랑스어 이름을 입력하세요.','<div class="form-grid"><label class="field">한국어<input id="new-ko"></label><label class="field">프랑스어<input id="new-fr"></label></div>','<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="new-product-save">추가</button>');
}
if(a==='product-up'||a==='product-down'){if(current()||productView==='catalog')return;const ar=store.products,shown=shownProducts(),index=shown.findIndex(p=>p.id===b.dataset.id);const from=ar.indexOf(shown[index]),to=ar.indexOf(shown[index+(a==='product-up'?-1:1)]);if(index>=0&&from>=0&&to>=0){[ar[from],ar[to]]=[ar[to],ar[from]];markProductDirty();rerender();}}
if(a==='column-settings')columnSettings();if(a==='column-reset'){localStorage.removeItem(colKey());rerender();}if(a==='import-past-open')run(b,()=>importPastModal());
 if(a==='products-publish'&&selectedEvent()?.status==='draft')run(b,async()=>{if(!confirm('상품 변경사항을 저장하고 이 바자회를 발행할까요?'))return;await saveProducts(true);if(productValidationIssues.length)return;const event=selectedEvent();await request('publishDraft',{id:event.id,updatedAt:event.updatedAt});location.href=url('',event.id);});
 if(a==='save-product'&&(productView==='catalog'||!current()))run(b,()=>saveProducts());
 if(a==='refresh-products'&&(!productDirty||confirm('저장하지 않은 변경사항을 버리고 새로고침할까요?'))){run(b,async()=>{productDirty=false;await load();});}
 if(a==='reorder-products'&&!current()){const ps=visibleProducts();modal('상품 진열 순서 변경','위아래로 이동하세요.','<div id="reorder-list">'+ps.map(p=>'<div class="modal-row" data-reorder-id="'+p.id+'"><span>'+esc(p.ko)+'</span><div class="actions"><button class="btn neutral" data-action="move-up">↑</button><button class="btn neutral" data-action="move-down">↓</button></div></div>').join('')+'</div>','<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="reorder-save">적용</button>');}
if(a==='manual-order'&&canManageOrder())manualOrderModal();
if(a==='order-filter'){store.orderFilter=b.dataset.value;persistOrdersView();rerender();}if(a==='order-detail'){
 orderModal(b.dataset.id);
 const mail=document.createElement('div');
 mail.className='muted small';
 mail.setAttribute('role','status');
 mail.textContent='이메일 발송 상태 확인 중…';
 $('#modal-body').append(mail);
 const order=store.orders.find(order=>order.id===b.dataset.id);
 if(order&&!order.bankConfirmedAt&&!canManageOrder()){
  const review=document.createElement('button');
  review.type='button';review.className='btn neutral';review.textContent='늦은 입금 검토 등록';
  review.addEventListener('click',()=>depositModal(order.id,true));
  $('#modal-body').append(review);
 }
 void showOrderMail(b.dataset.id,mail,selectedEvent().id,request);
}
if(a==='confirm')void confirmOrder(b.dataset.id,b);
if(a==='scope'){store.settleScope=b.dataset.value;rerender();}if(a==='vendor'){store.vendor=b.dataset.value;rerender();}if(a==='po-add')addPOModal();if(a==='po-del'){const ar=editablePO(store.vendor);if(confirm('발주서에서 해당 품목을 삭제할까요? 고객 주문 원본은 유지됩니다.')){const x=ar.findIndex(p=>p.id===b.dataset.id);if(x>=0)ar.splice(x,1);rerender();}}
if(a==='po-reset'){if(confirm('이 업체 발주서의 수동 변경을 초기화할까요?')){delete store.poDrafts[store.vendor];editablePO(store.vendor);rerender();}}
if(a==='po-preview')previewPO(store.vendor);if(a==='all-po')modal('전체 업체 구매발주서 검토','업체별 구매발주서 분리 작성',vendors().map(v=>'<div class="modal-row"><b>'+esc(v)+'</b><span>'+money(poTotal(v))+'</span><button class="linkbtn" data-action="show-po" data-value="'+esc(v)+'">미리보기</button></div>').join(''),'<button class="btn neutral" data-action="close">닫기</button>');
});
$('#modal').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;
if(handleModalAction(a,b))return;
if(a==='close')closeModal();
 if(a==='column-up'||a==='column-down'){const row=b.closest('[data-column]');if(a==='column-up'&&row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling);else if(a==='column-down'&&row.nextElementSibling)row.after(row.nextElementSibling);}
if(a==='column-reset'){localStorage.removeItem(colKey());closeModal();rerender();}
 if(a==='column-save'){const rows=[...$('#column-list').children];const pref={order:rows.map(row=>row.dataset.column),hidden:rows.filter(row=>!row.querySelector('[data-column-visible]').checked).map(row=>row.dataset.column),pinned:rows.filter(row=>row.querySelector('[data-column-pinned]').checked).map(row=>row.dataset.column),widths:Object.fromEntries(rows.map(row=>[row.dataset.column,Math.max(50,Math.min(500,Number(row.querySelector('[data-column-width]').value)||100))]))};localStorage.setItem(colKey(),JSON.stringify(pref));closeModal();rerender();}
 if(a==='move-up'||a==='move-down'){const row=b.closest('[data-reorder-id]');if(a==='move-up'&&row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling);else if(a==='move-down'&&row.nextElementSibling)row.after(row.nextElementSibling);}
 if(a==='reorder-save'){const ids=[...$('#reorder-list').children].map(el=>el.dataset.reorderId);const ar=store.products;const map=new Map(ar.map(p=>[p.id,p]));ar.splice(0,ar.length,...ids.map(id=>map.get(id)),...ar.filter(p=>!ids.includes(p.id)));markProductDirty();closeModal();rerender();}
if(a==='new-product-save'){const ko=$('#new-ko').value.trim(),fr=$('#new-fr').value.trim();store.catalog.push({id:newId(),ko,fr,koDesc:'',frDesc:'',vendor:'',buy:'',sale:'',pack:1,storage:'상온',photo:'',photoPath:'',emoji:'📦',active:false,boxes:'',manualLimit:'',limitMode:'unlimited'});markProductDirty();closeModal();rerender();}
 if(a==='save-product-detail')run(b,()=>saveProductDetail(b.dataset.id));
if(a==='import-back'){importModal();return;}
if(a==='import-apply'){let ids=[...document.querySelectorAll('[data-import]:checked')].map(x=>x.dataset.import);ids.forEach(id=>{let x=store.catalog.find(p=>p.id===id);if(x){const previous=store.products.find(p=>p.id===id);if(previous)previous.active=true;else store.products.push({...defaults(x),active:true});markProductDirty();}});closeModal();rerender();}
if(a==='import-past-apply'){const ids=new Set([...document.querySelectorAll('[data-import]:checked')].map(x=>x.dataset.import));const existing=new Set(store.products.filter(p=>p.active).map(p=>(p.ko+'|'+p.fr).trim().normalize('NFC').toLocaleLowerCase()));for(const raw of importPastProducts.filter(p=>ids.has(p.id))){const p=productViewModel(raw),key=(p.ko+'|'+p.fr).trim().normalize('NFC').toLocaleLowerCase();if(existing.has(key))continue;const copy={...clone(p),id:newId(),active:true};store.products.push(copy);existing.add(key);}if(ids.size)markProductDirty();closeModal();rerender();}
if(a==='po-add-save'){const name=$('#po-new-name').value.trim(),qty=Number($('#po-new-qty').value),price=Number($('#po-new-price').value);if(!name||!(qty>0)||!(price>=0)){alert('품목명·수량·단가를 확인해 주세요.');return}editablePO(store.vendor).push({id:newId(),name,ordered:0,per:0,qty,unit:$('#po-new-unit').value,price,amount:Math.round(qty*price*100)/100,manual:true});closeModal();rerender();}
if(a==='show-po'){store.vendor=b.dataset.value;previewPO(store.vendor);}
});
$('#modal').addEventListener('change',e=>{if(e.target.matches('[data-import-all]'))$('#modal').querySelectorAll('[data-import]').forEach(box=>box.checked=e.target.checked);if(e.target.matches('[data-import]')||e.target.matches('[data-import-all]')){const count=$('#modal').querySelector('[data-import-count]');if(count)count.textContent=(fr?'Articles sélectionnés ':'선택 상품 ')+$('#modal').querySelectorAll('[data-import]:checked').length+(fr?' produit(s)':'개');}if(e.target.id==='import-past-event')void importPastModal(e.target.value).catch(error=>alert(error.message));});
let rowDrag=null;
function clearRowDrop(){
 app.querySelectorAll('.row-drop-before,.row-drop-after').forEach(row=>row.classList.remove('row-drop-before','row-drop-after'));
}
app.addEventListener('pointerdown',event=>{
 const handle=event.target.closest('.drag-handle');
 const row=handle?.closest('[data-sort-row]');
 if(!row||event.button!==0||current()||productView==='catalog')return;
 rowDrag={id:row.dataset.sortRow,pointer:event.pointerId,y:event.clientY};
 handle.setPointerCapture(event.pointerId);
 event.preventDefault();
});
app.addEventListener('pointermove',event=>{
 if(rowDrag?.pointer!==event.pointerId)return;
 clearRowDrop();
 rowDrag.target=null;
 if(Math.abs(event.clientY-rowDrag.y)<4)return;
 const row=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-sort-row]');
 if(!row||!app.contains(row))return;
 const box=row.getBoundingClientRect();
 rowDrag.target=row.dataset.sortRow;
 rowDrag.after=event.clientY>box.top+box.height/2;
 row.classList.add(rowDrag.after?'row-drop-after':'row-drop-before');
});
for(const type of ['pointerup','pointercancel','lostpointercapture'])app.addEventListener(type,event=>{
 if(rowDrag?.pointer!==event.pointerId)return;
 const {id,target,after}=rowDrag;
 rowDrag=null;
 clearRowDrop();
 if(type!=='pointerup'||!target||id===target)return;
 const rows=store.products;
 const from=rows.findIndex(p=>p.id===id),to=rows.findIndex(p=>p.id===target);
 if(from<0||to<0)return;
 const [product]=rows.splice(from,1);
 rows.splice(to+(after?1:0)-(from<to?1:0),0,product);
 markProductDirty();
 rerender();
});
app.addEventListener('change',e=>{const el=e.target;if(page==='products'&&current()&&productView!=='catalog'||page==='settlement'&&!canEditPurchase())return;if(el.dataset.prod){if(!el.matches('input'))productChange(el);else if(el.dataset.key==='roi'){const p=(productView==='catalog'?store.catalog:store.products).find(p=>p.id===el.dataset.prod);el.value=p&&unit(p)>0&&p.sale!==''?roi(p):'';}return;}if(el.dataset.toggle){let p=store.products.find(p=>p.id===el.dataset.toggle);if(p)p.active=el.checked;return}if(el.dataset.po){poChange(el);return}if(el.id==='order-mobile-sort'){store.sortAsc=store.sortKey===el.value?!store.sortAsc:true;store.sortKey=el.value;persistOrdersView();rerender();return}if(el.id==='product-order-sort'){store.productOrderSort=el.value;rerender();return}});
app.addEventListener('input',e=>{const el=e.target;if(el.matches('input[data-prod]')&&(productView==='catalog'||!current())){productChange(el);return;}if(el.id==='product-search'){productFilter=el.value;const pos=el.selectionStart;rerender();const n=$('#product-search');n.focus();n.setSelectionRange(pos,pos)}if(el.id==='order-search'){store.search=el.value;persistOrdersView();const pos=el.selectionStart;rerender();const n=$('#order-search');n.focus();n.setSelectionRange(pos,pos)}});
function quantityByUnit(lines){
 const totals=new Map();
 for(const line of lines)totals.set(line.unit,(totals.get(line.unit)||0)+line.qty);
 return [...totals].map(([unit,qty])=>qty+' '+unit).join(' · ')||'0';
}
function poMeta(v){
 const event=selectedEvent();
 if(!event||!v)return {};
 return event.poMeta[v]??={number:'ASICC-'+event.round+'-'+(Object.keys(event.poMeta).length+1),
  date:new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Paris'}), contact:'',email:'',deliveryDate:'',location:'',notes:'',owner:''};
}
function poWarning(line){
 if(line.manual)return '';
 const capacity=line.unit==='박스'?line.qty*line.per:line.unit==='개'?line.qty:null;
 const need=demands().find(p=>p.id===line.id)?.ordered??0;
 return capacity!==null&&capacity<need?' · 발주 수량 부족 ('+(need-capacity)+'개)':'';
}
const metadata=[
 ['number','발주번호'],['date','발주일','date'],['contact','업체 담당자'],['email','업체 연락처'],
 ['deliveryDate','납품일','date'],['location','납품 장소'],['notes','전달사항'],['owner','발주 담당자']
];
function poSettings(){
 const meta=poMeta(store.vendor);
 modal('발주 정보 편집',store.vendor,'<div class="form-grid">'+metadata.map(([key,title,type])=>'<label class="field">'+title+'<input id="meta-'+key+'" type="'+(type||'text')+'" value="'+esc(meta[key])+'"></label>').join('')+'</div>',
 '<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="save-meta">적용</button>');
}
function purchaseRows(vendor){
 const meta=poMeta(vendor);
 return [
 ['ASICC','Association de la Section Internationale Coréenne à Courbevoie'],
 ['연락 이메일','contact@asicc-parents.fr'],['Bon de commande / 구매발주서',selectedEvent().name],['공급업체',vendor],
 ...metadata.map(([key,caption])=>[caption,meta[key]??'']),
 [],
 ['품목','발주수량','단위','매입 단가 TTC (€)','소계 TTC (€)'],
 ...makePO(vendor).map(p=>[p.name,p.qty,p.unit,p.price,p.amount]),
 ['총 매입 TTC (€)','','','',finance(poTotal(vendor))]
 ];
}
function exportExcel(list){
 if(!list.length)return;
 const workbook=XLSX.utils.book_new();
 list.forEach((vendor,i)=>{
  const sheet=XLSX.utils.aoa_to_sheet(purchaseRows(vendor));
  sheet['!cols']=[{wch:35},{wch:48},{wch:15},{wch:22},{wch:22}];
  XLSX.utils.book_append_sheet(workbook,sheet,'업체 '+(i+1));
 });
 XLSX.writeFile(workbook,'ASICC-'+(list.length>1?'전체':'업체')+'-구매발주서.xlsx');
}
function exportPdf(list){
 if(!list.length)return;
 const pdf=new jspdf.jsPDF();let first=true;
 for(const vendor of list){
  const canvas=document.createElement('canvas');canvas.width=1120;canvas.height=1580;
  const ctx=canvas.getContext('2d');let y=0;
  function start(){
   ctx.fillStyle='#fff';ctx.fillRect(0,0,1120,1580);
   ctx.fillStyle='#81364d';ctx.font='bold 36px system-ui';ctx.fillText('ASICC  ·  BON DE COMMANDE',55,80);
   ctx.fillStyle='#262127';ctx.font='24px system-ui';y=130;
  }
  function finish(){if(!first)pdf.addPage();first=false;pdf.addImage(canvas.toDataURL('image/png'),'PNG',5,5,200,282);}
  function wrap(text,width){
   return String(text??'').split('\n').flatMap(part=>{
    const lines=[];let current='';
    for(const char of part){if(current&&ctx.measureText(current+char).width>width){lines.push(current);current='';}current+=char;}
    return [...lines,current];
   });
  }
  start();
  for(const row of purchaseRows(vendor)){
   const xs=row.length===5?[55,465,600,740,920]:[55,350];
   const widths=row.length===5?[395,124,129,166,148]:[275,680];
   const columns=row.map((value,i)=>wrap(value,widths[i]));
   const count=Math.max(1,...columns.map(lines=>lines.length));
   for(let i=0;i<count;i++){
    if(y>1505){finish();start();}
    columns.forEach((lines,j)=>ctx.fillText(lines[i]||'',xs[j],y));y+=37;
   }
  }
  finish();
 }
 pdf.save('ASICC-'+(list.length>1?'전체':'업체')+'-구매발주서.pdf');
}
function exportAction(action){
 const all=action.startsWith('all-');
 const list=all?vendors():[store.vendor].filter(Boolean);
 if(action.endsWith('pdf'))exportPdf(list);else exportExcel(list);
}
async function saveProducts(publishing=false){
 const e=selectedEvent();
 const catalog=productView==='catalog';
 const products=catalog?store.catalog:store.products;
 const issues=[];
 productValidationIssues=[];
 const strict=publishing===true||(!catalog&&e.status!=='draft');
 if(strict)for(const [i,p] of products.entries()){
  if(!p.active)continue;
  const errors=[];
  if(!p.ko?.trim())errors.push(['ko','한국어 상품명']);if(!p.fr?.trim())errors.push(['fr','프랑스어 상품명']);
  if(!p.vendor?.trim())errors.push(['vendor','공급업체']);
  if(p.buy===''||!Number.isFinite(Number(p.buy))||Number(p.buy)<0)errors.push(['buy','매입가/박스 TTC']);
  if(p.pack===''||!Number.isInteger(Number(p.pack))||Number(p.pack)<1)errors.push(['pack','박스당 수량']);
  if(!p.storage||!['상온','냉장','냉동'].includes(p.storage))errors.push(['storage','보관 방법']);
  if(p.sale===''||!Number.isFinite(Number(p.sale))||Number(p.sale)<=0)errors.push(['sale','개당 판매가 계산']);
  if(productView==='event'){
   if(!['auto','manual','unlimited'].includes(p.limitMode))errors.push(['limitMode','판매한도 방식']);
   if(p.limitMode==='auto'&&(p.boxes===''||!Number.isInteger(Number(p.boxes))||Number(p.boxes)<0))errors.push(['boxes','예상 박스']);
   if(p.limitMode==='manual'&&(p.manualLimit===''||!Number.isInteger(Number(p.manualLimit))||Number(p.manualLimit)<0))errors.push(['manualLimit','수동 판매한도']);
   if(p.limitMode==='auto'&&p.boxes!==''&&Number(p.boxes)*Number(p.pack)<allocated(p))errors.push(['boxes','현재 주문 수량 이상 판매한도']);
   if(p.limitMode==='manual'&&p.manualLimit!==''&&Number(p.manualLimit)<allocated(p))errors.push(['manualLimit','현재 주문 수량 이상 판매한도']);
  }
  for(const [field,label] of errors)issues.push({index:i+1,id:p.id,name:p.ko||p.fr||'이름 없는 상품',field,label,hidden:getColumnPrefs()?.hidden?.includes(({ko:'title-ko',fr:'title-fr',vendor:'supplier',buy:'buy-box',pack:'box-qty',sale:'sell-price',storage:'storage',boxes:'planned-boxes','limitMode':'limit-mode','manualLimit':'limit'})[field])});
 }
 if(issues.length){productValidationIssues=issues;modal('저장할 수 없습니다','필수입력 또는 숫자 범위를 확인하세요.',banner('필수입력 항목이 누락되었거나 유효하지 않은 상품 '+new Set(issues.map(x=>x.id)).size+'개입니다.','warning')+'<ul class="validation-list">'+issues.map(x=>'<li><b>'+esc(x.name)+'</b> — '+esc(x.label)+(x.hidden?' · 현재 숨겨진 열입니다.':'')+'</li>').join('')+'</ul>','<button class="btn neutral" data-action="close">닫기</button><button class="btn primary" data-action="product-validation-focus">오류 항목 표시 및 수정</button>');return;}
 const items=(catalog?products:products.filter(p=>p.active||p.stopped)).map(productPayload);
 if(catalog){
  const saved=await request('saveCatalog',{revision:catalogRevision,items});
  catalogRevision=saved.revision;model.catalog=saved.items.map(productViewModel);
 }else if(e.status==='draft'){
  const saved=await request('saveDraft',{id:e.id,updatedAt:e.updatedAt,event:e.raw,items});
  const {draft}=await request('getDraft',{id:e.id});
  if(draft.updatedAt!==saved.updatedAt)throw new Error('다른 운영진이 초안을 변경했습니다. 다시 열어 주세요.');
  model.draft=eventViewModel(draft.event,draft.items);model.draft.updatedAt=draft.updatedAt;
 }else{
  await request('saveEventProducts',{eventId:e.id,revision:e.raw.productRevision??0,items});
  await load();
 }
 productDirty=false;rerender();
 $('#product-status').textContent=fr?'✓ Enregistré':'✓ 저장 완료';
}
let productValidationIssues=[];
async function saveProductDetail(id){
 const catalog=productView==='catalog';
 const p=(catalog?store.catalog:store.products).find(product=>product.id===id);
 if(!p)return;
 const edits=$('#edit-kod')?{koDesc:$('#edit-kod').value,frDesc:$('#edit-frd').value}:{};
 const file=$('#edit-photo')?.files[0];
 if($('#photo-remove')?.checked){p.photo='';p.photoPath='';}else if($('#photo-url')&&$('#photo-url').value.trim()!==p.photo&&!file){p.photo=$('#photo-url').value.trim();p.photoPath='';}
 if(file){
  if(file.size>1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type))
   throw new Error('1MB 이하 JPEG·PNG·WebP 사진을 선택해 주세요.');
  const content=await new Promise((resolve,reject)=>{
   const reader=new FileReader();
   reader.onload=()=>resolve(String(reader.result).split(',')[1]);
   reader.onerror=()=>reject(new Error('사진을 읽지 못했습니다.'));
   reader.readAsDataURL(file);
  });
  const e=selectedEvent();
  const saved=await request('storePhoto',{
   eventId:catalog?'base-catalog':e.id,catalog,draft:!catalog&&e.status==='draft',
   updatedAt:catalog?undefined:e.updatedAt,id,content,
  });
  p.photo=saved.imageUrl;p.photoPath=saved.photoPath;
 }
 Object.assign(p,edits);
 markProductDirty();closeModal();rerender();
}
async function savePurchase(confirmOrder){
 assertConfirmedScope();
 const isClosed=current();
 if(isClosed&&!confirm(closedPurchaseWarning+'\n\n변경사항을 저장할까요?'))return;
 const vendor=store.vendor,meta=poMeta(vendor);
 const lines=makePO(vendor).map(({price,amount,...row})=>({...row,priceCents:Math.round(price*100),amountCents:Math.round(amount*100)}));
 const result=await request('savePurchaseOrder',{
  eventId:selectedEvent().id,vendor,lines,info:meta,revision:meta.revision??0,confirm:confirmOrder,confirmClosedEdit:isClosed,
 });
 Object.assign(meta,{confirmed:result.confirmed,revision:result.revision,savedAt:result.updatedAt});
 rerender();
}
let previewSnapshot=null,previewLanguage='ko',previewDevice='desktop',previewCart={};
function openShopPreview(snapshot=selectedEvent(),language='ko',device='desktop'){
 previewSnapshot=snapshot;previewLanguage=language;previewDevice=device;
 const e=snapshot;if(!e)return;
 const ko=language==='ko';
 const products=(e.products||[]).filter(p=>p.active!==false);
 const items=renderShopProducts(products.map(p=>({
  ...productPayload(p),priceCents:Math.round(Number(p.sale)*100),
  stockRemaining:Number.isFinite(lim(p))?Math.max(0,lim(p)-allocated(p)):null
 })),language,{
  quantity:p=>Math.min(quantityCap(p.stockRemaining),previewCart[p.id]||0),
  price:value=>money(value/100),
  controls:(p,qty,sold)=>{
   const step=(amount,label,disabled)=>'<button type="button" data-action="preview-step" data-id="'+esc(p.id)+'" data-step="'+amount+'" '+(disabled?'disabled':'')+'>'+label+'</button>';
   return '<div class="bz-qty">'+step(-1,'−',sold||qty<=0)+'<span>'+qty+'</span>'+step(1,'+',sold||qty>=quantityCap(p.stockRemaining))+'</div>';
  }
 });
 const itemsQtyControls=(id,qty,p)=>{
  const cap=quantityCap(Number.isFinite(lim(p))?Math.max(0,lim(p)-allocated(p)):null);
  const step=(delta,label,disabled)=>'<button type="button" data-action="preview-step" data-id="'+esc(id)+'" data-step="'+delta+'" '+(disabled?'disabled':'')+'>'+label+'</button>';
  return '<div class="bz-qty">'+step(-1,'−',false)+qty+step(1,'+',qty>=cap)+'</div>';
 };
 const cart=Object.entries(previewCart).filter(([,qty])=>qty>0).map(([id,qty])=>{const p=products.find(item=>item.id===id);return p?'<div class="bz-cart-row"><span>'+esc(ko?p.ko:p.fr)+'</span>'+itemsQtyControls(id,qty,p)+'<b>'+money(p.sale*qty)+'</b></div>':''}).join('');
 const cartTotal=Object.entries(previewCart).reduce((sum,[id,qty])=>sum+(products.find(p=>p.id===id)?.sale||0)*qty,0);
 const width=device==='mobile'?'390px':'100%';
 const body='<div class="actions" style="margin-bottom:14px"><button class="filter '+(ko?'active':'')+'" data-action="preview-lang" data-value="ko">한국어</button><button class="filter '+(!ko?'active':'')+'" data-action="preview-lang" data-value="fr">Français</button><button class="filter '+(device==='desktop'?'active':'')+'" data-action="preview-device" data-value="desktop">PC</button><button class="filter '+(device==='mobile'?'active':'')+'" data-action="preview-device" data-value="mobile">모바일</button></div><div class="preview-shop-shell bz-shared-preview" data-device="'+device+'" style="max-width:'+width+';margin:auto"><div class="bz-note">'+esc(ko?'미리보기 전용 · 실제 주문·재고 차감·이메일 발송은 실행되지 않습니다.':'Aperçu uniquement · aucune commande réelle, modification de stock ou e-mail.')+'</div>'+renderShopEvent(e.raw||{},language)+'<h2>'+esc(ko?'상품 목록':'Nos produits')+'</h2>'+items+'<section class="bz-basket"><h2>'+esc(ko?'미리보기 장바구니':'Panier de prévisualisation')+'</h2>'+ (cart||'<p class="muted">'+esc(ko?'수량을 선택하면 여기에 표시됩니다.':'Les quantités choisies apparaîtront ici.')+'</p>')+'<div class="bz-total"><span>'+esc(ko?'합계':'Total')+'</span><strong>'+money(cartTotal)+'</strong></div><label>'+esc(ko?'이름':'Nom')+'<input disabled placeholder="'+esc(ko?'미리보기':'Aperçu')+'"></label><label>'+esc(ko?'전화번호':'Téléphone')+'<input disabled></label><label>'+esc(ko?'이메일':'E-mail')+'<input disabled></label><button class="bz-btn" disabled>'+esc(ko?'주문 접수 (미리보기에서는 비활성화)':'Commander (désactivé en aperçu)')+'</button></section></div>';
 modal(ko?'구매자 화면 미리보기':'Aperçu de la boutique','',body,'<button class="btn neutral" data-action="preview-edit">'+(ko?'닫기':'Fermer')+'</button>');
}
function readDraftForm(){return eventFormFields(id=>$('#'+id)?.value||'');}
function handleScreenAction(action,button){
 if(action==='order-list-excel'){exportOrderList();return true;}
 if(action==='pickup-excel'){exportPickupOrders();return true;}
 if(action==='order-sort-column'){const key=button.dataset.key;store.sortAsc=store.sortKey===key?!store.sortAsc:true;store.sortKey=key;persistOrdersView();rerender();return true;}
 if(action==='transfer-admin'){
  const order=store.orders.find(o=>o.id===button.dataset.id);if(!order)return true;
  const undo=order.status==='reported',reason=prompt(undo?language('정정 사유 (필수)','Motif obligatoire'):language('고객의 송금 통보 내용 (선택)','Note du client (facultatif)'));
  if(reason!==null&&(!undo||reason.trim()))run(button,async()=>{await request('adminTransferReport',{id:order.id,eventId:selectedEvent().id,undo,reason,confirm:true});await load();});return true;
 }
 if(action==='settlement-tab'){settlementTab=button.dataset.tab;rerender();return true;}
 if(action==='refund-open'){run(button,()=>refundModal(button.dataset.id));return true;}
 if(['all-pdf','all-excel','one-pdf','one-excel'].includes(action)){run(button,async()=>{assertConfirmedScope();exportAction(action);});return true;}
 const e=selectedEvent();
 if(action==='copy-banner'||action==='copy-event'){
  const address=action==='copy-banner'?'bazaar/?event='+encodeURIComponent(e.id):new URL(publicEventPath(e.id),location.origin).href;
  run(button,async()=>{await navigator.clipboard.writeText(address);button.closest('details').open=false;root.querySelector('[data-copy-status]').textContent=(fr?'Lien copié : ':'복사했습니다 · ')+address;});return true;
 }
 if(action==='draft-list'){modal('임시저장 행사 선택','',model.drafts.map(d=>'<p><a class="btn neutral" href="'+esc(url('',d.id))+'">'+esc(d.nameKo)+'</a></p>').join('')||'임시저장 행사가 없습니다.');return true;}
 if(action==='event-filter'){const query=new URLSearchParams(params);query.delete('event');query.set('status',button.dataset.value);location.href=url('',null)+'?'+query;return true;}
 if(action==='new-event'){draftModal();return true;}
 if(action==='preview-shop'){openShopPreview(selectedEvent());return true;}
 if(action==='refresh-orders'){run(button,load);return true;}
 if(action==='csv-orders'){const rows=[['주문번호','성함','전화','이메일','품목','금액','상태'],...store.orders.map(o=>[o.ref,o.name,o.phone,o.email,o.items.map(i=>i[0]+' ×'+i[1]).join(' / '),total(o).toFixed(2),statuses[o.status][0]])];const csv='\uFEFF'+rows.map(row=>row.map(v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(';')).join('\r\n');const uri=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=uri;a.download='ASICC_orders.csv';a.click();URL.revokeObjectURL(uri);return true;}
 if(action==='finalize-unpaid'){if(prompt('은행 최종 대조 완료 후 미입금 주문을 취소합니다. 계속하려면 최종 확인을 입력하세요.')==='최종 확인')run(button,async()=>{let count=0,result;do{result=await request('finalizeUnpaid',{eventId:e.id,confirm:true});count+=result.canceled||0;}while(result.pending);alert(count+'건 취소 완료');location.href=url('',e.id);});return true;}
 if(action==='closed-archive'){
  const archived=!!model.events.find(event=>event.id===e.id)?.hiddenAt;
  run(button,async()=>{await request('archiveClosedEvent',{eventId:e.id,archive:!archived});await load();});return true;
 }
 if(action==='closed-export'){
  run(button,async()=>{
   const record=await request('closedEventData',{eventId:e.id});
   const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));
   const link=document.createElement('a');link.href=url;link.download='ASICC-'+e.id+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });return true;
 }
 if(action==='closed-delete'){
  const name=prompt(fr?'Saisissez le titre coréen exact pour supprimer ce bazar sans historique : '+e.raw.nameKo:'거래 기록이 없는 행사의 상품 사본과 행사 기록을 삭제하려면 행사명을 입력하세요: '+e.raw.nameKo);
  if(name!==e.raw.nameKo)return true;
  run(button,async()=>{await request('deleteClosedEvent',{eventId:e.id,name,confirm:true});location.href=url('',null);});return true;
 }
 if(action==='mail-settings'){
  modal(fr?'Paramètres des e-mails':'이메일 발송 설정','','<div id="event-mail-settings"></div>');
  mountMailManager($('#event-mail-settings'),e,store.orders,request,e?.status==='draft'||canManageOrder(),true);
  return true;
 }
 if(action==='edit-draft'){draftModal(true);return true;}
 if(action==='delete-draft'){
  if(e?.status==='draft'&&confirm('임시저장을 삭제할까요?'))run(button,async()=>{
   await request('deleteDraft',{id:e.id,confirm:true});location.href=url('','');
  });
  return true;
 }
 if(action==='publish-draft'){
  if(e?.status==='draft'&&confirm('바자회를 발행할까요? 저장된 내용이 방문객에게 공개됩니다.'))run(button,async()=>{
   await request('publishDraft',{id:e.id,updatedAt:e.updatedAt});location.href=url('',e.id);
  });
  return true;
 }
 if(action==='end-event'){
  if(e===model.active&&confirm('행사를 종료하고 기록을 보관할까요?'))run(button,async()=>{
   await request('endEvent',{eventId:e.id,confirm:true});location.href=url('',e.id);
  });
  return true;
 }
 const readonlyActions=['add-product','delete-product','save-product','edit-product','import','edit-photo','reorder-products'];
 if(current()&&productView!=='catalog'&&readonlyActions.includes(action))return true;
 if(action==='po-new-vendor'){
  if(current()&&canEditPurchase())addPurchaseVendor();
  return true;
 }
 const poActions=['po-add','po-del','po-reset','po-settings','po-save','po-confirm'];
 if(poActions.includes(action)&&!canEditPurchase())return true;
 if(action==='po-settings'){poSettings();return true;}
 if(action==='po-save'){run(button,()=>savePurchase(false));return true;}
 if(action==='po-confirm'){
  if(current()||confirm('발주서를 확정할까요? 진행 중에는 확정한 발주서를 수정할 수 없습니다.'))
   run(button,()=>savePurchase(true));
  return true;
 }
 return false;
}
const canReconcile=()=>!!selectedEvent()&&(selectedEvent()===model.active||selectedEvent().raw?.eventId===latestEventId);
let latestEventId;
async function confirmOrder(id){
 const order=store.orders.find(order=>order.id===id);
 if(!canReconcile()||!order||!['reported','unpaid'].includes(order.status))return;
 depositModal(id,true);
}
function handleModalAction(action,button){
 const id=button.dataset.id;
 if(action==='import-past-open'){run(button,()=>importPastModal());return true;}
 if(action==='import-back'){importModal();return true;}
 if(action==='product-validation-focus'){
  const pref=getColumnPrefs()||{},titles={ko:'title-ko',fr:'title-fr',vendor:'supplier',buy:'buy-box',pack:'box-qty',sale:'sell-price',storage:'storage',boxes:'planned-boxes',limitMode:'limit-mode',manualLimit:'limit'};
  pref.hidden=(pref.hidden||[]).filter(name=>!productValidationIssues.some(issue=>issue.hidden&&titles[issue.field]===name));localStorage.setItem(colKey(),JSON.stringify(pref));productFilter='';closeModal();rerender();
  const issue=productValidationIssues[0],row=issue&&app.querySelector('[data-row="'+issue.id+'"]');row?.scrollIntoView({block:'center'});
  const target=row?.querySelector('[data-key="'+issue.field+'"], [data-derived="'+issue.field+'"]');
  if(target){const sheet=target.closest('.sheet');if(sheet)sheet.scrollLeft=Math.max(0,target.offsetLeft-80);target.classList.add('invalid');target.focus?.();}
  if(row)row.style.outline='2px solid #b52c2c';return true;
 }
 if(action==='manual-order'&&canManageOrder()){manualOrderModal(id);return true;}
 if(action==='manual-order-review'&&canManageOrder()){reviewManualOrder(id);return true;}
 if(action==='manual-order-back'&&manualRequest){manualOrderModal(manualRequest.data.parentId,manualRequest.data);return true;}
 if(action==='manual-order-submit'&&canManageOrder()){run(button,submitManualOrder);return true;}
 if(action==='refund-open'){run(button,()=>refundModal(id));return true;}
 if(action==='refund-table'){run(button,refundTable);return true;}
 if(action==='refund-detail'){run(button,()=>refundDetail(id,button.dataset.refund));return true;}
 if(action==='refund-edit-form'){run(button,()=>refundEdit(id,button.dataset.refund));return true;}
 if(action==='refund-select'){run(button,()=>refundModal($('#refund-select').value));return true;}
 if(action==='refund-save'){run(button,()=>saveRefund(id));return true;}
 if(action==='refund-complete-form'){completeRefundForm(id,button.dataset.refund);return true;}
 if(action==='refund-finish'){
  if(showFieldIssues([
   [$('#refund-actual'),!$('#refund-actual').value?language('실제 환불 일시를 입력하세요.','Indiquez la date et l’heure du remboursement.'):''],
   [$('#refund-actual-operator'),!$('#refund-actual-operator').value.trim()?language('환불 담당자를 입력하세요.','Indiquez le responsable.'):''],
  ]))return true;
  if(confirm(language('은행 환불이 실제로 완료되었습니까?','Le remboursement bancaire a-t-il été effectué ?')))run(button,async()=>{
   await request('finishRefund',{id,eventId:selectedEvent().id,requestId:button.dataset.refund,completedAt:parisToIso($('#refund-actual').value),
    operator:$('#refund-actual-operator').value,reference:$('#refund-actual-reference').value,confirm:true});await load();await refundModal(id);
  });return true;
 }
 if(action==='refund-void'||action==='refund-void-restore'){
  const restoreOrder=action==='refund-void-restore';
  const reason=prompt(restoreOrder?language('상품 복원 및 환불 등록 취소 사유','Motif de l’annulation avec rétablissement des articles'):
   language('대기 취소 사유 (상품 주문은 복원되지 않습니다)','Motif de l’annulation sans rétablissement des articles'));
  if(reason?.trim())run(button,async()=>{await request('voidRefund',{id,eventId:selectedEvent().id,reason,restoreOrder,requestId:button.dataset.refund,confirm:true});await load();await refundDetail(id,button.dataset.refund);});return true;
 }
 if(action==='print-order'){
  root.classList.add('print-order');
  try{window.print();}finally{root.classList.remove('print-order');}
  return true;
 }
 if(action==='order-payments'){run(button,()=>openOrderPayments(id));return true;}
 if(action==='deposit-add'){depositModal(id);return true;}
 if(action==='deposit-edit'){run(button,()=>editDeposit(id,button.dataset.entry));return true;}
 if(action==='ledger-record'){run(button,()=>recordPayment(button));return true;}
 if(action==='paid-cancel'){
  const reason=$('#paid-cancel-reason').value.trim();
  if(!reason){alert(fr?'Indiquez un motif.':'취소 사유를 입력해 주세요.');return true;}
  const restoreStock=$('#paid-cancel-restore')?.checked??false;
  if(confirm(fr?'Annuler la commande sans effectuer de remboursement bancaire ?':'이 주문을 취소할까요? 실제 은행 환불은 별도입니다.'))
   run(button,async()=>{await request('cancelOrder',{id,eventId:selectedEvent().id,reason,restoreStock,confirm:true});await load();await openOrderPayments(id);});
  return true;
 }
 if(action==='order-correct'){correctionModal(id);return true;}
 if(action==='order-correct-save'){run(button,()=>saveCorrection(id));return true;}
 if(action==='order-history'){run(button,()=>showOrderHistory(id));return true;}
 if(action==='confirm'){void confirmOrder(button.dataset.id,button);return true;}
 if(action==='open-past'){
  const record=model.past[Number($('#past-selector').value)];
  if(record)location.href=url('',record.id);
  return true;
 }
 if(action==='preview-draft-form'){
  const fields=readDraftForm(),existing=$('#event-name').dataset.edit==='true'?selectedEvent():null;
  if(!fields.nameKo||!fields.nameFr){alert('한국어와 프랑스어 행사명을 입력해 주세요.');return true;}
  const base=existing?.raw||{};
  const event={...base,...fields};previewSnapshot={id:existing?.id,updatedAt:existing?.updatedAt,status:'draft',name:fields.nameKo,raw:event,products:existing?.products||[],orderDeadline:fields.orderCutoff?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(new Date(fields.orderCutoff)).replace(' ','T'):'',transferDeadline:fields.transferCutoff?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(new Date(fields.transferCutoff)).replace(' ','T'):'',pickupKo:fields.pickupKo,pickupFr:fields.pickupFr};
  openShopPreview(previewSnapshot);return true;
 }
 if(action==='preview-lang'||action==='preview-device'){openShopPreview(previewSnapshot,action==='preview-lang'?button.dataset.value:previewLanguage,action==='preview-device'?button.dataset.value:previewDevice);return true;}
 if(action==='preview-edit'){closeModal();return true;}
 if(action==='preview-step'){
  const product=previewSnapshot?.products?.find(p=>p.id===id);
  if(!product)return true;
  const stock=Number.isFinite(lim(product))?Math.max(0,lim(product)-allocated(product)):null;
  changeCartQuantity(previewCart,id,Number(button.dataset.step||0),stock);
  openShopPreview(previewSnapshot,previewLanguage,previewDevice);return true;
 }
 if(action==='past-prev'||action==='past-next'){
  const selector=$('#past-selector'),length=model.past.length;
  selector.value=(Number(selector.value)+(action==='past-next'?1:-1)+length)%length;return true;
 }
 if(action==='create-draft'){
  run(button,async()=>{
   const nameKo=$('#event-name').value.trim(),nameFr=$('#event-name-fr').value.trim();
   if(!nameKo||!nameFr)throw new Error('한국어와 프랑스어 행사명을 입력해 주세요.');
   const fields=readDraftForm();
   if(fields.iban&&!/^FR\d{2}[A-Z0-9]{23}$/.test(fields.iban.replaceAll(' ','').toUpperCase()))throw new Error('IBAN을 확인해 주세요.');
   if(fields.orderCutoff&&fields.transferCutoff&&fields.orderCutoff>=fields.transferCutoff)
    throw new Error('송금 마감은 주문 마감 이후로 설정해 주세요.');
   const existing=$('#event-name').dataset.edit==='true'?selectedEvent():null;
   if(existing?.status==='active'){await request('saveEvent',{eventId:existing.id,...fields});closeModal();await load();return;}
   const draft=existing?{id:existing.id,updatedAt:existing.updatedAt,event:existing.raw,items:existing.products.map(productPayload)}:(await request('createDraft')).draft;
   let items=draft.items;
   if(!existing&&$('#copy-products-from')?.value){
    const source=await request('dashboard',{eventId:$('#copy-products-from').value});
    items=source.products.map(p=>({...productPayload(productViewModel(p)),id:newId(),included:p.active!==false}));
   }
   await request('saveDraft',{id:draft.id,updatedAt:draft.updatedAt,event:{...draft.event,...fields},items});
   location.href=url('',draft.id);
  });
  return true;
 }
 if(action==='po-vendor-save'){
  if(!current()||!canEditPurchase())return true;
  const vendor=$('#po-vendor-name').value.trim();
  if(!vendor){alert('공급업체명을 입력해 주세요.');return true;}
  if(!vendors().includes(vendor))store.poDrafts[vendor]=[];
  store.vendor=vendor;
  closeModal();rerender();return true;
 }
 if(action==='save-meta'){
  if(canEditPurchase())
   for(const [key] of metadata)poMeta(store.vendor)[key]=$('#meta-'+key).value;
  closeModal();rerender();return true;
 }
 if(action==='cancel-order'){
  const order=store.orders.find(o=>o.id===button.dataset.id);
  if(canReconcile()&&order&&['reported','unpaid'].includes(order.status)&&confirm(order.ref+' 주문을 취소하고 고객에게 알릴까요?'))
   run(button,async()=>{
    await request('cancelOrder',{id:order.id,eventId:selectedEvent().id,confirm:true});closeModal();await load();
   });
  return true;
 }
 if(['all-pdf','all-excel','one-pdf','one-excel'].includes(action)){run(button,async()=>{assertConfirmedScope();exportAction(action);});return true;}
 if(current()&&productView!=='catalog'&&['save-product-detail','import-apply','reorder-save'].includes(action))return true;
 if(action==='po-add-save'&&!canEditPurchase())return true;
 return false;
}

onAuthStateChanged(bazaarAuth,async user=>{
 const version=++authVersion;
 closeModal();$('#admin-actions').hidden=true;app.replaceChildren();
 model.active=null;model.draft=null;model.past=[];model.drafts=[];model.catalog=[];
 if(!user){
  if(showBazaarTestLogin(app))return;
  const anchor=document.createElement('a');
  anchor.href=root.dataset.login;anchor.textContent='운영진 계정으로 로그인해 주세요.';
  app.append(anchor);return;
 }
 try{
  await user.reload();await user.getIdToken(true);
  if(version===authVersion)await load();
 }catch(error){if(version===authVersion)app.textContent=error.message||'관리자 화면을 불러오지 못했습니다.';}
});
})();
