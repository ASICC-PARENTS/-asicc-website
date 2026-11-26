import {formatParisDateTime,formatParisPickupRange,paymentHoursFor} from '../../../firebase-functions-bazaar/bazaar/payment-window.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const icons = {
  ambient: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2m0-14-2 2M7 17l-2 2"/>',
  chilled: '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0Zm2 2V9m5-1h3m-3 4h3"/>',
  frozen: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3"/>',
};
const storageLabels = { ambient:['실온','Température ambiante'], chilled:['냉장','Réfrigéré'], frozen:['냉동','Surgelé'] };
const localize = (lang,ko,fr) => lang==='fr'?fr:ko;
export function stockNotice(stock,lang,selected=0) {
  if(stock==null)return '';
  const t=(ko,fr)=>localize(lang,ko,fr);
  const remaining=Math.max(0,stock-Math.max(0,selected));
  return '<p class="bz-stock">'+escape(stock<=0?t('매진','Épuisé'):t('남은 수량 '+remaining+'개','Stock restant : '+remaining))+'</p>';
}
const eventIcons={
  calendar:'M5 4h14a2 2 0 0 1 2 2v13H3V6a2 2 0 0 1 2-2Zm2-2v5m10-5v5M3 9h18m-13 4h2m4 0h2m-8 3h2',
  wallet:'M3 6h16a2 2 0 0 1 2 2v11H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm18 4h-6a2 2 0 0 0 0 5h6m-5-2h.01',
  detailArrow:'M5 4v7a3 3 0 0 0 3 3h11m-5-5 5 5-5 5',
  pin:'M20 10c0 5-8 11-8 11s-8-6-8-11a8 8 0 1 1 16 0Zm-5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  heart:'M12 20 4 12a5 5 0 0 1 8-6 5 5 0 0 1 8 6l-8 8Z',
  info:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 9v6m0-10h.01'
};
const eventIcon=path=>'<svg class="bz-info-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+path+'"/></svg>';
const disclosure=(key,label,icon,body,toggleLabels)=>'<details class="bz-disclosure" data-bz-disclosure="'+key+'"><summary>'+eventIcon(icon)+'<span>'+escape(label)+'</span>'+(toggleLabels?'<span class="bz-toggle-label" aria-hidden="true"><span class="bz-expand-label">'+escape(toggleLabels[0])+'</span><span class="bz-collapse-label">'+escape(toggleLabels[1])+'</span></span>':'')+'<span class="bz-chevron" aria-hidden="true"></span></summary><div class="bz-disclosure-body">'+body+'</div></details>';
// Keep the original event title, but allow a deliberate mobile break at a phrase boundary.
function eventTitleMarkup(name){
  const parts=String(name).match(/^(.+?(?:!|！| [–—-]))\s+(.+)$/u);
  if(!parts)return escape(name);
  return '<span class="bz-title-phrase">'+escape(parts[1])+'</span> <span class="bz-title-phrase">'+escape(parts[2])+'</span>';
}
export function renderShopEvent(event,lang,{showStatus=false}={}) {
  const t=(ko,fr)=>localize(lang,ko,fr);
  const date=value=>formatParisDateTime(value,lang);
  const name=t(event.nameKo,event.nameFr)||t('ASICC 온라인 바자회','Bazar en ligne ASICC');
  const info=(label,value,icon,note='')=>'<div class="bz-deadline">'+eventIcon(icon)+'<div><span class="bz-info-label">'+escape(label)+'</span><strong class="bz-info-date">'+escape(value||'—')+'</strong>'+(note?'<small class="bz-info-note">'+escape(note)+'</small>':'')+'</div></div>';
  const hours=paymentHoursFor(event);
  const paymentWindow=t('주문 후 '+hours+'시간 이내','Dans les '+hours+' heures suivant la commande');
  const finalDeadline=event.transferCutoff?t('최종 송금 마감: ','Date limite finale : ')+date(event.transferCutoff):'';
  const intro=t(event.introKo,event.introFr);
  const pickup=t(event.pickupKo,event.pickupFr);
  return '<div class="bz-shared-hero"><div class="bz-hero-banner">'+
    '<h1>'+eventTitleMarkup(name)+'</h1>'+
    (showStatus?'<div class="bz-hero-status-slot"></div>':'')+'</div>'+
    '<div class="bz-shared-info">'+
    info(t('주문 마감','Clôture des commandes'),date(event.orderCutoff),eventIcons.calendar)+
    info(t('송금 기한','Délai de virement'),paymentWindow,eventIcons.wallet,finalDeadline)+
    '<div class="bz-pickup-card">'+info(t('상품 수령','Retrait des commandes'),formatParisPickupRange(event.pickupAt,event.pickupEndAt,lang),eventIcons.pin)+
    (event.pickupPlace?'<p class="bz-pickup-place">'+escape(event.pickupPlace)+'</p>':'')+
    (pickup?disclosure('pickup',t('상세 주소 및 주차 안내','Adresse et informations de retrait'),eventIcons.detailArrow,'<p>'+escape(pickup)+'</p>',[t('펼치기','Afficher'),t('접기','Replier')]):'')+'</div></div>'+
    (intro?disclosure('intro',t('바자회 소개 및 수익금 사용 안내','Présentation du bazar et utilisation des bénéfices'),eventIcons.heart,'<p>'+escape(intro)+'</p>'):'')+'</div>';
}
export function renderShopNotice(lang,paymentHours=24){
  const L=(_lang,value)=>localize(lang,value.ko,value.fr);
  const t=(ko,fr)=>localize(lang,ko,fr);
  const hours=Number(paymentHours)||24;
const rows = [
  { title:L(lang,{ko:'한정 수량 판매',fr:'Quantités limitées'}), icon:'M4 7l8-4 8 4v10l-8 4-8-4V7Zm0 0 8 4 8-4m-8 4v10', lines:[
    L(lang,{ko:'일부 상품은 한정된 수량으로 판매되며, 재고 소진 시 해당 상품의 주문 접수가 조기에 마감될 수 있습니다.',fr:'Certains produits sont proposés en quantité limitée. Les commandes de ces produits pourront être clôturées avant la date prévue en cas d’épuisement des stocks.'})]},
  { title:L(lang,{ko:'주문 후 24시간 이내 송금',fr:'Paiement par virement sous 24 heures'}), icon:'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', payment:true, lines:[
    '',
    L(lang,{ko:'신속한 입금 확인을 위해 가능하면 즉시 계좌이체(Virement instantané)로 송금해 주세요.',fr:'Pour permettre une confirmation rapide du paiement, merci de privilégier le virement instantané.'}),
    L(lang,{ko:'한정 수량 상품에 대한 다른 구매자의 구매 기회를 보장하기 위해 기한 내 송금 완료 신고가 이루어지지 않은 주문은 취소될 수 있습니다.',fr:'Afin de permettre à d’autres acheteurs de bénéficier des produits disponibles en quantité limitée, toute commande dont le virement n’a pas été signalé dans le délai imparti pourra être annulée.'}),
    L(lang,{ko:'송금 시 반드시 주문번호만 송금 메모에 기재해 주세요.',fr:'Merci d’indiquer uniquement votre numéro de commande dans le libellé du virement.'})]},
  { title:L(lang,{ko:'주문 변경 및 취소',fr:'Modification et annulation des commandes'}), icon:'M4 19h16M5 15l-1 4 4-1L19 7l-3-3L5 15Zm9-9 3 3', lines:[
    L(lang,{ko:'주문 전 상품과 수량을 충분히 확인해 주세요. 주문 변경, 취소 및 환불은 주문서에 명시된 구매 규정에 따라 처리됩니다.',fr:'Veuillez vérifier attentivement les produits et les quantités avant de valider votre commande. Toute modification, annulation ou demande de remboursement sera traitée conformément aux conditions indiquées dans le formulaire de commande.'})]},
  { title:L(lang,{ko:'상품 수령 안내',fr:'Retrait des commandes'}), icon:'M20 10c0 5-8 11-8 11s-8-6-8-11a8 8 0 1 1 16 0Zm-5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', lines:[
    L(lang,{ko:'상품은 지정된 날짜와 장소에서 직접 수령해 주세요. 별도의 배송 서비스는 제공하지 않습니다.',fr:'Les produits doivent être retirés à la date et au lieu indiqués. Aucun service de livraison n’est proposé.'})]},
  { title:L(lang,{ko:'냉장·냉동 상품 안내',fr:'Produits réfrigérés et surgelés'}), icon:'M12 3v18m-8-14 16 10M4 17 20 7M9 5l3 3 3-3m-6 14 3-3 3 3', lines:[
    L(lang,{ko:'냉장·냉동 상품 구매 시 보냉 가방을 준비해 주시고, 수령 후 상품별 보관 방법을 준수해 주세요.',fr:'Veuillez prévoir un sac isotherme et respecter les conditions de conservation des produits après leur retrait.'})]},
  { title:L(lang,{ko:'함께 만들어 가는 ASICC 바자회',fr:'Ensemble, faisons vivre le bazar de l’ASICC'}), icon:'M12 20 4 12a5 5 0 0 1 8-6 5 5 0 0 1 8 6l-8 8Z', purpose:true, lines:[
    L(lang,{ko:'바자회 수익금은 한국어 국제섹션 학생들을 위한 교육·문화 활동 및 학부모협회의 공익 활동에 사용됩니다.',fr:'Les bénéfices du bazar contribuent au financement des activités éducatives et culturelles destinées aux élèves de la section internationale coréenne, ainsi qu’aux actions d’intérêt général de l’association.'})]},
];
  const paymentTitle=t('주문 후 '+hours+'시간 이내 송금','Paiement par virement sous '+hours+' heures');
  const paymentWindow=t('주문 완료 후 '+hours+'시간 이내에 송금해 주세요. 단, 행사 전체 송금 마감이 더 빠른 경우에는 해당 마감 시간이 적용됩니다.','Veuillez effectuer votre virement dans les '+hours+' heures suivant votre commande. Si la date limite générale de paiement du bazar intervient plus tôt, cette dernière s’applique.');
  const body='<ul>'+rows.map(({title,icon,lines,payment,purpose})=>'<li'+(purpose?' class="bz-purpose"':'')+'>'+eventIcon(icon)+'<div><h3'+(payment?' id="bz-transfer-heading"':'')+'>'+escape(payment?paymentTitle:title)+'</h3>'+
    lines.map((line,index)=>'<p'+(payment&&index===0?' id="bz-transfer-window"':'')+'>'+escape(payment&&index===0?paymentWindow:line)+'</p>').join('')+'</div></li>').join('')+'</ul>';
  return '<aside class="bz-before" aria-label="'+t('꼭 확인해 주세요','Informations importantes avant de commander')+'">'+
    '<details class="bz-disclosure" data-bz-disclosure="notice"><summary>'+eventIcon(eventIcons.info)+'<span><strong>'+t('주문 전 꼭 확인해 주세요','À lire avant de commander')+'</strong><small id="bz-notice-summary">'+escape(paymentTitle+' · '+t('직접 수령','Retrait sur place'))+'</small></span><span class="bz-chevron" aria-hidden="true"></span></summary><div class="bz-disclosure-body">'+body+'</div></details></aside>';
}
export function preserveShopDisclosures(root,render){
  const open=new Set([...root.querySelectorAll('details[data-bz-disclosure][open]')].map(item=>item.dataset.bzDisclosure));
  render();
  root.querySelectorAll('details[data-bz-disclosure]').forEach(item=>{if(open.has(item.dataset.bzDisclosure))item.open=true;});
}
export const quantityCap=stock=>Math.min(100,stock??100);
export function changeCartQuantity(cart,id,delta,stock){
 const qty=Math.max(0,Math.min(quantityCap(stock),(cart[id]||0)+delta));
 if(qty>0)cart[id]=qty;else delete cart[id];
 return qty;
}
export function renderShopProducts(products,lang,{quantity,controls,price}) {
  const t=(ko,fr)=>localize(lang,ko,fr);
  return '<div class="bz-shared-products">'+products.map(product=>{
    const name=t(product.titleKo,product.titleFr),storage=storageLabels[product.storage];
    const label=storage?t(...storage):'';
    const icon=storage?'<button type="button" class="bz-storage-icon '+product.storage+'" title="'+escape(label)+'" aria-label="'+escape(label)+'" aria-expanded="false"><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7">'+icons[product.storage]+'</svg><span>'+escape(label)+'</span></button>':'';
    const photo=product.imageUrl?'<img class="bz-photo" src="'+escape(product.imageUrl)+'" alt="'+escape(name)+'" loading="lazy">':'<div class="bz-photo bz-placeholder" aria-hidden="true">📦</div>';
    const selected=quantity(product);
    const stamp=product.stockRemaining===0?'<span class="bz-sold-stamp">'+t('매진','ÉPUISÉ')+'</span>':'';
    return '<article class="bz-shared-product"><div class="bz-shared-photo">'+photo+stamp+icon+'</div>'+
      '<div class="bz-desc"><h3>'+escape(name)+'</h3><p>'+escape(t(product.descriptionKo,product.descriptionFr))+'</p>'+
      '<strong class="bz-price">'+escape(price(product.priceCents))+'</strong></div>'+
      '<div class="bz-shared-actions">'+controls(product,selected,product.stockRemaining===0)+stockNotice(product.stockRemaining,lang,selected)+'</div></article>';
  }).join('')+'</div>';
}
export function bindStorageLabels(root) {
  root.addEventListener('click',event=>{
    const icon=event.target.closest?.('.bz-storage-icon');
    if(icon)icon.setAttribute('aria-expanded',String(icon.getAttribute('aria-expanded')!=='true'));
  });
}
