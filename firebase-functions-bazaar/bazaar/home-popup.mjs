// Public homepage campaign data only. No customer or order data is exposed.
const kimchi='https://dotasia.eu/cdn/shop/files/default-title-10kg-76498486919493.png?v=1758108920';
const rice='https://www.dunyongfoodservices.com/media/catalog/product/cache/12d2e42418ef20d971780ce2bd5d61b2/R/h/Rhee_Chun_Rice.jpg';
const firstPoster='/popup-assets/asicc-bazaar-2026.webp';
const firstTestEvents=new Set(['bazaar-1795524749706-cf2ffb3aa60b','bazaar-1795637217624-e68e66bc8716']);
export function defaultHomePopup(event,testMode=false){
  const poster=testMode&&firstTestEvents.has(event?.eventId);
  return {revision:0,enabled:testMode&&event?.status==='published',bazaarOnly:true,
    startsAt:'',endsAt:'',link:event?.eventId?'bazaar/?event='+event.eventId:'bazaar/',
    titleKo:'제1회 ASICC 온라인 바자회',titleFr:'Premier bazar solidaire en ligne',
    bodyKo:poster?'':'종가집 포기김치 · 이천쌀 공동구매와 다양한 한국 먹거리를 만나보세요.',
    bodyFr:poster?'':'Kimchi Jongga, riz Rhee Chun et autres spécialités coréennes : découvrez notre achat groupé solidaire.',
    buttonKo:'온라인 바자회 바로가기',buttonFr:'Accéder au bazar',
    image1:poster?firstPoster:'',
    caption1Ko:poster?'ASICC 온라인 바자회 — 김치와 이천쌀 공동구매':'',caption1Fr:poster?'Bazar ASICC — achat groupé de kimchi et de riz Rhee Chun':''};
}
// Migrate only the known legacy two-product preview for the first test bazaar.
export function singleImageHomePopup(settings,event,testMode=false){
  if(!settings)return settings;
  const {image2,caption2Ko,caption2Fr,...single}=settings;
  if(testMode&&firstTestEvents.has(event?.eventId)&&single.bazaarOnly&&single.image1===kimchi&&image2===rice){
    const defaults=defaultHomePopup(event,true);
    return {...single,image1:firstPoster,bodyKo:single.bodyKo==='종가집 포기김치 · 이천쌀 공동구매와 다양한 한국 먹거리를 만나보세요.'?'':single.bodyKo,
      bodyFr:single.bodyFr==='Kimchi Jongga, riz Rhee Chun et autres spécialités coréennes : découvrez notre achat groupé solidaire.'?'':single.bodyFr,
      caption1Ko:defaults.caption1Ko,caption1Fr:defaults.caption1Fr};
  }
  return single;
}
function secureUrl(value){
  if(typeof value!=='string'||value.length>900||!/^https:\/\//i.test(value))return false;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}
}
export function normalizeHomePopup(input){
  if(!input||typeof input.enabled!=='boolean'||typeof input.bazaarOnly!=='boolean')return null;
  const out={enabled:input.enabled,bazaarOnly:input.bazaarOnly};
  const limits={titleKo:120,titleFr:120,bodyKo:400,bodyFr:400,buttonKo:60,buttonFr:60,caption1Ko:100,caption1Fr:100,link:500,image1:900,startsAt:40,endsAt:40};
  for(const [key,max] of Object.entries(limits)){
    if(typeof input[key]!=='string'||input[key].length>max)return null;
    out[key]=input[key].trim();
  }
  if(['titleKo','titleFr','buttonKo','buttonFr','link'].some(k=>!out[k]))return null;
  if(!(/^(?:bazaar\/(?:\?event=[a-z0-9-]{12,60})?|(?:news|events|admission|about|section|contact|membres)\/(?:[a-z0-9/_-]+\/)?)$/.test(out.link)||secureUrl(out.link)))return null;
  if(out.bazaarOnly&&!/^bazaar\/(?:\?event=[a-z0-9-]{12,60})?$/.test(out.link))return null;
  // Same-origin, bundled poster assets may also be selected. No arbitrary relative URLs.
  if(['image1'].some(k=>out[k]&&!secureUrl(out[k])&&!/^\/popup-assets\/[a-z0-9-]+\.(?:png|jpe?g|webp)$/i.test(out[k])))return null;
  for(const k of ['startsAt','endsAt'])if(out[k]&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(out[k])||!Number.isFinite(Date.parse(out[k]))))return null;
  if(out.startsAt&&out.endsAt&&Date.parse(out.startsAt)>=Date.parse(out.endsAt))return null;
  return out;
}
export function publicHomePopup(settings,event,intake,at=Date.now()){
  const p=normalizeHomePopup(settings);if(!p||!p.enabled)return null;
  if(p.startsAt&&at<Date.parse(p.startsAt)||p.endsAt&&at>=Date.parse(p.endsAt))return null;
  if(p.bazaarOnly&&(!event||intake!=='open'||(p.link!=='bazaar/'&&p.link!=='bazaar/?event='+event.eventId)))return null;
  return {...p,revision:settings.revision??0,identity:p.bazaarOnly?event.eventId:'announcement'};
}
