import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createBazaar } from '../../firebase-functions-bazaar/bazaar/service.mjs';
import { createFirestore, FieldValue } from './firestore.mjs';
import { createMail, mailFields } from './mail.mjs';
import { createPhotos } from './photos.mjs';

const loopback = 'http://127.0.0.1:8080';
const site = 'https://test.example.test';
const id = () => randomBytes(16).toString('hex');
const future = offset => new Date(Date.now() + offset).toISOString();
const photo = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7hoAAAAASUVORK5CYII=';

test('customer mail templates use the order language and preserve the private follow-up link', () => {
  const { message } = createBazaar({ db:{ doc() {}, collection() {} }, siteUrl: () => site });
  const order = { id:id(), buyerToken:id()+id(), orderRef:'ASICC-TEST', name:'Test & <buyer>', totalCents:900,
    items:[{ titleKo:'한국어 상품', titleFr:'Article français', qty:2, priceCents:450 }], pickupNote:'<note>' };
  const event = { beneficiary:'Test Association', iban:'TEST', transferCutoff:'2026-07-20T15:45:00Z',
    pickupKo:'한국어 수령 안내', pickupFr:'Instructions de retrait', contactEmail:'help@example.test' };
  for(const [lang,labels] of [
    ['ko',['주문 접수','주문 확정','송금 마감 안내','주문 취소','주문 취소 안내']],
    ['fr',['Commande reçue','Commande confirmée','Rappel avant la date limite de virement','Commande annulée','Commande annulée faute de paiement']]
  ]){
    const fr=lang==='fr';
    const url=`${site}/${lang}/bazaar/commande/?id=${order.id}#token=${order.buyerToken}`;
    for(const [index,type] of ['receipt','confirmed','reminderFinal','cancel','bulkCancel'].entries()){
      const rendered=message({...order,lang},type,event);
      assert.ok(rendered.subject.includes(labels[index]));
      assert.ok(rendered.text.includes(fr?'Article français':'한국어 상품'));
      assert.ok(rendered.text.includes(fr?'Instructions de retrait':'한국어 수령 안내'));
      assert.ok(rendered.text.includes(url));
      assert.ok(rendered.html.includes(`href="${url}"`));
      assert.ok(rendered.html.includes('Test &amp; &lt;buyer&gt;'));
      if(type==='receipt'||type==='reminderFinal'){
        assert.ok(rendered.text.includes(fr?'Date limite du virement (heure de Paris)':'송금 마감 (파리 시간)'));
        assert.match(rendered.text,fr?/17:45/:/오후 5:45/);
      }else assert.doesNotMatch(rendered.text,/IBAN/);
      if(type==='receipt')assert.ok(rendered.html.includes('&lt;note&gt;'));
    }
  }
});

test('publishing, closing and changing the next event preserve historical products, images and orders', { timeout:30000 }, async t => {
  const projectId='demo-asicc-readiness-'+randomBytes(4).toString('hex');
  const db=createFirestore({ projectId, token:()=> 'owner', emulator:loopback });
  t.after(async ()=>{
    const response=await fetch(`${loopback}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{ method:'DELETE' });
    assert.ok(response.ok);
  });
  const objects=new Map();
  const env={ BAZAAR_MODE:'local', MAIL_MODE:'capture', B2_BUCKET:'test-bucket', B2_S3_ENDPOINT:'https://s3.eu-central-003.backblazeb2.com',
    B2_KEY_ID:'fixture', B2_APPLICATION_KEY:'fixture', BAZAAR_PHOTO_SIGNING_KEY:'fixture' };
  const photos=createPhotos(env,db,site,undefined,async (url,init)=>{
    const path=new URL(url).pathname;
    assert.match(path,/^\/test-bucket\/bazaar\/test\/photos\/[a-f0-9]{64}$/);
    if(init.method==='PUT'){objects.set(path,Buffer.from(init.body));return new Response();}
    if(!objects.has(path))return new Response(null,{status:404});
    return new Response(init.method==='HEAD'?null:objects.get(path),{headers:{'Content-Type':'image/png'}});
  });
  const mail=createMail(env,db,()=>assert.fail('capture must not contact an email provider'));
  const service=createBazaar({ db, FieldValue, storePhoto:photos.storePhoto, eventPhoto:photos.eventPhoto, siteUrl:()=>site,
    canSendMail:mail.canSend, sendQueuedMail:mail.deliver, queueFields:mailFields });
  const uid='readiness-admin';
  await db.doc('members/'+uid).set({ role:'admin',status:'approved' });
  const admin=(op,data={})=>service.bazaarAdmin({auth:{uid,token:{email_verified:true}},data:{op,...data}});
  const schedule={orderCutoff:future(3600000),transferCutoff:future(7200000),beneficiary:'ASICC',
    iban:'FR7612345678901234567890123',pickupKo:'한국어 수령',pickupFr:'Retrait en français'};
  const obsolete=(await admin('createDraft')).draft;
  await admin('deleteDraft',{id:obsolete.id,confirm:true});
  await assert.rejects(admin('getDraft',{id:obsolete.id}),{code:'not-found'});
  const first=(await admin('createDraft')).draft;
  assert.deepEqual(first.items,[]);
  const base=(await admin('getCatalog')).items.find(item=>item.id==='k-alt500');
  const original={...base,included:true,limitMode:'manual',plannedBoxes:0,manualLimit:4,
    titleKo:'예전 상품',titleFr:'Ancien article',descriptionKo:'예전 설명',descriptionFr:'Ancienne description',
    retailCents:450,boxPriceTtcCents:600,boxPriceHtCents:569};
  Object.assign(original,await photos.storePhoto(first.id,original.id,{content:photo}));
  const saved=await admin('saveDraft',{id:first.id,updatedAt:first.updatedAt,event:{...first.event,...schedule},items:[original]});
  assert.equal((await admin('getDraft',{id:first.id})).draft.items[0].descriptionFr,'Ancienne description');
  await admin('publishDraft',{id:first.id,updatedAt:saved.updatedAt});
  assert.equal((await service.bazaarPublic({data:{eventId:first.id}})).products[0].stockRemaining,4);

  const extraId='custom-'+id();
  await admin('addProduct',{eventId:first.id,id:extraId,product:{...original,imageUrl:'',photoPath:''}});
  await admin('archiveProduct',{eventId:first.id,id:extraId,archive:true});
  assert.equal((await service.bazaarPublic({data:{eventId:first.id}})).products.some(item=>item.id===extraId),false);
  const buy=qty=>service.bazaarCreateOrder({data:{eventId:first.id,requestId:id(),lang:'fr',name:'Test Buyer',
    email:'buyer@example.test',phone:'0600000000',consent:true,items:[{id:original.id,qty,priceCents:450}]}});
  const paid=await buy(2);
  assert.equal(paid.iban,schedule.iban);
  assert.equal(paid.totalCents,900);
  await admin('bankConfirm',{id:paid.id,eventId:first.id});
  const canceled=await buy(1);
  await service.bazaarBuyerAction({data:{id:canceled.id,token:canceled.token,action:'cancel',ackNoTransfer:true}});
  assert.equal((await db.doc('bazaarProducts/'+original.id).get()).data().soldQty,2);
  for(const [orderId,type] of [[paid.id,'receipt'],[paid.id,'confirmed'],[canceled.id,'cancel']]){
    assert.equal((await db.doc(`bazaarOutbox/${orderId}_${type}`).get()).data().providerId,'captured');
  }
  await db.doc('bazaarMeta/event').update({orderCutoff:future(-1000)});
  await assert.rejects(buy(1),{code:'failed-precondition'});
  await admin('endEvent',{eventId:first.id,confirm:true});
  assert.equal((await service.bazaarPublic({data:{eventId:first.id}})).event.status,'closed');

  const second=(await admin('createDraft')).draft;
  const replacement={...original,titleFr:'Nouvel article',descriptionFr:'Nouvelle description',retailCents:700,
    boxPriceTtcCents:760,boxPriceHtCents:720};
  Object.assign(replacement,await photos.storePhoto(second.id,original.id,{
    content:Buffer.concat([Buffer.from(photo,'base64'),Buffer.from('second fixture')]).toString('base64')
  }));
  const next=await admin('saveDraft',{id:second.id,updatedAt:second.updatedAt,event:{...second.event,...schedule},items:[replacement]});
  await admin('publishDraft',{id:second.id,updatedAt:next.updatedAt});
  await admin('saveProduct',{eventId:second.id,id:original.id,product:{...replacement,titleKo:'신규 수정 상품'}});
  const listing=await admin('listEvents');
  assert.equal(listing.events.find(event=>event.id===first.id).status,'closed');
  const historical=await admin('dashboard',{eventId:first.id});
  const past=historical.products.find(item=>item.id===original.id);
  for(const key of ['titleKo','titleFr','descriptionKo','descriptionFr','photoPath','retailCents','boxPriceTtcCents','boxPriceHtCents']){
    assert.equal(past[key],original[key]);
  }
  const current=(await admin('dashboard',{eventId:second.id})).products.find(item=>item.id===original.id);
  assert.equal(current.titleKo,'신규 수정 상품');
  assert.notEqual(current.photoPath,past.photoPath);
  assert.equal(historical.orders.length,2);
  const accepted=historical.orders.filter(order=>order.bankConfirmedAt&&!order.canceledAt);
  assert.equal(accepted.reduce((sum,order)=>sum+order.totalCents,0),900);
  assert.equal(accepted[0].items[0].qty,2);
  assert.equal(accepted[0].items[0].boxPriceTtcCents,600);
  const oldUrl=new URL(photos.preview(past).imageUrl);
  assert.deepEqual(Buffer.from(await (await photos.serve(oldUrl)).arrayBuffer()),Buffer.from(photo,'base64'));
  assert.equal((await service.bazaarPublic({data:{eventId:first.id}})).event.status,'closed');
});
