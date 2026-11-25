import {orderPaymentSummary} from './order-payments.mjs';
import {validRefundIban} from './iban.mjs';
import {defaultPaymentHours,paymentGuidance,personalTransferDeadline,transferIdentification} from './payment-window.mjs';
import {orderTerms,orderTermsVersion,pickupTerms,pickupContact} from './order-terms.mjs';
import {randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import {catalogue, initialEvent} from './products.mjs';

export class BazaarError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function depositDetails(data) {
  const details=Object.fromEntries(Object.entries({payer:120,operator:120,reference:160,note:500})
    .map(([field,max])=>[field,typeof data[field]==='string'?data[field].trim().slice(0,max+1):'']));
  const actualDate=typeof data.actualDate==='string'?data.actualDate:'';
  if(Object.entries({payer:120,operator:120,reference:160,note:500}).some(([field,max])=>details[field].length>max)||
    actualDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(actualDate)||!Number.isFinite(Date.parse(actualDate))||
      new Date(actualDate).toISOString().slice(0,10)!==actualDate))return null;
  return {...details,actualDate};
}

export function createBazaar({ db, FieldValue, HttpsError = BazaarError, storePhoto, eventPhoto, siteUrl,
  sendQueuedMail, canSendMail, queueFields = () => ({}), mailAdmin, evidence, batchFinalization = false, requireExplicitAdmin = false, pilot = false }) {
  const eventRef=db.doc('bazaarMeta/event');
  const products=db.collection('bazaarProducts');
  const orders=db.collection('bazaarOrders');
  const outbox=db.collection('bazaarOutbox');
  const eventArchives=db.collection('bazaarEvents');
  const eventDrafts=db.collection('bazaarDrafts');
  const catalogRef=db.doc('bazaarMeta/baseCatalog');
  const purchaseOrders=db.collection('bazaarPurchaseOrders');
  const eventFinancials=db.collection('bazaarEventFinancials');
  async function requireOpenAccounting(tx,eventId){
    if((await tx.get(eventFinancials.doc(eventId))).data()?.finalizedAt)
      throw new HttpsError('failed-precondition','확정 결산을 정정 상태로 전환한 뒤 기록하세요.');
  }
  const catalogPhotoScope='base-catalog';
  function catalogItems(rows){
    return rows.map(({soldQty,bazaarEventId,plannedBoxes,manualLimit,limitMode,...p})=>p)
      .sort((a,b)=>a.displayOrder-b.displayOrder);
  }
  function catalogSnapshot(products){
    return catalogItems(products.empty?catalogue:snapshotProducts(products));
  }
  function initializeCatalog(tx, products){
    const items=catalogSnapshot(products);
    if(Buffer.byteLength(JSON.stringify(items))>800000)bad('기본 상품 정보가 너무 많습니다.');
    tx.create(catalogRef,{revision:1,items,updatedAt:now()});
  }
  function normalizeCatalog(rows){
    if(!Array.isArray(rows)||rows.length>70)bad('기본 상품 목록을 확인해 주세요.');
    const ids=new Set();
    return rows.map((item,index)=>{
      const id=s(item.id);
      if(!productIdValid(id)||ids.has(id))bad('기본 상품 ID가 올바르지 않습니다.');
      ids.add(id);
      const p=validateProduct({...item,imageUrl:item.photoPath?'':item.imageUrl,limitMode:'unlimited',visible:false},{soldQty:0},true);
      return {...catalogItems([p])[0],id,visible:item.visible===true,displayOrder:index+1,
        photoPath:s(item.photoPath),archivedAt:null};
    });
  }
  async function copyProductPhoto(eventId,id,product){
    if(!product.photoPath||typeof product.photoPath!=='string'||product.photoPath.startsWith(`bazaar-photos/${eventId}/${id}/`))
      return eventPhoto(eventId,id,product);
    if(product.photoPath.split('/')[2]!==id)bad('선택한 상품의 사진을 확인해 주세요.');
    try{return await storePhoto(eventId,id,{sourcePath:product.photoPath});}
    catch{throw new HttpsError('failed-precondition','행사 사진을 복사하지 못했습니다. 원본 사진과 행사 자료는 유지됩니다.');}
  }
  function normalizePurchase(data){
    const vendor=s(data.vendor);
    if(!vendor||vendor.length>120||!Array.isArray(data.lines)||data.lines.length>100)bad('발주서 정보를 확인해 주세요.');
    const lines=data.lines.map(line=>{
      const name=s(line.name),unit=s(line.unit);
      if(!name||name.length>200||!['박스','개','봉','세트'].includes(unit)
        ||!Number.isSafeInteger(line.qty)||line.qty<0||line.qty>10000
        ||!cents(line.priceCents)||!cents(line.amountCents))bad('발주 품목·단위를 확인해 주세요.');
      return {id:s(line.id).slice(0,70),name,unit,qty:line.qty,priceCents:line.priceCents,
        amountCents:line.amountCents,manual:line.manual===true,ordered:Number.isSafeInteger(line.ordered)?line.ordered:0,
        per:Number.isSafeInteger(line.per)?line.per:0};
    });
    const keys=['number','date','contact','email','deliveryDate','location','notes','owner'];
    const info=Object.fromEntries(keys.map(key=>[key,s(data.info?.[key]).slice(0,key==='notes'?2000:200)]));
    return {vendor,lines,info};
  }
  const s=x=>typeof x==='string'?x.trim():'';
  const bad=(message)=>{throw new HttpsError('invalid-argument',message)};
  const cents=n=>Number.isSafeInteger(n)&&n>=0&&n<=1_000_000_00;
  const euro=c=>(c/100).toFixed(2)+' €';
  const now=()=>new Date().toISOString();
  const localDate=(d,locale)=>Number.isFinite(Date.parse(d))
    ?new Intl.DateTimeFormat(locale,{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short'}).format(new Date(d)):'—';
  const stockCap=p=>p.limitMode==='unlimited'?null:p.limitMode==='box'?(p.packQty*(p.plannedBoxes??0)):p.manualLimit;
  const esc=t=>String(t??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const validUrl=v=>!v||(/^https:\/\/[^\s]+$/.test(v)&&v.length<=1200);
  const validEventId=id=>/^[a-z0-9-]{12,60}$/.test(id);
  const productIdValid=id=>/^[a-z0-9-]{2,50}$/.test(id);
  const closed=e=>e?.status==='closed'||!!e?.finalizedAt;
  const snapshotProducts=ps=>ps.docs.map(d=>({id:d.id,...d.data()}));
  function archiveEvent(tx, ref, event, products, at) {
    const items=snapshotProducts(products);
    const archive={event:{...event,status:'closed'},products:event.scopedProducts
      ?items.filter(item=>item.bazaarEventId===event.eventId):items,archivedAt:at};
    if (Buffer.byteLength(JSON.stringify(archive))>850000) {
      throw new HttpsError('failed-precondition','보관할 상품 정보가 너무 많습니다.');
    }
    tx.create(ref,archive);
  }
  const safeOrder=x=>{const {buyerToken,requestFingerprint,createdBy,parentId,...rest}=x;return {...rest,payment:orderPaymentSummary(x)}};
  const locked = event => Boolean(event?.finalizedAt || event?.reconciliationStartedAt || event?.reconciledAt);
  const paymentDetails = order => {
    const { iban, beneficiary, transferCutoff } = order.eventSnapshot ?? {};
    return { orderRef: order.orderRef, totalCents: order.totalCents, iban, beneficiary, transferCutoff:order.paymentDeadline||transferCutoff,paymentHours:order.paymentHours??null };
  };
  const orderNotOpen=event=>!!event.orderStartsAt&&Date.now()<Date.parse(event.orderStartsAt);
  function eventSchedule(input){
    const orderStartsAt=s(input.orderStartsAt),pickupAt=s(input.pickupAt),pickupPlace=s(input.pickupPlace).slice(0,300);
    if((orderStartsAt&&(!Number.isFinite(Date.parse(orderStartsAt))||Date.parse(orderStartsAt)>=Date.parse(input.orderCutoff)))||(pickupAt&&!Number.isFinite(Date.parse(pickupAt))))bad('주문 시작과 픽업 일정을 확인해 주세요.');
    const paymentHours=input.paymentHours==null||input.paymentHours===''?defaultPaymentHours:Number(input.paymentHours);
    if(!Number.isSafeInteger(paymentHours)||paymentHours<1||paymentHours>720)bad('개인 송금 시간은 1~720시간이어야 합니다.');
    return {orderStartsAt,pickupAt,pickupPlace,paymentHours};
  }
  const buyerCanCancel=event=>event?.status==='published'&&Date.now()<Date.parse(event.orderCutoff);
  const publicItem=({titleKo,titleFr,qty,priceCents})=>({titleKo,titleFr,qty,priceCents});
  function buyerOrder(order, event) {
    return {
      ...paymentDetails(order),
      items: order.canceledAt?[]:order.items.map(publicItem),
      canceledItems:[...(order.canceledItems||[]),...(order.canceledAt?order.items:[])].map(publicItem),
      payment:orderPaymentSummary(order), name:order.name,createdAt:order.createdAt,
      modifiedAt:order.modifiedAt||null,eventNameKo:order.eventSnapshot?.nameKo||'',eventNameFr:order.eventSnapshot?.nameFr||'',
      refundReason:order.publicRefundReason||'',lastRefundAt:order.lastRefundAt||null,
      pickupNote: order.pickupNote,
      transferReportedAt: order.transferReportedAt, bankConfirmedAt: order.bankConfirmedAt, canceledAt: order.canceledAt,
      canChange: event?.eventId === order.eventId && !locked(event),
      canCancel: event?.eventId === order.eventId && !locked(event) && buyerCanCancel(event)
    };
  }
  const orderItem=(p,id,qty)=>({id,qty,priceCents:p.retailCents,titleKo:p.titleKo,titleFr:p.titleFr,supplier:p.supplier,
    descriptionKo:p.descriptionKo||'',descriptionFr:p.descriptionFr||'',imageUrl:p.imageUrl||'',photoPath:p.photoPath||'',
    storage:p.storage||'ambient',packQty:p.packQty,boxPriceTtcCents:p.boxPriceTtcCents,
    boxPriceHtCents:p.boxPriceHtCents??null,plannedBoxes:p.plannedBoxes??null});
  const totalFor=items=>items.reduce((total,item)=>total+item.qty*item.priceCents,0);
  function orderTotal(items){
    const total=totalFor(items);
    if(!cents(total)||total===0)bad('금액을 확인해 주세요.');
    return total;
  }
  function assertOrderEvent(event,eventId){
    if(event?.eventId!==eventId||!['published','closed'].includes(event.status)||locked(event))
      throw new HttpsError('failed-precondition','현재 관리 중인 행사를 다시 확인해 주세요. 최종 입금 대조가 시작된 행사에는 주문을 변경할 수 없습니다.');
  }
  function assertAvailable(product,delta,id){
    if(!product||delta<=0)return;
    const limit=stockCap(product);
    if(limit!=null&&(product.soldQty||0)+delta>limit)
      throw new HttpsError('failed-precondition',`${product.titleKo||id}의 재고가 부족합니다.`,
        { reason:'stock', productId:id, available:Math.max(0,limit-(product.soldQty||0)) });
  }
  const pickPublic=p=>({id:p.id,titleKo:p.titleKo,titleFr:p.titleFr,descriptionKo:p.descriptionKo||'',descriptionFr:p.descriptionFr||'',priceCents:p.retailCents,storage:p.storage||'ambient',imageUrl:p.imageUrl||'',displayOrder:p.displayOrder,stockCap:stockCap(p),stockRemaining:stockCap(p)==null?null:Math.max(0,stockCap(p)-(p.soldQty||0))});
  async function requireAdmin(req){
    if(!req.auth?.uid) throw new HttpsError('unauthenticated','관리자 로그인이 필요합니다.');
    const [member, access] = await db.getAll(db.collection('members').doc(req.auth.uid), db.doc('bazaarMeta/access'));
    const profile = member.data();
    const allowed = access.data()?.adminUids;
    if(req.auth.token?.email_verified!==true||profile?.status!=='approved'||profile.role!=='admin'||((requireExplicitAdmin||access.exists)&&(!Array.isArray(allowed)||!allowed.includes(req.auth.uid)))) throw new HttpsError('permission-denied','바자회 관리자 권한이 없습니다.');
  }
  function checkBuyerOrder(x,{emailOptional=false}={}){
    if(!x||typeof x!=='object')bad('주문 정보를 확인해 주세요.');
    const name=s(x.name),email=s(x.email).toLowerCase(),phone=s(x.phone);
    if(name.length<2||name.length>100)bad('성함을 확인해 주세요.');
    if((email||!emailOptional)&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>200))bad('이메일을 확인해 주세요.');
    if(phone.replace(/\D/g,'').length<8||phone.length>40)bad('전화번호를 확인해 주세요.');
    if(!Array.isArray(x.items)||x.items.length<1||x.items.length>30)bad('장바구니를 확인해 주세요.');
    const idSet=new Set();
    const items=x.items.map(i=>{
      const id=s(i.id),qty=Number(i.qty),priceCents=i.priceCents;
      if(!/^[a-z0-9-]{2,50}$/.test(id)||!Number.isSafeInteger(qty)||qty<1||qty>100||!cents(priceCents)||idSet.has(id))bad('수량 또는 품목이 올바르지 않습니다.');
      idSet.add(id);return{id,qty,priceCents};
    });
    if(x.pickupNote!==undefined&&(typeof x.pickupNote!=='string'||x.pickupNote.length>500)){
      bad(x.lang==='fr'?'Limitez les informations de retrait à 500 caractères.':'판매자에게 전달할 사항은 500자 이내로 입력해 주세요.');
    }
    const pickupNote=s(x.pickupNote);
    return{name,email,phone,items,lang:x.lang==='fr'?'fr':'ko',...(pickupNote?{pickupNote}:{})};
  }
  async function queue(tx,orderId,type,extra={}){
    const {jobKey=type,...fields}=extra;
    const id=`${orderId}_${jobKey}`;
    tx.create(outbox.doc(id),{orderId,type,createdAt:now(),sentAt:null,attempts:0,...queueFields(type),...fields});
    return id;
  }
  function links(order){
    const origin=siteUrl();
    const base=`${origin}/${order.lang==='fr'?'fr':'ko'}/bazaar/commande/`;
    return `${base}?id=${encodeURIComponent(order.id)}${pilot?'&pilot=1':''}#token=${encodeURIComponent(order.buyerToken)}`;
  }
  function message(order,type,event={},template={},change={}){
    const fr=order.lang==='fr';
    const t=(ko,french)=>fr?french:ko;
    const contact=pickupContact;
    let [title,intro]=({
      receipt:[t('바자회 주문 접수','Commande reçue'),t('주문이 접수되었습니다. 아직 입금 확인 또는 주문 확정 상태는 아닙니다.',
        'Nous avons reçu votre commande. Elle sera confirmée après réception du virement.')],
      reported:[t('송금 완료 알림 접수','Signalement de virement reçu'),t('송금 완료 알림이 접수되었습니다. 실제 입금 확인 및 주문 확정은 별도로 진행됩니다.',
        'Votre signalement a été reçu. La validation du virement et la confirmation de la commande suivront.')],
      confirmed:[t('바자회 주문 확정','Commande confirmée'),t('입금이 확인되어 주문이 확정되었습니다. 감사합니다!',
        'Nous avons reçu votre virement et votre commande est confirmée. Merci !')],
      cancel:[t('바자회 주문 취소','Commande annulée'),t('주문이 취소되었습니다.','Votre commande a été annulée.')],
      bulkCancel:[t('바자회 주문 취소 안내','Commande annulée faute de paiement'),t(
        `최종 입금 확인 시점까지 입금이 확인되지 않아 주문이 취소되었습니다. 이미 송금하셨다면 주문번호와 송금일을 ${contact}로 알려주세요.`,
        `Votre commande a été annulée faute de paiement confirmé. Si vous avez déjà effectué le virement, envoyez sa date et votre référence de commande à ${contact}.`)],
      reminder3:[t('바자회 송금 안내','Rappel de virement'),t('아직 송금 완료 표시가 접수되지 않았습니다. 송금을 마치셨다면 아래 주문 관리 링크에서 알려주세요.',
        'Nous n’avons pas encore reçu votre signalement de virement. Si vous avez déjà payé, signalez-le via le lien de suivi ci-dessous.')],
      orderChanged:[t('바자회 주문 변경','Commande modifiée'),t('운영진이 주문 내역을 변경했습니다.','L’association a modifié votre commande.')],
      additionalPayment:[t('바자회 추가 송금 안내','Virement complémentaire'),t('변경된 주문에 추가 송금이 필요합니다.','Un virement complémentaire est nécessaire.')],
      refundCompleted:[t('바자회 환불 완료','Remboursement effectué'),t('은행 환불을 처리했습니다.','Le remboursement bancaire a été effectué.')],
      pickup:[t('상품 수령 안내','Retrait des produits'),t('행사 안내에 따라 상품을 수령해 주세요.','Veuillez suivre les indications de retrait.')],
      reminderFinal:[t('바자회 송금 마감 안내','Rappel avant la date limite de virement'),t('송금 마감 안내입니다. 아직 송금 완료 표시가 접수되지 않았습니다.',
        'La date limite de virement approche. Nous n’avons pas encore reçu votre signalement de virement.')]
    })[type]||[t('바자회 안내','Informations sur la vente solidaire'),t('주문 안내','Informations sur votre commande')];
    title=t(template.subjectKo,template.subjectFr)||title;
    intro=t(template.introKo,template.introFr)||intro;
    const subject=`[ASICC] ${title}`;
    const items=order.items.map(i=>`• ${t(i.titleKo||i.titleFr,i.titleFr||i.titleKo)} × ${i.qty} = ${euro(i.qty*i.priceCents)}`).join('\n');
    const note=type==='receipt'&&order.pickupNote
      ?`\n\n${t('판매자에게 전달할 사항','Informations complémentaires pour le retrait')}\n${order.pickupNote}`:'';
    const url=links(order);
    const action=t('주문 관리 페이지','Consulter la commande');
    const eventName=t(event.nameKo,event.nameFr);
    const details=[...(eventName?[eventName]:[]),`${t('주문번호','Référence de commande')}: ${order.orderRef}\n${t('주문자','Nom')}: ${order.name}${note}`,
      items,`${t('주문 총액','Total')}: ${euro(order.totalCents)}`];
    if(['receipt','reported','reminder3','reminderFinal'].includes(type)){
      details.push(`${t('수취인','Bénéficiaire')}: ${event.beneficiary}\nIBAN: ${event.iban}\n${t('송금 금액','Montant du virement')}: ${euro(order.totalCents)}\n${t('송금 메모','Référence du virement')}: ${order.orderRef}\n${t('송금 마감 (파리 시간)','Date limite du virement (heure de Paris)')}: ${localDate(order.paymentDeadline||event.transferCutoff,t('ko-KR','fr-FR'))}`);
    }
    if(['receipt','reminderFinal'].includes(type)&&order.paymentHours!=null)details.push(paymentGuidance(order.lang,order.paymentHours).join('\n'));
    if(type==='additionalPayment'){
      const due=change.amountCents??orderPaymentSummary(order).additionalDue;
      details.push([t('추가 입금액','Complément à verser')+': '+euro(due),t('수취인','Bénéficiaire')+': '+event.beneficiary,'IBAN: '+event.iban,t('송금 메모','Référence du virement')+': '+order.orderRef].join('\n'));
    }
    if(['receipt','additionalPayment'].includes(type))details.push(transferIdentification(order.lang));
    if(type==='refundCompleted'&&change.amountCents){
      details.push([t('환불액','Montant remboursé')+': '+euro(change.amountCents),t('환불 시각','Date du remboursement')+': '+localDate(change.at,t('ko-KR','fr-FR'))].join('\n'));
    }
    const pickup=[event.pickupAt?localDate(event.pickupAt,t('ko-KR','fr-FR')):'',event.pickupPlace,t(event.pickupKo||event.pickupFr,event.pickupFr||event.pickupKo)].filter(Boolean).join('\n');
    if(pickup&&['receipt','confirmed','reminderFinal','pickup'].includes(type))details.push(`${t('수령','Retrait')}: ${pickup}`);
    details.push(`${t('문의','Contact')}: ${contact}`);
    if(['receipt','confirmed','reminderFinal','pickup'].includes(type)){
      const terms=orderTerms[fr?'fr':'ko'];
      details.push([terms.title,...terms.lines].join('\n'));
    }
    const actions=['receipt','reminderFinal'].includes(type)&&!order.transferReportedAt&&!order.bankConfirmedAt&&!order.canceledAt?
      [[t('송금 완료 알리기','Signaler le virement'),'report'],...(buyerCanCancel(event)?[[t('주문 취소하기','Annuler ma commande'),'cancel']]:[])]:[];
    const linksHtml=actions.map(([label,target])=>'<p><a href="'+esc(url+'&focus='+target)+'">'+esc(label)+'</a></p>').join('');
    const linksText=actions.map(([label,target])=>label+': '+url+'&focus='+target).join('\n');
    if(type==='other'){
      details.length=0;
      const fields=template.fields||[];
      if(fields.includes('event')&&eventName)details.push(eventName);
      if(fields.includes('order'))details.push(t('주문번호','Référence de commande')+': '+order.orderRef);
      if(fields.includes('items'))details.push(items);
      if(fields.includes('total'))details.push(t('주문 총액','Total')+': '+euro(order.totalCents));
      if(fields.includes('pickup')&&pickup)details.push(t('수령','Retrait')+': '+pickup);
      if(fields.includes('deadline'))details.push(t('송금 마감','Date limite de virement')+': '+localDate(order.paymentDeadline||event.transferCutoff,t('ko-KR','fr-FR')));
      details.push(t('문의','Contact')+': '+contact);
    }
    const body=details.join('\n\n');
    const pickupPolicy=['confirmed','pickup'].includes(type)?pickupTerms[fr?'fr':'ko']:null;
    const pickupText=pickupPolicy?'\n\n'+[pickupPolicy.title,...pickupPolicy.lines,pickupPolicy.contact+': '+contact].join('\n'):'';
    const pickupHtml=pickupPolicy?'<h3>'+esc(pickupPolicy.title)+'</h3>'+pickupPolicy.lines.map(line=>'<p>'+esc(line)+'</p>').join('')+
      '<p>'+esc(pickupPolicy.contact)+': <a href="mailto:'+contact+'">'+contact+'</a></p>':'';
    return{subject,text:`${intro}\n\n${body}${pickupText}\n\n${action}: ${url}${linksText?'\n'+linksText:''}`,
      html:`<div style="font:15px/1.7 Arial,sans-serif;max-width:650px"><h2>${esc(subject)}</h2><p>${esc(intro)}</p><pre style="white-space:pre-wrap;font:inherit">${esc(body)}</pre>${pickupHtml}<p><a href="${esc(url)}" style="color:#932b35">${esc(action)}</a></p>${linksHtml}</div>`};
  }
  const deliver = mailId => sendQueuedMail(mailId, message);
  async function bazaarPublic(req){
    const requested=s(req.data?.eventId);
    if(requested&&!validEventId(requested))bad('행사 주소를 확인해 주세요.');
    return db.runTransaction(async tx=>{
      const current=(await tx.get(eventRef)).data();
      const eventId=requested||current?.eventId||initialEvent.eventId;
      if(!current||eventId!==current.eventId){
        const archived=requested&&(await tx.get(eventArchives.doc(eventId))).exists;
        return {serverNow:now(),event:{eventId,status:archived?'closed':'draft'},products:[]};
      }
      if(closed(current))return {serverNow:now(),event:{eventId,status:'closed'},products:[]};
      const e=current;
      const safe={eventId,status:e.status||'draft',orderStartsAt:e.orderStartsAt||'',pickupAt:e.pickupAt||'',pickupPlace:e.pickupPlace||'',nameKo:e.nameKo,nameFr:e.nameFr,introKo:e.introKo,introFr:e.introFr,orderCutoff:e.orderCutoff,transferCutoff:e.transferCutoff,paymentHours:e.paymentHours??defaultPaymentHours,pickupKo:e.pickupKo,pickupFr:e.pickupFr,beneficiary:e.beneficiary,iban:e.iban,contactEmail:e.contactEmail,finalizedAt:null};
      const ps=e.status==='published' ? snapshotProducts(await tx.get(products)) : [];
      return{serverNow:now(),event:safe,products:ps.filter(p=>(!e.scopedProducts||p.bazaarEventId===eventId)&&
        !p.archivedAt&&p.visible&&cents(p.retailCents)).map(pickPublic).sort((a,b)=>a.displayOrder-b.displayOrder)};
    },{readOnly:true});
  }
  async function bazaarCreateOrder(req){
    const buyer=checkBuyerOrder(req.data);
    const requested=s(req.data?.eventId);
    if(!validEventId(requested)||req.data?.consent!==true)bad('행사 주소와 개인정보 동의를 확인해 주세요.');
    const requestId=s(req.data?.requestId);
    if(!/^[a-f0-9]{32}$/.test(requestId))bad('주문 요청 번호를 확인해 주세요.');
    // The public order ID must not double as evidence that a caller submitted the order.
    const resultId=createHash('sha256').update(`bazaar-order:${requestId}`).digest('hex').slice(0,32);
    const ref=orders.doc(resultId),token=randomBytes(32).toString('hex');
    const fingerprint=createHash('sha256').update(JSON.stringify({requested,buyer})).digest('hex');
    const ip=s(req.rawRequest?.ip||req.rawRequest?.socket?.remoteAddress||'unknown');
    const ipHash=createHash('sha256').update(ip).digest('hex');
    const throttleRef=db.doc(`bazaarRateLimits/${ipHash}`);
    const refs=buyer.items.map(i=>products.doc(i.id));
    const checkout=async tx=>{
      const [eventSnap,rateSnap,existing]=await Promise.all([tx.get(eventRef),tx.get(throttleRef),tx.get(ref)]);
      if(existing.exists){
        const o=existing.data();
        if(o.requestFingerprint!==fingerprint)throw new HttpsError('already-exists','같은 요청 번호에 다른 주문이 있습니다.');
        return { order:{ id:o.id, token:o.buyerToken, ...paymentDetails(o), pickupKo:o.eventSnapshot.pickupKo } };
      }
      const e=eventSnap.data();
      const rate=rateSnap.data()||{};
      const windowStart=Date.now()-10*60*1000;
      if((rate.startedMs||0)>windowStart&&(rate.count||0)>=8)throw new HttpsError('resource-exhausted','짧은 시간에 주문 요청이 많습니다. 협회에 문의해 주세요.');
      if(!e)throw new HttpsError('failed-precondition','바자회 준비 중입니다.');
      if(e.status!=='published'||locked(e)||orderNotOpen(e)||e.eventId!==requested||!(Date.now()<Date.parse(e.orderCutoff)))throw new HttpsError('failed-precondition','주문 접수가 마감되었습니다.');
      if(!/^FR\d{2}[A-Z0-9 ]{20,}$/.test(s(e.iban).replaceAll(' ','')))throw new HttpsError('failed-precondition','송금계좌 등록 후 주문할 수 있습니다.');
      const snapshots=await Promise.all(refs.map(r=>tx.get(r)));
      const itemDetails=[];let total=0;
      for(let i=0;i<buyer.items.length;i++){
        const data=snapshots[i].data(),{qty,id}=buyer.items[i];
        if(!data?.visible||data.archivedAt||(e.scopedProducts&&data.bazaarEventId!==requested)||!cents(data.retailCents))throw new HttpsError('failed-precondition',`품목 ${id}의 판매가 중단되었습니다.`);
        if(data.retailCents!==buyer.items[i].priceCents)throw new HttpsError('failed-precondition','상품 가격이 변경되었습니다. 다시 확인해 주세요.');
        assertAvailable(data,qty,id);
        total+=data.retailCents*qty;
        itemDetails.push(orderItem(data,id,qty));
      }
      if(!cents(total)||total===0)bad('금액을 확인해 주세요.');
      const orderRef=`ASICC-${new Date().getUTCFullYear().toString().slice(-2)}-${ref.id.slice(0,10).toUpperCase()}`;
      const createdAt=now();
      const data={id:ref.id,eventId:e.eventId||initialEvent.eventId,eventSnapshot:{...e},orderRef,...buyer,consent:true,orderTermsVersion,orderTermsAcceptedAt:createdAt,paymentDeadline:personalTransferDeadline(createdAt,e),paymentHours:e.paymentHours??defaultPaymentHours,requestFingerprint:fingerprint,items:itemDetails,originalItems:itemDetails,originalTotalCents:total,totalCents:total,createdAt,buyerToken:token,transferReportedAt:null,bankConfirmedAt:null,canceledAt:null,reminder3At:null,reminderFinalAt:null};
      snapshots.forEach((snapshot,i)=>tx.update(snapshot.ref,{soldQty:FieldValue.increment(buyer.items[i].qty)}));
      tx.create(ref,data);
      tx.set(throttleRef,{startedMs:(rate.startedMs||0)>windowStart?rate.startedMs:Date.now(),count:(rate.startedMs||0)>windowStart?(rate.count||0)+1:1,expiresAt:new Date(Date.now()+24*3600000).toISOString()});
      await queue(tx,ref.id,'receipt',{eventId:requested});
      return { created:true,order:{ id:ref.id, token, ...paymentDetails(data), pickupKo:e.pickupKo } };
    };
    const {order,created}=await (db.runCheckout
      ? db.runCheckout([eventRef,throttleRef,ref,...refs],checkout)
      : db.runTransaction(checkout));
    if(created)await deliver(`${order.id}_receipt`).catch(error=>console.error('Bazaar receipt delivery failed',error));
    return order;
  }
  async function bazaarBuyerAction(req){
    const {id,token,action,ackNoTransfer}=req.data||{};
    if(!/^[a-zA-Z0-9]{15,40}$/.test(s(id))||!/^[a-f0-9]{64}$/.test(s(token)))bad('주문 확인 링크가 올바르지 않습니다.');
    if(!['view','report','cancel'].includes(action))bad('요청을 확인해 주세요.');
    let mailId=null;
    const result=await db.runTransaction(async tx=>{
      const ref=orders.doc(id), snap=await tx.get(ref);
      if(!snap.exists)throw new HttpsError('permission-denied','주문 확인 권한이 없습니다.');
      const o=snap.data();
      const a=Buffer.from(token,'hex'),b=Buffer.from(o.buyerToken||'','hex');
      if(a.length!==b.length||!timingSafeEqual(a,b))throw new HttpsError('permission-denied','주문 확인 권한이 없습니다.');
      const currentEvent=(await tx.get(eventRef)).data();
      if(action==='view')return{order:buyerOrder(o,currentEvent),changed:false};
      assertOrderEvent(currentEvent,o.eventId);
      if(o.canceledAt)throw new HttpsError('failed-precondition','이미 취소된 주문입니다.');
      if(action==='report'){
        if(o.bankConfirmedAt)throw new HttpsError('failed-precondition','이미 입금이 확인된 주문입니다.');
        const reportedAt=o.transferReportedAt||now();
        if(!o.transferReportedAt){
          tx.update(ref,{transferReportedAt:reportedAt,transferReportSource:'buyer'});
        }
        return{order:buyerOrder({...o,transferReportedAt:reportedAt},currentEvent),changed:!o.transferReportedAt};
      }
      if(!buyerCanCancel(currentEvent))throw new HttpsError('failed-precondition','주문 접수 마감 후 온라인으로 취소할 수 없습니다.');
      if(!ackNoTransfer)bad('송금하지 않았음을 확인해야 합니다.');
      if(o.transferReportedAt||o.bankConfirmedAt)throw new HttpsError('failed-precondition','송금 신고 또는 입금 확인된 주문은 온라인으로 취소할 수 없습니다. 협회에 문의해 주세요.');
      const refs=o.items.map(i=>products.doc(i.id));
      const snaps=await Promise.all(refs.map(r=>tx.get(r)));
      snaps.forEach((snap,i)=>{if(snap.exists)tx.update(snap.ref,{soldQty:FieldValue.increment(-o.items[i].qty)});});
      tx.update(ref,{canceledAt:now(),cancelReason:'buyer'});
      if(o.email)mailId=await queue(tx,id,'cancel',{eventId:o.eventId});
      return{order:buyerOrder({...o,canceledAt:now()},currentEvent),changed:true};
    });
    if(mailId)await deliver(mailId).catch(error=>console.error('Bazaar cancellation delivery failed',error));
    return result;
  }
  function productHistory(snapshot){
    const rows=snapshot.docs.map(doc=>doc.data());
    return {ids:new Set(rows.flatMap(order=>[...(order.productHistoryIds||[]),...(order.items||[]).map(item=>item.id)])),
      legacy:rows.some(order=>order.revision>0&&!order.productHistoryIds)};
  }
  function validateProduct(p,existing,allowIncomplete=false){
    if(!p||typeof p!=='object')bad('상품을 확인해 주세요.');
    const number=value=>value==null||value===''?null:typeof value==='number'?value:NaN;
    const out={titleKo:s(p.titleKo).slice(0,120),titleFr:s(p.titleFr).slice(0,120),descriptionKo:s(p.descriptionKo).slice(0,3000),descriptionFr:s(p.descriptionFr).slice(0,3000),supplier:s(p.supplier),storage:s(p.storage),imageUrl:s(p.imageUrl),visible:p.visible===true,retailCents:number(p.retailCents),packQty:number(p.packQty),plannedBoxes:number(p.plannedBoxes),boxPriceTtcCents:number(p.boxPriceTtcCents),boxPriceHtCents:p.boxPriceHtCents==null?null:Number(p.boxPriceHtCents),limitMode:p.limitMode,manualLimit:number(p.manualLimit)};
    if(!allowIncomplete&&(!out.titleKo||!out.titleFr))bad('상품명 누락: '+(out.titleKo||out.titleFr||s(p.id)||'이름 없는 상품'));
    if((!allowIncomplete&&!out.supplier.trim())||out.supplier.length>120||/[\x00-\x1f\x7f]/.test(out.supplier)||out.supplier==='__asicc_new_supplier__')bad(out.titleKo+' — 공급업체명을 확인해 주세요.');
    out.supplier=out.supplier.trim();
    if(!validUrl(out.imageUrl)||(!(allowIncomplete&&out.storage==='')&&!['ambient','chilled','frozen'].includes(out.storage)))bad(out.titleKo+' — 상품 이미지 주소 또는 보관 방법을 확인해 주세요.');
    if(out.retailCents==null?!allowIncomplete:!cents(out.retailCents)||out.retailCents<=0)bad(out.titleKo+' — TTC 판매가격이 없거나 0 이하입니다.');
    if((out.packQty==null?!allowIncomplete:!Number.isSafeInteger(out.packQty)||out.packQty<1||out.packQty>10000)||(out.boxPriceTtcCents==null?!allowIncomplete:!cents(out.boxPriceTtcCents))||out.boxPriceHtCents!=null&&!cents(out.boxPriceHtCents))bad('매입가격 또는 박스당 입수량을 확인해 주세요.');
    if(out.plannedBoxes!=null&&(!Number.isSafeInteger(out.plannedBoxes)||out.plannedBoxes<0||out.plannedBoxes>10000))bad('발주 박스 수를 확인해 주세요.');
    if(!['manual','box','unlimited'].includes(out.limitMode)||out.manualLimit!=null&&(!Number.isSafeInteger(out.manualLimit)||out.manualLimit<0))bad('한정 수량을 확인해 주세요.');
    if(!allowIncomplete&&out.limitMode==='box'&&out.plannedBoxes==null)bad('박스 연동을 사용하려면 발주 예정 박스 수가 필요합니다.');
    if(!allowIncomplete&&out.limitMode==='manual'&&out.manualLimit==null)bad('수동 입력 방식은 최대 판매수량을 입력해 주세요.');
    const limit=stockCap(out);
    if(limit!=null&&limit<(existing.soldQty||0))bad(`이미 접수된 ${existing.soldQty}개보다 판매 한도를 낮출 수 없습니다.`);
    if(out.visible&&out.retailCents==null)bad('판매가격 미정 상품은 공개할 수 없습니다.');
    return out;
  }
  async function bazaarAdmin(req){
    await requireAdmin(req);
    const {op,...data}=req.data||{};
    if(op==='mailPreview'){
      const eventId=s(data.eventId),type=s(data.type);
      if(!validEventId(eventId)||!['receipt','confirmed','buyerCancel','adminCancel','reminderFinal','bulkCancel','pickup','other','orderChanged','additionalPayment','refundCompleted'].includes(type))bad('이메일 미리보기 종류와 행사를 확인해 주세요.');
      const [active,draft,archive]=await db.getAll(eventRef,eventDrafts.doc(eventId),eventArchives.doc(eventId));
      const event=active.data()?.eventId===eventId?active.data():draft.data()?.event||archive.data()?.event;
      if(!event)throw new HttpsError('not-found','해당 행사를 찾을 수 없습니다.');
      const id=s(data.id);
      const selected=id&&/^[a-zA-Z0-9]{15,40}$/.test(id)?(await orders.doc(id).get()).data():null;
      if(id&&selected?.eventId!==eventId)bad('같은 행사의 주문만 선택할 수 있습니다.');
      const lang=data.lang==='fr'?'fr':'ko';
      const order={...(selected||{name:lang==='fr'?'Client exemple':'예시 주문자',orderRef:'ASICC-PREVIEW',totalCents:650,
        items:[{titleKo:'예시 상품',titleFr:'Produit exemple',qty:1,priceCents:650}],paymentDeadline:personalTransferDeadline(now(),event)}),
        id:'preview',buyerToken:'preview-only',lang,paymentHours:selected?.paymentHours??event.paymentHours??defaultPaymentHours};
      const tpl=Object.fromEntries(['subjectKo','subjectFr','introKo','introFr'].map(key=>[key,s(data.template?.[key]).slice(0,key.startsWith('subject')?150:2500)]));
      if(type==='other'&&Array.isArray(data.template?.fields))tpl.fields=data.template.fields.filter(field=>['event','order','items','total','pickup','deadline'].includes(field));
      const jobId=s(data.jobId);
      if(jobId){
        if(!/^[a-zA-Z0-9_-]{16,110}$/.test(jobId))bad('이메일 이력을 확인해 주세요.');
        const job=(await outbox.doc(jobId).get()).data();
        if(!selected||job?.eventId!==eventId||job.orderId!==id||job.type!==type||!job.change)bad('선택한 주문의 거래 이메일이 아닙니다.');
        const policy=(await db.doc('bazaarMailPolicies/'+eventId).get()).data();
        const {subject,text}=message({...order,...job.change},type,selected.eventSnapshot||event,{...policy?.templates?.[type],...job.template},job.change);
        return {subject,text};
      }
      const template=message(order,['buyerCancel','adminCancel'].includes(type)?'cancel':type,selected?.eventSnapshot||event,tpl,
        type==='refundCompleted'?{amountCents:100,at:now()}:type==='additionalPayment'?{amountCents:100}:{});
      return {subject:template.subject,text:template.text};
    }
    if (typeof op==='string' && op.startsWith('mail') && mailAdmin) return mailAdmin(op,data,req.auth.uid);
    if(['storeEvidence','getEvidence','saveEvidence','confirmPurchaseCosts'].includes(op)){
      const eventId=s(data.eventId),id=s(data.id);
      if(!validEventId(eventId))bad('증빙을 연결할 행사를 확인해 주세요.');
      const account=eventFinancials.doc(eventId);
      const archive=eventArchives.doc(eventId);
      const ensureEvent=([active,past])=>{
        if(active.data()?.eventId!==eventId&&!past.exists)throw new HttpsError('not-found','행사를 찾을 수 없습니다.');
      };
      if(op==='storeEvidence'||op==='getEvidence'){
        if(!evidence)throw new HttpsError('failed-precondition','비공개 증빙 저장소가 연결되지 않았습니다.');
        const [active,past,financial]=await db.getAll(eventRef,archive,account);
        ensureEvent([active,past]);
        const ledger=financial.data();
        if(op==='storeEvidence'){
          if(ledger?.finalizedAt)throw new HttpsError('failed-precondition','확정 결산을 정정 상태로 전환해 주세요.');
          return evidence.put(eventId,data.name,data.content);
        }
        const file=(ledger?.evidence||[]).find(row=>row.id===id)?.files.find(file=>file.id===data.fileId);
        if(!file)throw new HttpsError('not-found','증빙 파일을 찾을 수 없습니다.');
        return evidence.get(eventId,file);
      }
      return db.runTransaction(async tx=>{
        const [active,past,financial,purchases]=await Promise.all([tx.get(eventRef),tx.get(archive),tx.get(account),
          tx.get(purchaseOrders.where('eventId','==',eventId))]);
        ensureEvent([active,past]);
        const old=financial.data()||{eventId,revision:0,expenses:[],finalizedAt:null};
        if(old.finalizedAt||data.revision!==old.revision)throw new HttpsError('failed-precondition','결산 변경사항을 새로고침하거나 정정 상태로 전환해 주세요.');
        const records=old.evidence||[],suppliers=[...new Set(purchases.docs.filter(doc=>doc.data().confirmed).map(doc=>doc.data().vendor))];
        const actor={updatedAt:now(),updatedBy:req.auth.uid};
        let update;
        if(op==='confirmPurchaseCosts'){
          if(data.confirm!==true)bad('실제 매입비용 확인을 완료해 주세요.');
          const missing=suppliers.filter(vendor=>!records.some(row=>!row.voidedAt&&row.scope==='purchase'&&row.vendor===vendor&&row.kind!=='credit'));
          if(missing.length)throw new HttpsError('failed-precondition','증빙이 없는 공급업체: '+missing.join(', '));
          update={purchaseCostsConfirmedAt:actor.updatedAt,purchaseCostsConfirmedBy:actor.updatedBy,
            confirmedSuppliers:suppliers};
        }else{
          if(!/^[a-f0-9]{32}$/.test(id))bad('증빙 번호를 확인해 주세요.');
          const previous=records.find(row=>row.id===id);
          if(previous?.voidedAt)throw new HttpsError('failed-precondition','취소된 증빙입니다.');
          const reason=s(data.reason).trim();
          if(previous&&(!reason||reason.length>500))bad('증빙 수정 또는 삭제 사유를 입력해 주세요.');
          let row;
          if(data.void===true){
            if(!previous)throw new HttpsError('not-found','증빙이 없습니다.');
            row={...previous,voidedAt:actor.updatedAt};
          }else{
            const scope=data.scope,kind=data.kind,vendor=s(data.vendor).trim(),number=s(data.number).trim(),
              note=s(data.note).trim(),date=s(data.date),expenseId=s(data.expenseId),method=s(data.method),paymentStatus=data.paymentStatus;
            const {amountCents,paidCents}=data;
            if(!['purchase','expense'].includes(scope)||!['invoice','receipt','credit'].includes(kind)||
              !['paid','unpaid','partial'].includes(paymentStatus)||!['','bank','card','cash','other'].includes(method)||
              !depositDetails({actualDate:date})||!date||!cents(amountCents)||amountCents===0||!cents(paidCents)||paidCents>amountCents||
              paymentStatus==='paid'&&paidCents!==amountCents||paymentStatus==='unpaid'&&paidCents!==0||
              paymentStatus==='partial'&&(paidCents===0||paidCents===amountCents)||vendor.length>120||number.length>120||note.length>500||
              scope==='purchase'&&(!vendor||!purchases.docs.some(doc=>doc.data().vendor===vendor))||
              scope==='expense'&&(!(old.expenses||[]).some(expense=>expense.id===expenseId)||kind==='credit')||
              !Array.isArray(data.files)||!data.files.length||data.files.length>5)bad('증빙 종류, 날짜, 금액, 지급 상태 및 파일을 확인해 주세요.');
            const files=data.files.map(raw=>previous?.files.find(file=>file.id===raw?.id)||evidence?.verify(eventId,raw));
            if(files.some(file=>!file)||new Set(files.map(file=>file.digest)).size!==files.length)bad('중복되거나 유효하지 않은 증빙 파일입니다.');
            const normalize=value=>value.toLowerCase().replace(/\s+/g,'');
            const duplicate=records.some(other=>{
              if(other.voidedAt||other.id===id)return false;
              if(other.files.some(file=>files.some(candidate=>file.digest===candidate.digest)))return true;
              if(scope==='expense')return other.scope==='expense'&&other.expenseId===expenseId;
              if(other.scope!=='purchase'||normalize(vendor)!==normalize(other.vendor))return false;
              if(number&&other.number&&normalize(number)===normalize(other.number)&&kind===other.kind)return true;
              return kind!=='credit'&&other.kind!=='credit'&&(!number||!other.number||kind!==other.kind)&&date===other.date&&amountCents===other.amountCents;
            });
            if(duplicate)
              throw new HttpsError('already-exists','동일한 비용 또는 파일이 이미 등록되었습니다.');
            row={id,scope,kind,vendor,number,note,date,expenseId,method,paymentStatus,amountCents,paidCents,files,
              createdAt:previous?.createdAt||actor.updatedAt,createdBy:previous?.createdBy||actor.updatedBy};
          }
          if(!previous&&records.length>=100)bad('행사별 증빙은 최대 100건입니다.');
          tx.create(account.collection('audit').doc(randomBytes(16).toString('hex')),{at:actor.updatedAt,by:actor.updatedBy,reason,before:previous||null,after:row});
          update={evidence:[...records.filter(item=>item.id!==id),row],purchaseCostsConfirmedAt:null};
        }
        const result={...old,...update,...actor,revision:old.revision+1};
        tx.set(account,result);return result;
      });
    }
    const requireCurrentEvent=active=>{
      if(!validEventId(s(data.eventId))||active?.eventId!==data.eventId||closed(active)){
        throw new HttpsError('failed-precondition','현재 행사가 변경되어 저장하지 못했습니다. 행사 목록에서 다시 확인해 주세요.');
      }
    };
    if(op==='getCatalog'){
      const [saved,legacy]=await Promise.all([catalogRef.get(),products.get()]);
      return saved.exists?saved.data():{revision:0,items:catalogSnapshot(legacy)};
    }
    if(op==='saveProductDetail'){
      const id=s(data.id),scope=data.scope;
      if(!productIdValid(id)||!['catalog','draft','event'].includes(scope)
        ||scope!=='catalog'&&!validEventId(s(data.eventId)))bad('행사와 상품을 확인해 주세요.');
      const eventId=scope==='catalog'?catalogPhotoScope:data.eventId;
      const changes={};
      if(data.field==='description'){
        if(typeof data.descriptionKo!=='string'||typeof data.descriptionFr!=='string'
          ||data.descriptionKo.length>3000||data.descriptionFr.length>3000)bad('상품 설명은 언어별로 3,000자까지 입력할 수 있습니다.');
        changes.descriptionKo=s(data.descriptionKo);
        changes.descriptionFr=s(data.descriptionFr);
      }else if(data.field==='photo'){
        if(typeof data.photoPath!=='string')bad('상품 사진을 확인해 주세요.');
        Object.assign(changes,await eventPhoto(eventId,id,{photoPath:data.photoPath}));
      }else bad('저장할 상품 정보를 확인해 주세요.');
      const target=scope==='catalog'?catalogRef:scope==='draft'?eventDrafts.doc(eventId):eventRef;
      return db.runTransaction(async tx=>{
        const snapshot=await tx.get(target);
        const saved=snapshot.data();
        if(scope==='event'){
          requireCurrentEvent(saved);
          const ref=products.doc(id),product=(await tx.get(ref)).data();
          if(!product||product.archivedAt||saved.scopedProducts&&product.bazaarEventId!==eventId)
            throw new HttpsError('not-found','상품을 찾을 수 없습니다.');
          const revision=saved.productRevision??0;
          if(revision!==data.revision)throw new HttpsError('failed-precondition','상품이 변경됐습니다. 다시 불러와 주세요.');
          tx.update(ref,changes);
          tx.update(target,{productRevision:revision+1});
          return {...changes,revision:revision+1};
        }
        if(scope==='draft'&&(saved?.status!=='draft'||saved.updatedAt!==data.updatedAt))
          throw new HttpsError('failed-precondition','초안이 변경되었습니다. 다시 불러와 주세요.');
        const items=saved?.items??catalogSnapshot(await tx.get(products));
        if(!items.some(item=>item.id===id))throw new HttpsError('not-found','상품을 찾을 수 없습니다.');
        const updatedAt=scope==='draft'?new Date(Math.max(Date.now(),Date.parse(saved.updatedAt)+1)).toISOString():now();
        const revision=(saved?.revision??0)+1;
        if(scope==='catalog'&&revision-1!==data.revision)
          throw new HttpsError('failed-precondition','기본 목록이 변경됐습니다. 다시 불러와 주세요.');
        const document={...saved,items:items.map(item=>item.id===id?{...item,...changes}:item),updatedAt,
          ...(scope==='catalog'?{revision}:{})};
        if(Buffer.byteLength(JSON.stringify(document))>800000)bad('상품 정보가 너무 많아 저장할 수 없습니다.');
        tx.set(target,document);
        return {...changes,updatedAt,...(scope==='catalog'?{revision}:{})};
      });
    }
    if(op==='saveCatalog'){
      const items=await Promise.all(normalizeCatalog(data.items).map(async item=>{
        if(item.photoPath&&!item.photoPath.startsWith(`bazaar-photos/${catalogPhotoScope}/${item.id}/`)){
          const photo=await storePhoto(catalogPhotoScope,item.id,{sourcePath:item.photoPath});
          return {...item,...photo};
        }
        return item.photoPath?{...item,...await eventPhoto(catalogPhotoScope,item.id,item)}:item;
      }));
      if(Buffer.byteLength(JSON.stringify(items))>800000)bad('기본 상품 정보가 너무 많습니다.');
      return db.runTransaction(async tx=>{
        const snapshot=await tx.get(catalogRef);
        const revision=snapshot.data()?.revision??0;
        if(revision!==data.revision)throw new HttpsError('failed-precondition','기본 목록이 변경됐습니다. 다시 불러와 주세요.');
        tx.set(catalogRef,{revision:revision+1,items,updatedAt:now()});
        return {revision:revision+1,items};
      });
    }
    if(op==='listPurchaseOrders'||op==='savePurchaseOrder'){
      const eventId=s(data.eventId);
      if(!validEventId(eventId))bad('행사 주소를 확인해 주세요.');
      if(op==='listPurchaseOrders'){
        const result=await purchaseOrders.where('eventId','==',eventId).get();
        return {documents:result.docs.map(doc=>doc.data())};
      }
      const document=normalizePurchase(data);
      const ref=purchaseOrders.doc(createHash('sha256').update(JSON.stringify([eventId,document.vendor])).digest('hex'));
      return db.runTransaction(async tx=>{
        const [active,previous,archive]=await Promise.all([
          tx.get(eventRef),tx.get(ref),tx.get(eventArchives.doc(eventId)),
        ]);
        const event=active.data()?.eventId===eventId?active.data():archive.data()?.event;
        await requireOpenAccounting(tx,eventId);
        const isClosed=closed(event);
        if(!event||(!isClosed&&event.status!=='published'))
          throw new HttpsError('failed-precondition','발행 또는 종료된 행사의 발주서만 저장할 수 있습니다.');
        if(isClosed&&data.confirmClosedEdit!==true)
          throw new HttpsError('failed-precondition','종료된 행사입니다. 정산 변경 안내를 확인한 뒤 다시 저장해 주세요.');
        if(!isClosed&&data.confirmClosedEdit===true)
          throw new HttpsError('failed-precondition','행사 상태가 변경됐습니다. 다시 불러와 주세요.');
        const old=previous.data();
        if((old?.revision??0)!==data.revision||(!isClosed&&old?.confirmed))
          throw new HttpsError('failed-precondition','이미 확정됐거나 변경된 발주서입니다. 다시 불러와 주세요.');
        const confirmed=old?.confirmed===true||data.confirm===true;
        if(confirmed&&(!document.lines.length||!document.info.number||!document.info.date))
          bad('발주번호, 발주일과 품목을 확인해 주세요.');
        const result={...document,eventId,revision:(old?.revision??0)+1,
          confirmed,updatedAt:now(),updatedBy:req.auth.uid,...(isClosed?{closedAdjustment:true}:{})};
        if(isClosed&&old)tx.create(ref.collection('revisions').doc(String(old.revision)),old);
        tx.set(ref,result);
        return result;
      });
    }
    if(op==='eventFinancials'||op==='saveEventExpenses'||op==='finalizeEventFinancials'){
      const eventId=s(data.eventId);
      if(!validEventId(eventId))bad('행사 주소를 확인해 주세요.');
      const planned=data.planned===true;
      if(planned&&op==='finalizeEventFinancials')bad('예상 정산은 확정할 수 없습니다.');
      const ref=eventFinancials.doc(planned?'planned-'+eventId:eventId);
      if(op==='eventFinancials'){
        if(planned&&!(await eventDrafts.doc(eventId).get()).exists)throw new HttpsError('not-found','초안을 찾을 수 없습니다.');
        const [active,archive,record]=await Promise.all([eventRef.get(),(planned?eventDrafts.doc(eventId):eventArchives.doc(eventId)).get(),ref.get()]);
        if(planned?!archive.exists:active.data()?.eventId!==eventId&&!archive.exists)throw new HttpsError('not-found','해당 바자회 기록을 찾을 수 없습니다.');
        return record.exists?record.data():{eventId,revision:0,expenses:[],finalizedAt:null};
      }
      if(op==='saveEventExpenses'){
        if(!Number.isSafeInteger(data.revision)||!Array.isArray(data.expenses)||data.expenses.length>100)
          bad('지출 목록을 확인해 주세요.');
        const ids=new Set();
        const expenses=data.expenses.map(row=>{
          const id=s(row?.id),name=s(row?.name),amountCents=row?.amountCents;
          if(!/^[a-zA-Z0-9-]{8,60}$/.test(id)||ids.has(id)||!name||name.length>120
            ||!cents(amountCents)||amountCents===0)bad('지출 항목명과 금액을 확인해 주세요.');
          ids.add(id);return{id,name,amountCents};
        });
        return db.runTransaction(async tx=>{
          const [active,archive,previous]=await Promise.all([tx.get(eventRef),tx.get(planned?eventDrafts.doc(eventId):eventArchives.doc(eventId)),tx.get(ref)]);
          if(planned?!archive.exists:active.data()?.eventId!==eventId&&!archive.exists)throw new HttpsError('not-found','해당 바자회 기록을 찾을 수 없습니다.');
          const old=previous.data()||{revision:0,expenses:[],finalizedAt:null};
          if(old.finalizedAt)throw new HttpsError('failed-precondition','정산이 확정되어 있습니다. 수정하려면 먼저 확정을 해제해 주세요.');
          if(old.revision!==data.revision)throw new HttpsError('failed-precondition','지출 내역이 변경됐습니다. 다시 불러와 주세요.');
          if((old.evidence||[]).some(row=>!row.voidedAt&&row.scope==='expense'&&!expenses.some(expense=>expense.id===row.expenseId)))
            throw new HttpsError('failed-precondition','연결된 증빙을 먼저 정리해 주세요.');
          const result={...old,eventId,revision:old.revision+1,expenses,finalizedAt:null,updatedAt:now(),updatedBy:req.auth.uid};
          tx.set(ref,result);return result;
        });
      }
      if(data.confirm!==true||!['finalize','reopen'].includes(data.action))bad('정산 확정 상태를 확인해 주세요.');
      return db.runTransaction(async tx=>{
        const [active,archive,previous]=await Promise.all([tx.get(eventRef),tx.get(eventArchives.doc(eventId)),tx.get(ref)]);
        if(active.data()?.eventId!==eventId&&!archive.exists)throw new HttpsError('not-found','해당 바자회 기록을 찾을 수 없습니다.');
        const old=previous.data()||{eventId,revision:0,expenses:[],finalizedAt:null};
        if(old.finalizedAt&&data.action==='finalize')return old;
        if(!old.finalizedAt&&data.action==='reopen')return old;
        const at=now(),by=req.auth.uid;
        if(data.action==='reopen'){
          const reason=s(data.reason).trim();
          if(!reason||reason.length>500)bad('결산 정정 사유를 입력해 주세요.');
          tx.create(ref.collection('audit').doc(randomBytes(16).toString('hex')),{action:'reopen',at,by,reason,previousSnapshot:old.snapshot||null,previousFinalizedAt:old.finalizedAt});
          const result={...old,revision:old.revision+1,finalizedAt:null,updatedAt:at,updatedBy:by};
          tx.set(ref,result);return result;
        }
        const event=active.data()?.eventId===eventId?active.data():archive.data().event;
        const [orderRows,purchaseRows,lateRows]=await Promise.all([
          tx.get(orders.where('eventId','==',eventId)),tx.get(purchaseOrders.where('eventId','==',eventId)),
          tx.get(db.collection('bazaarLatePayments').where('eventId','==',eventId)),
        ]);
        const balances=orderRows.docs.map(doc=>({...orderPaymentSummary(doc.data()),ref:doc.data().orderRef}));
        const activeEvidence=(old.evidence||[]).filter(row=>!row.voidedAt);
        const buys=activeEvidence.filter(row=>row.scope==='purchase');
        const supplierSet=new Set(purchaseRows.docs.filter(doc=>doc.data().confirmed).map(doc=>doc.data().vendor));
        const orderSuppliers=new Set(orderRows.docs.filter(doc=>!doc.data().canceledAt).flatMap(doc=>doc.data().items.map(item=>item.supplier).filter(Boolean)));
        const errors=[];
        if(lateRows.docs.some(doc=>doc.data().status==='pending'))
          errors.push('장부에 반영하지 않은 늦은 입금 검토 건이 있습니다. / Des virements tardifs restent à comptabiliser.');
        if(event.status==='published'&&(!Number.isFinite(Date.parse(event.orderCutoff))||Date.now()<Date.parse(event.orderCutoff)))
          errors.push('주문 접수가 아직 열려 있습니다. / Les commandes sont encore ouvertes.');
        for(const balance of balances){
          if(balance.additionalDue||balance.refundDue||balance.reservedRefund||balance.net<0||balance.net!==balance.due)
            errors.push(balance.ref+' · '+euro(balance.additionalDue)+' / '+euro(balance.refundDue)+' / '+euro(balance.reservedRefund));
        }
        if((supplierSet.size||orderSuppliers.size||buys.length)&&!old.purchaseCostsConfirmedAt)
          errors.push('실제 매입비용을 확정해 주세요. / Confirmez les coûts d’achat réels.');
        for(const vendor of new Set([...supplierSet,...orderSuppliers])){
          if(!supplierSet.has(vendor)||!old.confirmedSuppliers?.includes(vendor)||!buys.some(row=>row.vendor===vendor&&row.kind!=='credit'))
            errors.push(vendor+' · 발주 또는 증빙 누락 / Commande ou justificatif manquant');
        }
        for(const row of activeEvidence){
          if(row.paidCents!==row.amountCents)errors.push((row.vendor||row.expenseId)+' · 미결제 / Paiement incomplet');
        }
        for(const expense of old.expenses||[]){
          if(!activeEvidence.some(row=>row.scope==='expense'&&row.expenseId===expense.id&&row.amountCents===expense.amountCents))
            errors.push(expense.name+' · 증빙 또는 금액 불일치 / Justificatif ou montant incohérent');
        }
        const sum=(rows,field)=>rows.reduce((total,row)=>total+row[field],0);
        const signed=(rows,field)=>rows.reduce((total,row)=>total+(row.kind==='credit'?-1:1)*row[field],0);
        const salesCents=sum(balances,'due'),purchaseCents=signed(buys,'amountCents'),expenseCents=sum(old.expenses||[],'amountCents');
        if(purchaseCents<0)errors.push('매입 차감액을 확인해 주세요. / Vérifiez les avoirs.');
        if(errors.length)throw new HttpsError('failed-precondition','결산 전 확인 / À vérifier : '+errors.slice(0,15).join(' · '));
        const profitCents=salesCents-purchaseCents-expenseCents;
        const snapshot={salesCents,purchaseCents,expenseCents,depositedCents:sum(balances,'deposited'),refundedCents:sum(balances,'refunded'),
          netCents:sum(balances,'net'),paidCostCents:signed(activeEvidence,'paidCents'),profitCents,margin:salesCents?profitCents/salesCents:null,
          evidence:activeEvidence,expenses:old.expenses||[],at,by};
        tx.create(ref.collection('snapshots').doc(randomBytes(16).toString('hex')),snapshot);
        const result={...old,snapshot,revision:old.revision+1,finalizedAt:at,updatedAt:at,updatedBy:by};
        tx.set(ref,result);return result;
      });
    }
    if(op==='saveEventProducts'){
      if(!Array.isArray(data.items)||data.items.length>70)bad('행사 상품 목록을 확인해 주세요.');
      const ids=data.items.map(p=>s(p.id));
      if(new Set(ids).size!==ids.length||ids.some(id=>!productIdValid(id)))bad('상품 ID를 확인해 주세요.');
      requireCurrentEvent((await eventRef.get()).data());
      const photos=await Promise.all(data.items.map(p=>copyProductPhoto(data.eventId,p.id,p)));
      return db.runTransaction(async tx=>{
        const [active,result,base]=await Promise.all([tx.get(eventRef),tx.get(products),tx.get(catalogRef)]);
        requireCurrentEvent(active.data());
        const revision=active.data().productRevision??0;
        if(data.revision!==revision)throw new HttpsError('failed-precondition','상품이 변경됐습니다. 다시 불러와 주세요.');
        const previous=new Map(result.docs.filter(doc=>!active.data().scopedProducts||doc.data().bazaarEventId===data.eventId).map(doc=>[doc.id,doc]));
        if(new Set([...previous.keys(),...ids]).size>70)bad('상품 수가 많습니다.');
        const history=productHistory(await tx.get(orders.where('eventId','==',data.eventId)));
        if(!base.exists)initializeCatalog(tx,result);
        for(const doc of result.docs){
          const product=doc.data();
          if(ids.includes(doc.id)||active.data().scopedProducts&&product.bazaarEventId!==data.eventId)continue;
          if(history.ids.has(doc.id)||history.legacy||product.soldQty>0)tx.update(doc.ref,{visible:false,archivedAt:product.archivedAt||now()});
          else tx.delete(doc.ref);
        }
        data.items.forEach((item,index)=>{
          const doc=previous.get(item.id);
          const old=doc?.data()||{soldQty:0};
          const p=validateProduct({...item,imageUrl:item.photoPath?'':item.imageUrl},old);
          tx.set(products.doc(item.id),{...old,...p,...photos[index],displayOrder:index+1,
            bazaarEventId:data.eventId,archivedAt:null});
        });
        tx.update(eventRef,{productRevision:revision+1});
        return {revision:revision+1};
      });
    }
    if(op==='createManualOrder'){
      const eventId=s(data.eventId),source=s(data.source),parentId=s(data.parentId);
      const requestId=s(data.requestId);
      if(!validEventId(eventId)||!['phone','additional'].includes(source)||!/^[a-f0-9]{32}$/.test(requestId)
        ||parentId&&(!/^[a-zA-Z0-9]{15,40}$/.test(parentId)||source!=='additional'))bad('주문 유형과 대상 행사를 확인해 주세요.');
      const buyer=checkBuyerOrder(data,{emailOptional:true});
      const ref=orders.doc(requestId),token=randomBytes(32).toString('hex');
      const fingerprint=createHash('sha256').update(JSON.stringify({eventId,source,parentId,buyer,uid:req.auth.uid})).digest('hex');
      const result=await db.runTransaction(async tx=>{
        const [active,existing,parent]=await Promise.all([
          tx.get(eventRef),tx.get(ref),parentId?tx.get(orders.doc(parentId)):null,
        ]);
        if(existing.exists){
          const order=existing.data();
          if(order.requestFingerprint!==fingerprint)throw new HttpsError('already-exists','같은 요청 번호에 다른 주문이 있습니다.');
          return {id:order.id,orderRef:order.orderRef,totalCents:order.totalCents};
        }
        const event=active.data();
        assertOrderEvent(event,eventId);
        await requireOpenAccounting(tx,eventId);
        if(parentId&&(!parent?.exists||parent.data().eventId!==eventId||parent.data().canceledAt))
          throw new HttpsError('failed-precondition','추가 구매와 연결할 주문을 다시 확인해 주세요.');
        const snapshots=await Promise.all(buyer.items.map(item=>tx.get(products.doc(item.id))));
        const items=snapshots.map((snapshot,i)=>{
          const product=snapshot.data(),{id,qty,priceCents}=buyer.items[i];
          if(!product?.visible||product.archivedAt||event.scopedProducts&&product.bazaarEventId!==eventId||!cents(product.retailCents))
            throw new HttpsError('failed-precondition','이 행사에서 판매하는 상품을 선택해 주세요.');
          if(product.retailCents!==priceCents)throw new HttpsError('failed-precondition','상품 가격이 변경됐습니다. 화면을 다시 불러와 주세요.');
          assertAvailable(product,qty,id);
          return orderItem(product,id,qty);
        });
        const totalCents=orderTotal(items);
        const prefix=source==='phone'?'TEL':'ADD';
        const orderRef=`ASICC-${prefix}-${ref.id.slice(0,16).toUpperCase()}`;
        const order={...buyer,id:ref.id,eventId,eventSnapshot:event,orderRef,source,
          ...(parentId?{parentId,parentOrderRef:parent.data().orderRef}:{}),createdBy:req.auth.uid,
          requestFingerprint:fingerprint,buyerToken:token,createdAt:now(),paymentDeadline:personalTransferDeadline(now(),event),paymentHours:event.paymentHours??defaultPaymentHours,items,originalItems:items,originalTotalCents:totalCents,totalCents,
          transferReportedAt:null,bankConfirmedAt:null,canceledAt:null,reminder3At:null,reminderFinalAt:null};
        tx.create(ref,order);
        snapshots.forEach((snapshot,i)=>tx.update(snapshot.ref,{soldQty:FieldValue.increment(items[i].qty)}));
        if(buyer.email)await queue(tx,ref.id,'receipt',{eventId});
        return {id:ref.id,orderRef,totalCents};
      });
      if(buyer.email)await deliver(`${result.id}_receipt`).catch(error=>console.error('Bazaar receipt delivery failed',error));
      return result;
    }
    if(op==='orderCorrections'||op==='correctOrder'){
      const id=s(data.id),eventId=s(data.eventId);
      if(!/^[a-zA-Z0-9]{15,40}$/.test(id)||!validEventId(eventId))bad('주문 번호와 행사를 확인해 주세요.');
      const ref=orders.doc(id);
      if(op==='orderCorrections'){
        const order=(await ref.get()).data();
        if(order?.eventId!==eventId)throw new HttpsError('not-found','해당 행사에서 주문을 찾을 수 없습니다.');
        const history=await ref.collection('corrections').orderBy('revision','desc').get();
        return {history:history.docs.map(item=>item.data())};
      }
      const reason=s(data.reason);
      if(data.confirm!==true||!reason||reason.length>500||!Array.isArray(data.items)||data.items.length>30)
        bad('정정 사유와 수정할 수량을 확인해 주세요.');
      const quantities=new Map();
      for(const row of data.items){
        if(!productIdValid(s(row?.id))||!Number.isSafeInteger(row.qty)||row.qty<0||row.qty>100||quantities.has(row.id))
          bad('수정할 품목과 수량을 확인해 주세요.');
        quantities.set(row.id,row.qty);
      }
      return db.runTransaction(async tx=>{
        const [active,snapshot]=await Promise.all([tx.get(eventRef),tx.get(ref)]);
        const event=active.data(),order=snapshot.data();
        assertOrderEvent(event,eventId);
        const revision=order?.revision??0;
        if(order?.eventId!==eventId||order.canceledAt||revision!==data.revision)
          throw new HttpsError('failed-precondition','주문 상태가 변경됐습니다. 주문을 다시 확인해 주세요.');
        await requireOpenAccounting(tx,eventId);
        if(order.items.some(item=>!quantities.has(item.id)))bad('기존 품목의 수량을 모두 지정해 주세요.');
        const previous=new Map(order.items.map(item=>[item.id,item]));
        const stock=await Promise.all([...quantities.keys()].map(id=>tx.get(products.doc(id))));
        const items=[],stockChanges=[];
        for(const doc of stock){
          const id=doc.id,old=previous.get(id),qty=quantities.get(id);
          const delta=qty-(old?.qty??0),product=doc.data();
          const matches=product&&(!event.scopedProducts||product.bazaarEventId===eventId);
          if(delta>0&&(!matches||!product.visible||product.archivedAt))
            throw new HttpsError('failed-precondition','현재 판매 중인 품목의 수량만 늘릴 수 있습니다.');
          if(qty>0)items.push(old?{...old,qty}:orderItem(product,id,qty));
          if(matches&&delta){assertAvailable(product,delta,id);stockChanges.push([doc.ref,delta]);}
        }
        if(!items.length)bad('모든 상품을 취소하려면 전체 주문 취소를 사용해 주세요.');
        if(!stockChanges.length&&items.length===order.items.length&&items.every(item=>item.qty===previous.get(item.id)?.qty))bad('변경된 수량이 없습니다.');
        const totalCents=orderTotal(items)-(order.priceAdjustmentCents||0);
        if(totalCents<0)bad('현재 주문금액보다 가격 조정액이 클 수 없습니다.');
        if((order.reservedRefundCents||0)>orderPaymentSummary({...order,totalCents}).refundDue)throw new HttpsError('failed-precondition','환불 대기 금액이 변경되는 정정은 먼저 환불 대기를 처리해야 합니다.');
        if(order.transferReportedAt&&!order.bankConfirmedAt&&totalCents!==order.totalCents)
          throw new HttpsError('failed-precondition','송금 신고 주문은 은행 입금을 먼저 확인해 주세요.');
        if(order.bankConfirmedAt&&data.restoreStock!==true&&data.restoreStock!==false)bad('회수한 상품을 재고로 복원할지 선택해 주세요.');
        for(const [product,delta] of stockChanges){
          if(delta>0||!order.bankConfirmedAt||data.restoreStock===true)tx.update(product,{soldQty:FieldValue.increment(delta)});
        }
        const changed={revision:revision+1,at:now(),by:req.auth.uid,reason,
          before:{items:order.items,totalCents:order.totalCents},after:{items,totalCents}};
        tx.create(ref.collection('corrections').doc(String(changed.revision)),changed);
        const payment=orderPaymentSummary(order);
        const removed=order.items.map(item=>({...item,qty:item.qty-quantities.get(item.id)})).filter(item=>item.qty>0);
        tx.update(ref,{items,totalCents,modifiedAt:changed.at,originalItems:order.originalItems||order.items,canceledItems:[...(order.canceledItems||[]),...removed],originalTotalCents:payment.original,depositedCents:payment.deposited,refundedCents:payment.refunded,revision:changed.revision,productHistoryIds:[...new Set([...(order.productHistoryIds||[]),...order.items.map(item=>item.id),...items.map(item=>item.id)])]});
        if(order.email){
          const fields={eventId,change:{items,totalCents}};
          await queue(tx,id,'orderChanged',{...fields,jobKey:'orderChanged-'+changed.revision});
          const due=orderPaymentSummary({...order,totalCents}).additionalDue;
          if(order.bankConfirmedAt&&due>0)await queue(tx,id,'additionalPayment',{...fields,jobKey:'additionalPayment-'+changed.revision,change:{items,totalCents,amountCents:due}});
        }
        return {id,totalCents,revision:changed.revision};
      });
    }
    if(op==='correctDeposit'){
      const {eventId,requestId,paymentId,amountCents}=data,id=s(data.id),reason=s(data.reason).trim();
      if(!validEventId(eventId)||!/^[A-Za-z0-9]{15,40}$/.test(id)||!/^[a-f0-9]{32}$/.test(requestId)||
        !/^[a-f0-9]{32}$/.test(paymentId)||!cents(amountCents)||!reason||reason.length>500)bad('입금 거래와 정정 사유를 확인해 주세요.');
      const ref=orders.doc(id),payments=ref.collection('payments'),entry=payments.doc(paymentId),audit=payments.doc(requestId);
      return db.runTransaction(async tx=>{
        const [snapshot,deposit,previous,financial,confirmation]=await Promise.all([
          tx.get(ref),tx.get(entry),tx.get(audit),tx.get(eventFinancials.doc(eventId)),tx.get(outbox.doc(id+'_confirmed')),
        ]);
        const order=snapshot.data(),record=deposit.data(),prior=previous.data();
        if(order?.eventId!==eventId||record?.type!=='deposit')throw new HttpsError('not-found','입금 기록을 찾을 수 없습니다.');
        const current=orderPaymentSummary(order);
        if(prior){
          if(prior.type!=='depositCorrection'||prior.paymentId!==paymentId||prior.afterCents!==amountCents||prior.reason!==reason)
            throw new HttpsError('already-exists','같은 요청 번호로 다른 정정을 기록할 수 없습니다.');
          return {payment:current};
        }
        if(financial.data()?.finalizedAt)throw new HttpsError('failed-precondition','확정 결산을 정정 상태로 전환한 뒤 기록하세요.');
        const beforeCents=record.correctedAmountCents??record.amountCents;
        if(data.beforeCents!==beforeCents||amountCents===beforeCents)throw new HttpsError('failed-precondition','입금 기록의 현재 금액을 다시 확인해 주세요.');
        const depositedCents=current.deposited+amountCents-beforeCents;
        const patch={depositedCents,bankConfirmedAt:depositedCents>0?order.bankConfirmedAt:null};
        const payment=orderPaymentSummary({...order,...patch});
        if(payment.net<0||payment.refundDue<current.reservedRefund)
          throw new HttpsError('failed-precondition','이미 완료했거나 예약한 환불보다 입금액을 낮출 수 없습니다.');
        const at=now();
        tx.create(audit,{id:requestId,type:'depositCorrection',paymentId,amountCents:amountCents-beforeCents,beforeCents,afterCents:amountCents,reason,by:req.auth.uid,at});
        tx.update(entry,{correctedAmountCents:amountCents,correctedAt:at});
        tx.update(ref,patch);
        if(order.email&&!order.canceledAt&&depositedCents>0){
          if(current.additionalDue>0&&payment.additionalDue===0&&!confirmation.exists)await queue(tx,id,'confirmed',{eventId});
          if(payment.additionalDue>0&&payment.additionalDue!==current.additionalDue)
            await queue(tx,id,'additionalPayment',{eventId,jobKey:'additionalPayment-'+requestId,
              change:{items:order.items,totalCents:order.totalCents,amountCents:payment.additionalDue}});
        }
        return {payment};
      });
    }
    if(op==='recordOrderPayment'||op==='orderPayments'){
      const id=s(data.id);
      if(!/^[A-Za-z0-9]{15,40}$/.test(id))bad('주문 번호를 확인해 주세요.');
      const ref=orders.doc(id);
      if(op==='orderPayments'){
        const order=(await ref.get()).data();
        if(!order||order.eventId!==data.eventId)throw new HttpsError('not-found','해당 주문을 찾을 수 없습니다.');
        const records=await ref.collection('payments').orderBy('at','desc').get();
        return {payment:orderPaymentSummary(order),records:records.docs.map(doc=>doc.data())};
      }
      const key=s(data.requestId),reason=s(data.reason).trim(),reference=s(data.reference).trim(),amount=data.amountCents,type=data.type;
      const details=type==='deposit'?depositDetails(data):null;
      if(!/^[a-f0-9]{32}$/.test(key)||!['refund','deposit'].includes(type)||!cents(amount)||amount===0||
        (type==='refund'&&!reason)||reason.length>500||reference.length>160||(type==='deposit'&&!details))bad('거래 금액, 종류 및 입력 정보를 확인해 주세요.');
      const ledger=ref.collection('payments').doc(key);
      return db.runTransaction(async tx=>{
        const [snapshot,previous,confirmation]=await Promise.all([tx.get(ref),tx.get(ledger),tx.get(outbox.doc(id+'_confirmed'))]);
        const order=snapshot.data();
        if(!order||order.eventId!==data.eventId||!order.bankConfirmedAt)
          throw new HttpsError('failed-precondition','기본 입금 확인이 완료된 주문을 선택해 주세요.');
        const current=orderPaymentSummary(order);
        if(previous.exists){
          const record=previous.data();
          if(record.amountCents!==amount||record.type!==type||record.reason!==reason||record.reference!==reference||
            details&&Object.entries(details).some(([field,value])=>(record[field]||'')!==value))
            throw new HttpsError('already-exists','같은 요청 번호로 다른 거래를 기록할 수 없습니다.');
          return {payment:current};
        }
        await requireOpenAccounting(tx,order.eventId);
        const allowed=type==='refund'?Math.max(0,current.refundDue-(order.reservedRefundCents||0)):current.additionalDue;
        if(amount>allowed&&!(type==='deposit'&&data.overpayment===true))throw new HttpsError('failed-precondition','처리할 수 있는 차액보다 입력 금액이 큽니다.');
        const record={...details,id:key,type,amountCents:amount,reason,reference,by:req.auth.uid,at:now()};
        const patch={originalTotalCents:current.original,depositedCents:current.deposited+(type==='deposit'?amount:0),
          refundedCents:current.refunded+(type==='refund'?amount:0)};
        tx.create(ledger,record);
        tx.update(ref,patch);
        if(type==='refund'&&order.email)await queue(tx,id,'refundCompleted',{eventId:order.eventId,jobKey:'refundCompleted-'+key,change:{amountCents:amount,at:record.at,items:order.items,totalCents:order.totalCents}});
        const payment=orderPaymentSummary({...order,...patch});
        if(type==='deposit'&&order.email&&!order.canceledAt){
          if(current.additionalDue>0&&payment.additionalDue===0&&!confirmation.exists)await queue(tx,id,'confirmed',{eventId:order.eventId});
          else if(payment.additionalDue>0)await queue(tx,id,'additionalPayment',{eventId:order.eventId,
            jobKey:'additionalPayment-'+key,change:{items:order.items,totalCents:order.totalCents,amountCents:payment.additionalDue}});
        }
        return {payment};
      });
    }
    if(op==='eventRefunds'){
      const eventId=s(data.eventId),ids=data.ids;
      if(!validEventId(eventId)||!Array.isArray(ids)||ids.length>12||new Set(ids).size!==ids.length||
        ids.some(id=>!/^[A-Za-z0-9]{15,40}$/.test(id)))bad('조회할 환불과 행사를 확인해 주세요.');
      if(!ids.length)return {refunds:[]};
      const snapshots=await db.getAll(...ids.map(id=>orders.doc(id)));
      const lists=await Promise.all(snapshots.filter(doc=>doc.data()?.eventId===eventId).map(async doc=>{
        const {orderRef,name}=doc.data();
        const rows=await orders.doc(doc.id).collection('refunds').orderBy('createdAt','desc').get();
        return rows.docs.map(record=>{
          const {id,kind,status,amountCents,createdAt,completedAt,items,method,operator}=record.data();
          return {id,kind,status,amountCents,createdAt,completedAt,items:(items||[]).map(({titleKo,titleFr,qty})=>({titleKo,titleFr,qty})),
            method,operator,orderRef,name,orderId:doc.id};
        });
      }));
      return {refunds:lists.flat()};
    }
    if(['adminTransferReport','orderRefunds','refundAudit','createRefund','finishRefund','voidRefund','editRefund'].includes(op)){
      const id=s(data.id),eventId=s(data.eventId),uid=req.auth.uid;
      if(!/^[A-Za-z0-9]{15,40}$/.test(id)||!validEventId(eventId))bad('행사와 주문을 확인해 주세요.');
      const ref=orders.doc(id),refunds=ref.collection('refunds');
      if(op==='orderRefunds'||op==='refundAudit'){
        const order=(await ref.get()).data();
        if(!order||order.eventId!==eventId)throw new HttpsError('not-found','주문을 찾을 수 없습니다.');
        if(op==='refundAudit'){
          const key=s(data.refundId);
          if(!/^[a-f0-9]{32}$/.test(key))bad('환불 번호를 확인해 주세요.');
          const refund=(await refunds.doc(key).get()).data();
          if(!refund)throw new HttpsError('not-found','환불 기록을 찾을 수 없습니다.');
          const [entries,orderChange]=await Promise.all([refunds.doc(key).collection('audit').orderBy('at','desc').limit(100).get(),
            ref.collection('corrections').doc(String(refund.revision)).get()]);
          return {refund,edits:entries.docs.map(doc=>doc.data()),
            orderChange:orderChange.data()?.refundId===key?orderChange.data():null};
        }
        const rows=await refunds.orderBy('createdAt','desc').get();
        return {refunds:rows.docs.map(doc=>doc.data())};
      }
      if(op==='adminTransferReport'){
        const reason=s(data.reason).trim();
        if(data.confirm!==true||reason.length>500||data.undo===true&&!reason)bad('송금 신고 내용을 확인해 주세요.');
        return db.runTransaction(async tx=>{
          const [snapshot,active]=await Promise.all([tx.get(ref),tx.get(eventRef)]);
          const order=snapshot.data();
          if(!order||order.eventId!==eventId)throw new HttpsError('not-found','주문을 찾을 수 없습니다.');
          assertOrderEvent(active.data(),eventId);
          if(order.bankConfirmedAt||order.canceledAt)throw new HttpsError('failed-precondition','취소 또는 입금 확인된 주문은 변경할 수 없습니다.');
          if(data.undo===true&&order.transferReportSource!=='admin')throw new HttpsError('failed-precondition','운영진이 등록한 신고만 정정할 수 있습니다.');
          if(data.undo!==true&&order.transferReportedAt)return {changed:false};
          const at=now();
          const seq=(order.transferReportRevision||0)+1;
          tx.create(ref.collection('transferReports').doc(String(seq)),{at,by:uid,reason,undo:data.undo===true,previousAt:order.transferReportedAt||null});
          tx.update(ref,{transferReportedAt:data.undo===true?null:at,transferReportSource:data.undo===true?null:'admin',
            transferReportBy:data.undo===true?null:uid,transferReportRevision:seq});
          return {changed:true};
        });
      }
      const key=s(data.requestId),reason=s(data.reason).trim();
      if(!/^[a-f0-9]{32}$/.test(key)||data.confirm!==true||reason.length>500)bad('환불 요청을 확인해 주세요.');
      const document=refunds.doc(key);
      return db.runTransaction(async tx=>{
        const [snapshot,existing,active]=await Promise.all([tx.get(ref),tx.get(document),tx.get(eventRef)]);
        const order=snapshot.data(),record=existing.data(),event=active.data();
        if(!order||order.eventId!==eventId||!order.bankConfirmedAt)throw new HttpsError('failed-precondition','같은 행사의 입금 확인 주문을 선택하세요.');
        const reserved=order.reservedRefundCents||0,at=now(),payment=orderPaymentSummary(order);
        if(op==='editRefund'){
          if(!record||!['pending','completed'].includes(record.status)||!reason)bad('환불 및 정정 사유를 확인해 주세요.');
          const auditKey=s(data.auditId),details=depositDetails(data),amount=data.amountCents;
          if(!/^[a-f0-9]{32}$/.test(auditKey)||!details||!details.operator||!cents(amount)||amount===0)
            bad('환불 금액과 담당자를 확인해 주세요.');
          const audit=document.collection('audit').doc(auditKey);
          const [entry,financial]=await Promise.all([tx.get(audit),tx.get(eventFinancials.doc(eventId))]);
          const iban=data.iban===undefined?record.iban:s(data.iban).replace(/\s/g,'').toUpperCase();
          const beneficiary=data.beneficiary===undefined?record.beneficiary:s(data.beneficiary);
          if(iban&&(record.method!=='bank'||!validRefundIban(iban))||(beneficiary||'').length>120)
            bad('수취인과 IBAN의 국가별 길이 및 검증 번호를 확인해 주세요.');
          const fields={amountCents:amount,operator:details.operator,reference:details.reference,iban:iban||'',beneficiary:beneficiary||''};
          const fingerprint=createHash('sha256').update(JSON.stringify({fields,reason})).digest('hex');
          if(entry.exists){
            if(entry.data().fingerprint!==fingerprint)throw new HttpsError('already-exists','같은 요청 번호로 다른 정정을 기록할 수 없습니다.');
            return {refund:record,payment};
          }
          if(financial.data()?.finalizedAt)throw new HttpsError('failed-precondition','확정 결산을 정정 상태로 전환한 뒤 기록하세요.');
          if((record.editRevision||0)!==data.editRevision)throw new HttpsError('failed-precondition','환불 기록을 다시 불러와 주세요.');
          const delta=amount-record.amountCents;
          const patch=record.status==='pending'?{reservedRefundCents:reserved+delta}:{refundedCents:payment.refunded+delta};
          const updated=orderPaymentSummary({...order,...patch});
          if(updated.refunded>updated.deposited||updated.reservedRefund>updated.refundDue||
            record.status==='completed'&&delta>0&&delta>payment.refundDue-reserved)
            throw new HttpsError('failed-precondition','환불 가능 금액을 초과했습니다.');
          const update={...fields,editRevision:(record.editRevision||0)+1};
          const change={at,by:uid,reason,before:{amountCents:record.amountCents,operator:record.operator,reference:record.reference||'',
            iban:record.iban||'',beneficiary:record.beneficiary||''},after:fields};
          tx.create(audit,{...change,fingerprint});
          tx.update(document,{...update,lastEdit:change});
          tx.update(ref,patch);
          return {refund:{...record,...update,lastEdit:change},payment:updated};
        }
        if(op==='voidRefund'){
          if(record?.status==='void')return {refund:record,payment};
          if(record?.status!=='pending'||!reason)throw new HttpsError('failed-precondition','사유를 입력하고 환불 대기 기록을 선택하세요.');
          await requireOpenAccounting(tx,eventId);
          const change={status:'void',voidAt:at,voidBy:uid,voidReason:reason};
          const patch={reservedRefundCents:reserved-record.amountCents};
          if(data.restoreOrder===true){
            if(record.kind!=='items'||record.revision!==(order.revision||0)||event?.eventId!==eventId||locked(event)||
              event.status!=='published'||!Number.isFinite(Date.parse(event.pickupAt))||Date.parse(event.pickupAt)<=Date.now())
              throw new HttpsError('failed-precondition','수령 전 진행 중인 행사에서 변경되지 않은 상품 주문만 복원할 수 있습니다.');
            const [revisionDoc,procurement,inventory]=await Promise.all([
              tx.get(ref.collection('corrections').doc(String(record.revision))),
              tx.get(purchaseOrders.where('eventId','==',eventId)),
              Promise.all(record.items.map(item=>tx.get(products.doc(item.id)))),
            ]);
            const before=revisionDoc.data()?.before;
            const canceled=order.canceledItems||[],restored=record.items;
            const matches=canceled.slice(-restored.length).every((item,i)=>item.id===restored[i].id&&item.qty===restored[i].qty);
            if(revisionDoc.data()?.refundId!==key||!before?.items||canceled.length<restored.length||!matches)
              throw new HttpsError('failed-precondition','취소 전 주문 기록이 일치하지 않습니다.');
            for(let i=0;i<restored.length;i++){
              const item=restored[i],product=inventory[i].data();
              if(!product?.visible||product.archivedAt||event.scopedProducts&&product.bazaarEventId!==eventId||
                procurement.docs.some(doc=>doc.data().confirmed&&doc.data().vendor===product.supplier))
                throw new HttpsError('failed-precondition','판매가 중지되었거나 공급업체 발주가 확정된 상품은 복원할 수 없습니다.');
              if(record.restoreStock)assertAvailable(product,item.qty,item.id);
            }
            const revision=(order.revision||0)+1;
            Object.assign(patch,{items:before.items,totalCents:before.totalCents,canceledAt:null,cancelReason:null,revision,modifiedAt:at,
              canceledItems:canceled.slice(0,canceled.length-restored.length)});
            if(orderPaymentSummary({...order,...patch}).refundDue<patch.reservedRefundCents)
              throw new HttpsError('failed-precondition','다른 환불 대기 건을 먼저 처리해 주세요.');
            if(record.restoreStock)inventory.forEach((doc,i)=>tx.update(doc.ref,{soldQty:FieldValue.increment(restored[i].qty)}));
            tx.create(ref.collection('corrections').doc(String(revision)),{revision,at,by:uid,reason,restoredRefundId:key,
              before:{items:order.items,totalCents:order.totalCents},after:before});
            if(order.email)await queue(tx,id,'orderChanged',{eventId,jobKey:'orderChanged-'+revision,change:before});
            change.orderRestored=true;
          }
          tx.update(document,change);tx.update(ref,patch);
          return {refund:{...record,...change},payment:orderPaymentSummary({...order,...patch})};
        }
        if(op==='finishRefund'){
          if(record?.status==='completed')return {refund:record,payment};
          await requireOpenAccounting(tx,eventId);
          const actual=s(data.completedAt),reference=s(data.reference).trim(),operator=s(data.operator).trim();
          if(record?.status!=='pending'||record.amountCents>reserved||record.amountCents>payment.refundDue||
            !actual||!Number.isFinite(Date.parse(actual))||Date.parse(actual)>Date.now()||!operator||operator.length>120||reference.length>160)
            throw new HttpsError('failed-precondition','환불 대기 금액, 실제 날짜 및 담당자를 확인해 주세요.');
          const change={status:'completed',completedAt:new Date(actual).toISOString(),completedBy:uid,recordedAt:at,operator,reference};
          const patch={reservedRefundCents:reserved-record.amountCents,refundedCents:payment.refunded+record.amountCents,lastRefundAt:change.completedAt};
          tx.update(document,change);tx.update(ref,patch);
          if(order.email)await queue(tx,id,'refundCompleted',{eventId,jobKey:'refundCompleted-'+key,change:{
            amountCents:record.amountCents,at:change.completedAt,items:record.items,totalCents:order.totalCents}});
          return {refund:{...record,...change},payment:orderPaymentSummary({...order,...patch})};
        }
        const kind=data.kind,amount=data.amountCents,restore=data.restoreStock===true,method=s(data.method),operator=s(data.operator).trim();
        const publicReason=s(data.publicReason).trim(),note=s(data.note).trim(),iban=s(data.iban).replace(/\s/g,'').toUpperCase(),beneficiary=s(data.beneficiary).trim();
        const quantities=data.items??[];
        if(iban&&(method!=='bank'||!validRefundIban(iban)))bad('IBAN의 지원 국가, 길이와 검증 번호를 확인해 주세요.');
        if(!['items','price','overpayment','balance'].includes(kind)||!cents(amount)||amount<=0||!reason||!operator||operator.length>120||
          !['bank','cash','other'].includes(method)||publicReason.length>400||note.length>500||beneficiary.length>120||
          !Array.isArray(quantities)||quantities.length>30||
          (kind!=='items'&&(quantities.length||restore)))bad('환불 종류, 금액, 담당자 또는 취소 수량을 확인해 주세요.');
        const fingerprint=createHash('sha256').update(JSON.stringify({kind,amount,reason,restore,method,operator,publicReason,note,iban,beneficiary,quantities})).digest('hex');
        if(record){
          if(record.fingerprint!==fingerprint)throw new HttpsError('already-exists','같은 요청 번호의 환불 내용이 다릅니다.');
          return {refund:record,payment};
        }
        await requireOpenAccounting(tx,eventId);
        if((order.revision||0)!==data.revision)throw new HttpsError('failed-precondition','주문이 수정되었습니다. 다시 불러와 주세요.');
        if(order.canceledAt&&['items','price'].includes(kind))bad('이미 취소된 주문의 상품 또는 가격을 변경할 수 없습니다.');
        const previous=new Map(order.items.map(item=>[item.id,item])),canceled=[];
        for(const item of quantities){
          const old=previous.get(s(item?.id));
          if(!old||!Number.isSafeInteger(item.qty)||item.qty<1||item.qty>old.qty||canceled.some(line=>line.id===old.id))bad('현재 유효한 수량 이내에서 취소할 상품을 선택하세요.');
          canceled.push({...old,qty:item.qty});
        }
        const calculated=canceled.reduce((total,item)=>total+item.qty*item.priceCents,0);
        if(kind==='items'&&(!canceled.length||amount!==calculated&&!s(data.differenceReason).trim()))bad('취소 상품을 선택하고 계산값과 금액 차이의 사유를 입력하세요.');
        if(restore&&(event?.eventId!==eventId||event.status!=='published'||locked(event)))
          throw new HttpsError('failed-precondition','진행 중이며 정산이 시작되지 않은 행사만 재고를 복원할 수 있습니다.');
        const inventory=restore?await Promise.all(canceled.map(item=>tx.get(products.doc(item.id)))):[];
        if(inventory.some((doc,i)=>!doc.exists||event.scopedProducts&&doc.data().bazaarEventId!==eventId||doc.data().soldQty<canceled[i].qty))
          throw new HttpsError('failed-precondition','재고를 복원할 수 없는 상품이 있습니다.');
        const afterItems=order.items.map(item=>({...item,qty:item.qty-(canceled.find(line=>line.id===item.id)?.qty||0)})).filter(item=>item.qty>0);
        const total=payment.due-(kind==='items'?calculated:kind==='price'?amount:0);
        if(total<0||amount+reserved>payment.net-total)throw new HttpsError('failed-precondition','기존 환불 대기를 포함해 실제 환불 가능 금액을 초과했습니다.');
        const financialOnly=!['items','price'].includes(kind);
        const revision=(order.revision||0)+(financialOnly?0:1);
        const next={id:key,eventId,kind,status:'pending',amountCents:amount,createdAt:at,createdBy:uid,reason,method,operator,
          publicReason,note,beneficiary,iban,restoreStock:restore,calculatedCents:calculated,differenceReason:s(data.differenceReason).slice(0,500),
          items:canceled.length?canceled:afterItems,revision,fingerprint};
        const patch={reservedRefundCents:reserved+amount};
        if(!financialOnly){
          const first=order.originalItems||((order.revision||0)>0?(await tx.get(ref.collection('corrections').doc('1'))).data()?.before?.items:null)||order.items;
          Object.assign(patch,{items:afterItems,totalCents:total,modifiedAt:at,revision,originalItems:first,originalTotalCents:payment.original,
            depositedCents:payment.deposited,refundedCents:payment.refunded,canceledItems:[...(order.canceledItems||[]),...canceled],
            priceAdjustmentCents:(order.priceAdjustmentCents||0)+(kind==='price'?amount:0),publicRefundReason:publicReason,
            productHistoryIds:[...new Set([...(order.productHistoryIds||[]),...order.items.map(item=>item.id)])]});
          if(!afterItems.length)Object.assign(patch,{canceledAt:at,cancelReason:'admin'});
          tx.create(ref.collection('corrections').doc(String(revision)),{revision,at,by:uid,reason,refundId:key,
            before:{items:order.items,totalCents:order.totalCents},after:{items:afterItems,totalCents:total}});
          inventory.forEach((doc,i)=>tx.update(doc.ref,{soldQty:FieldValue.increment(-canceled[i].qty)}));
          if(order.email)await queue(tx,id,'orderChanged',{eventId,jobKey:'orderChanged-'+revision,change:{items:afterItems,totalCents:total}});
        }
        tx.create(document,next);tx.update(ref,patch);
        return {refund:next,payment:orderPaymentSummary({...order,...patch})};
      });
    }
    if(op==='cancelOrder'){
      const id=s(data.id);
      if(!/^[A-Za-z0-9]{15,40}$/.test(id)||data.confirm!==true)bad('취소할 주문을 확인해 주세요.');
      const mailId=await db.runTransaction(async tx=>{
        const ref=orders.doc(id);
        const [active,snapshot]=await Promise.all([tx.get(eventRef),tx.get(ref)]);
        const order=snapshot.data();
        if(!order||order.eventId!==data.eventId)
          throw new HttpsError('failed-precondition','행사와 주문을 확인해 주세요.');
        if(order.canceledAt)return null;
        await requireOpenAccounting(tx,order.eventId);
        const event=active.data(),reason=s(data.reason).trim();
        const canRestore=event?.eventId===order.eventId&&!locked(event)&&event.status==='published';
        const paid=!!order.bankConfirmedAt;
        if(!paid)assertOrderEvent(event,order.eventId);
        if(paid&&(!reason||reason.length>500||typeof data.restoreStock!=='boolean'))bad('취소 사유와 재고 복원 여부를 확인해 주세요.');
        if(paid&&data.restoreStock&&!canRestore)throw new HttpsError('failed-precondition','종료 또는 정산 중인 행사에는 재고를 복원할 수 없습니다.');
        const restore=!paid||data.restoreStock===true;
        const stock=restore?await Promise.all(order.items.map(item=>tx.get(products.doc(item.id)))):[];
        stock.forEach((doc,i)=>{if(doc.exists&&(!event.scopedProducts||doc.data().bazaarEventId===order.eventId))tx.update(doc.ref,{soldQty:FieldValue.increment(-order.items[i].qty)});});
        const at=now();
        tx.update(ref,{canceledAt:at,cancelReason:'admin',adminCancellation:{at,by:req.auth.uid,reason,restoreStock:restore}});

        return order.email?queue(tx,id,'cancel',{eventId:order.eventId}):null;
      });
      if(mailId)await deliver(mailId).catch(error=>console.error('Bazaar cancellation delivery failed',error));
      return {ok:true};
    }
    if(op==='storePhoto'){
      const eventId=s(data.eventId),id=s(data.id);
      if(!validEventId(eventId)||!productIdValid(id))bad('행사와 상품을 확인해 주세요.');
      if(data.catalog===true){
        if(eventId!==catalogPhotoScope||data.sourcePath)bad('기본 상품 사진 요청을 확인해 주세요.');
      }else if(data.draft===true){
        const draft=(await eventDrafts.doc(eventId).get()).data();
        if(!draft||draft.updatedAt!==data.updatedAt)throw new HttpsError('failed-precondition','초안이 변경되었습니다. 다시 불러와 주세요.');
      }else{
        requireCurrentEvent((await eventRef.get()).data()||initialEvent);
      }
      try{return await storePhoto(eventId,id,data);}
      catch(error){
        if(error instanceof HttpsError)throw error;
        console.error('Bazaar photo storage failed',error.code??error.name);
        throw new HttpsError('failed-precondition','사진을 저장하지 못했습니다. 기존 사진과 행사 자료는 유지됩니다.');
      }
    }
    if(op==='endEvent'){
      if(data.confirm!==true)bad('행사 종료 확인이 필요합니다.');
      return await db.runTransaction(async tx=>{
        const current=await tx.get(eventRef);
        if(!current.exists)throw new HttpsError('not-found','진행 중인 바자회가 없습니다.');
        const currentEvent=current.data();
        if(currentEvent.eventId!==data.eventId)throw new HttpsError('failed-precondition','행사가 변경되었습니다. 다시 불러와 주세요.');
        if(currentEvent.status==='closed')return{ok:true,alreadyClosed:true,endedAt:currentEvent.endedAt||null};
        if(currentEvent.status!=='published')throw new HttpsError('failed-precondition','발행된 행사만 종료할 수 있습니다.');
        const endedAt=now();
        const archive=eventArchives.doc(currentEvent.eventId);
        const [stored,ps]=await Promise.all([tx.get(archive),tx.get(products)]);
        if(!stored.exists)archiveEvent(tx,archive,{...currentEvent,endedAt},ps,endedAt);
        tx.update(eventRef,{status:'closed',endedAt});
        return{ok:true,endedAt};
      });
    }
    if(op==='dashboard'){
      const requested=s(data.eventId);
      if(requested&&!validEventId(requested))bad('행사 주소를 확인해 주세요.');
      return db.runTransaction(async tx=>{
        const active=(await tx.get(eventRef)).data()||initialEvent;
        const isCurrent=!requested||requested===active.eventId;
        let ev=active, productData;
        if(!isCurrent||closed(active)){
          const snap=await tx.get(eventArchives.doc(requested||active.eventId));
          if(snap.exists){
            const archive=snap.data();
            ev=isCurrent?{...archive.event,...active,status:'closed'}:archive.event;
            productData=archive.products;
          }else if(!isCurrent){
            throw new HttpsError('not-found','해당 바자회 기록을 찾을 수 없습니다.');
          }
        }
        productData??=snapshotProducts(await tx.get(products)).filter(product=>!ev.scopedProducts||product.bazaarEventId===ev.eventId);
        const o=await tx.get(orders.where('eventId','==',ev.eventId||initialEvent.eventId));
        const history=productHistory(o);
        productData=productData.map(p=>({...p,hasOrderHistory:history.ids.has(p.id)||history.legacy||p.soldQty>0}));
        return{event:ev,isCurrent,readOnly:!isCurrent||closed(ev),products:productData.sort((a,b)=>a.displayOrder-b.displayOrder),orders:o.docs.map(d=>safeOrder(d.data())).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
      },{readOnly:true});
    }
    if(['archiveClosedEvent','closedEventData','deleteClosedEvent'].includes(op)){
      const id=s(data.eventId),ref=eventArchives.doc(id);
      if(!validEventId(id))bad('행사 ID를 확인해 주세요.');
      return db.runTransaction(async tx=>{
        const [archived,active]=await Promise.all([tx.get(ref),tx.get(eventRef)]);
        const record=archived.data();
        if(!record?.event?.endedAt&&!record?.event?.finalizedAt)throw new HttpsError('not-found','종료 행사를 찾을 수 없습니다.');
        if(op==='archiveClosedEvent'){
          if(typeof data.archive!=='boolean')bad('보관 또는 복원을 선택해 주세요.');
          tx.update(ref,{hiddenAt:data.archive?now():null});return {ok:true};
        }
        const [eventOrders,financial,purchases,eventMail]=await Promise.all([
          tx.get(orders.where('eventId','==',id).limit(op==='closedEventData'?1000:1)),tx.get(eventFinancials.doc(id)),
          tx.get(purchaseOrders.where('eventId','==',id).limit(op==='closedEventData'?150:1)),
          tx.get(outbox.where('eventId','==',id).limit(1)),
        ]);
        if(op==='closedEventData')return {event:record.event,products:record.products,orders:eventOrders.docs.map(doc=>safeOrder(doc.data())),financial:financial.data()||null,purchases:purchases.docs.map(doc=>doc.data())};
        if(data.confirm!==true||s(data.name)!==record.event.nameKo)bad('삭제하려면 행사명을 정확히 입력해 주세요.');
        if(active.data()?.eventId===id||!eventOrders.empty||financial.exists||!purchases.empty||!eventMail.empty)
          throw new HttpsError('failed-precondition','주문, 발주, 정산 또는 발송 기록이 있거나 최근 종료된 행사는 보관 처리해 주세요.');
        tx.delete(ref);return {ok:true};
      },{readOnly:op==='closedEventData'});
    }
    if(op==='listEvents'){
      const [cur,old,drafts]=await Promise.all([eventRef.get(),eventArchives.get(),eventDrafts.get()]);
      const active=cur.exists?cur.data():null;
      const dateFields=e=>({createdAt:e?.createdAt||'',orderStartsAt:e?.orderStartsAt||'',orderCutoff:e?.orderCutoff||'',endedAt:e?.endedAt||''});
      const events=old.docs.map(d=>({id:d.id,nameKo:d.data().event?.nameKo||d.id,nameFr:d.data().event?.nameFr||'',...dateFields(d.data().event),serial:d.data().event?.serial||0,status:'closed',hiddenAt:d.data().hiddenAt||null}));
      if(active&&!events.some(e=>e.id===active.eventId))events.push({id:active.eventId,nameKo:active.nameKo||'진행 중 바자회',nameFr:active.nameFr||'',...dateFields(active),serial:active.serial||1,status:active.status||'draft'});
      return{events:events.sort((a,b)=>b.serial-a.serial||b.createdAt.localeCompare(a.createdAt)),drafts:drafts.docs.map(d=>({id:d.id,nameKo:d.data().event?.nameKo||'임시저장',nameFr:d.data().event?.nameFr||'',...dateFields(d.data().event),createdAt:d.data().createdAt||d.data().event?.createdAt||'',serial:d.data().serial||0,updatedAt:d.data().updatedAt||''}))};
    }
    if(op==='createDraft'){
      const [cur,ps,archives,existingDrafts]=await Promise.all([eventRef.get(),products.get(),eventArchives.get(),eventDrafts.get()]);
      if(existingDrafts.size>=10)throw new HttpsError('resource-exhausted','임시저장 바자회가 너무 많습니다.');
      if(ps.size>70)throw new HttpsError('failed-precondition','상품이 70개를 초과하여 별도 저장 구조가 필요합니다.');
      const prev=cur.exists?cur.data():initialEvent;
      const maxSerial=Math.max(prev.serial||1,...archives.docs.map(d=>d.data().event?.serial||0),...existingDrafts.docs.map(d=>d.data().serial||0));
      const freshFirst=prev.status==='draft'&&!prev.publishedAt&&existingDrafts.empty;
      const serial=freshFirst?(prev.serial||1):maxSerial+1;
      const id=`bazaar-${Date.now()}-${randomBytes(6).toString('hex')}`;
      const draft={id,serial,status:'draft',createdAt:now(),updatedAt:now(),event:{...prev,eventId:id,serial,nameKo:`${serial}차 ASICC 온라인 바자회`,nameFr:`Vente solidaire ASICC n°${serial}`,orderCutoff:'',transferCutoff:'',orderStartsAt:'',pickupAt:'',pickupPlace:'',paymentHours:defaultPaymentHours,pickupKo:'',pickupFr:'',finalizedAt:null,endedAt:null,publishedAt:null,createdAt:now(),status:'draft'},items:[]};
      await eventDrafts.doc(id).create(draft);
      return{draft};
    }
    if(op==='getDraft'){
      const id=s(data.id);if(!validEventId(id))bad('임시저장 ID를 확인해 주세요.');
      const snap=await eventDrafts.doc(id).get();
      if(!snap.exists)throw new HttpsError('not-found','임시저장 바자회를 찾을 수 없습니다.');
      return{draft:snap.data()};
    }
    if(op==='saveDraft'){
      const id=s(data.id);if(!/^[a-z0-9-]{12,60}$/.test(id))bad('임시저장 ID가 올바르지 않습니다.');
      const snap=await eventDrafts.doc(id).get();if(!snap.exists)throw new HttpsError('not-found','임시저장 내역이 없습니다.');
      if(snap.data().status!=='draft')throw new HttpsError('failed-precondition','이미 발행된 바자회는 임시저장할 수 없습니다.');
      if(!Array.isArray(data.items)||data.items.length>70)bad('상품 목록을 확인해 주세요.');
      const ids=data.items.map(x=>s(x?.id));if(new Set(ids).size!==ids.length||ids.some(x=>!/^[a-z0-9-]{2,50}$/.test(x)))bad('중복되거나 잘못된 상품 ID가 있습니다.');
      const previousItems=new Map(snap.data().items.map(item=>[item.id,item]));
      const base=await catalogRef.get();
      const baseIds=new Set((base.exists?base.data().items:catalogSnapshot(await products.get())).map(p=>p.id));
      const items=await Promise.all(data.items.map(async (item,i)=>{
        const previous=previousItems.get(ids[i]);
        if(!previous&&!/^custom-[a-f0-9]{32}$/.test(ids[i])&&!baseIds.has(ids[i]))bad('초안의 상품 ID를 확인해 주세요.');
        const included=item.included===true;
        const checked=validateProduct({...item,imageUrl:item.photoPath?'':item.imageUrl,visible:false},{soldQty:0},true);
        const photo=await copyProductPhoto(id,ids[i],item);
        return{...checked,...photo,visible:included,id:ids[i],included,displayOrder:i+1,
          soldQty:0,archivedAt:included?null:(previous?.archivedAt||null)};
      }));
      const input=data.event||{};
      const e={...snap.data().event,...eventSchedule(input),nameKo:s(input.nameKo).slice(0,120),nameFr:s(input.nameFr).slice(0,120),introKo:s(input.introKo).slice(0,1000),introFr:s(input.introFr).slice(0,1000),pickupKo:s(input.pickupKo).slice(0,500),pickupFr:s(input.pickupFr).slice(0,500),iban:s(input.iban).replaceAll(' ','').toUpperCase(),beneficiary:s(input.beneficiary).slice(0,200),orderCutoff:s(input.orderCutoff),transferCutoff:s(input.transferCutoff)};
      if(!e.nameKo||!e.nameFr)bad('바자회 이름을 입력해 주세요.');
      if(e.iban&&!/^FR\d{2}[A-Z0-9]{23}$/.test(e.iban))bad('IBAN을 확인해 주세요.');
      for(const field of ['orderCutoff','transferCutoff'])if(e[field]&&!Number.isFinite(Date.parse(e[field])))bad('일정 형식을 확인해 주세요.');
      const updatedAt=new Date(Math.max(Date.now(),Date.parse(snap.data().updatedAt)+1)).toISOString();
      const result={...snap.data(),event:e,items,updatedAt};
      if(Buffer.byteLength(JSON.stringify(result))>800000)bad('상품 정보가 너무 많아 저장할 수 없습니다.');
      await db.runTransaction(async tx=>{
        const current=await tx.get(snap.ref);
        if(!current.exists||!current.updateTime.isEqual(snap.updateTime)||current.data().updatedAt!==data.updatedAt){
          throw new HttpsError('failed-precondition','초안이 변경되었습니다. 다시 불러와 주세요.');
        }
        tx.set(snap.ref,result);
      });
      return{ok:true,updatedAt:result.updatedAt};
    }
    if(op==='deleteDraft'){
      const id=s(data.id);if(!validEventId(id)||data.confirm!==true)bad('임시저장 삭제를 확인해 주세요.');
      await db.runTransaction(async tx=>{
        const ref=eventDrafts.doc(id);
        const [draft,cur,o]=await Promise.all([tx.get(ref),tx.get(eventRef),tx.get(orders.where('eventId','==',id).limit(1))]);
        if(!draft.exists)throw new HttpsError('not-found','임시저장 내역이 없습니다.');
        if(draft.data().status!=='draft'||cur.data()?.eventId===id||!o.empty)throw new HttpsError('failed-precondition','발행했거나 주문이 있는 바자회는 삭제할 수 없습니다.');
        tx.delete(ref);
      });
      return{ok:true};
    }
    if(op==='publishDraft'){

      const id=s(data.id);
      if(!validEventId(id))bad('임시저장 ID를 확인해 주세요.');
      return db.runTransaction(async tx=>{
        const snap=await tx.get(eventDrafts.doc(id));
        if(!snap.exists||snap.data()?.status!=='draft')throw new HttpsError('not-found','발행할 임시저장 바자회가 없습니다.');
        if(snap.data().updatedAt!==data.updatedAt)throw new HttpsError('failed-precondition','초안이 변경되었습니다. 다시 불러와 주세요.');
        const draft=snap.data(),e=draft.event;
        if(!e.orderCutoff||!e.transferCutoff||!Number.isFinite(Date.parse(e.orderCutoff))||!Number.isFinite(Date.parse(e.transferCutoff))||Date.parse(e.orderCutoff)<=Date.now()||Date.parse(e.transferCutoff)<=Date.parse(e.orderCutoff))bad('주문·송금 마감 날짜를 확인해 주세요.');
        if(!/^FR\d{2}[A-Z0-9]{23}$/.test(s(e.iban))||!e.beneficiary||!e.pickupKo||!e.pickupFr)bad('IBAN, 수취인과 픽업 안내를 모두 입력해 주세요.');
        if(!draft.items.some(p=>p.included))bad('판매할 상품을 하나 이상 선택해 주세요.');
        const sellingItems=draft.items.filter(p=>p.included&&!p.archivedAt);
        if(!sellingItems.length)bad('판매 상품을 추가해 주세요.');
        const issues=[];
        for(const item of sellingItems){
          try{validateProduct({...item,imageUrl:item.photoPath?'':item.imageUrl},{soldQty:0});}
          catch(error){if(error.code!=='invalid-argument')throw error;issues.push({id:item.id,message:error.message});}
        }
        if(issues.length)throw new HttpsError('invalid-argument',issues.map(issue=>issue.message).join('\n'),{issues});
        const [old,ps,base]=await Promise.all([tx.get(eventRef),tx.get(products),tx.get(catalogRef)]);
        const previous=old.data();
        if(previous?.status==='published'&&!previous.finalizedAt){
          throw new HttpsError('failed-precondition','진행 중인 바자회를 먼저 종료해 주세요.');
        }
        if(previous?.reconciliationStartedAt&&!previous.reconciledAt){
          throw new HttpsError('failed-precondition','기존 행사의 입금 정리를 완료해 주세요.');
        }
        if(previous&&!previous.finalizedAt){
          const pending=await tx.get(orders.where('eventId','==',previous.eventId));
          if(pending.docs.some(d=>!d.data().bankConfirmedAt&&!d.data().canceledAt)){
            throw new HttpsError('failed-precondition','기존 행사에 입금 확인이 필요한 주문이 있습니다.');
          }
        }
        if(closed(previous)){
          const archive=eventArchives.doc(previous.eventId);
          if(!(await tx.get(archive)).exists)archiveEvent(tx,archive,previous,ps,now());
        }
        if(!base.exists)initializeCatalog(tx,ps);
        const byId=new Map(sellingItems.map(p=>[p.id,p]));
        const catalogueIds=new Set(ps.docs.map(p=>p.id));
        if(new Set([...catalogueIds,...byId.keys()]).size>70)bad('상품 수가 많습니다.');
        for(const product of ps.docs){
          if(!byId.has(product.id))tx.update(product.ref,{visible:false,soldQty:0});
        }
        for(const [productId,item] of byId){
          const {included,id:ignored,...fields}=item;
          tx.set(products.doc(productId),{...fields,bazaarEventId:id,visible:included&&!item.archivedAt,soldQty:0});
        }
        tx.set(eventRef,{...e,status:'published',publishedAt:now(),endedAt:null,finalizedAt:null,
          scopedProducts:true,productRevision:0,reconciliationStartedAt:null,reconciledAt:null,finalizeNotBefore:e.transferCutoff});
        tx.delete(snap.ref);
        return{ok:true,eventId:id};
      });
    }
    if(op==='seed'){
      const ps=await products.limit(1).get();
      if(!ps.empty)throw new HttpsError('already-exists','상품이 이미 존재합니다. 초기화를 반복할 수 없습니다.');
      const batch=db.batch();
      catalogue.forEach(p=>{const {id,...rest}=p;batch.set(products.doc(id),rest);});
      if(!(await eventRef.get()).exists)batch.set(eventRef,initialEvent);
      await batch.commit();return{ok:true,count:catalogue.length};
    }
    if(op==='addProduct'){
      const id=s(data.id);
      if(!/^custom-[a-f0-9]{32}$/.test(id))bad('새 상품 ID를 확인해 주세요.');
      requireCurrentEvent((await eventRef.get()).data()||initialEvent);
      const checked=validateProduct({...data.product,imageUrl:data.product?.photoPath?'':data.product?.imageUrl},{soldQty:0});
      const photo=await eventPhoto(s(data.eventId),id,data.product);
      await db.runTransaction(async tx=>{
        requireCurrentEvent((await tx.get(eventRef)).data()||initialEvent);
        const snapshot=await tx.get(products);
        if(snapshot.size>=70)bad('상품 수가 많습니다.');
        tx.create(products.doc(id),{...checked,...photo,bazaarEventId:data.eventId,displayOrder:snapshot.size+1,soldQty:0,archivedAt:null,createdAt:now()});
        tx.update(eventRef,{productRevision:FieldValue.increment(1)});
      });
      return{ok:true,id};
    }
    if(op==='setProductSales'){
      const id=s(data.id);
      if(!productIdValid(id)||typeof data.visible!=='boolean'||!Number.isSafeInteger(data.revision))bad('상품과 판매 상태를 확인해 주세요.');
      const ref=products.doc(id);
      return db.runTransaction(async tx=>{
        const [active,doc]=await Promise.all([tx.get(eventRef),tx.get(ref)]);
        const event=active.data(),product=doc.data();
        requireCurrentEvent(event);
        if(!product||event.scopedProducts&&product.bazaarEventId!==data.eventId)throw new HttpsError('not-found','상품을 찾을 수 없습니다.');
        if((event.productRevision??0)!==data.revision)throw new HttpsError('failed-precondition','상품이 변경됐습니다. 다시 불러와 주세요.');
        if(data.visible)validateProduct({...product,visible:true,imageUrl:product.photoPath?'':product.imageUrl},product);
        tx.update(ref,{visible:data.visible,archivedAt:null});
        tx.update(eventRef,{productRevision:FieldValue.increment(1)});
        return {ok:true};
      });
    }
    if(op==='archiveProduct'){
      const id=s(data.id);if(!/^[a-z0-9-]{2,50}$/.test(id))bad('상품 ID를 확인해 주세요.');
      const ref=products.doc(id);
      await db.runTransaction(async tx=>{
        requireCurrentEvent((await tx.get(eventRef)).data()||initialEvent);
        const doc=await tx.get(ref);
        if(!doc.exists)throw new HttpsError('not-found','상품을 찾을 수 없습니다.');
        tx.update(ref,{archivedAt:data.archive===true?now():null,visible:false});
        tx.update(eventRef,{productRevision:FieldValue.increment(1)});
      });
      return{ok:true};
    }
    if(op==='newEvent')throw new HttpsError('failed-precondition','새 바자회 만들기 → 임시저장 → 발행 기능을 이용해 주세요.');
    if(op==='saveProduct'){
      const id=s(data.id);if(!/^[a-z0-9-]{2,50}$/.test(id))bad('상품 ID를 확인해 주세요.');
      requireCurrentEvent((await eventRef.get()).data()||initialEvent);
      const photo=await eventPhoto(s(data.eventId),id,data.product);
      await db.runTransaction(async tx=>{
        requireCurrentEvent((await tx.get(eventRef)).data()||initialEvent);
        const ref=products.doc(id),d=await tx.get(ref);
        if(!d.exists)throw new HttpsError('not-found','상품을 찾을 수 없습니다.');
        tx.update(ref,{...validateProduct({...data.product,imageUrl:data.product?.photoPath?'':data.product?.imageUrl},d.data()),...photo,bazaarEventId:data.eventId});
        tx.update(eventRef,{productRevision:FieldValue.increment(1)});
      });return{ok:true};
    }
    if(op==='reorder'){
      const ids=data.ids;
      if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length)bad('상품 순서를 확인해 주세요.');
      await db.runTransaction(async tx=>{
        requireCurrentEvent((await tx.get(eventRef)).data()||initialEvent);
        const ps=await tx.get(products);
        if(ids.length!==ps.size||ps.docs.some(d=>!ids.includes(d.id)))bad('상품 목록이 변경되었습니다. 다시 불러와 주세요.');
        ids.forEach((id,i)=>tx.update(products.doc(id),{displayOrder:i+1}));
        tx.update(eventRef,{productRevision:FieldValue.increment(1)});
      });
      return{ok:true};
    }
    if(op==='saveEvent'){
      const patch={...eventSchedule(data),introKo:s(data.introKo).slice(0,1000),introFr:s(data.introFr).slice(0,1000),pickupKo:s(data.pickupKo).slice(0,500),pickupFr:s(data.pickupFr).slice(0,500),iban:s(data.iban).replaceAll(' ','').toUpperCase(),beneficiary:s(data.beneficiary).slice(0,200),orderCutoff:s(data.orderCutoff),transferCutoff:s(data.transferCutoff)};
      if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(patch.orderCutoff)||!Number.isFinite(Date.parse(patch.orderCutoff))||!Number.isFinite(Date.parse(patch.transferCutoff))||Date.parse(patch.orderCutoff)>=Date.parse(patch.transferCutoff))bad('마감 날짜를 확인해 주세요.');
      if(patch.iban&&!/^FR\d{2}[A-Z0-9]{23}$/.test(patch.iban))bad('IBAN을 확인해 주세요.');
      await db.runTransaction(async tx=>{
        const old=(await tx.get(eventRef)).data()||initialEvent;
        if(closed(old)||old.eventId!==data.eventId)throw new HttpsError('failed-precondition','현재 행사를 다시 불러와 주세요.');
        if(locked(old))throw new HttpsError('failed-precondition','최종 입금 대조가 시작되어 행사 설정을 변경할 수 없습니다.');
        await requireOpenAccounting(tx,old.eventId);
        tx.set(eventRef,{...old,...patch,finalizeNotBefore:patch.transferCutoff,nameKo:s(data.nameKo||old.nameKo).slice(0,120),nameFr:s(data.nameFr||old.nameFr).slice(0,120)});
      });
      return{ok:true};
    }
    if(op==='bankConfirm'){
      const orderId=s(data.id);
      if(!/^[A-Za-z0-9]{15,40}$/.test(orderId))bad('주문 번호를 확인해 주세요.');
      const ref=orders.doc(orderId);
      const key=s(data.requestId),amount=data.amountCents;
      const details=depositDetails(data);
      if(!details||!/^[a-f0-9]{32}$/.test(key)||!cents(amount)||amount===0)
        bad('실제 입금액과 입금 정보를 확인해 주세요.');
      const ledger=ref.collection('payments').doc(key);
      const result=await db.runTransaction(async tx=>{
        const [snap,active,prior]=await Promise.all([tx.get(ref),tx.get(eventRef),tx.get(ledger)]);
        if(data.eventId&&snap.data()?.eventId!==data.eventId)
          throw new HttpsError('failed-precondition','선택한 행사와 주문을 다시 확인해 주세요.');
        if(!snap.exists)throw new HttpsError('not-found','주문을 찾을 수 없습니다.');
        const o=snap.data();
        if(prior.exists){
          const record=prior.data();
          if(record.type!=='deposit'||record.initial!==true||record.amountCents!==data.amountCents||
            Object.entries(details).some(([field,value])=>(record[field]||'')!==value))
            throw new HttpsError('already-exists','같은 요청 번호로 다른 거래를 기록할 수 없습니다.');
          return {changed:false,payment:orderPaymentSummary(o)};
        }
        const reviewRef=db.doc(`bazaarLatePayments/${orderId}`);
        if(data.applyReview===true){
          const review=(await tx.get(reviewRef)).data();
          if(review?.eventId!==o.eventId||review.orderId!==orderId||
            review.amountCents!==amount||Object.entries(details).some(([field,value])=>(review[field]||'')!==value))
            throw new HttpsError('failed-precondition','등록된 늦은 입금 검토 내역을 확인해 주세요.');
          if(review.status==='posted')return {changed:false,payment:orderPaymentSummary(o)};
          if(review.status!=='pending'||o.bankConfirmedAt)
            throw new HttpsError('failed-precondition','이미 처리되었거나 검토할 수 없는 입금입니다.');
          await requireOpenAccounting(tx,o.eventId);
          const at=now(),patch={bankConfirmedAt:at,originalTotalCents:o.originalTotalCents??o.totalCents,depositedCents:amount,refundedCents:0};
          tx.create(ledger,{...details,id:key,initial:true,type:'deposit',amountCents:amount,by:req.auth.uid,at,lateReview:true});
          tx.update(ref,patch);
          tx.update(reviewRef,{status:'posted',postedAt:at,postedBy:req.auth.uid,paymentId:key});
          return {changed:true,payment:orderPaymentSummary({...o,...patch})};
        }
        if(o.bankConfirmedAt)throw new HttpsError('failed-precondition','이미 최초 입금이 있습니다. 추가 입금으로 기록해 주세요.');
        if(active.data()?.eventId!==o.eventId||locked(active.data())){
          const review=(await tx.get(reviewRef)).data();
          if(review&&(review.amountCents!==amount||Object.entries(details).some(([field,value])=>(review[field]||'')!==value)))
            throw new HttpsError('already-exists','이 주문에 다른 내용의 늦은 입금 검토가 이미 있습니다.');
          if(!review)tx.create(reviewRef,{orderId,eventId:o.eventId,status:'pending',reportedAt:now(),reportedBy:req.auth.uid,amountCents:amount,...details});
          return { changed:false, needsReview:true };
        }
        assertOrderEvent(active.data(),o.eventId);
        if(o.canceledAt)throw new HttpsError('failed-precondition','취소된 주문은 확인할 수 없습니다.');
        await requireOpenAccounting(tx,o.eventId);
        const at=now();
        const patch={bankConfirmedAt:at,originalTotalCents:o.originalTotalCents??o.totalCents,depositedCents:amount,refundedCents:0};
        tx.create(ledger,{...details,id:key,initial:true,type:'deposit',amountCents:amount,by:req.auth.uid,at});
        tx.update(ref,patch);
        const payment=orderPaymentSummary({...o,...patch});
        const mailId=o.email?await queue(tx,o.id,payment.additionalDue?'additionalPayment':'confirmed',{eventId:o.eventId,
          ...(payment.additionalDue?{jobKey:'additionalPayment-'+key,change:{items:o.items,totalCents:o.totalCents,amountCents:payment.additionalDue}}:{})}):null;
        return {changed:true,mailId,payment};
      });
      if(result.mailId)await deliver(result.mailId).catch(error=>console.error('Bazaar payment mail delivery failed',error));
      return {ok:true,changed:result.changed,needsReview:result.needsReview===true,payment:result.payment??null};
    }
    if(op==='finalizeUnpaid'){
      if(data.confirm!==true)bad('최종 계좌 대조 후 확인해야 합니다.');
      const e=await db.runTransaction(async tx=>{
        const current=(await tx.get(eventRef)).data();
        if(!current||current.eventId!==data.eventId||!Number.isFinite(Date.parse(current.orderCutoff))||!Number.isFinite(Date.parse(current.transferCutoff))||Date.now()<Date.parse(current.orderCutoff)||Date.now()<Date.parse(current.transferCutoff)){
          bad('최종 은행 대조가 가능한 현재 행사인지 확인해 주세요.');
        }
        if (batchFinalization && current.reconciliationStartedAt) return current;
        const at=current.finalizedAt||now();
        const archive=eventArchives.doc(current.eventId);
        const [stored,ps]=await Promise.all([tx.get(archive),tx.get(products)]);
        if(!stored.exists)archiveEvent(tx,archive,{...current,finalizedAt:at},ps,at);
        tx.update(eventRef,{status:'closed',finalizedAt:at,reconciliationStartedAt:at});
        return current;
      });
      if (batchFinalization) {
        return db.runTransaction(async tx => {
          const active = (await tx.get(eventRef)).data();
          if (active?.eventId !== e.eventId) bad('현재 행사가 변경되었습니다.');
          if (active.reconciledAt) return { ok: true, canceled: 0, pending: false };
          let page = orders.where('eventId', '==', e.eventId).orderBy('__name__').limit(6);
          if (active.reconciliationCursor) page = page.startAfter(orders.doc(active.reconciliationCursor));
          const rows = (await tx.get(page)).docs;
          const unpaid = rows.slice(0, 5).filter(row => !row.data().canceledAt && !row.data().bankConfirmedAt);
          const restore = new Map();
          for (const row of unpaid) {
            for (const item of row.data().items) restore.set(item.id, (restore.get(item.id) ?? 0) + item.qty);
          }
          const stock = await Promise.all([...restore.keys()].map(id => tx.get(products.doc(id))));
          const policy=(await tx.get(db.doc(`bazaarMailPolicies/${e.eventId}`))).data();
          for (const item of stock) {
            if (item.exists) tx.update(item.ref, { soldQty: FieldValue.increment(-restore.get(item.id)) });
          }
          const at = now();
          for (const row of unpaid) {
            tx.update(row.ref, { canceledAt: at, cancelReason: 'unpaidFinalization' });
            if (row.data().email && policy?.bulkCancel==='auto') await queue(tx, row.id, 'bulkCancel',{eventId:e.eventId});
          }
          const pending = rows.length > 5;
          tx.update(eventRef, pending ? { reconciliationCursor: rows[4].id }
            : { reconciliationCursor: null, reconciledAt: at });
          return { ok: true, canceled: unpaid.length, pending };
        });
      }
      const oldOrders=await orders.where('eventId','==',e.eventId).get();
      const pending=oldOrders.docs.filter(d=>!d.data().bankConfirmedAt);let canceled=0;
      for(const snap of pending){
        await db.runTransaction(async tx=>{
          const ref=orders.doc(snap.id),current=await tx.get(ref),o=current.data();
          if(!o||o.canceledAt||o.bankConfirmedAt)return;
          const refs=o.items.map(i=>products.doc(i.id));const stock=await Promise.all(refs.map(r=>tx.get(r)));
          stock.forEach((p,i)=>{if(p.exists)tx.update(p.ref,{soldQty:FieldValue.increment(-o.items[i].qty)});});
          tx.update(ref,{canceledAt:now(),cancelReason:'unpaidFinalization'});
          // The legacy adapter leaves bulk cancellation announcements for manual delivery.
          canceled++;
        });
      }
      await db.runTransaction(async tx=>{
        const current=(await tx.get(eventRef)).data();
        if(current?.eventId===e.eventId)tx.update(eventRef,{reconciledAt:now()});
      });
      return{ok:true,canceled};
    }
    bad('알 수 없는 관리자 요청입니다.');
  }
  return { bazaarPublic, bazaarCreateOrder, bazaarBuyerAction, bazaarAdmin, message, queue };
}
