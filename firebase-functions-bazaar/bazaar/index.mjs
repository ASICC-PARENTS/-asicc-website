import {onCall, HttpsError} from 'firebase-functions/v2/https';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {defineSecret} from 'firebase-functions/params';
import {initializeApp, getApps} from 'firebase-admin/app';
import {getFirestore, FieldValue} from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';
import {randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import {eventPhoto,storePhoto} from './photos.mjs';
import {catalogue, initialEvent} from './products.mjs';

if (!getApps().length) initializeApp();
const db=getFirestore();
const smtpPassword=defineSecret('BAZAAR_SMTP_PASSWORD');
const eventRef=db.doc('bazaarMeta/event');
const products=db.collection('bazaarProducts');
const orders=db.collection('bazaarOrders');
const outbox=db.collection('bazaarOutbox');
const eventArchives=db.collection('bazaarEvents');
const eventDrafts=db.collection('bazaarDrafts');
const allowed=['https://asicc-parents.fr','https://www.asicc-parents.fr','http://localhost:4321','http://127.0.0.1:4321'];
const options={cors:allowed,region:'europe-west1',maxInstances:15};
const s=x=>typeof x==='string'?x.trim():'';
const bad=(message)=>{throw new HttpsError('invalid-argument',message)};
const cents=n=>Number.isSafeInteger(n)&&n>=0&&n<=1_000_000_00;
const euro=c=>(c/100).toFixed(2)+' €';
const now=()=>new Date().toISOString();
const localDate=d=>new Intl.DateTimeFormat('fr-FR',{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short'}).format(new Date(d));
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
const safeOrder=x=>{const {buyerToken,requestFingerprint,...rest}=x;return rest};
const pickPublic=p=>({id:p.id,titleKo:p.titleKo,titleFr:p.titleFr,descriptionKo:p.descriptionKo||'',descriptionFr:p.descriptionFr||'',priceCents:p.retailCents,storage:p.storage||'ambient',imageUrl:p.imageUrl||'',displayOrder:p.displayOrder,stockCap:stockCap(p),stockRemaining:stockCap(p)==null?null:Math.max(0,stockCap(p)-(p.soldQty||0))});
async function requireAdmin(req){
  if(!req.auth?.uid) throw new HttpsError('unauthenticated','관리자 로그인이 필요합니다.');
  const profile=(await db.collection('members').doc(req.auth.uid).get()).data();
  if(req.auth.token?.email_verified!==true||profile?.status!=='approved'||profile.role!=='admin') throw new HttpsError('permission-denied','바자회 관리자 권한이 없습니다.');
}
function checkBuyerOrder(x){
  if(!x||typeof x!=='object')bad('주문 정보를 확인해 주세요.');
  const name=s(x.name),email=s(x.email).toLowerCase(),phone=s(x.phone);
  if(name.length<2||name.length>100)bad('성함을 확인해 주세요.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>200)bad('이메일을 확인해 주세요.');
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
  const id=`${orderId}_${type}`;
  tx.set(outbox.doc(id),{orderId,type,createdAt:now(),sentAt:null,attempts:0,...extra},{merge:true});
  return id;
}
function links(order){
  const base=`https://asicc-parents.fr/${order.lang==='fr'?'fr':'ko'}/bazaar/commande/`;
  return `${base}?id=${encodeURIComponent(order.id)}&token=${encodeURIComponent(order.buyerToken)}`;
}
export function message(order,type,event){
  const items=order.items.map(i=>`• ${i.titleKo} × ${i.qty} = ${euro(i.qty*i.priceCents)}`).join('\n');
  const bank=`수취인: ${event.beneficiary}\nIBAN: ${event.iban}\n송금 금액: ${euro(order.totalCents)}\n송금 메모: ${order.orderRef}`;
  const intro={receipt:'주문이 접수되었습니다. 아직 입금 확인 또는 주문 확정 상태는 아닙니다.',reported:'송금 완료 알림이 접수되었습니다. 실제 입금 확인 및 주문 확정은 별도로 진행됩니다.',confirmed:'입금이 확인되어 주문이 확정되었습니다. 감사합니다!',cancel:'주문이 취소되었습니다.',bulkCancel:'최종 입금 확인 시점까지 입금이 확인되지 않아 주문이 취소되었습니다. 이미 송금하셨다면 주문번호와 송금일을 contact@asicc-parents.fr 로 알려주세요.',reminder3:'아직 송금 완료 표시가 접수되지 않았습니다. 송금을 마치셨다면 아래 주문 관리 링크에서 알려주세요.',reminderFinal:'송금 마감 안내입니다. 아직 송금 완료 표시가 접수되지 않았습니다.'}[type]||'주문 안내';
  const subject={receipt:'[ASICC] 바자회 주문 접수',reported:'[ASICC] 송금 완료 알림 접수',confirmed:'[ASICC] 바자회 주문 확정',cancel:'[ASICC] 바자회 주문 취소',bulkCancel:'[ASICC] 바자회 주문 취소 안내',reminder3:'[ASICC] 바자회 송금 안내',reminderFinal:'[ASICC] 바자회 송금 마감 안내'}[type]||'[ASICC] 바자회 안내';
  const noteLabel=order.lang==='fr'?'Informations complémentaires pour le retrait':'판매자에게 전달할 사항';
  const note=type==='receipt'&&order.pickupNote?`\n\n${noteLabel}\n${order.pickupNote}`: '';
  const text=`${intro}\n\n주문번호: ${order.orderRef}\n주문자: ${order.name}${note}\n\n${items}\n\n주문 총액: ${euro(order.totalCents)}\n\n${['receipt','reported','reminder3','reminderFinal'].includes(type)?bank+'\n\n송금 마감: '+localDate(event.transferCutoff):''}\n\n픽업: ${event.pickupKo}\n\n주문 확인 / 송금 완료 알림 / 취소: ${links(order)}\n\n문의: ${event.contactEmail}`;
  return{subject,text,html:`<div style="font:15px/1.7 Arial,sans-serif;max-width:650px"><h2>${esc(subject)}</h2><p>${esc(intro)}</p><pre style="white-space:pre-wrap;font:inherit">${esc(text.replace(intro,'').trim())}</pre><p><a href="${esc(links(order))}" style="color:#932b35">주문 관리 페이지 / Consulter la commande</a></p></div>`};
}
async function deliver(mailId){
  if(!process.env.BAZAAR_SMTP_HOST||!process.env.BAZAAR_SMTP_USER||!smtpPassword.value()) return false;
  const ref=outbox.doc(mailId), lease=now();
  const ready=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);if(!snap.exists)return null;
    const v=snap.data();
    if(v.sentAt||(v.sendingUntil&&v.sendingUntil>lease))return null;
    tx.update(ref,{sendingUntil:new Date(Date.now()+90000).toISOString(),attempts:FieldValue.increment(1)});
    return v;
  });
  if(!ready)return false;
  try{
    const [orderSnap,evSnap]=await Promise.all([orders.doc(ready.orderId).get(),eventRef.get()]);
    if(!orderSnap.exists)throw new Error('Order missing');
    const transporter=nodemailer.createTransport({
      host:process.env.BAZAAR_SMTP_HOST,
      port:Number(process.env.BAZAAR_SMTP_PORT||465),
      secure:Number(process.env.BAZAAR_SMTP_PORT||465)===465,
      auth:{user:process.env.BAZAAR_SMTP_USER,pass:smtpPassword.value()}
    });
    const msg=message(orderSnap.data(),ready.type,orderSnap.data().eventSnapshot||evSnap.data());
    await transporter.sendMail({from:`ASICC <${process.env.BAZAAR_SMTP_USER}>`,to:orderSnap.data().email,...msg});
    await ref.update({sentAt:now(),sendingUntil:null,lastError:null});
    return true;
  }catch(err){await ref.update({sendingUntil:null,lastError:String(err?.message||err).slice(0,300)});return false;}
}
export const bazaarPublic=onCall(options,async req=>{
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
    const safe={eventId,status:e.status||'draft',nameKo:e.nameKo,nameFr:e.nameFr,introKo:e.introKo,introFr:e.introFr,orderCutoff:e.orderCutoff,transferCutoff:e.transferCutoff,pickupKo:e.pickupKo,pickupFr:e.pickupFr,beneficiary:e.beneficiary,iban:e.iban,contactEmail:e.contactEmail,finalizedAt:null};
    const ps=e.status==='published' ? snapshotProducts(await tx.get(products)) : [];
    return{serverNow:now(),event:safe,products:ps.filter(p=>!p.archivedAt&&p.visible&&cents(p.retailCents)).map(pickPublic).sort((a,b)=>a.displayOrder-b.displayOrder)};
  },{readOnly:true});
});
export const bazaarCreateOrder=onCall({...options,secrets:[smtpPassword]},async req=>{
  const buyer=checkBuyerOrder(req.data);
  const requested=s(req.data?.eventId);
  if(!validEventId(requested)||req.data?.consent!==true)bad('행사 주소와 개인정보 동의를 확인해 주세요.');
  const requestId=s(req.data?.requestId);
  if(!/^[a-f0-9]{32}$/.test(requestId))bad('주문 요청 번호를 확인해 주세요.');
  const ref=orders.doc(requestId),token=randomBytes(32).toString('hex');
  const fingerprint=createHash('sha256').update(JSON.stringify({requested,buyer})).digest('hex');
  const ip=s(req.rawRequest?.ip||req.rawRequest?.socket?.remoteAddress||'unknown');
  const ipHash=createHash('sha256').update(ip).digest('hex');
  const throttleRef=db.doc(`bazaarRateLimits/${ipHash}`);
  const order=await db.runTransaction(async tx=>{
    const [eventSnap,rateSnap,existing]=await Promise.all([tx.get(eventRef),tx.get(throttleRef),tx.get(ref)]);
    if(existing.exists){
      const o=existing.data();
      if(o.requestFingerprint!==fingerprint)throw new HttpsError('already-exists','같은 요청 번호에 다른 주문이 있습니다.');
      return{id:o.id,orderRef:o.orderRef,totalCents:o.totalCents,token:o.buyerToken,
        iban:o.eventSnapshot.iban,beneficiary:o.eventSnapshot.beneficiary,pickupKo:o.eventSnapshot.pickupKo};
    }
    const e=eventSnap.data();
    const rate=rateSnap.data()||{};
    const windowStart=Date.now()-10*60*1000;
    if((rate.startedMs||0)>windowStart&&(rate.count||0)>=8)throw new HttpsError('resource-exhausted','짧은 시간에 주문 요청이 많습니다. 협회에 문의해 주세요.');
    if(!e)throw new HttpsError('failed-precondition','바자회 준비 중입니다.');
    if(e.status!=='published'||e.finalizedAt||e.eventId!==requested||!(Date.now()<Date.parse(e.orderCutoff)))throw new HttpsError('failed-precondition','주문 접수가 마감되었습니다.');
    if(!/^FR\d{2}[A-Z0-9 ]{20,}$/.test(s(e.iban).replaceAll(' ','')))throw new HttpsError('failed-precondition','송금계좌 등록 후 주문할 수 있습니다.');
    const refs=buyer.items.map(i=>products.doc(i.id));
    const snapshots=await Promise.all(refs.map(r=>tx.get(r)));
    const itemDetails=[];let total=0;
    for(let i=0;i<buyer.items.length;i++){
      const data=snapshots[i].data(),{qty,id}=buyer.items[i];
      if(!data?.visible||data.archivedAt||!cents(data.retailCents))throw new HttpsError('failed-precondition',`품목 ${id}의 판매가 중단되었습니다.`);
      if(data.retailCents!==buyer.items[i].priceCents)throw new HttpsError('failed-precondition','상품 가격이 변경되었습니다. 다시 확인해 주세요.');
      const limit=stockCap(data);
      if(limit!=null&&(data.soldQty||0)+qty>limit)throw new HttpsError('failed-precondition',`${data.titleKo}의 재고가 부족합니다.`);
      total+=data.retailCents*qty;
      itemDetails.push({id,qty,priceCents:data.retailCents,titleKo:data.titleKo,titleFr:data.titleFr,supplier:data.supplier,descriptionKo:data.descriptionKo||'',descriptionFr:data.descriptionFr||'',imageUrl:data.imageUrl||'',storage:data.storage,packQty:data.packQty,boxPriceTtcCents:data.boxPriceTtcCents,boxPriceHtCents:data.boxPriceHtCents,plannedBoxes:data.plannedBoxes});
    }
    if(!cents(total)||total===0)bad('금액을 확인해 주세요.');
    const orderRef=`ASICC-${new Date().getUTCFullYear().toString().slice(-2)}-${ref.id.slice(0,10).toUpperCase()}`;
    const createdAt=now();
    const data={id:ref.id,eventId:e.eventId||initialEvent.eventId,eventSnapshot:{...e},orderRef,...buyer,consent:true,requestFingerprint:fingerprint,items:itemDetails,totalCents:total,createdAt,buyerToken:token,transferReportedAt:null,bankConfirmedAt:null,canceledAt:null,reminder3At:null,reminderFinalAt:null};
    snapshots.forEach((snapshot,i)=>tx.update(snapshot.ref,{soldQty:FieldValue.increment(buyer.items[i].qty)}));
    tx.create(ref,data);
    tx.set(throttleRef,{startedMs:(rate.startedMs||0)>windowStart?rate.startedMs:Date.now(),count:(rate.startedMs||0)>windowStart?(rate.count||0)+1:1,expiresAt:new Date(Date.now()+24*3600000).toISOString()});
    await queue(tx,ref.id,'receipt');
    return{id:ref.id,orderRef,totalCents:total,token,iban:e.iban,beneficiary:e.beneficiary,pickupKo:e.pickupKo};
  });
  await deliver(`${order.id}_receipt`).catch(error=>console.error('Bazaar receipt delivery failed',error));
  return order;
});
export const bazaarBuyerAction=onCall({...options,secrets:[smtpPassword]},async req=>{
  const {id,token,action,ackNoTransfer}=req.data||{};
  if(!/^[a-zA-Z0-9]{15,40}$/.test(s(id))||!/^[a-f0-9]{64}$/.test(s(token)))bad('주문 확인 링크가 올바르지 않습니다.');
  if(!['view','report','cancel'].includes(action))bad('요청을 확인해 주세요.');
  let mailId=null;
  const result=await db.runTransaction(async tx=>{
    const ref=orders.doc(id), snap=await tx.get(ref);
    if(!snap.exists)throw new HttpsError('not-found','주문을 찾을 수 없습니다.');
    const o=snap.data();
    const a=Buffer.from(token,'hex'),b=Buffer.from(o.buyerToken||'','hex');
    if(a.length!==b.length||!timingSafeEqual(a,b))throw new HttpsError('permission-denied','주문 확인 권한이 없습니다.');
    if(action==='view')return{order:safeOrder(o),changed:false};
    const currentEvent=(await tx.get(eventRef)).data();
    if(o.eventId!==(currentEvent?.eventId||initialEvent.eventId))throw new HttpsError('failed-precondition','이전 바자회 주문은 온라인으로 변경할 수 없습니다. 협회에 문의해 주세요.');
    if(o.canceledAt)throw new HttpsError('failed-precondition','이미 취소된 주문입니다.');
    if(action==='report'){
      if(!o.transferReportedAt){tx.update(ref,{transferReportedAt:now()});mailId=await queue(tx,id,'reported');}
      return{order:safeOrder({...o,transferReportedAt:o.transferReportedAt||now()}),changed:!!mailId};
    }
    if(!ackNoTransfer)bad('송금하지 않았음을 확인해야 합니다.');
    if(o.transferReportedAt||o.bankConfirmedAt)throw new HttpsError('failed-precondition','송금 신고 또는 입금 확인된 주문은 온라인으로 취소할 수 없습니다. 협회에 문의해 주세요.');
    const refs=o.items.map(i=>products.doc(i.id));
    const snaps=await Promise.all(refs.map(r=>tx.get(r)));
    snaps.forEach((snap,i)=>{if(snap.exists)tx.update(snap.ref,{soldQty:FieldValue.increment(-o.items[i].qty)});});
    tx.update(ref,{canceledAt:now(),cancelReason:'buyer'});
    mailId=await queue(tx,id,'cancel');
    return{order:safeOrder({...o,canceledAt:now()}),changed:true};
  });
  if(mailId)await deliver(mailId);
  return result;
});
function validateProduct(p,existing){
  if(!p||typeof p!=='object')bad('상품을 확인해 주세요.');
  const out={titleKo:s(p.titleKo).slice(0,120),titleFr:s(p.titleFr).slice(0,120),descriptionKo:s(p.descriptionKo).slice(0,3000),descriptionFr:s(p.descriptionFr).slice(0,3000),supplier:s(p.supplier),storage:s(p.storage)||'ambient',imageUrl:s(p.imageUrl),visible:p.visible===true,retailCents:p.retailCents===null?null:Number(p.retailCents),packQty:Number(p.packQty),plannedBoxes:p.plannedBoxes==null?null:Number(p.plannedBoxes),boxPriceTtcCents:Number(p.boxPriceTtcCents),boxPriceHtCents:p.boxPriceHtCents==null?null:Number(p.boxPriceHtCents),limitMode:p.limitMode,manualLimit:p.manualLimit==null?null:Number(p.manualLimit)};
  if(!out.titleKo||!out.titleFr||!['K커머셜','누리커넥트'].includes(out.supplier))bad('상품명 또는 공급업체가 올바르지 않습니다.');
  if(!validUrl(out.imageUrl)||!['ambient','chilled','frozen'].includes(out.storage))bad('상품 이미지 또는 보관 방법을 확인해 주세요.');
  if(out.retailCents!=null&&!cents(out.retailCents))bad('판매가격을 확인해 주세요.');
  if(!Number.isSafeInteger(out.packQty)||out.packQty<1||out.packQty>10000||!cents(out.boxPriceTtcCents)||out.boxPriceHtCents!=null&&!cents(out.boxPriceHtCents))bad('매입가격 또는 박스당 입수량을 확인해 주세요.');
  if(out.plannedBoxes!=null&&(!Number.isSafeInteger(out.plannedBoxes)||out.plannedBoxes<0||out.plannedBoxes>10000))bad('발주 박스 수를 확인해 주세요.');
  if(!['manual','box','unlimited'].includes(out.limitMode)||out.manualLimit!=null&&(!Number.isSafeInteger(out.manualLimit)||out.manualLimit<0))bad('한정 수량을 확인해 주세요.');
  if(out.limitMode==='box'&&out.plannedBoxes==null)bad('박스 연동을 사용하려면 발주 예정 박스 수가 필요합니다.');
  const limit=stockCap(out);
  if(limit!=null&&limit<(existing.soldQty||0))bad(`이미 접수된 ${existing.soldQty}개보다 판매 한도를 낮출 수 없습니다.`);
  if(out.supplier==='K커머셜'&&out.boxPriceHtCents!=null){
    out.boxPriceTtcCents=Math.round(out.boxPriceHtCents*1.055);
  }
  if(out.visible&&out.retailCents==null)bad('판매가격 미정 상품은 공개할 수 없습니다.');
  return out;
}
export const bazaarAdmin=onCall({...options,secrets:[smtpPassword]},async req=>{
  await requireAdmin(req);
  const {op,...data}=req.data||{};
  const requireCurrentEvent=active=>{
    if(!validEventId(s(data.eventId))||active?.eventId!==data.eventId||closed(active)){
      throw new HttpsError('failed-precondition','현재 행사가 변경되어 저장하지 못했습니다. 행사 목록에서 다시 확인해 주세요.');
    }
  };
  if(op==='storePhoto'){
    const eventId=s(data.eventId),id=s(data.id);
    if(!validEventId(eventId)||!productIdValid(id))bad('행사와 상품을 확인해 주세요.');
    if(data.draft===true){
      const draft=(await eventDrafts.doc(eventId).get()).data();
      if(!draft||draft.updatedAt!==data.updatedAt)throw new HttpsError('failed-precondition','초안이 변경되었습니다. 다시 불러와 주세요.');
    }else{
      requireCurrentEvent((await eventRef.get()).data()||initialEvent);
    }
    try{return await storePhoto(eventId,id,data);}
    catch(error){
      if(error instanceof HttpsError)throw error;
      console.error('Bazaar photo storage failed',error.code);
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
      productData??=snapshotProducts(await tx.get(products));
      const o=await tx.get(orders.where('eventId','==',ev.eventId||initialEvent.eventId));
      return{event:ev,isCurrent,readOnly:!isCurrent||closed(ev),products:productData.sort((a,b)=>a.displayOrder-b.displayOrder),orders:o.docs.map(d=>safeOrder(d.data())).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
    },{readOnly:true});
  }
  if(op==='listEvents'){
    const [cur,old,drafts]=await Promise.all([eventRef.get(),eventArchives.get(),eventDrafts.get()]);
    const active=cur.exists?cur.data():null;
    const events=old.docs.map(d=>({id:d.id,nameKo:d.data().event?.nameKo||d.id,serial:d.data().event?.serial||0,status:'closed',createdAt:d.data().event?.createdAt||''}));
    if(active&&!events.some(e=>e.id===active.eventId))events.push({id:active.eventId,nameKo:active.nameKo||'진행 중 바자회',serial:active.serial||1,status:active.finalizedAt?'closed':(active.status||'draft'),createdAt:active.createdAt||''});
    return{events:events.sort((a,b)=>b.serial-a.serial||b.createdAt.localeCompare(a.createdAt)),drafts:drafts.docs.map(d=>({id:d.id,nameKo:d.data().event?.nameKo||'임시저장',serial:d.data().serial||0,updatedAt:d.data().updatedAt||''}))};
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
    const draft={id,serial,status:'draft',createdAt:now(),updatedAt:now(),event:{...prev,eventId:id,serial,nameKo:`${serial}차 ASICC 온라인 바자회`,nameFr:`Vente solidaire ASICC n°${serial}`,orderCutoff:'',transferCutoff:'',pickupKo:'',pickupFr:'',finalizedAt:null,endedAt:null,publishedAt:null,createdAt:now(),status:'draft'},items:ps.docs.map(d=>({...d.data(),id:d.id,included:!d.data().archivedAt&&d.data().visible===true,soldQty:0})).sort((a,b)=>a.displayOrder-b.displayOrder)};
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
    const items=await Promise.all(data.items.map(async (item,i)=>{
      const previous=previousItems.get(ids[i]);
      if(!previous&&!/^custom-[a-f0-9]{32}$/.test(ids[i]))bad('초안의 상품 ID를 확인해 주세요.');
      const included=item.included===true;
      const checked=validateProduct({...item,imageUrl:item.photoPath?'':item.imageUrl,visible:false},{soldQty:0});
      const photo=await eventPhoto(id,ids[i],item);
      return{...checked,...photo,visible:included,id:ids[i],included,displayOrder:i+1,
        soldQty:0,archivedAt:included?null:(previous?.archivedAt||null)};
    }));
    const input=data.event||{};
    const e={...snap.data().event,nameKo:s(input.nameKo).slice(0,120),nameFr:s(input.nameFr).slice(0,120),introKo:s(input.introKo).slice(0,1000),introFr:s(input.introFr).slice(0,1000),pickupKo:s(input.pickupKo).slice(0,500),pickupFr:s(input.pickupFr).slice(0,500),iban:s(input.iban).replaceAll(' ','').toUpperCase(),beneficiary:s(input.beneficiary).slice(0,200),orderCutoff:s(input.orderCutoff),transferCutoff:s(input.transferCutoff)};
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
    if(!process.env.BAZAAR_SMTP_HOST||!process.env.BAZAAR_SMTP_USER||!smtpPassword.value())throw new HttpsError('failed-precondition','주문 접수 이메일 발송 계정이 설정되지 않았습니다. SMTP 설정 후 발행하세요.');
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
      if(draft.items.some(p=>p.included&&(p.retailCents==null||p.archivedAt)))bad('선택한 상품의 판매가격을 모두 확정해 주세요.');
      const [old,ps]=await Promise.all([tx.get(eventRef),tx.get(products)]);
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
      const byId=new Map(draft.items.map(p=>[p.id,p]));
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
        scopedProducts:true,reconciliationStartedAt:null,reconciledAt:null,finalizeNotBefore:new Date(Date.parse(e.orderCutoff)+69*3600000).toISOString()});
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
    });
    return{ok:true,id};
  }
  if(op==='archiveProduct'){
    const id=s(data.id);if(!/^[a-z0-9-]{2,50}$/.test(id))bad('상품 ID를 확인해 주세요.');
    const ref=products.doc(id);
    await db.runTransaction(async tx=>{
      requireCurrentEvent((await tx.get(eventRef)).data()||initialEvent);
      const doc=await tx.get(ref);
      if(!doc.exists)throw new HttpsError('not-found','상품을 찾을 수 없습니다.');
      tx.update(ref,{archivedAt:data.archive===true?now():null,visible:false});
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
    });
    return{ok:true};
  }
  if(op==='saveEvent'){
    const patch={introKo:s(data.introKo).slice(0,1000),introFr:s(data.introFr).slice(0,1000),pickupKo:s(data.pickupKo).slice(0,500),pickupFr:s(data.pickupFr).slice(0,500),iban:s(data.iban).replaceAll(' ','').toUpperCase(),beneficiary:s(data.beneficiary).slice(0,200),orderCutoff:s(data.orderCutoff),transferCutoff:s(data.transferCutoff)};
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(patch.orderCutoff)||!Number.isFinite(Date.parse(patch.orderCutoff))||!Number.isFinite(Date.parse(patch.transferCutoff))||Date.parse(patch.orderCutoff)>=Date.parse(patch.transferCutoff))bad('마감 날짜를 확인해 주세요.');
    if(patch.iban&&!/^FR\d{2}[A-Z0-9]{23}$/.test(patch.iban))bad('IBAN을 확인해 주세요.');
    await db.runTransaction(async tx=>{
      const old=(await tx.get(eventRef)).data()||initialEvent;
      if(closed(old)||old.eventId!==data.eventId)throw new HttpsError('failed-precondition','현재 행사를 다시 불러와 주세요.');
      tx.set(eventRef,{...old,...patch});
    });
    return{ok:true};
  }
  if(op==='bankConfirm'){
    const orderId=s(data.id);
    if(!/^[A-Za-z0-9]{15,40}$/.test(orderId))bad('주문 번호를 확인해 주세요.');
    const ref=orders.doc(orderId);let mailId=null;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);
      if(!snap.exists)throw new HttpsError('not-found','주문을 찾을 수 없습니다.');
      const o=snap.data();if(o.canceledAt)throw new HttpsError('failed-precondition','취소된 주문은 확인할 수 없습니다.');
      if(!o.bankConfirmedAt){tx.update(ref,{bankConfirmedAt:now()});mailId=await queue(tx,o.id,'confirmed');}
    });
    if(mailId)await deliver(mailId);return{ok:true,changed:!!mailId};
  }
  if(op==='finalizeUnpaid'){
    if(data.confirm!==true)bad('최종 계좌 대조 후 확인해야 합니다.');
    const e=await db.runTransaction(async tx=>{
      const current=(await tx.get(eventRef)).data();
      if(!current||current.eventId!==data.eventId||Date.now()<Date.parse(current.orderCutoff)||Date.now()<Date.parse(current.finalizeNotBefore||'2026-11-30T08:00:00.000Z')){
        bad('최종 은행 대조가 가능한 현재 행사인지 확인해 주세요.');
      }
      const at=current.finalizedAt||now();
      const archive=eventArchives.doc(current.eventId);
      const [stored,ps]=await Promise.all([tx.get(archive),tx.get(products)]);
      if(!stored.exists)archiveEvent(tx,archive,{...current,finalizedAt:at},ps,at);
      tx.update(eventRef,{status:'closed',finalizedAt:at,reconciliationStartedAt:at});
      return current;
    });
    const oldOrders=await orders.where('eventId','==',e.eventId).get();
    const pending=oldOrders.docs.filter(d=>!d.data().bankConfirmedAt);let canceled=0;
    for(const snap of pending){
      let mailId=null;
      await db.runTransaction(async tx=>{
        const ref=orders.doc(snap.id),current=await tx.get(ref),o=current.data();
        if(!o||o.canceledAt||o.bankConfirmedAt)return;
        const refs=o.items.map(i=>products.doc(i.id));const stock=await Promise.all(refs.map(r=>tx.get(r)));
        stock.forEach((p,i)=>{if(p.exists)tx.update(p.ref,{soldQty:FieldValue.increment(-o.items[i].qty)});});
        tx.update(ref,{canceledAt:now(),cancelReason:'unpaidFinalization'});
        mailId=await queue(tx,o.id,'bulkCancel');canceled++;
      });
      if(mailId)await deliver(mailId);
    }
    await db.runTransaction(async tx=>{
      const current=(await tx.get(eventRef)).data();
      if(current?.eventId===e.eventId)tx.update(eventRef,{reconciledAt:now()});
    });
    return{ok:true,canceled};
  }
  bad('알 수 없는 관리자 요청입니다.');
});
const parisParts=d=>{
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(p=>[p.type,p.value]));
  return{day:parts.weekday,hour:Number(parts.hour),minute:Number(parts.minute)};
};
export const bazaarReminders=onSchedule({schedule:'every 15 minutes',timeZone:'Europe/Paris',region:'europe-west1',secrets:[smtpPassword],maxInstances:1},async()=>{
  const e=(await eventRef.get()).data();if(!e)return;
  const t=new Date(),{day,hour}=parisParts(t);
  const safeHours=hour>=9&&hour<20;
  const allCurrent=await orders.where('eventId','==',e.eventId||initialEvent.eventId).get();
  const pending=allCurrent.docs.filter(d=>!d.data().bankConfirmedAt);
  for(const snap of pending){
    const o=snap.data();if(o.canceledAt)continue;
    // Retry all queued receipts and other messages regardless of reminder eligibility.
    const mails=await outbox.where('orderId','==',o.id).get();
    for(const m of mails.docs)if(!m.data().sentAt)await deliver(m.id);
    if(o.transferReportedAt||!safeHours)continue;
    const age=t.getTime()-Date.parse(o.createdAt);
    if(age>=3*3600000&&!o.reminder3At&&t.getTime()<Date.parse(e.transferCutoff)){
      let queued=false;
      await db.runTransaction(async tx=>{
        const fresh=await tx.get(snap.ref),v=fresh.data();
        if(v.reminder3At||v.transferReportedAt||v.bankConfirmedAt||v.canceledAt)return;
        tx.update(snap.ref,{reminder3At:now()});await queue(tx,o.id,'reminder3');queued=true;
      });
      if(queued)await deliver(`${o.id}_reminder3`);
    }
    const isFinal=day==='Fri'&&t.getTime()>=Date.parse(e.orderCutoff)&&t.getTime()<Date.parse(e.transferCutoff)&&hour>=15;
    if(isFinal&&!o.reminderFinalAt&&(!o.reminder3At||t.getTime()-Date.parse(o.reminder3At)>=3*3600000)){
      let queued=false;
      await db.runTransaction(async tx=>{
        const fresh=await tx.get(snap.ref),v=fresh.data();
        if(v.reminderFinalAt||v.transferReportedAt||v.bankConfirmedAt||v.canceledAt)return;
        tx.update(snap.ref,{reminderFinalAt:now()});await queue(tx,o.id,'reminderFinal');queued=true;
      });
      if(queued)await deliver(`${o.id}_reminderFinal`);
    }
  }
  // Retry email queue for confirmed/canceled orders too.
  const leftovers=await outbox.where('sentAt','==',null).limit(200).get();
  for(const m of leftovers.docs)await deliver(m.id);
});
