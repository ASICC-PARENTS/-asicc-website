import { formatParisPaymentDeadline, personalTransferDeadline } from '../../firebase-functions-bazaar/bazaar/payment-window.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createBazaar } from '../../firebase-functions-bazaar/bazaar/service.mjs';
import { createFirestore, FieldValue } from './firestore.mjs';
import { createMail, mailFields } from './mail.mjs';
import { createMailAdmin } from './mail-admin.mjs';
import { mailKinds } from './mail-policy.mjs';
import { createPhotos } from './photos.mjs';

const loopback = 'http://127.0.0.1:8080';
const site = 'https://test.example.test';
const id = () => randomBytes(16).toString('hex');
const future = offset => new Date(Date.now() + offset).toISOString();
const photo = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7hoAAAAASUVORK5CYII=';

test('order intake can change without ending the bazaar or modifying previous orders and settlement', async t => {
  const projectId='demo-asicc-intake-'+id().slice(0,8);
  const db=createFirestore({projectId,token:()=> 'owner',emulator:loopback});
  t.after(async()=>{
    const cleared=await fetch(loopback+'/emulator/v1/projects/'+projectId+'/databases/(default)/documents',{method:'DELETE'});
    assert.ok(cleared.ok);
  });
  const service=createBazaar({db,FieldValue,siteUrl:()=>site,sendQueuedMail:async()=>false,batchFinalization:true});
  const eventId='bazaar-intake-regression';
  const eventRef=db.doc('bazaarMeta/event');
  const category=db.doc('bazaarProducts/intake-product');
  const uid='intake-test-admin';
  await db.doc('members/'+uid).set({role:'admin',status:'approved'});
  const admin=(op,data={})=>service.bazaarAdmin({auth:{uid,token:{email_verified:true}},data:{op,eventId,...data}});
  const order=(requestId=id())=>service.bazaarCreateOrder({data:{eventId,requestId,consent:true,lang:'fr',
    name:'Buyer',phone:'0612345678',email:'intake@example.test',items:[{id:'intake-product',qty:1,priceCents:450}]}});
  const buyer=(o,action)=>service.bazaarBuyerAction({data:{id:o.id,token:o.token,action}});
  const publicEvent=async()=> (await service.bazaarPublic({data:{eventId}})).event;
  const originalDeadline=future(3*3600000);
  const event={eventId,status:'published',serial:1,scopedProducts:true,nameKo:'검수',nameFr:'Vérification',pickupKo:'수령',
    orderCutoff:future(3600000),transferCutoff:originalDeadline,iban:'FR7612345678901234567890123',beneficiary:'ASICC'};
  await eventRef.set(event);
  await category.set({bazaarEventId:eventId,visible:true,titleKo:'상품',titleFr:'Produit',supplier:'Test',
    limitMode:'manual',manualLimit:5,retailCents:450,soldQty:0,packQty:12,boxPriceTtcCents:500,displayOrder:1});
  const first=await order();
  await eventRef.update({orderCutoff:future(-1000)});
  assert.equal((await publicEvent()).status,'published');
  await assert.rejects(order(),{code:'failed-precondition'});
  assert.equal((await buyer(first,'view')).order.transferCutoff,originalDeadline);
  await assert.rejects(admin('setOrderIntake',{action:'reopen',orderCutoff:future(-1000)}),{code:'invalid-argument'});
  await admin('setOrderIntake',{action:'reopen',orderCutoff:future(1800000)});
  assert.equal((await publicEvent()).transferCutoff,originalDeadline);
  await admin('setOrderIntake',{action:'close'});
  const paused=await publicEvent();
  assert.equal(paused.status,'published');
  assert.ok(paused.orderIntakeClosedAt);
  await assert.rejects(order(),{code:'failed-precondition'});
  assert.equal((await category.get()).data().soldQty,1);
  assert.equal((await buyer(first,'report')).changed,true);
  assert.equal((await admin('bankConfirm',{id:first.id,requestId:id(),amountCents:450})).changed,true);
  const financial=await admin('saveEventExpenses',{revision:0,expenses:[{id:'test-expense-id',name:'Transport',amountCents:150}]});
  const newDeadline=future(2*3600000);
  await admin('setOrderIntake',{action:'reopen',orderCutoff:future(3600000),transferCutoff:newDeadline});
  assert.equal((await order()).transferCutoff,newDeadline);
  assert.equal((await buyer(first,'view')).order.transferCutoff,originalDeadline);
  assert.deepEqual(await admin('eventFinancials'),financial);
  assert.equal((await category.get()).data().soldQty,2);
  assert.equal((await eventRef.get()).data().priorTransferCutoff,originalDeadline);
  await eventRef.update({orderCutoff:future(-1000),transferCutoff:future(-500)});
  await assert.rejects(admin('finalizeUnpaid',{confirm:true}),{code:'invalid-argument'});
  await eventRef.update({priorTransferCutoff:future(-500)});
  await admin('finalizeUnpaid',{confirm:true});
  assert.equal((await publicEvent()).status,'published');
  assert.equal((await publicEvent()).orderIntakeLocked,true);
  await admin('endEvent',{confirm:true});
  assert.equal((await publicEvent()).status,'closed');
  await assert.rejects(admin('setOrderIntake',{action:'reopen',orderCutoff:future(1000000),transferCutoff:future(2000000)}),{code:'failed-precondition'});
});

test('customer mail templates use the order language and preserve the private follow-up link', () => {
  const { message } = createBazaar({ db:{ doc() {}, collection() {} }, siteUrl: () => site });
  const order = { id:id(), buyerToken:id()+id(), orderRef:'ASICC-TEST', name:'Test & <buyer>', totalCents:900,
    items:[{ titleKo:'한국어 상품', titleFr:'Article français', qty:2, priceCents:450 }], pickupNote:'<note>' };
  const event = { beneficiary:'Test Association', iban:'TEST', transferCutoff:'2026-07-20T15:45:00Z',
    pickupKo:'한국어 수령 안내', pickupFr:'Instructions de retrait', contactEmail:'help@example.test' };
  for(const [lang,labels] of [
    ['ko',['주문 접수','주문 확정','송금 기한 안내','주문 취소','주문 취소 안내']],
    ['fr',['Commande reçue','Commande confirmée','Rappel de paiement','Commande annulée','Commande annulée faute de paiement']]
  ]){
    const fr=lang==='fr';
    const url=`${site}/${lang}/bazaar/commande/?id=${order.id}#token=${order.buyerToken}`;
    for(const [index,type] of ['receipt','confirmed','reminderFinal','cancel','bulkCancel'].entries()){
      const rendered=message({...order,lang},type,event);
      assert.ok(rendered.subject.includes(labels[index]));
      assert.ok(rendered.text.includes(fr?'Article français':'한국어 상품'));
      const pickup=fr?'Instructions de retrait':'한국어 수령 안내';
      assert.equal(rendered.text.includes(pickup),!['cancel','bulkCancel'].includes(type));
      assert.ok(rendered.text.includes(url));
      assert.ok(rendered.html.includes(`href="${url}"`));
      assert.ok(rendered.html.includes('Test &amp; &lt;buyer&gt;'));
      if(type==='receipt'||type==='reminderFinal'){
        assert.ok(rendered.text.includes(fr?'Date limite de virement':'송금 마감'));
        assert.match(rendered.text,fr?/17h45/:/17:45/);
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
    canSendMail:mail.canSend, sendQueuedMail:mail.deliver, queueFields:mailFields,mailAdmin:createMailAdmin(db,mail).admin });
  const uid='readiness-admin';
  await db.doc('members/'+uid).set({ role:'admin',status:'approved' });
  const admin=(op,data={})=>service.bazaarAdmin({auth:{uid,token:{email_verified:true}},data:{op,...data}});
  const schedule={orderCutoff:future(3600000),transferCutoff:future(7200000),pickupAt:future(10800000),beneficiary:'ASICC',
    iban:'FR7612345678901234567890123',pickupKo:'한국어 수령',pickupFr:'Retrait en français'};
  const obsolete=(await admin('createDraft')).draft;
  await admin('deleteDraft',{id:obsolete.id,confirm:true});
  await assert.rejects(admin('getDraft',{id:obsolete.id}),{code:'not-found'});
  const first=(await admin('createDraft')).draft;
  assert.deepEqual(first.items,[]);
  const base=(await admin('getCatalog')).items.find(item=>item.id==='k-alt500');
  const original={...base,included:true,limitMode:'manual',plannedBoxes:null,manualLimit:4,
    titleKo:'예전 상품',titleFr:'Ancien article',descriptionKo:'예전 설명',descriptionFr:'Ancienne description',
    retailCents:450,boxPriceTtcCents:600,boxPriceHtCents:569};
  Object.assign(original,await photos.storePhoto(first.id,original.id,{content:photo}));
  const incomplete={...original,retailCents:null,titleFr:'',packQty:null,boxPriceTtcCents:null};
  const draftSave=await admin('saveDraft',{id:first.id,updatedAt:first.updatedAt,event:{...first.event,...schedule},items:[incomplete]});
  const draftProduct=(await admin('getDraft',{id:first.id})).draft.items[0];
  assert.equal(draftProduct.retailCents,null);
  assert.equal(draftProduct.packQty,null);
  assert.equal(draftProduct.boxPriceTtcCents,null);
  const draftDetail=await admin('saveProductDetail',{scope:'draft',eventId:first.id,id:original.id,
    updatedAt:draftSave.updatedAt,field:'description',descriptionKo:'초안 설명',descriptionFr:'Brouillon'});
  const revisedDraft=(await admin('getDraft',{id:first.id})).draft;
  assert.equal(revisedDraft.items[0].descriptionFr,'Brouillon');
  assert.equal(revisedDraft.items[0].retailCents,null);
  assert.equal(revisedDraft.items[0].photoPath,original.photoPath);
  await assert.rejects(admin('saveProductDetail',{scope:'draft',eventId:first.id,id:original.id,
    updatedAt:draftSave.updatedAt,field:'photo',photoPath:''}),{code:'failed-precondition'});
  const draftReset=await admin('saveProductDetail',{scope:'draft',eventId:first.id,id:original.id,
    updatedAt:draftDetail.updatedAt,field:'description',descriptionKo:original.descriptionKo,descriptionFr:original.descriptionFr});
  draftSave.updatedAt=draftReset.updatedAt;
  await assert.rejects(admin('publishDraft',{id:first.id,updatedAt:draftSave.updatedAt}),{code:'invalid-argument'});
  const excluded={...incomplete,id:'custom-'+id(),included:false,imageUrl:'',photoPath:''};
  const saved=await admin('saveDraft',{id:first.id,updatedAt:draftSave.updatedAt,event:{...first.event,...schedule},items:[original,excluded]});
  assert.equal((await admin('getDraft',{id:first.id})).draft.items[0].descriptionFr,'Ancienne description');
  await admin('publishDraft',{id:first.id,updatedAt:saved.updatedAt});
  const publicProducts=(await service.bazaarPublic({data:{eventId:first.id}})).products;
  assert.equal(publicProducts.length,1);
  assert.equal(publicProducts[0].stockRemaining,4);
  const ev=await db.doc('bazaarMeta/event').get();
  const activePhoto={scope:'event',eventId:first.id,id:original.id,field:'photo'};
  const removed=await admin('saveProductDetail',{...activePhoto,revision:ev.data().productRevision??0,photoPath:''});
  assert.equal((await service.bazaarPublic({data:{eventId:first.id}})).products[0].imageUrl,'');
  await assert.rejects(admin('saveProductDetail',{...activePhoto,revision:removed.revision,
    photoPath:original.photoPath.replace(first.id,'different-event')}),{code:'failed-precondition'});
  await admin('saveProductDetail',{...activePhoto,revision:removed.revision,photoPath:original.photoPath});
  const restoredPhoto=(await service.bazaarPublic({data:{eventId:first.id}})).products[0];
  assert.equal(restoredPhoto.imageUrl,publicProducts[0].imageUrl);
  assert.equal(restoredPhoto.priceCents,450);
  assert.equal(restoredPhoto.stockRemaining,4);
  const catalogSnapshot=await admin('getCatalog');
  await admin('saveProductDetail',{scope:'catalog',id:original.id,revision:catalogSnapshot.revision,
    field:'description',descriptionKo:'기본 설명',descriptionFr:'Catalogue uniquement'});
  assert.equal((await admin('getCatalog')).items.find(item=>item.id===original.id).descriptionFr,'Catalogue uniquement');
  assert.equal((await service.bazaarPublic({data:{eventId:first.id}})).products[0].descriptionFr,'Ancienne description');

  const extraId='custom-'+id();
  await admin('addProduct',{eventId:first.id,id:extraId,product:{...original,imageUrl:'',photoPath:''}});
  await assert.rejects(admin('archiveProduct',{eventId:first.id,id:extraId,archive:true}),{code:'failed-precondition'});
  const salesRevision=(await db.doc('bazaarMeta/event').get()).data().productRevision;
  await admin('setProductSales',{eventId:first.id,id:extraId,revision:salesRevision,visible:false});
  const suspended=(await db.doc('bazaarProducts/'+extraId).get()).data();
  assert.equal(suspended.visible,false);
  assert.equal(suspended.archivedAt,null);
  assert.equal((await service.bazaarPublic({data:{eventId:first.id}})).products.some(item=>item.id===extraId),false);
  const buy=qty=>service.bazaarCreateOrder({data:{eventId:first.id,requestId:id(),lang:'fr',name:'Test Buyer',
    email:'buyer@example.test',phone:'0600000000',consent:true,items:[{id:original.id,qty,priceCents:450}]}});
  const paid=await buy(2);
  assert.equal(paid.iban,schedule.iban);
  assert.equal(paid.totalCents,900);
  await admin('bankConfirm',{id:paid.id,eventId:first.id,requestId:id(),amountCents:paid.totalCents});
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
  const unrelated='outside-current-event';
  await db.doc('bazaarProducts/'+unrelated).set({...replacement,id:unrelated,bazaarEventId:first.id,visible:true,soldQty:1});
  assert.equal((await admin('dashboard',{eventId:second.id})).products.some(product=>product.id===unrelated),false);
  assert.equal((await service.bazaarPublic({data:{eventId:second.id}})).products.some(product=>product.id===unrelated),false);
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
  const paidChange=await service.bazaarCreateOrder({data:{eventId:second.id,requestId:id(),lang:'fr',name:'Test Refund',
    email:'buyer@example.test',phone:'0600000000',consent:true,items:[{id:original.id,qty:2,priceCents:700}]}});
  assert.equal(paidChange.transferCutoff,schedule.transferCutoff);
  await admin('bankConfirm',{id:paidChange.id,eventId:second.id,requestId:id(),amountCents:paidChange.totalCents});
  const change={id:paidChange.id,eventId:second.id,reason:'Synthetic correction',confirm:true,restoreStock:true};
  await admin('correctOrder',{...change,revision:0,items:[{id:original.id,qty:1}]});
  const paymentFields={id:paidChange.id,eventId:second.id,reason:'Synthetic bank record'};
  const refund={...paymentFields,requestId:id(),type:'refund',amountCents:700};
  assert.equal((await admin('recordOrderPayment',refund)).payment.refunded,700);
  assert.equal((await admin('recordOrderPayment',refund)).payment.refunded,700);
  await admin('correctOrder',{...change,revision:1,items:[{id:original.id,qty:2}]});
  const deposit={...paymentFields,requestId:id(),type:'deposit',amountCents:700};
  assert.equal((await admin('recordOrderPayment',deposit)).payment.additionalDue,0);
  await admin('cancelOrder',change);
  await admin('cancelOrder',change);
  const finalRefund={...paymentFields,requestId:id(),type:'refund',amountCents:1400};
  assert.equal((await admin('recordOrderPayment',finalRefund)).payment.state,'refunded');
  const recorded=(await admin('orderPayments',paymentFields)).records;
  assert.equal(recorded.filter(row=>!row.initial).length,3);
  assert.equal(recorded.find(row=>row.initial).amountCents,paidChange.totalCents);
  assert.equal((await db.doc('bazaarProducts/'+original.id).get()).data().soldQty,0);
  const mailPreview=await admin('mailPreview',{eventId:second.id,type:'receipt',lang:'fr',id:paidChange.id});
  assert.match(mailPreview.text,/Acheteur|Test Refund/);
  assert.match(mailPreview.text,/#token=preview-only/);
  assert.doesNotMatch(mailPreview.text,new RegExp(paidChange.token));
  await admin('archiveClosedEvent',{eventId:first.id,archive:true});
  assert.ok((await admin('listEvents')).events.find(event=>event.id===first.id).hiddenAt);
  await admin('archiveClosedEvent',{eventId:first.id,archive:false});
  await assert.rejects(admin('deleteClosedEvent',{eventId:first.id,name:first.event.nameKo,confirm:true}),{code:'failed-precondition'});
  const modes=Object.fromEntries(Object.keys(mailKinds).map(kind=>[kind,'off']));
  await admin('mailPolicy',{eventId:second.id,modes,preferredModes:mailKinds});
  const synthetic=await service.bazaarCreateOrder({data:{eventId:second.id,requestId:id(),name:'Synthetic R9',
    email:'r9@example.test',phone:'06 00 00 00 00',consent:true,items:[{id:original.id,qty:2,priceCents:700}]}});
  const scope={id:synthetic.id,eventId:second.id,confirm:true};
  assert.equal((await db.doc('bazaarOutbox/'+synthetic.id+'_receipt').get()).data().status,'skipped');
  assert.equal((await admin('adminTransferReport',{...scope,reason:'Synthetic call'})).changed,true);
  assert.equal((await admin('adminTransferReport',scope)).changed,false);
  assert.equal((await service.bazaarBuyerAction({data:{id:synthetic.id,token:synthetic.token,action:'report'}})).changed,false);
  await admin('bankConfirm',{...scope,requestId:id(),amountCents:synthetic.totalCents});
  const pending={...scope,requestId:id(),revision:0,kind:'items',items:[{id:original.id,qty:1}],amountCents:700,
    restoreStock:true,reason:'synthetic internal note',publicReason:'Supply shortage',operator:'Fixture operator',method:'cash'};
  const registered=await admin('createRefund',pending);
  assert.deepEqual([registered.payment.original,registered.payment.due,registered.payment.refunded,registered.payment.refundDue],[1400,700,0,700]);
  assert.equal((await admin('createRefund',pending)).payment.reservedRefund,700);
  assert.equal((await db.doc('bazaarProducts/'+original.id).get()).data().soldQty,1);
  const view=async()=> (await service.bazaarBuyerAction({data:{id:synthetic.id,token:synthetic.token,action:'view'}})).order;
  const awaiting=await view();
  assert.equal(awaiting.items[0].qty,1);
  assert.equal(awaiting.canceledItems[0].qty,1);
  assert.equal(awaiting.refundReason,'Supply shortage');
  assert.doesNotMatch(JSON.stringify(awaiting),/synthetic internal note|Fixture operator|boxPrice/);
  const retryFinish={...scope,requestId:pending.requestId,completedAt:future(-2000),operator:'Fixture operator',reference:'mock-reference'};
  await Promise.all([admin('finishRefund',retryFinish),admin('finishRefund',retryFinish)]);
  await admin('mailPolicy',{eventId:second.id,modes:{...modes,orderChanged:'manual',refundCompleted:'manual'},preferredModes:mailKinds});
  const changedJob=synthetic.id+'_orderChanged-1';
  assert.equal((await admin('mailTransactionQueue',{eventId:second.id,jobId:changedJob,confirm:true})).queued,true);
  assert.equal(await mail.deliver(changedJob,service.message),true);
  assert.equal(await mail.deliver(changedJob,service.message),false);
  const jobId=synthetic.id+'_refundCompleted-'+pending.requestId;
  assert.equal((await admin('mailTransactionQueue',{eventId:second.id,jobId,confirm:true})).queued,true);
  assert.equal((await admin('mailTransactionQueue',{eventId:second.id,jobId,confirm:true})).queued,true);
  assert.equal(await mail.deliver(jobId,service.message),true);
  assert.equal(await mail.deliver(jobId,service.message),false);
  assert.equal((await db.doc('bazaarOutbox/'+jobId).get()).data().providerId,'captured');
  const complete=await view();
  assert.deepEqual([complete.payment.net,complete.payment.refunded,complete.payment.refundDue],[700,700,0]);
  assert.equal((await db.doc('bazaarProducts/'+original.id).get()).data().soldQty,1);
  assert.equal((await admin('orderRefunds',scope)).refunds.length,1);
  await assert.rejects(admin('createRefund',{...pending,requestId:id(),revision:1,kind:'overpayment',items:[],restoreStock:false}),{code:'failed-precondition'});
  const stopProduct=async visible=>{
    const {event}=await admin('dashboard',{eventId:second.id});
    await admin('setProductSales',{eventId:second.id,id:original.id,revision:event.productRevision,visible});
  };
  await stopProduct(false);
  const stopped=(await admin('dashboard',{eventId:second.id})).products.find(item=>item.id===original.id);
  assert.equal(stopped.visible,false);
  assert.equal(stopped.soldQty,1);
  assert.equal(stopped.hasOrderHistory,true);
  assert.equal((await service.bazaarPublic({data:{eventId:second.id}})).products.some(item=>item.id===original.id),false);
  const buyAgain=()=>service.bazaarCreateOrder({data:{eventId:second.id,requestId:id(),name:'R9.1 fixture',
    email:'r91@example.test',phone:'06 00 00 00 00',consent:true,items:[{id:original.id,qty:1,priceCents:700}]}});
  await assert.rejects(buyAgain(),{code:'failed-precondition'});
  await stopProduct(true);
  const installment=await buyAgain(),paymentScope={id:installment.id,eventId:second.id};
  const initial={...paymentScope,requestId:id(),amountCents:400,actualDate:'2026-11-25'};
  assert.equal((await admin('bankConfirm',initial)).payment.additionalDue,300);
  assert.equal((await admin('bankConfirm',initial)).changed,false);
  await assert.rejects(admin('bankConfirm',{...initial,amountCents:401}),{code:'already-exists'});
  assert.equal((await db.doc('bazaarOutbox/'+installment.id+'_confirmed').get()).exists,false);
  const balanceJob=installment.id+'_additionalPayment-'+initial.requestId;
  await assert.rejects(admin('mailTransactionQueue',{eventId:second.id,jobId:balanceJob,confirm:true}),{code:'failed-precondition'});
  assert.equal((await db.doc('bazaarOutbox/'+balanceJob).get()).data().providerId,undefined);
  await admin('mailPolicy',{eventId:second.id,modes:{...modes,orderChanged:'manual',additionalPayment:'manual',refundCompleted:'manual'},preferredModes:mailKinds});
  await admin('mailTransactionQueue',{eventId:second.id,jobId:balanceJob,confirm:true});
  await admin('mailTransactionQueue',{eventId:second.id,jobId:balanceJob,confirm:true});
  assert.equal(await mail.deliver(balanceJob,service.message),true);
  assert.equal(await mail.deliver(balanceJob,service.message),false);
  const reviewedMail=(await admin('mailOverview',{eventId:second.id})).messages;
  for(const id of [changedJob,jobId,balanceJob]){
    const row=reviewedMail.find(message=>message.id===id);
    assert.equal(row?.method,'capture');
    assert.equal(row.mode,'manual');
    assert.doesNotMatch(row.sentSnapshot.text,/#token=[a-f0-9]{64}/i);
  }
  const installmentDeposit=amountCents=>({...paymentScope,amountCents,requestId:id(),type:'deposit',overpayment:true});
  const secondDeposit=installmentDeposit(150);
  await Promise.all([admin('recordOrderPayment',secondDeposit),admin('recordOrderPayment',secondDeposit)]);
  assert.equal((await admin('orderPayments',paymentScope)).payment.additionalDue,150);
  assert.equal((await admin('recordOrderPayment',installmentDeposit(150))).payment.settled,true);
  assert.equal((await db.doc('bazaarOutbox/'+installment.id+'_confirmed').get()).exists,true);
  const surplus=await admin('recordOrderPayment',installmentDeposit(100));
  assert.deepEqual([surplus.payment.deposited,surplus.payment.refundDue,surplus.payment.due],[800,100,700]);
  const over=await admin('createRefund',{...paymentScope,requestId:id(),revision:0,kind:'overpayment',confirm:true,
    amountCents:100,reason:'Synthetic overpayment',operator:'Fixture operator',method:'cash'});
  assert.deepEqual([over.payment.due,over.payment.refunded,over.payment.reservedRefund],[700,0,100]);
  const surplusScope={...paymentScope,requestId:over.refund.id,confirm:true};
  const edited={...surplusScope,auditId:id(),editRevision:0,amountCents:95,reason:'Fixture correction',operator:'Fixture operator'};
  await admin('editRefund',edited);
  await admin('editRefund',edited);
  assert.equal((await admin('refundAudit',{...paymentScope,refundId:over.refund.id})).edits.length,1);
  await admin('editRefund',{...edited,editRevision:1,auditId:id(),amountCents:100});
  await admin('finishRefund',{...surplusScope,completedAt:future(-1000),operator:'Fixture operator'});
  const correction={...paymentScope,paymentId:secondDeposit.requestId,requestId:id(),beforeCents:150,amountCents:160,reason:'Fixture deposit correction'};
  await admin('correctDeposit',correction);
  const correctionResult=await admin('correctDeposit',correction);
  assert.equal(correctionResult.payment.refundDue,10);
  const reverse={...paymentScope,requestId:id(),revision:0,kind:'items',confirm:true,items:[{id:original.id,qty:1}],
    amountCents:700,restoreStock:true,reason:'Fixture cancellation',operator:'Fixture operator',method:'cash'};
  await admin('createRefund',reverse);
  const restored=await admin('voidRefund',{...paymentScope,requestId:reverse.requestId,confirm:true,restoreOrder:true,reason:'Fixture restoration'});
  assert.deepEqual([restored.payment.due,restored.payment.refundDue,restored.payment.reservedRefund],[700,10,0]);
  assert.equal((await db.doc('bazaarProducts/'+original.id).get()).data().soldQty,2);
  const oldUrl=new URL(photos.preview(past).imageUrl);
  assert.deepEqual(Buffer.from(await (await photos.serve(oldUrl)).arrayBuffer()),Buffer.from(photo,'base64'));
  assert.equal((await service.bazaarPublic({data:{eventId:first.id}})).event.status,'closed');
});

test('R9.1 private evidence and immutable accounting reconcile 145 less 65, 50 and 5', {timeout:30000},async t=>{
  const projectId='demo-asicc-accounting-'+id().slice(0,8),eventId='accounting-fixture';
  const db=createFirestore({projectId,token:()=> 'owner',emulator:loopback});
  t.after(async()=>assert.ok((await fetch(`${loopback}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'})).ok));
  const stored=new Map();
  const photos=createPhotos({BAZAAR_MODE:'test',B2_BUCKET:'fixture-bucket',B2_S3_ENDPOINT:'https://s3.eu-central-003.backblazeb2.com',
    B2_KEY_ID:'fixture',B2_APPLICATION_KEY:'fixture',BAZAAR_PHOTO_SIGNING_KEY:'fixture'},db,site,null,async(url,init)=>{
    const path=new URL(url).pathname;
    assert.match(path,/^\/fixture-bucket\/bazaar\/test\/photos\/evidence\/accounting-fixture\/[a-f0-9]{32}$/);
    if(init.method==='PUT'){stored.set(path,Buffer.from(init.body));return new Response();}
    return new Response(stored.get(path));
  });
  const service=createBazaar({db,FieldValue,evidence:photos.evidence,siteUrl:()=>site});
  const uid='accounting-admin',member='accounting-member';
  await db.doc('members/'+uid).set({role:'admin',status:'approved'});
  await db.doc('members/'+member).set({role:'member',status:'approved'});
  const invoke=(actor,op,data)=>service.bazaarAdmin({auth:{uid:actor,token:{email_verified:true}},data:{...data,op,eventId}});
  const admin=(op,data={})=>invoke(uid,op,data);
  await db.doc('bazaarMeta/event').set({eventId,status:'published',orderCutoff:future(-1000),transferCutoff:future(10000)});
  const orderId=id(),orderRef=db.doc('bazaarOrders/'+orderId);
  await orderRef.set({id:orderId,eventId,orderRef:'ASICC-145-FIXTURE',name:'Synthetic',items:[{id:'remaining',qty:2,priceCents:4000,supplier:'Fournisseur fictif'}],
    totalCents:8000,originalTotalCents:14500,bankConfirmedAt:future(-20000),depositedCents:14500,refundedCents:6500,canceledAt:null});
  await assert.rejects(admin('finalizeEventFinancials',{action:'finalize',confirm:true}),{code:'failed-precondition'});
  const vendor='Fournisseur fictif';
  await admin('savePurchaseOrder',{vendor,revision:0,confirm:true,info:{number:'PO-FIXTURE',date:'2026-11-25'},
    lines:[{id:'remaining',name:'Test',unit:'박스',qty:1,priceCents:5500,amountCents:5500}]});
  const invoice=Buffer.from('%PDF-1.4\nSynthetic invoice; no financial data');
  const photoBytes=Buffer.from(photo,'base64');
  const files=[await admin('storeEvidence',{name:'preuve.pdf',content:invoice}),await admin('storeEvidence',{name:'photo.png',content:photoBytes})];
  assert.ok([...stored.values()].every(bytes=>!bytes.includes(invoice)&&!bytes.includes(photoBytes)));
  const purchase={id:id(),revision:0,scope:'purchase',kind:'invoice',vendor,number:'INV-001',date:'2026-11-25',paymentStatus:'partial',
    amountCents:5000,paidCents:3500,files};
  let saved=await admin('saveEvidence',purchase);
  assert.equal(saved.evidence[0].files.length,2);
  await assert.rejects(admin('saveEvidence',{...purchase,id:id(),revision:saved.revision}),{code:'already-exists'});
  await assert.rejects(invoke(member,'getEvidence',{id:purchase.id,fileId:files[0].id}),{code:'permission-denied'});
  const opened=await admin('getEvidence',{id:purchase.id,fileId:files[0].id});
  assert.deepEqual(Buffer.from(await opened.arrayBuffer()),invoice);
  saved=await admin('confirmPurchaseCosts',{confirm:true,revision:saved.revision});
  await assert.rejects(admin('finalizeEventFinancials',{action:'finalize',confirm:true}),/미결제/);
  saved=await admin('saveEvidence',{...purchase,revision:saved.revision,paymentStatus:'paid',paidCents:5000,reason:'Supplier fully paid'});
  const expenseId=id();
  saved=await admin('saveEventExpenses',{revision:saved.revision,expenses:[{id:expenseId,name:'Transport fixture',amountCents:500}]});
  const receipt=await admin('storeEvidence',{name:'transport.pdf',content:Buffer.from('%PDF-1.4\nSynthetic receipt')});
  saved=await admin('saveEvidence',{id:id(),revision:saved.revision,scope:'expense',expenseId,kind:'receipt',date:'2026-11-25',
    paymentStatus:'paid',amountCents:500,paidCents:500,files:[receipt]});
  saved=await admin('confirmPurchaseCosts',{confirm:true,revision:saved.revision});
  const result=await admin('finalizeEventFinancials',{action:'finalize',confirm:true});
  const {salesCents,purchaseCents,expenseCents,depositedCents,refundedCents,netCents,profitCents}=result.snapshot;
  assert.deepEqual([salesCents,purchaseCents,expenseCents,depositedCents,refundedCents,netCents,profitCents],[8000,5000,500,14500,6500,8000,2500]);
  await assert.rejects(admin('saveEventExpenses',{revision:result.revision,expenses:[]}),{code:'failed-precondition'});
  const openedAgain=await admin('finalizeEventFinancials',{action:'reopen',confirm:true,reason:'Synthetic accounting correction'});
  assert.deepEqual(openedAgain.snapshot,result.snapshot);
  const final=await admin('finalizeEventFinancials',{action:'finalize',confirm:true});
  assert.equal(final.snapshot.profitCents,2500);
  const ref=db.doc('bazaarEventFinancials/'+eventId);
  assert.equal((await ref.collection('snapshots').get()).size,2);
  assert.ok((await ref.collection('audit').get()).docs.some(row=>row.data().action==='reopen'));
});

test('November cutoffs apply the earlier Paris deadline to both customer emails', () => {
  const {message}=createBazaar({db:{doc(){},collection(){}},siteUrl:()=>site});
  const event={status:'published',orderCutoff:'2026-11-27T17:00:00.000Z',transferCutoff:'2026-11-27T21:00:00.000Z',
    paymentHours:24,beneficiary:'Fixture Association',iban:'FR7610278060220002261190128'};
  const cases=[
    ['2026-11-25T15:20:00Z','2026-11-26T15:20:00.000Z'],
    ['2026-11-26T17:00:00Z','2026-11-27T17:00:00.000Z'],
    ['2026-11-26T21:00:00Z','2026-11-27T21:00:00.000Z'],
    ['2026-11-27T08:00:00Z','2026-11-27T21:00:00.000Z'],
    ['2026-11-27T14:00:00Z','2026-11-27T21:00:00.000Z'],
    ['2026-11-27T16:59:00Z','2026-11-27T21:00:00.000Z'],
  ];
  for(const [createdAt,expected] of cases){
    const paymentDeadline=personalTransferDeadline(createdAt,event);
    assert.equal(paymentDeadline,expected);
    for(const lang of ['ko','fr']){
      const order={id:id(),buyerToken:id()+id(),orderRef:'BZ010001',lang,createdAt,paymentDeadline,totalCents:3020,name:'Fixture buyer'};
      for(const type of ['receipt','reminderFinal']){
        const mail=message(order,type,{...event,transferCutoff:'2026-11-28T21:00:00Z'},{},{},{testMode:true});
        assert.ok(mail.text.includes(formatParisPaymentDeadline(expected,lang)));
        assert.match(mail.subject,/^\[TEST\] \[ASICC\].* · BZ010001$/u);
        assert.match(mail.html,/^<!doctype html>[\s\S]*<table/);
        assert.match(mail.html,/focus=report/);
        assert.match(mail.html,/FR76 1027 8060 2200 0226 1190 128/);
        assert.doesNotMatch(mail.html,/<pre\b/i);
        assert.doesNotMatch(message({...order,transferReportedAt:createdAt},type,event).html,/focus=report|focus=cancel/);
      }
    }
  }
  assert.equal(formatParisPaymentDeadline(event.transferCutoff,'fr'),'vendredi 27 novembre 2026 à 22h00 (heure de Paris)');
  assert.equal(formatParisPaymentDeadline(event.transferCutoff,'ko'),'2026년 11월 27일 22:00 (파리 현지 시간)');
  assert.match(formatParisPaymentDeadline('2026-07-20T15:45:00Z','fr'),/17h45/);
});
