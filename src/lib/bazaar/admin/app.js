import {onAuthStateChanged} from 'firebase/auth';
import {adminAction,bazaarAuth,showBazaarTestLogin} from '../api';
import {eventViewModel,parisToIso,productPayload,productViewModel} from './data';
import {mountMailManager,showOrderMail} from './mail';

(function(){'use strict';
const root=document.querySelector('#approved-admin');
const page=root.dataset.page,$=s=>root.querySelector(s),app=$('#app');
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
 try{await work();}catch(error){alert(error.message||'처리하지 못했습니다. 다시 시도해 주세요.');}
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
 }
 $('#admin-actions').hidden=false;
 rerender();
}
const store={search:'',orderFilter:'all',orderSort:'new',settleScope:'confirmed',vendor:'업체 A',
 get catalog(){return model.catalog;},get products(){return selectedEvent()?.products??[];},
 get orders(){return selectedEvent()?.orders??[];},get poDrafts(){return selectedEvent()?.poDrafts??{};},
 get mode(){return model.view;},set mode(value){model.view=value==='active'&&!model.active?'empty':value;},
 get history(){return model.history;},
};
const finance=n=>Math.round((Number(n)||0)*100)/100;
const defaults=p=>({...clone(p),boxes:'',limitMode:'unlimited',manualLimit:''});
const allocated=p=>store.orders.filter(o=>o.status!=='canceled').reduce((sum,o)=>sum+o.items.reduce((n,i)=>n+(i[3]===p.id?Number(i[1]):0),0),0);
const statuses={unpaid:['송금 신고 없음','unpaid'],reported:['송금 신고 접수','reported'],confirmed:['입금 확인 완료','confirmed'],canceled:['취소','canceled']};
function total(o){return o.items.reduce((s,x)=>s+x[1]*x[2],0)}
function stats(){let valid=store.orders.filter(x=>x.status!=='canceled'),confirmed=store.orders.filter(x=>x.status==='confirmed');return [['총 주문',valid.length+'건'],['총 주문금액',money(valid.reduce((s,x)=>s+total(x),0))],['입금 확인액',money(confirmed.reduce((s,x)=>s+total(x),0))],['입금 확인 대기',store.orders.filter(x=>['reported','unpaid'].includes(x.status)).length+'건']];}
function metrics(xs){return '<div class="metrics">'+xs.map(x=>'<div class="metric"><span>'+x[0]+'</span><strong>'+x[1]+'</strong>'+(x[2]?'<small>'+x[2]+'</small>':'')+'</div>').join('')+'</div>'}
function eventHead(e=selectedEvent()){
 if(!e)return '<section class="panel empty"><h2>진행 중인 바자회가 없습니다.</h2></section>';
 const label={active:Date.now()<Date.parse(e.raw.orderCutoff)?'● 주문 접수 중':'주문 접수 마감',draft:'준비 중 · 임시저장',past:'종료된 바자회'}[e.status];
 const time=value=>value?esc(value.replace('T',' ')):'미설정';
 return '<section class="panel pad"><div class="toolbar"><h2>'+esc(e.name)+'</h2><span class="status '+(e.status==='past'?'old':e.status==='draft'?'draft':'')+'">'+label+'</span></div><div class="info-row"><span>주문 마감 <b>'+time(e.orderDeadline)+'</b></span><span>송금 마감 <b>'+time(e.transferDeadline)+'</b></span></div>'+metrics(stats())+banner('총 주문과 주문금액은 취소 주문을 제외합니다.')+'</section>';
}
function tabs(){return '<nav class="tabs" aria-label="관리 탭"><a href="'+link('products')+'" class="'+(page==='products'?'active':'')+'">제품관리</a><a href="'+link('orders')+'" class="'+(page==='orders'?'active':'')+'">주문관리</a><a href="'+link('settlement')+'" class="'+(page==='settlement'?'active':'')+'">정산관리</a></nav>'}
function banner(msg,cls=''){return '<div class="notice '+cls+'">'+msg+'</div>'}
function modal(title,caption,body,foot){$('#modal-title').textContent=title;$('#modal-caption').textContent=caption||'';$('#modal-body').innerHTML=body;$('#modal-foot').innerHTML=foot||'<button class="btn neutral" data-action="close">닫기</button>';$('#modal').hidden=false;if(title==='상품표 열 설정')enableColumnDrag();}
function closeModal(){$('#modal').hidden=true;}
$('#modal-close').onclick=closeModal;
function pastModal(){
 if(!model.past.length){modal('지난 바자회 선택','','<p>저장된 지난 행사가 없습니다.</p>');return;}
 modal('지난 바자회 선택','지난 행사는 기록 조회용이며 상품 원본은 유지됩니다.',
 '<div class="past-select"><button class="btn neutral" data-action="past-prev" aria-label="이전 회차">‹</button><select class="select" id="past-selector" aria-label="지난 바자회">'+model.past.map((e,i)=>'<option value="'+i+'">'+e.round+'회 · '+esc(e.name)+'</option>').join('')+'</select><button class="btn neutral" data-action="past-next" aria-label="다음 회차">›</button></div>',
 '<button class="btn primary" data-action="open-past">확인</button>');
 $('#past-selector').value=store.history;
}
function draftModal(resume=false){
 const existing=resume?selectedEvent():null, active=existing?.status==='active';
 const field=(id,label,value,type='text')=>'<label class="field">'+label+'<input type="'+type+'" id="'+id+'" value="'+esc(value||'')+'"></label>';
 const area=(id,label,value,max)=>'<label class="field wide">'+label+'<textarea id="'+id+'" maxlength="'+max+'">'+esc(value||'')+'</textarea></label>';
 const date=(id,label,value)=>'<div><b>'+label+' (파리)</b><div class="actions">'+field(id+'-date','날짜',value?.slice(0,10),'date')+field(id+'-time','시간',value?.slice(11,16),'time')+'</div></div>';
 modal(existing?'행사 설정':'새 바자회 만들기','행사 기본 정보 및 구매자 안내',
 '<div class="form-grid">'+(!existing?'<label class="field wide">지난 바자회 상품 복사<select class="select" id="copy-products-from"><option value="">복사하지 않음</option>'+model.past.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.round+'회 · '+p.name)+'</option>').join('')+'</select></label>':'')+field('event-name','행사명 · 한국어',existing?.name)+field('event-name-fr','행사명 · 프랑스어',existing?.raw.nameFr)+area('event-intro-ko','행사 소개 · 한국어',existing?.raw.introKo,1000)+area('event-intro-fr','행사 소개 · 프랑스어',existing?.raw.introFr,1000)+date('event-order','주문 마감',existing?.orderDeadline)+date('event-transfer','송금 마감',existing?.transferDeadline)+area('event-pickup-ko','픽업 안내 · 한국어',existing?.pickupKo,500)+area('event-pickup-fr','픽업 안내 · 프랑스어',existing?.pickupFr,500)+field('event-beneficiary','수취인',existing?.raw.beneficiary)+field('event-iban','IBAN (FR · 27자리)',existing?.raw.iban)+'</div>',
 '<button class="btn neutral" data-action="close">취소</button>'+(existing?.status==='draft'?'<button class="btn neutral" data-action="preview-draft-form">미리보기</button>':'')+'<button class="btn primary" data-action="create-draft">'+(active?'설정 저장':'임시저장')+'</button>');
 $('#event-name').dataset.edit=String(!!existing);
 $('#event-iban').addEventListener('input',ev=>{ev.target.value=ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,27).match(/.{1,4}/g)?.join(' ')||'';});
}
function eventList(filter='all'){
 const active=model.events.filter(e=>e.status==='published');
 const drafts=model.drafts.map(d=>({...d,status:'draft'}));
 const all=[...model.events,...drafts].sort((a,b)=>(b.serial||0)-(a.serial||0)||String(b.createdAt||b.updatedAt||'').localeCompare(String(a.createdAt||a.updatedAt||'')));
 const shown=all.filter(e=>filter==='all'||e.status===filter||filter==='published'&&e.status==='published'||filter==='completed'&&e.status==='closed');
 const controls=[['all','전체'],['draft','임시저장'],['published','발행'],['completed','완료']];
 return '<section class="panel pad" id="event-list"><div class="toolbar"><div><h2>전체 바자회</h2><p class="muted small">행사를 선택해 상품·주문·정산·설정을 관리합니다.</p></div><div class="actions"><button class="btn neutral" data-action="new-event">＋ 새 바자회 만들기</button><a class="btn neutral" href="'+esc(url('products','')+'?catalog=1')+'">기본 상품 목록 관리</a></div></div><div class="filters">'+controls.map(([key,label])=>'<button class="filter '+(filter===key?'active':'')+'" data-action="event-filter" data-value="'+key+'">'+label+'</button>').join('')+'</div>'+(
  shown.length?'<div class="sheet"><table style="min-width:760px"><thead><tr><th>회차</th><th>행사</th><th>상태</th><th>관리</th></tr></thead><tbody>'+shown.map(e=>{
   const label=e.status==='draft'?'임시저장':e.status==='closed'?'완료':'발행';
   const href=esc(url('',e.id));
   return '<tr><td>'+(e.serial||'—')+'</td><td><a href="'+href+'">'+esc(e.nameKo||'바자회')+'</a></td><td><span class="status '+(e.status==='draft'?'draft':e.status==='closed'?'old':'')+'">'+label+'</span></td><td><div class="actions"><a class="linkbtn" href="'+href+'">행사 선택</a>'+(e.status==='draft'?'<a class="linkbtn" href="'+esc(url('products',e.id))+'">제품관리</a>':'<a class="linkbtn" href="'+esc(url('orders',e.id))+'">주문관리</a><a class="linkbtn" href="'+esc(url('settlement',e.id))+'">정산관리</a>')+'</div></td></tr>';
  }).join('')+'</tbody></table></div>':'<p class="notice">표시할 행사가 없습니다.</p>')+'</section>';
}
function renderMain(){
 const e=selectedEvent();let body=model.active?eventHead(model.active):'<section class="panel pad"><div class="toolbar"><div><h2>현재 진행 중인 바자회가 없습니다.</h2><p class="muted small">(작성 중인 바자회 '+model.drafts.length+'건)</p></div><span class="status draft">준비 중</span></div></section>';
 if(e&&e!==model.active)body+=eventHead(e);
 body+=eventList(new URLSearchParams(location.search).get('status')||'all');
 if(e){
 const draft=e.status==='draft',past=e.status==='past';
 body+='<section class="panel pad"><div class="toolbar"><h3>행사 관리</h3><div class="actions">'+(!past?'<button class="btn neutral" data-action="edit-draft">행사 설정</button><button class="btn neutral" data-action="preview-shop">구매자 화면 미리보기</button>':'')+(draft?'<button class="btn danger" data-action="delete-draft">임시저장 삭제</button><button class="btn primary" data-action="publish-draft">발행</button>':past?'':'<button class="btn danger" data-action="end-event">행사 종료</button>')+'</div></div>'+tabs()+'</section>';
 if(!draft){
 const relative='bazaar/?event='+encodeURIComponent(e.id),publicUrl=root.dataset.base.replace(/admin\/$/,'')+'?event='+encodeURIComponent(e.id);
 body+='<section class="panel pad"><h3>홈페이지 배너 연결용 주소</h3><p class="muted small">배너 링크 칸에 입력하면 홈페이지 언어에 맞게 열립니다.</p><div class="actions"><code>'+esc(relative)+'</code><button class="btn neutral" data-action="copy-banner" data-url="'+esc(relative)+'">배너 링크 복사</button><a class="btn neutral" href="'+esc(publicUrl)+'" target="_blank" rel="noopener">공개 행사 열기</a><button class="btn neutral" data-action="copy-event" data-url="'+esc(publicUrl)+'">공개 주소 복사</button></div></section>';
 }}
 app.innerHTML=body;
}
let productView=new URLSearchParams(location.search).has('catalog')?'catalog':'event',productFilter='',productDirty=false;
const visibleProducts=()=>productView==='catalog'?store.catalog:store.products.filter(p=>p.active);
function markProductDirty(){productDirty=true;const el=$('#product-status');if(el){el.textContent='● 수정 중 · 저장되지 않음';el.style.color='var(--amber)';}}
window.addEventListener('beforeunload',e=>{if(productDirty){e.preventDefault();e.returnValue='';}});
function unit(p){return Number(p.pack)>0?Number(p.buy)/Number(p.pack):0}
function roi(p){return unit(p)>0&&p.sale!==''?((p.sale/unit(p)-1)*100).toFixed(2):'—'}
function lim(p){if(p.limitMode==='unlimited')return Infinity;return p.limitMode==='manual'?(Number(p.manualLimit)||0):(Number(p.boxes)||0)*(Number(p.pack)||0)}

function supplierOptions(p){
 const names=[...new Set([...store.catalog,...store.products].map(x=>String(x.vendor||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
 return (p.vendor?'':'<option value="" selected>업체 선택</option>')+names.map(name=>'<option value="'+esc(name)+'"'+(name===p.vendor?' selected':'')+'>'+esc(name)+'</option>').join('')+'<option value="__asicc_new_supplier__">＋ 새 업체 추가…</option>';
}
function storageOptions(p){
 const names=['상온','냉장','냉동'];if(p.storage&&!names.includes(p.storage))names.push(p.storage);
 return names.map(name=>'<option value="'+esc(name)+'"'+(name===p.storage?' selected':'')+'>'+esc(name)+'</option>').join('');
}
function tableProducts(){const ps=visibleProducts().filter(x=>(x.ko+' '+x.fr+' '+x.vendor).toLowerCase().includes(productFilter.toLowerCase()));const catalog=productView==='catalog';return '<div class="sheet"><table style="min-width:1495px"><colgroup><col style="width:58px"><col style="width:52px"><col style="width:160px"><col style="width:150px"><col style="width:82px"><col style="width:120px"><col style="width:105px"><col style="width:117px"><col style="width:105px"><col style="width:117px"><col style="width:107px"><col style="width:108px"><col style="width:110px"><col style="width:127px"><col style="width:107px"><col style="width:85px"><col style="width:98px"></colgroup><thead><tr>'+['순서','사진','상품명 · 한국어','상품명 · 프랑스어','상품 설명','공급업체','매입가 HT €','매입가 TTC €','박스당 수량','개당 원가','판매가/개 €','수익률 %','예상 박스','판매한도 방식','판매한도','보관','관리'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+ps.map((p,index)=>'<tr data-row="'+p.id+'" '+(!catalog?'draggable="true" data-sort-row="'+p.id+'"':'')+'><td>'+(!catalog?'<div class="sort-controls"><button class="linkbtn" data-action="product-up" data-id="'+p.id+'" aria-label="위로">↑</button><button class="linkbtn" data-action="product-down" data-id="'+p.id+'" aria-label="아래로">↓</button><span class="drag-handle" title="드래그하여 순서 변경" aria-label="드래그하여 순서 변경">⠿</span></div>':String(index+1))+'</td><td><button class="thumb" data-action="edit-photo" data-id="'+p.id+'" title="사진 편집">'+(p.photo?'<img src="'+esc(p.photo)+'" alt="" width="32">':'＋')+'</button></td>'+['ko','fr','desc','vendor','boxHt','buy','pack'].map(f=>f==='desc'?'<td><button class="linkbtn" data-action="edit-product" data-id="'+p.id+'">설명 ✎</button></td>':f==='vendor'?'<td><select class="select" style="width:100%;max-width:120px;padding:7px" data-prod="'+p.id+'" data-key="vendor">'+supplierOptions(p)+'</select></td>':f==='boxHt'?'<td><input class="cell" type="number" min="0" step="0.01" data-prod="'+p.id+'" data-key="boxHt" value="'+(p.boxHt==null?'':(p.boxHt/100).toFixed(2))+'" '+(p.vendor==='K커머셜'?'':'disabled title="TTC 가격 직접 입력"')+'></td>':'<td><input class="cell" data-prod="'+p.id+'" data-key="'+f+'" '+(['buy','pack'].includes(f)?'type="number" step="any" min="0"':'type="text"')+' value="'+esc(p[f])+'"></td>').join('')+'<td data-derived="unit" data-id="'+p.id+'">'+(unit(p)?money(unit(p)):'—')+'</td><td><input class="cell" type="number" step="0.01" min="0" data-prod="'+p.id+'" data-key="sale" value="'+p.sale+'"></td><td><input class="cell" type="number" step="0.01" min="0" data-prod="'+p.id+'" data-key="roi" value="'+roi(p)+'"></td><td><input class="cell" type="number" step="1" min="0" data-prod="'+p.id+'" data-key="boxes" value="'+(p.boxes??'—')+'"></td><td><select class="select" style="padding:7px;max-width:112px" data-prod="'+p.id+'" data-key="limitMode"><option value="auto" '+(p.limitMode==='auto'?'selected':'')+'>자동 계산</option><option value="unlimited" '+(p.limitMode==='unlimited'?'selected':'')+'>제한 없음</option><option value="manual" '+(p.limitMode==='manual'?'selected':'')+'>수동 입력</option></select></td><td><input class="cell" type="number" step="1" min="0" data-prod="'+p.id+'" data-key="manualLimit" value="'+(Number.isFinite(lim(p))?lim(p):'')+'" '+(p.limitMode!=='manual'?'disabled':'')+'></td><td><select class="select" style="width:100%;max-width:125px;padding:7px" data-prod="'+p.id+'" data-key="storage">'+storageOptions(p)+'</select></td><td><button class="linkbtn" data-action="delete-product" data-id="'+p.id+'">'+(catalog?'삭제':allocated(p)>0?'판매 중지':'행사 제외')+'</button></td></tr>').join('')+'</tbody></table></div><p class="muted tiny" style="margin-top:8px">드래그 손잡이 또는 화살표로 진열 순서를 바꾼 뒤 저장하세요 · 판매가 ↔ 수익률 양방향 계산</p>'}
function renderProducts(){const catalog=productView==='catalog';app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><div class="toolbar"><div><h2>'+(catalog?'기본 상품 목록 관리':'이번 바자회 상품 관리')+'</h2><p class="muted small">'+(catalog?'상시 원본 관리 · 필요한 상품을 행사에서 선택하여 가져오기':esc(selectedEvent()?.name||'')+'에만 적용되는 상품 사본')+'</p></div><div class="actions">'+(catalog?'<button class="btn neutral" data-action="switch-event">← 이번 바자회로</button>':'<button class="btn neutral" data-action="switch-catalog">⚙ 기본 상품 목록 관리</button><button class="btn neutral" data-action="preview-shop">구매자 화면 미리보기</button>')+'</div></div>'+banner(catalog?'<b>원본 상품 관리</b> · 기본 목록을 수정해도 이미 생성된 바자회의 상품에는 영향을 주지 않습니다.':'<b>이번 행사 전용 복사본</b> · 여기서 수정하는 모든 상품 정보는 기본 상품 목록에 반영되지 않습니다.')+'<div class="toolbar"><div class="actions"><input id="product-search" class="search" value="'+esc(productFilter)+'" placeholder="상품 또는 공급업체 검색"><span class="muted small">상품 '+visibleProducts().length+'종</span></div><div class="actions">'+(catalog?'<button class="btn neutral" data-action="add-product">＋ 상품 추가</button>':'<button class="btn neutral" data-action="import">＋ 기본 목록에서 가져오기</button>')+'<button class="btn neutral" data-action="column-settings">열 설정</button></div></div>'+tableProducts()+'<div class="footbar"><span id="product-status" class="muted small">'+(productDirty?'● 수정 중 · 저장되지 않음':'✓ 저장 완료')+'</span><div class="actions"><button class="btn neutral" data-action="refresh-products">새로고침</button><button class="btn primary" data-action="save-product">'+(catalog?'기본 목록 저장':'이번 행사 변경사항 저장')+'</button></div></div></section>'}
const colKey=()=> 'asicc-bazaar-cols-'+(bazaarAuth.currentUser?.uid||'anonymous')+'-'+productView;
function getColumnPrefs(){try{return JSON.parse(localStorage.getItem(colKey())||'null');}catch{return null;}}
function applyColumns(){
 const table=app.querySelector('.sheet table');if(!table||page!=='products')return;
 const headers=[...table.querySelectorAll('thead th')],cols=[...table.querySelectorAll('colgroup col')],rows=[...table.rows];
 const names=headers.map(h=>h.textContent),stored=getColumnPrefs();
 const order=(stored?.order||names).filter(n=>names.includes(n));for(const name of names)if(!order.includes(name))order.push(name);
 const indices=order.map(n=>names.indexOf(n));
 for(const row of rows){const cells=[...row.cells];for(const i of indices){const cell=cells[i];row.append(cell);cell.hidden=stored?.hidden?.includes(names[i])||false;}}
 const group=table.querySelector('colgroup');
 for(const i of indices){group.append(cols[i]);const name=names[i];cols[i].style.display=stored?.hidden?.includes(name)?'none':'';if(stored?.widths?.[name])cols[i].style.width=stored.widths[name]+'px';}
 const total=cols.reduce((n,c)=>n+(c.style.display==='none'?0:parseInt(c.style.width)||90),0);table.style.minWidth=total+'px';
 const pinned=(stored?.pinned||[]).filter(n=>order.includes(n)&&!stored?.hidden?.includes(n));let left=0;
 for(const name of pinned){const i=names.indexOf(name),width=parseInt(cols[i].style.width)||90;for(const row of rows){const cell=row.cells[indices.indexOf(i)];if(cell){cell.style.position='sticky';cell.style.left=left+'px';cell.style.zIndex=row.parentElement.tagName==='THEAD'?'5':'2';}}left+=width;}
 headers.forEach((h,i)=>{if(h.querySelector('[data-col-resize]'))return;const grip=document.createElement('span');grip.dataset.colResize='';grip.title='드래그하여 열 너비 조절';grip.setAttribute('aria-label','열 너비 조절');h.append(grip);grip.addEventListener('pointerdown',ev=>{ev.preventDefault();const start=ev.clientX,width=cols[i].getBoundingClientRect().width;grip.setPointerCapture(ev.pointerId);const move=moveEvent=>{const next=Math.max(50,Math.min(500,width+moveEvent.clientX-start));cols[i].style.width=next+'px';};const up=()=>{grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',up);const pref=getColumnPrefs()||{};pref.widths={...(pref.widths||{}),[names[i]]:parseInt(cols[i].style.width)||100};localStorage.setItem(colKey(),JSON.stringify(pref));};grip.addEventListener('pointermove',move);grip.addEventListener('pointerup',up,{once:true});});});
}
function enableColumnDrag(){const list=$('#column-list');if(!list)return;for(const row of list.children)row.draggable=true;let dragged=null;list.addEventListener('dragstart',e=>{const row=e.target.closest('[data-column]');if(row)dragged=row;});list.addEventListener('dragover',e=>{if(e.target.closest('[data-column]')&&dragged)e.preventDefault();});list.addEventListener('drop',e=>{const row=e.target.closest('[data-column]');if(!row||!dragged||row===dragged)return;e.preventDefault();const rect=row.getBoundingClientRect();list.insertBefore(dragged,e.clientY<rect.top+rect.height/2?row:row.nextSibling);});}
function columnSettings(){
 const table=app.querySelector('.sheet table'),headers=[...table.querySelectorAll('thead th')],cols=[...table.querySelectorAll('colgroup col')];
 const pref=getColumnPrefs();modal('상품표 열 설정','표시, 고정, 순서와 너비를 바꿉니다. 이 기기의 운영진 계정별로 저장됩니다.','<div id="column-list">'+headers.map((h,i)=>'<div class="modal-row" data-column="'+esc(h.textContent)+'"><label><input type="checkbox" data-column-visible '+(!h.hidden?'checked':'')+'> '+esc(h.textContent)+'</label><div class="actions"><label class="tiny"><input type="checkbox" data-column-pinned '+(pref?.pinned?.includes(h.textContent)?'checked':'')+'> 고정</label><input aria-label="너비" type="number" min="50" max="500" value="'+(parseInt(cols[i].style.width)||100)+'" style="width:75px" data-column-width> px <button class="btn neutral" data-action="column-up">↑</button><button class="btn neutral" data-action="column-down">↓</button></div></div>').join('')+'</div>','<button class="btn neutral" data-action="column-reset">초기화</button><button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="column-save">적용</button>');
}
function editProduct(id,photo=false){
 const p=(productView==='catalog'?store.catalog:store.products).find(p=>p.id===id);if(!p)return;
 const content=photo?'<div class="form-grid">'+(p.photo?'<img width="100" src="'+esc(p.photo)+'" alt="">':'')+'<label class="field wide">사진 업로드<input id="edit-photo" type="file" accept="image/jpeg,image/png,image/webp"></label><label class="field wide">사진 URL<input id="photo-url" value="'+esc(p.photo)+'"></label><label><input id="photo-remove" type="checkbox"> 사진 삭제</label></div>':'<div class="form-grid"><label class="field wide">설명 · 한국어<textarea id="edit-kod">'+esc(p.koDesc)+'</textarea></label><label class="field wide">Description · français<textarea id="edit-frd">'+esc(p.frDesc)+'</textarea></label></div>';
 modal(p.ko+' · '+(photo?'사진':'상품 설명'),p.fr,content,'<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="save-product-detail" data-id="'+p.id+'">수정 적용</button>');
}
function importModal(){let items=store.catalog.filter(c=>!store.products.some(x=>x.id===c.id&&x.active));modal('기본 상품 목록에서 가져오기','체크박스로 여러 상품을 한 번에 행사에 복사할 수 있습니다.',items.length?'<label class="modal-row"><input type="checkbox" data-import-all> <b>전체 선택 / 해제</b></label>'+items.map(p=>'<label class="modal-row"><input type="checkbox" data-import="'+p.id+'"><span>'+p.emoji+' <b>'+esc(p.ko)+'</b> · '+esc(p.fr)+'</span><b>'+money(p.sale)+'</b></label>').join(''):banner('기본 목록 상품을 모두 가져왔습니다.'),'<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="import-apply">선택 상품 가져오기</button>')}
function productChange(el){const arr=productView==='catalog'?store.catalog:store.products,p=arr.find(x=>x.id===el.dataset.prod);if(!p)return;const k=el.dataset.key;if(productView==='catalog'&&['boxes','manualLimit','limitMode'].includes(k))return;let val=el.value;
 if(k==='vendor'&&val==='__asicc_new_supplier__'){
  const entered=prompt('새 공급업체명을 입력해 주세요 (최대 120자).');
  if(entered===null||!entered.trim()){el.value=p.vendor||'';return;}
  val=entered.trim().normalize('NFC');const found=[...store.catalog,...store.products].find(x=>x.vendor?.normalize('NFC').toLowerCase()===val.toLowerCase());if(found)val=found.vendor;
  if(val.length>120){alert('공급업체명은 120자 이내로 입력해 주세요.');el.value=p.vendor||'';return;}
 }
 if(k==='boxHt'){if(p.vendor!=='K커머셜')return;const ht=val===''?null:Math.round(Math.max(0,Number(val)||0)*100);p.boxHt=ht;if(ht!=null){p.buy=Math.round(ht*1.055)/100;p.originalBuy=p.buy;}markProductDirty();rerender();return;}
 if(['buy','pack','sale','boxes','manualLimit','roi'].includes(k)){if(val===''){el.value=k==='roi'?roi(p):k==='manualLimit'?lim(p):p[k];return;}val=Math.max(k==='roi'?-100:0,Number(val)||0);}if(k==='pack'||k==='boxes'||k==='manualLimit')val=Math.floor(val);
 const candidate={...p,[k]:val};
 if(productView==='event'&&['pack','boxes','manualLimit','limitMode'].includes(k)&&lim(candidate)<allocated(p)){
  $('#product-status').textContent='이미 접수한 주문 수량보다 판매한도를 낮출 수 없습니다.';
  el.value=k==='manualLimit'?lim(p):p[k];return;
 }
 if(k==='buy'||(k==='vendor'&&val!=='K커머셜')){p.boxHt=null;}if(k==='roi'){if(unit(p)>0&&p.buy>0)p.sale=finance(unit(p)*(1+val/100));}else p[k]=['buy','sale'].includes(k)?finance(val):val;let row=app.querySelector('[data-row="'+p.id+'"]');if(!row)return;const unitcell=row.querySelector('[data-derived=unit]');if(unitcell)unitcell.textContent=unit(p)>0?money(unit(p)):'—';const rcell=row.querySelector('[data-key=roi]');if(rcell&&k!=='roi')rcell.value=roi(p);const scell=row.querySelector('[data-key=sale]');if(scell&&k==='roi')scell.value=p.sale.toFixed(2);const limitcell=row.querySelector('[data-key=manualLimit]');if(limitcell&&productView==='event'){limitcell.disabled=p.limitMode!=='manual';if(p.limitMode==='auto'||k==='limitMode')limitcell.value=Number.isFinite(lim(p))?lim(p):''}if(k==='vendor'||k==='buy'){
  markProductDirty();const oldSheet=app.querySelector('.sheet'),left=oldSheet?.scrollLeft||0,top=oldSheet?.scrollTop||0;
  renderProducts();applyColumns();
  const nextSheet=app.querySelector('.sheet');if(nextSheet){nextSheet.scrollLeft=left;nextSheet.scrollTop=top;}
 }
 markProductDirty();}
const orderSources={web:'웹 주문',phone:'전화 주문',additional:'추가 구매'};
const canManageOrder=()=>selectedEvent()?.status!=='draft'&&canReconcile()&&!selectedEvent().raw.finalizedAt;
function orderSource(order){return orderSources[order.source]||orderSources.web;}
const orderFields=['주문번호','주문자','주문일시','연락처','이메일','상품 주문내역','총 주문액','송금 신고','은행 입금 확인','비고','주문 상태','관리'];
function filteredOrders(){return store.orders.filter(o=>(store.orderFilter==='all'||(store.orderFilter==='pending'?o.status==='reported':o.status===store.orderFilter))&&[o.ref,o.name,o.phone,o.email,o.memo,orderSource(o),o.parentOrderRef,...o.items.map(i=>i[0])].join(' ').toLowerCase().includes(store.search.toLowerCase())).sort((a,b)=>store.orderSort==='amount'?total(b)-total(a):store.orderSort==='name'?a.name.localeCompare(b.name,'ko'):store.orderSort==='old'?store.orders.indexOf(b)-store.orders.indexOf(a):store.orders.indexOf(a)-store.orders.indexOf(b))}
function renderOrders(){let ls=filteredOrders();const filters=[['all','전체'],['pending','송금 신고 · 확인 대기'],['unpaid','송금 신고 없음'],['confirmed','입금 확인'],['canceled','취소']];app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><div class="toolbar"><div><h2>주문관리</h2><p class="muted small">PC는 엑셀형 주문표 · 모바일은 카드형 주문 목록</p></div><div class="actions"><span class="muted small">주문 1건당 1행</span>'+(canManageOrder()?'<button class="btn primary" data-action="manual-order">＋ 전화 주문·추가 구매</button>':'')+'</div></div>'+banner('<b>은행 입금 확인 대기 '+store.orders.filter(o=>o.status==='reported').length+'건</b> · 고객의 송금 신고만으로 주문이 확정되지 않습니다.','warning')+'<div class="toolbar"><div class="actions"><input class="search" id="order-search" placeholder="이름 · 주문번호 · 연락처 · 비고 검색" value="'+esc(store.search)+'"><select class="select" id="order-sort"><option value="new">최신 주문순</option><option value="old">오래된 주문순</option><option value="amount">주문금액 높은 순</option><option value="name">이름순</option></select></div><span class="muted tiny">전체 '+store.orders.length+'건</span></div><div class="filters">'+filters.map(([f,t])=>'<button class="filter '+(f===store.orderFilter?'active':'')+'" data-action="order-filter" data-value="'+f+'">'+t+' ('+store.orders.filter(o=>f==='all'||(f==='pending'?o.status==='reported':o.status===f)).length+')</button>').join('')+'</div><div class="sheet"><table style="min-width:1470px"><colgroup>'+[110,110,95,126,160,195,105,118,125,90,112,105].map(x=>'<col style="width:'+x+'px">').join('')+'</colgroup><thead><tr>'+orderFields.map((x,i)=>'<th class="'+(i===0?'sticky-one':i===1?'sticky-two':'')+'">'+x+'</th>').join('')+'</tr></thead><tbody>'+ls.map(o=>{const st=statuses[o.status];return '<tr><td class="sticky-one"><b style="color:var(--wine)">'+esc(o.ref)+'</b><div class="muted tiny">'+orderSource(o)+'</div></td><td class="sticky-two"><b>'+esc(o.name)+'</b></td><td class="tiny">'+esc(o.date)+'</td><td>'+esc(o.phone)+'</td><td class="tiny">'+esc(o.email)+'</td><td>'+o.items.map(i=>esc(i[0])+' ×'+i[1]).join(' · ')+'</td><td><b>'+money(total(o))+'</b></td><td><span class="state '+(o.status==='reported'||o.status==='confirmed'?'reported':'unpaid')+'">'+(o.status==='reported'||o.status==='confirmed'?'신고 완료':'미신고')+'</span></td><td>'+(o.status==='confirmed'?'<span class="state confirmed">✓ 확인 완료</span>':o.status==='canceled'?'—':'<button class="linkbtn dark" data-action="confirm" data-id="'+o.id+'">입금 확인</button>')+'</td><td>'+(o.memo?'<button class="linkbtn warn" data-action="order-detail" data-id="'+o.id+'">● 비고 있음</button>':'—')+'</td><td><span class="state '+st[1]+'">'+st[0]+'</span></td><td><button class="linkbtn" data-action="order-detail" data-id="'+o.id+'">상세 보기</button></td></tr>'}).join('')+'</tbody></table></div><div class="order-cards">'+ls.map(o=>'<div class="order-card" data-action="order-detail" data-id="'+o.id+'"><div class="toolbar"><div><b style="color:var(--wine)">'+esc(o.ref)+'</b><div class="muted tiny">'+orderSource(o)+'</div><p style="margin-top:4px"><b>'+esc(o.name)+'</b></p></div><span class="state '+o.status+'">'+statuses[o.status][0]+'</span></div><div class="toolbar" style="margin-top:11px"><strong>'+money(total(o))+'</strong><span class="muted small">'+esc(o.date)+(o.memo?' · 📝 비고':'')+' ›</span></div></div>').join('')+'</div><div class="footbar"><span class="muted small">표시 '+ls.length+'건 · 접수된 주문의 정정은 운영진이 사유와 이력을 남겨 처리합니다.</span></div></section>';$('#order-sort').value=store.orderSort}
function orderModal(id){let o=store.orders.find(o=>o.id===id);if(!o)return;modal(o.ref+' · '+o.name,orderSource(o)+(o.parentOrderRef?' · 원주문 '+o.parentOrderRef:''),'<div class="modal-row"><span>연락처</span><b>'+esc(o.phone)+'</b></div><div class="modal-row"><span>이메일</span>'+esc(o.email)+'</div><h3 style="margin:17px 0 6px">상품 내역</h3>'+o.items.map(i=>'<div class="modal-row"><span>'+esc(i[0])+' ×'+i[1]+'</span><b>'+money(i[1]*i[2])+'</b></div>').join('')+'<div class="summary-bar"><b>총 주문액</b><strong>'+money(total(o))+'</strong></div>'+(o.memo?'<h3>판매자에게 전달할 사항</h3>'+banner(esc(o.memo),'warning'):'')+'<h3>입금 처리</h3><p class="muted small" style="margin:8px 0">'+statuses[o.status][0]+(o.verifiedAt?' · '+esc(o.verifiedAt):'')+'</p>'+banner('송금 신고와 은행의 실제 입금 확인은 서로 다른 단계입니다.'),'<button class="btn neutral" data-action="close">닫기</button>'+(canReconcile()&&(o.status==='unpaid'||o.status==='reported')?'<button class="btn primary" data-action="confirm" data-id="'+o.id+'">실제 은행 입금 확인</button><button class="btn neutral" data-action="cancel-order" data-id="'+o.id+'">주문 취소</button>':'')+orderTools(o));}
function orderTools(order){
 let buttons=order.revision?'<button class="btn neutral" data-action="order-history" data-id="'+esc(order.id)+'">정정 이력</button>':'';
 if(canManageOrder()&&order.status!=='canceled'){
  buttons+='<button class="btn neutral" data-action="manual-order" data-id="'+esc(order.id)+'">이 주문에 추가 구매 등록</button>';
  buttons+='<button class="btn neutral" data-action="order-correct" data-id="'+esc(order.id)+'">관리자 정정</button>';
 }
 return buttons;
}
let manualRequest;
function manualOrderModal(parentId){
 const original=store.orders.find(o=>o.id===parentId);
 const products=store.products.filter(p=>p.active&&p.sale!=='');
 if(!products.length){alert('등록할 수 있는 판매 상품이 없습니다.');return;}
 const parent=original?'<p class="small">연결 주문: '+esc(original.ref)+'</p>':'';
 modal('전화 주문·추가 구매 등록',selectedEvent().name,
  banner('별도 주문번호가 발급됩니다. 고객이 안내받을 이메일을 제공한 경우에만 입력하세요.')+parent+
  '<div class="form-grid"><label class="field">주문 유형<select id="manual-source" '+(original?'disabled':'')+'>'+
  (original?'<option value="additional">추가 구매</option>':'<option value="phone">전화 주문</option><option value="additional">추가 구매</option>')+
  '</select></label><label class="field">안내 언어<select id="manual-lang"><option value="ko">한국어</option><option value="fr">Français</option></select></label>'+
  '<label class="field">주문자<input id="manual-name" maxlength="100" value="'+esc(original?.name)+'"></label>'+
  '<label class="field">전화번호<input type="tel" id="manual-phone" maxlength="40" value="'+esc(original?.phone)+'"></label>'+
  '<label class="field wide">이메일 (선택)<input type="email" id="manual-email" maxlength="200"></label>'+
  '<label class="field wide">전달 사항 (선택)<textarea id="manual-note" maxlength="500"></textarea></label></div>'+
  '<h3>수량을 입력할 상품</h3>'+products.map(p=>'<label class="modal-row"><span>'+esc(p.ko)+' · '+money(p.sale)+
    '</span><input class="cell" style="max-width:100px" type="number" min="0" max="100" step="1" value="0" data-manual-item="'+esc(p.id)+
    '" data-price="'+Math.round(p.sale*100)+'"></label>').join(''),
  '<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="manual-order-save" data-id="'+esc(original?.id)+'">별도 주문 등록</button>');
}
async function saveManualOrder(parentId){
 const items=[...root.querySelectorAll('[data-manual-item]')].filter(el=>Number(el.value)!==0).map(el=>({
  id:el.dataset.manualItem,qty:Number(el.value),priceCents:Number(el.dataset.price),
 }));
 const data={eventId:selectedEvent().id,source:$('#manual-source').value,parentId,
  name:$('#manual-name').value.trim(),phone:$('#manual-phone').value.trim(),email:$('#manual-email').value.trim(),
  lang:$('#manual-lang').value,pickupNote:$('#manual-note').value,items};
 if(!items.length||data.name.length<2||data.phone.replace(/\D/g,'').length<8||!$('#manual-email').validity.valid){
  throw new Error('주문자 이름, 전화번호와 상품 수량을 확인해 주세요. 이메일은 공란으로 둘 수 있습니다.');
 }
 const signature=JSON.stringify(data);
 if(manualRequest?.signature!==signature)manualRequest={signature,id:crypto.randomUUID().replaceAll('-','')};
 const result=await request('createManualOrder',{...data,requestId:manualRequest.id});
 manualRequest=null;
 closeModal();await load();
 orderModal(result.id);
}
function correctionModal(id){
 const order=store.orders.find(o=>o.id===id);
 if(!order||!canManageOrder()||order.status==='canceled')return;
 modal('관리자 주문 정정',order.ref,
  banner('불가피한 정정에만 사용하세요. 기존 품목의 수량을 바꾸면 사유와 변경 전후 내역이 남습니다. 추가 구매는 별도 주문으로 등록하세요.','warning')+
  order.items.map(([name,qty,price,itemId])=>'<label class="modal-row"><span>'+esc(name)+' · '+money(price)+'</span><input class="cell" style="max-width:100px" type="number" min="0" max="100" step="1" value="'+qty+'" data-order-quantity="'+esc(itemId)+'"></label>').join('')+
  '<label class="field">정정 사유<textarea id="order-correction-reason" maxlength="500" required></textarea></label>',
  '<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="order-correct-save" data-id="'+esc(id)+'">정정 저장</button>');
}
async function saveCorrection(id){
 const order=store.orders.find(o=>o.id===id);
 if(!order||!canManageOrder())return;
 const reason=$('#order-correction-reason').value.trim();
 if(!reason)throw new Error('정정 사유를 입력해 주세요.');
 const items=[...root.querySelectorAll('[data-order-quantity]')].map(el=>({id:el.dataset.orderQuantity,qty:Number(el.value)}));
 if(!confirm('이 주문을 정정할까요? 원본과 정정 사유가 보관됩니다.'))return;
 await request('correctOrder',{id,eventId:selectedEvent().id,revision:order.revision,reason,items,confirm:true});
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
function renderSettlement(){let ds=demands(),vs=vendors(),sumBuy=vs.reduce((s,v)=>s+poTotal(v),0),sumSales=ds.reduce((s,p)=>s+p.revenue,0);if(!vs.includes(store.vendor))store.vendor=vs[0]||'';if(!vs.length){app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><h2>정산관리</h2>'+closedPurchaseControls()+banner('집계할 주문이 없습니다.')+'<div class="actions"><button class="btn neutral" data-action="scope" data-value="confirmed">입금 확인 주문</button><button class="btn neutral" data-action="scope" data-value="all">전체 유효 주문</button></div></section>';return;}app.innerHTML=eventHead()+tabs()+'<section class="tabbody"><div class="toolbar"><div><h2>정산관리</h2><p class="muted small">업체별 정산 · 발주서 품목/수량/매입가 직접 수정</p></div><span class="muted small">고객 주문 원본과 발주서는 별개</span></div>'+closedPurchaseControls()+'<div class="notice"><div class="toolbar"><b>집계 기준</b><div class="actions"><button class="filter '+(store.settleScope==='confirmed'?'active':'')+'" data-action="scope" data-value="confirmed">입금 확인 주문</button><button class="filter '+(store.settleScope==='all'?'active':'')+'" data-action="scope" data-value="all">전체 유효 주문</button></div></div><p class="muted tiny" style="margin-top:8px">'+(store.settleScope==='confirmed'?'운영진이 은행 입금을 확인한 주문을 기준으로 합니다.':'취소 주문을 제외하고 미입금 주문까지 포함한 예상 수요입니다.')+'</p></div>'+metrics([['집계 주문',accepted().length+'건'],['고객 판매액',money(sumSales)],['업체 발주액',money(sumBuy)],['예상 판매차액',money(sumSales-sumBuy)]])+'<h3 style="margin:21px 0 11px">업체별 발주 현황</h3><div class="supplier-grid">'+vs.map(v=>{let rr=demands().filter(p=>p.vendor===v);return '<div class="vendor-box '+(store.vendor===v?'active':'')+'"><div class="toolbar"><h3>'+esc(v)+'</h3><button class="linkbtn" data-action="vendor" data-value="'+esc(v)+'">'+(store.vendor===v?'선택됨':'상세·발주')+'</button></div><div class="vendor-stats"><div><span>상품 주문수량</span><b>'+rr.reduce((s,p)=>s+p.ordered,0)+'개</b></div><div><span>발주 수량</span><b>'+esc(quantityByUnit(makePO(v)))+'</b></div><div><span>매입액 TTC</span><b>'+money(poTotal(v))+'</b></div><div><span>판매액</span><b>'+money(vendorSales(v))+'</b></div><div><span>예상 차액</span><b>'+money(vendorSales(v)-poTotal(v))+'</b></div></div></div>'}).join('')+'</div><div class="panel pad" style="margin-top:20px"><div class="toolbar"><div><h3>'+esc(store.vendor)+' · 구매발주서 편집</h3><p class="muted small">'+(poMeta(store.vendor).confirmed?(current()?'확정 · 종료 후 수정 가능':'확정 · 읽기 전용'):poMeta(store.vendor).savedAt?'저장된 초안':'작성 중')+' · 집계와 발주서 차이 '+money(poTotal(store.vendor)-finance(demands().filter(p=>p.vendor===store.vendor).reduce((sum,p)=>sum+p.minimum*p.buy,0)))+'</p><p class="muted small">전화주문·추가 구매를 위해 품목, 수량, 단가, 소계를 직접 변경할 수 있습니다.</p></div><button class="btn primary" data-action="po-add">＋ 발주 품목 추가</button></div><div class="sheet" style="max-height:460px"><table style="min-width:900px"><colgroup><col style="width:210px"><col style="width:115px"><col style="width:110px"><col style="width:125px"><col style="width:125px"><col style="width:85px"></colgroup><thead><tr><th>품목 / 구분</th><th>발주수량</th><th>단위</th><th>매입단가 TTC</th><th>품목 소계 TTC</th><th>관리</th></tr></thead><tbody>'+makePO(store.vendor).map(p=>'<tr><td><input class="cell" value="'+esc(p.name)+'" data-po="'+esc(p.id)+'" data-key="name"><div class="muted tiny">'+(p.manual?'수동 추가':'주문 수량 '+p.ordered+'개 · '+p.per+'개/박스')+poWarning(p)+'</div></td><td><input type="number" min="0" step="1" class="cell" value="'+p.qty+'" data-po="'+p.id+'" data-key="qty"></td><td><select class="select" style="width:100%;padding:7px" data-po="'+p.id+'" data-key="unit">'+['박스','개','봉','세트'].map(u=>'<option '+(p.unit===u?'selected':'')+'>'+u+'</option>').join('')+'</select></td><td><input type="number" min="0" step="0.01" class="cell" value="'+p.price+'" data-po="'+p.id+'" data-key="price"></td><td><input type="number" min="0" step="0.01" class="cell" value="'+p.amount+'" data-po="'+p.id+'" data-key="amount"></td><td><button class="linkbtn" data-action="po-del" data-id="'+p.id+'">삭제</button></td></tr>').join('')+'</tbody></table></div><div class="summary-bar"><span><b>'+esc(store.vendor)+'</b> 총 발주금액 TTC</span><strong id="po-edit-total">'+money(poTotal(store.vendor))+'</strong></div><div class="actions" style="justify-content:flex-end"><button class="btn neutral" data-action="po-reset">자동 산출로 초기화</button><button class="btn neutral" data-action="po-settings">발주 정보 편집</button><button class="btn neutral" data-action="po-save">'+(current()&&poMeta(store.vendor).confirmed?'수정사항 저장':'발주서 초안 저장')+'</button>'+(poMeta(store.vendor).confirmed?'':'<button class="btn neutral" data-action="po-confirm">발주서 확정</button>')+'<button class="btn neutral" data-action="one-pdf">PDF</button><button class="btn neutral" data-action="one-excel">Excel</button><button class="btn primary" data-action="po-preview">구매발주서 미리보기</button></div></div>'+banner('고객 판매 실적과 발주서는 별도로 보존합니다. 구매발주서의 수동 변경이 고객 주문액이나 상품 원본을 수정하지 않습니다.')+'<div class="panel pad"><div class="toolbar"><div><h3>전체 업체 구매발주서</h3><p class="muted small">공급업체용 자료에는 고객정보와 판매금액이 포함되지 않습니다.</p></div><button class="btn neutral" data-action="all-po">전체 업체 검토</button><button class="btn neutral" data-action="all-pdf">전체 PDF</button><button class="btn neutral" data-action="all-excel">전체 Excel</button></div></div></section>'}
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
function rerender(){
 if(page==='main'||(!selectedEvent()&&!(page==='products'&&productView==='catalog'))){renderMain();return;}
 if(page==='products'){renderProducts();applyColumns();}
 if(page==='orders'){
  renderOrders();
  const ev=selectedEvent();const bar=document.createElement('div');bar.className='footbar';bar.innerHTML='<div class="actions"><button class="btn neutral" data-action="refresh-orders">새로고침</button><button class="btn neutral" data-action="csv-orders">주문 CSV 다운로드</button></div>'+(canReconcile()&&ev.status!=='draft'&&!ev.raw.reconciledAt?'<button class="btn danger" data-action="finalize-unpaid">최종 입금 대조 · 미입금 일괄 취소</button>':'');app.querySelector('.tabbody').append(bar);
  mountMailManager(app.querySelector('.tabbody'),selectedEvent(),store.orders,request,canManageOrder());
 }
 if(page==='settlement')renderSettlement();
 if(page==='orders'&&selectedEvent()?.status==='draft'){app.querySelectorAll('[data-action=manual-order]').forEach(b=>b.disabled=true);}
 if(page==='products'&&productView==='catalog')app.querySelectorAll('[data-key=boxes],[data-key=manualLimit],[data-key=limitMode]').forEach(el=>el.disabled=true);
 if(page==='products'&&current()&&productView!=='catalog'||page==='settlement'&&!canEditPurchase()){
  app.querySelectorAll(page==='products'?'[data-prod],[data-toggle],[data-action=delete-product],[data-action=edit-product],[data-action=edit-photo],[data-action=import],[data-action=reorder-products],[data-action=save-product]':
   '[data-po],[data-action=po-add],[data-action=po-del],[data-action=po-reset],[data-action=po-settings],[data-action=po-save],[data-action=po-confirm]').forEach(el=>el.disabled=true);
 }
}
app.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;
if(handleScreenAction(a,b))return;
if(a==='mode-active')location.href=url('','');if(a==='show-past')pastModal();if(a==='new-event')draftModal();
if(a==='switch-catalog'){if(productDirty){alert('변경사항을 저장하거나 새로고침한 뒤 목록을 변경하세요.');return;}productView='catalog';productFilter='';rerender();}if(a==='switch-event'){if(productDirty){alert('변경사항을 저장하거나 새로고침한 뒤 목록을 변경하세요.');return;}if(!selectedEvent()){location.href=url('','');return;}productView='event';productFilter='';rerender();}if(a==='edit-product'&&(productView==='catalog'||!current()))editProduct(b.dataset.id);if(a==='edit-photo'&&(productView==='catalog'||!current()))editProduct(b.dataset.id,true);if(a==='import'&&!current())importModal();if(a==='delete-product'&&(productView==='catalog'||!current())){const ar=productView==='catalog'?store.catalog:store.products;const p=ar.find(x=>x.id===b.dataset.id);if(p&&confirm(p.ko+' 상품을 '+(productView==='catalog'?'기본 상품 목록':'이번 바자회')+'에서 삭제할까요?')){if(productView==='event'&&(allocated(p)>0||selectedEvent()?.status==='active'))p.active=false;else ar.splice(ar.indexOf(p),1);markProductDirty();rerender();}}
if(a==='add-product'){
 const ar=productView==='catalog'?store.catalog:store.products;
 const p={id:newId(),ko:'',fr:'',koDesc:'',frDesc:'',vendor:'',buy:0,sale:'',pack:1,storage:'상온',photo:'',photoPath:'',emoji:'📦',active:false,boxes:'',manualLimit:'',limitMode:'unlimited'};
 if(productView!=='catalog')return;modal('새 상품 등록','한국어와 프랑스어 이름을 입력하세요.','<div class="form-grid"><label class="field">한국어<input id="new-ko"></label><label class="field">프랑스어<input id="new-fr"></label></div>','<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="new-product-save">추가</button>');
}
if(a==='product-up'||a==='product-down'){if(current()||productView==='catalog')return;const ar=store.products,from=ar.findIndex(p=>p.id===b.dataset.id),to=from+(a==='product-up'?-1:1);if(from>=0&&to>=0&&to<ar.length){[ar[from],ar[to]]=[ar[to],ar[from]];markProductDirty();rerender();}}
if(a==='column-settings')columnSettings();
 if(a==='save-product'&&(productView==='catalog'||!current()))run(b,saveProducts);
 if(a==='refresh-products'&&(!productDirty||confirm('저장하지 않은 변경사항을 버리고 새로고침할까요?'))){run(b,async()=>{productDirty=false;await load();});}
 if(a==='reorder-products'&&!current()){const ps=visibleProducts();modal('상품 진열 순서 변경','위아래로 이동하세요.','<div id="reorder-list">'+ps.map(p=>'<div class="modal-row" data-reorder-id="'+p.id+'"><span>'+esc(p.ko)+'</span><div class="actions"><button class="btn neutral" data-action="move-up">↑</button><button class="btn neutral" data-action="move-down">↓</button></div></div>').join('')+'</div>','<button class="btn neutral" data-action="close">취소</button><button class="btn primary" data-action="reorder-save">적용</button>');}
if(a==='manual-order'&&canManageOrder())manualOrderModal();
if(a==='order-filter'){store.orderFilter=b.dataset.value;rerender();}if(a==='order-detail'){
 orderModal(b.dataset.id);
 const mail=document.createElement('div');
 mail.className='muted small';
 mail.setAttribute('role','status');
 mail.textContent='이메일 발송 상태 확인 중…';
 $('#modal-body').append(mail);
 const order=store.orders.find(order=>order.id===b.dataset.id);
 if(order&&order.status!=='confirmed'&&!canManageOrder()){
  const review=document.createElement('button');
  review.type='button';review.className='btn neutral';review.textContent='늦은 입금 검토 등록';
  review.addEventListener('click',async()=>{
   if(!confirm('은행에서 늦은 입금을 확인했나요? 주문 변경 없이 검토 대상으로 기록합니다.'))return;
   review.disabled=true;
   try{
    const result=await request('bankConfirm',{id:order.id,eventId:selectedEvent().id});
    if(result.needsReview)await showOrderMail(order.id,mail,selectedEvent().id,request);
   }catch(error){alert(error.message);}
   finally{review.disabled=false;}
  });
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
if(a==='new-product-save'){const ko=$('#new-ko').value.trim(),fr=$('#new-fr').value.trim();if(!ko||!fr){alert('상품명을 모두 입력하세요.');return;}store.catalog.push({id:newId(),ko,fr,koDesc:'',frDesc:'',vendor:'',buy:0,sale:'',pack:1,storage:'상온',photo:'',photoPath:'',emoji:'📦',active:false,boxes:'',manualLimit:'',limitMode:'unlimited'});markProductDirty();closeModal();rerender();}
 if(a==='save-product-detail')run(b,()=>saveProductDetail(b.dataset.id));
if(a==='import-apply'){let ids=[...document.querySelectorAll('[data-import]:checked')].map(x=>x.dataset.import);ids.forEach(id=>{let x=store.catalog.find(p=>p.id===id);if(x){const previous=store.products.find(p=>p.id===id);if(previous)previous.active=true;else store.products.push({...defaults(x),active:true});markProductDirty();}});closeModal();rerender();}
if(a==='po-add-save'){const name=$('#po-new-name').value.trim(),qty=Number($('#po-new-qty').value),price=Number($('#po-new-price').value);if(!name||!(qty>0)||!(price>=0)){alert('품목명·수량·단가를 확인해 주세요.');return}editablePO(store.vendor).push({id:newId(),name,ordered:0,per:0,qty,unit:$('#po-new-unit').value,price,amount:Math.round(qty*price*100)/100,manual:true});closeModal();rerender();}
if(a==='show-po'){store.vendor=b.dataset.value;previewPO(store.vendor);}
});
$('#modal').addEventListener('change',e=>{if(e.target.matches('[data-import-all]'))$('#modal').querySelectorAll('[data-import]').forEach(box=>box.checked=e.target.checked);});
let draggedProductId=null;
app.addEventListener('dragstart',e=>{const row=e.target.closest('[data-sort-row]');if(!row||current()||productView==='catalog')return;draggedProductId=row.dataset.sortRow;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',draggedProductId);});
app.addEventListener('dragover',e=>{if(e.target.closest('[data-sort-row]')&&draggedProductId)e.preventDefault();});
app.addEventListener('drop',e=>{const row=e.target.closest('[data-sort-row]');if(!row||!draggedProductId||current()||productView==='catalog')return;e.preventDefault();const from=store.products.findIndex(p=>p.id===draggedProductId),to=store.products.findIndex(p=>p.id===row.dataset.sortRow);if(from>=0&&to>=0&&from!==to){const [item]=store.products.splice(from,1);store.products.splice(to,0,item);markProductDirty();rerender();}draggedProductId=null;});
app.addEventListener('change',e=>{const el=e.target;if(page==='products'&&current()&&productView!=='catalog'||page==='settlement'&&!canEditPurchase())return;if(el.dataset.prod){productChange(el);return}if(el.dataset.toggle){let p=store.products.find(p=>p.id===el.dataset.toggle);if(p)p.active=el.checked;return}if(el.dataset.po){poChange(el);return}if(el.id==='order-sort'){store.orderSort=el.value;rerender();return}});
app.addEventListener('input',e=>{const el=e.target;if(el.id==='product-search'){productFilter=el.value;const pos=el.selectionStart;rerender();const n=$('#product-search');n.focus();n.setSelectionRange(pos,pos)}if(el.id==='order-search'){store.search=el.value;const pos=el.selectionStart;rerender();const n=$('#order-search');n.focus();n.setSelectionRange(pos,pos)}});
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
async function saveProducts(){
 const e=selectedEvent();
 const catalog=productView==='catalog';
 const products=catalog?store.catalog:store.products;
 for(const [i,p] of products.entries()){if(!p.ko?.trim()||!p.fr?.trim()||!p.vendor?.trim()||!Number.isInteger(Number(p.pack))||Number(p.pack)<1){const row=app.querySelector('[data-row="'+p.id+'"]');row?.scrollIntoView({block:'center'});if(row)row.style.outline='2px solid #b52c2c';throw new Error((i+1)+'행 '+(p.ko||p.fr||'이름 없는 상품')+' — 상품명, 공급업체, 박스당 수량을 확인하세요.');}}
 const items=products.map(productPayload);
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
 $('#product-status').textContent='✓ 저장 완료';
}
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
let previewSnapshot=null,previewLanguage='ko',previewDevice='desktop',previewDraftInput=null;
function openShopPreview(snapshot=selectedEvent(),language='ko',device='desktop'){
 previewSnapshot=snapshot;previewLanguage=language;previewDevice=device;
 const e=snapshot;if(!e)return;
 const ko=language==='ko',name=ko?(e.name||e.raw?.nameKo):(e.raw?.nameFr||e.name),intro=ko?(e.raw?.introKo||''):(e.raw?.introFr||''),pickup=ko?(e.pickupKo||''):(e.pickupFr||'');
 const products=(e.products||[]).filter(p=>p.active!==false);
 const cardWidth=device==='mobile'?'390px':'100%';
 const body='<div class="actions" style="margin-bottom:14px"><button class="filter '+(ko?'active':'')+'" data-action="preview-lang" data-value="ko">한국어</button><button class="filter '+(!ko?'active':'')+'" data-action="preview-lang" data-value="fr">Français</button><button class="filter '+(device==='desktop'?'active':'')+'" data-action="preview-device" data-value="desktop">PC</button><button class="filter '+(device==='mobile'?'active':'')+'" data-action="preview-device" data-value="mobile">모바일</button></div><div class="shop-preview-frame" style="max-width:'+cardWidth+';margin:auto"><h2>'+esc(name||'바자회')+'</h2><p style="white-space:pre-line">'+esc(intro)+'</p><p>'+esc(ko?'주문 마감':'Clôture des commandes')+' '+esc(e.orderDeadline||'—')+' · '+esc(ko?'송금 마감':'Date limite de virement')+' '+esc(e.transferDeadline||'—')+'</p><p>'+esc(pickup)+'</p><div class="preview-products">'+products.map(p=>'<article class="preview-product">'+(p.photo?'<img src="'+esc(p.photo)+'" alt="">':'<div class="preview-placeholder">📦</div>')+'<h3>'+esc(ko?p.ko:p.fr)+'</h3><p>'+esc(ko?p.koDesc:p.frDesc)+'</p><b>'+money(p.sale)+'</b><div class="notice">'+esc(ko?'미리보기 전용 · 주문 불가':'Aperçu uniquement · commande désactivée')+'</div></article>').join('')+'</div></div>';
 const draft=e.status==='draft';
 modal('구매자 화면 미리보기', '저장되지 않은 상품 편집 내용 포함 · 실제 주문은 비활성화되어 있습니다.',body,'<button class="btn neutral" data-action="close">닫기</button>'+(draft?'<button class="btn neutral" data-action="preview-save">임시저장</button><button class="btn primary" data-action="preview-publish">발행</button>':''));
}
function readDraftForm(){
 const value=id=>$('#'+id)?.value||'';
 return {nameKo:value('event-name').trim(),nameFr:value('event-name-fr').trim(),introKo:value('event-intro-ko'),introFr:value('event-intro-fr'),orderCutoff:parisToIso(value('event-order-date')&&value('event-order-time')?value('event-order-date')+'T'+value('event-order-time'):''),transferCutoff:parisToIso(value('event-transfer-date')&&value('event-transfer-time')?value('event-transfer-date')+'T'+value('event-transfer-time'):''),pickupKo:value('event-pickup-ko'),pickupFr:value('event-pickup-fr'),beneficiary:value('event-beneficiary'),iban:value('event-iban')};
}
function handleScreenAction(action,button){
 if(['all-pdf','all-excel','one-pdf','one-excel'].includes(action)){run(button,async()=>{assertConfirmedScope();exportAction(action);});return true;}
 const e=selectedEvent();
 if(action==='copy-banner'){run(button,()=>navigator.clipboard.writeText(button.dataset.url));return true;}
 if(action==='draft-list'){modal('임시저장 행사 선택','',model.drafts.map(d=>'<p><a class="btn neutral" href="'+esc(url('',d.id))+'">'+esc(d.nameKo)+'</a></p>').join('')||'임시저장 행사가 없습니다.');return true;}
 if(action==='event-filter'){location.href=url('',null)+(button.dataset.value==='all'?'':'?status='+encodeURIComponent(button.dataset.value));return true;}
 if(action==='new-event'){draftModal();return true;}
 if(action==='preview-shop'){openShopPreview(selectedEvent());return true;}
 if(action==='copy-event'){run(button,()=>navigator.clipboard.writeText(new URL(button.dataset.url,location.origin).href));return true;}
 if(action==='refresh-orders'){run(button,load);return true;}
 if(action==='csv-orders'){const rows=[['주문번호','성함','전화','이메일','품목','금액','상태'],...store.orders.map(o=>[o.ref,o.name,o.phone,o.email,o.items.map(i=>i[0]+' ×'+i[1]).join(' / '),total(o).toFixed(2),statuses[o.status][0]])];const csv='\uFEFF'+rows.map(row=>row.map(v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(';')).join('\r\n');const uri=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=uri;a.download='ASICC_orders.csv';a.click();URL.revokeObjectURL(uri);return true;}
 if(action==='finalize-unpaid'){if(prompt('은행 최종 대조 완료 후 미입금 주문을 취소합니다. 계속하려면 최종 확인을 입력하세요.')==='최종 확인')run(button,async()=>{let count=0,result;do{result=await request('finalizeUnpaid',{eventId:e.id,confirm:true});count+=result.canceled||0;}while(result.pending);alert(count+'건 취소 완료');location.href=url('',e.id);});return true;}
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
async function confirmOrder(id,button){
 const order=store.orders.find(order=>order.id===id);
 if(!canReconcile()||!order||!['reported','unpaid'].includes(order.status))return;
 if(confirm(order.ref+' · '+order.name+'님의 실제 은행 입금 '+money(total(order))+'을 확인하셨습니까?'))
  await run(button,async()=>{
   const result=await request('bankConfirm',{id,eventId:selectedEvent().id});
   if(result.needsReview)alert('최종 대조 후 입금 검토 대상으로 기록했습니다.');
   closeModal();await load();
  });
}
function handleModalAction(action,button){
 const id=button.dataset.id;
 if(action==='manual-order'&&canManageOrder()){manualOrderModal(id);return true;}
 if(action==='manual-order-save'&&canManageOrder()){run(button,()=>saveManualOrder(id));return true;}
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
  const base=existing?.raw||{};previewDraftInput={existing,fields,items:(existing?.products||[]).map(productPayload)};
  const event={...base,...fields};previewSnapshot={id:existing?.id,updatedAt:existing?.updatedAt,status:'draft',name:fields.nameKo,raw:event,products:existing?.products||[],orderDeadline:fields.orderCutoff?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(new Date(fields.orderCutoff)).replace(' ','T'):'',transferDeadline:fields.transferCutoff?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(new Date(fields.transferCutoff)).replace(' ','T'):'',pickupKo:fields.pickupKo,pickupFr:fields.pickupFr};
  openShopPreview(previewSnapshot);return true;
 }
 if(action==='preview-lang'||action==='preview-device'){openShopPreview(previewSnapshot,action==='preview-lang'?button.dataset.value:previewLanguage,action==='preview-device'?button.dataset.value:previewDevice);return true;}
 if(action==='preview-save'||action==='preview-publish'){
  run(button,async()=>{
   if(previewDraftInput){let target=previewDraftInput.existing|| (await request('createDraft')).draft;const saved=await request('saveDraft',{id:target.id,updatedAt:target.updatedAt,event:{...target.event,...previewDraftInput.fields},items:previewDraftInput.items});if(action==='preview-publish'){await request('publishDraft',{id:target.id,updatedAt:saved.updatedAt});}location.href=url('',target.id);}
   else{await saveProducts();const latest=selectedEvent();if(action==='preview-publish'){await request('publishDraft',{id:latest.id,updatedAt:latest.updatedAt});location.href=url('',latest.id);}else closeModal();}
  });return true;
 }
 if(action==='past-prev'||action==='past-next'){
  const selector=$('#past-selector'),length=model.past.length;
  selector.value=(Number(selector.value)+(action==='past-next'?1:-1)+length)%length;return true;
 }
 if(action==='create-draft'){
  run(button,async()=>{
   const nameKo=$('#event-name').value.trim(),nameFr=$('#event-name-fr').value.trim();
   if(!nameKo||!nameFr)throw new Error('한국어와 프랑스어 행사명을 입력해 주세요.');
   const fields={nameKo,nameFr,orderCutoff:parisToIso($('#event-order-date').value&&$('#event-order-time').value?$('#event-order-date').value+'T'+$('#event-order-time').value:''),transferCutoff:parisToIso($('#event-transfer-date').value&&$('#event-transfer-time').value?$('#event-transfer-date').value+'T'+$('#event-transfer-time').value:''),introKo:$('#event-intro-ko').value,introFr:$('#event-intro-fr').value,
    pickupKo:$('#event-pickup-ko').value,pickupFr:$('#event-pickup-fr').value,
    beneficiary:$('#event-beneficiary').value,iban:$('#event-iban').value};
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
