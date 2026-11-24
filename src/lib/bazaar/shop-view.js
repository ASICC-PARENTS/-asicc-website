const escape = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const icons = {
  ambient: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2m0-14-2 2M7 17l-2 2"/>',
  chilled: '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0Zm2 2V9m5-1h3m-3 4h3"/>',
  frozen: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3"/>',
};
const storageLabels = { ambient:['실온','Température ambiante'], chilled:['냉장','Réfrigéré'], frozen:['냉동','Surgelé'] };
const localize = (lang,ko,fr) => lang==='fr'?fr:ko;
export function stockNotice(stock,lang) {
  if(stock==null)return '';
  const t=(ko,fr)=>localize(lang,ko,fr);
  if(stock<=0)return '<p class="bz-stock is-sold">'+t('품절','Épuisé')+'</p>';
  return '<p class="bz-stock'+(stock<=10?' is-low':'')+'">'+
    (stock<=10?t('남은 수량 '+stock+'개','Quantité restante : '+stock):t('한정수량 '+stock+'개','Quantité limitée : '+stock))+'</p>';
}
export function renderShopEvent(event,lang) {
  const t=(ko,fr)=>localize(lang,ko,fr);
  const date=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat(lang==='fr'?'fr-FR':'ko-KR',{
    timeZone:'Europe/Paris',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).format(new Date(value)):'—';
  const name=t(event.nameKo,event.nameFr)||t('ASICC 온라인 바자회','Bazar en ligne ASICC');
  const info=(label,value)=>'<div><strong>'+label+'</strong><p>'+escape(value||'—')+'</p></div>';
  return '<div class="bz-shared-hero"><span>ASICC ONLINE BAZAAR</span><h1>'+escape(name)+'</h1><p>'+
    escape(t(event.introKo,event.introFr))+'</p><div class="bz-shared-info">'+
    info(t('주문 마감','Clôture des commandes'),date(event.orderCutoff))+
    info(t('송금 마감','Date limite de virement'),date(event.transferCutoff))+
    info(t('상품 수령 안내','Informations de retrait'),t(event.pickupKo,event.pickupFr))+'</div></div>';
}
export function renderShopProducts(products,lang,{quantity,controls,price}) {
  const t=(ko,fr)=>localize(lang,ko,fr);
  return '<div class="bz-shared-products">'+products.map(product=>{
    const name=t(product.titleKo,product.titleFr),storage=storageLabels[product.storage];
    const label=storage?t(...storage):'';
    const icon=storage?'<button type="button" class="bz-storage-icon '+product.storage+'" title="'+escape(label)+'" aria-label="'+escape(label)+'" aria-expanded="false"><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7">'+icons[product.storage]+'</svg><span>'+escape(label)+'</span></button>':'';
    const photo=product.imageUrl?'<img class="bz-photo" src="'+escape(product.imageUrl)+'" alt="'+escape(name)+'" loading="lazy">':'<div class="bz-photo bz-placeholder" aria-hidden="true">📦</div>';
    return '<article class="bz-shared-product"><div class="bz-shared-photo">'+photo+icon+'</div>'+
      '<div class="bz-desc"><h3>'+escape(name)+'</h3><p>'+escape(t(product.descriptionKo,product.descriptionFr))+'</p>'+
      stockNotice(product.stockRemaining,lang)+'<strong class="bz-price">'+escape(price(product.priceCents))+'</strong></div>'+
      '<div class="bz-shared-actions">'+controls(product,quantity(product),product.stockRemaining===0)+'</div></article>';
  }).join('')+'</div>';
}
export function bindStorageLabels(root) {
  root.addEventListener('click',event=>{
    const icon=event.target.closest?.('.bz-storage-icon');
    if(icon)icon.setAttribute('aria-expanded',String(icon.getAttribute('aria-expanded')!=='true'));
  });
}
