import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deleteApp, getApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const projectId = 'demo-asicc-bazaar';
if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
  throw new Error('Run this test in the local Firestore emulator.');
}
if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '')) {
  throw new Error('Run this test in the local Storage emulator.');
}
initializeApp({ projectId, storageBucket: 'demo-asicc-bazaar.appspot.com' });
const { bazaarAdmin, bazaarBuyerAction, bazaarCreateOrder, bazaarPublic, bazaarReminders } = await import('../index.mjs');
const db = getFirestore();
const { message } = await import('../bazaar/index.mjs');
after(() => deleteApp(getApp()));

const otherStaff = { uid: 'bazaar-admin-two', token: { email_verified: true } };
const staff = { uid: 'bazaar-admin', token: { email_verified: true } };
const call = (op, data = {}, auth = staff) => bazaarAdmin.run({ auth, data: { op, ...data } });
const shop = eventId => bazaarPublic.run({ data: { eventId } });
const eventId = 'bazaar-test-original';
const productId = 'test-product';
const buyer = {
  requestId: randomBytes(16).toString('hex'),
  eventId, name: 'Test Customer', email: 'buyer@example.test', phone: '0612345678',
  consent: true, lang: 'fr', items: [{ id: productId, qty: 2, priceCents: 450 }],
};
const failure = { code: 'failed-precondition' };

test('administrators can publish a draft and close it without losing history or reopening its public URL', async () => {
  delete process.env.BAZAAR_SMTP_HOST;
  await db.doc('members/bazaar-admin').set({ role: 'admin', status: 'approved' });
  await db.doc('members/bazaar-admin-two').set({ role: 'admin', status: 'approved' });
  await db.doc('members/bazaar-member').set({ role: 'member', status: 'approved' });
  await assert.rejects(call('listEvents', {}, { uid: 'bazaar-member', token: { email_verified: true } }), { code: 'permission-denied' });
  await assert.rejects(call('listEvents', {}, { ...staff, token: { email_verified: false } }), { code: 'permission-denied' });
  const active = {
    eventId, serial: 1, status: 'published', nameKo: '첫 행사', nameFr: 'Première vente',
    introKo: '안내', introFr: 'Présentation', createdAt: new Date().toISOString(),
    orderCutoff: new Date(Date.now() + 3600000).toISOString(),
    transferCutoff: new Date(Date.now() + 7200000).toISOString(),
    pickupKo: '픽업', pickupFr: 'Retrait', beneficiary: 'ASICC', contactEmail: 'contact@example.test',
    iban: 'FR7612345678901234567890123',
  };
  const product = {
    titleKo: '상품', titleFr: 'Produit', supplier: '누리커넥트', imageUrl: '',
    descriptionKo: '설명', descriptionFr: 'Description', storage: 'ambient', visible: true,
    retailCents: 450, packQty: 12, boxPriceTtcCents: 700, boxPriceHtCents: null,
    plannedBoxes: null, limitMode: 'unlimited', manualLimit: null, soldQty: 0, displayOrder: 1,
  };
  await db.doc('bazaarMeta/event').set(active);
  const originalBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7hoAAAAASUVORK5CYII=';
  const replacedBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const writePhoto = (data,auth) => call('storePhoto', {id: productId,...data},auth);
  Object.assign(product, await writePhoto({eventId,content:originalBytes}));
  await db.doc(`bazaarProducts/${productId}`).set(product);
  const disposable = (await call('createDraft')).draft;
  await call('deleteDraft', { id: disposable.id, confirm: true });
  assert.equal((await call('listEvents')).drafts.length, 0);
  const publicView = await shop(eventId);
  assert.equal(publicView.products[0].priceCents, 450);
  assert.equal(publicView.products[0].boxPriceTtcCents, undefined);
  await assert.rejects(bazaarCreateOrder.run({ data: { ...buyer, consent: false } }), { code: 'invalid-argument' });
  const receipt = await bazaarCreateOrder.run({ data: buyer, rawRequest: { ip: '127.0.0.2' } });
  assert.equal(receipt.totalCents, 900);
  const blank = (await db.doc(`bazaarOrders/${receipt.id}`).get()).data();
  assert.equal(blank.pickupNote,undefined);
  const fresh = () => randomBytes(16).toString('hex');
  await assert.rejects(bazaarCreateOrder.run({data:{...buyer,requestId:fresh(),pickupNote:'가'.repeat(501)}}),{code:'invalid-argument'});
  const pickupNote='4시에 찾으러 갑니다.\n<예시>';
  const noted = await bazaarCreateOrder.run({data:{...buyer,requestId:fresh(),pickupNote}});
  const notedOrder = (await db.doc(`bazaarOrders/${noted.id}`).get()).data();
  assert.equal(notedOrder.pickupNote,pickupNote);
  const french = message(notedOrder,'receipt',active);
  assert.ok(french.text.includes('Informations complémentaires pour le retrait\n'+pickupNote));
  assert.ok(french.html.includes('&lt;예시&gt;'));
  assert.ok(message({...notedOrder,lang:'ko'},'receipt',active).text.includes('판매자에게 전달할 사항\n'+pickupNote));
  assert.ok(!message(blank,'receipt',active).text.includes('Informations complémentaires pour le retrait'));
  await call('bankConfirm',{id:noted.id});
  assert.deepEqual(await bazaarCreateOrder.run({ data: buyer }), receipt);
  await assert.rejects(bazaarCreateOrder.run({ data: {
    ...buyer, requestId: randomBytes(16).toString('hex'), items: [{ id: productId, qty: 2, priceCents: 1 }],
  } }), failure);
  await assert.rejects(call('endEvent', { eventId, confirm: false }), { code: 'invalid-argument' });
  await call('endEvent', { eventId, confirm: true });
  assert.deepEqual((await shop(eventId)).event, { eventId, status: 'closed' });
  assert.deepEqual((await shop(eventId)).products, []);
  await assert.rejects(bazaarCreateOrder.run({ data: { ...buyer, requestId: randomBytes(16).toString('hex') } }), failure);
  await call('bankConfirm', { id: receipt.id });

  const draft = (await call('createDraft',{},otherStaff)).draft;
  assert.deepEqual(draft.items,[]);
  const baseProduct=(await call('getCatalog')).items.find(item=>item.id===productId);
  assert.equal(baseProduct.imageUrl,product.imageUrl);
  assert.equal(baseProduct.retailCents,product.retailCents);
  await assert.rejects(writePhoto({eventId:draft.id,draft:true,updatedAt:draft.updatedAt,content:'eA=='}), {code:'invalid-argument'});
  const copyRequest = {eventId:draft.id,draft:true,updatedAt:draft.updatedAt,sourcePath:product.photoPath};
  const copied = await writePhoto(copyRequest,otherStaff);
  assert.notEqual(copied.photoPath,product.photoPath);
  const publicPhoto = await fetch(copied.imageUrl);
  assert.equal(publicPhoto.status,200);
  assert.equal(Buffer.from(await publicPhoto.arrayBuffer()).toString('base64'),originalBytes);
  assert.equal((await fetch(copied.imageUrl.split('&token=')[0])).ok,false);
  const bucket = getStorage().bucket();
  assert.equal((await bucket.file(copied.photoPath).download())[0].toString('base64'),originalBytes);
  const updates = {
    id: draft.id, updatedAt: draft.updatedAt,
    event: { ...active, nameKo: '다음 행사', nameFr: 'Vente suivante' },
    items: [{ ...product, ...copied, id: productId, included: true, retailCents: 650 }],
  };
  const saved = await call('saveDraft', updates);
  await assert.rejects(call('saveDraft', updates), failure);
  assert.deepEqual(await writePhoto({...copyRequest,updatedAt:saved.updatedAt},otherStaff),copied);
  assert.equal((await bucket.getFiles({prefix:`bazaar-photos/${draft.id}/`}))[0].length,1);
  const replaced = await writePhoto({eventId:draft.id,draft:true,updatedAt:saved.updatedAt,content:replacedBytes},otherStaff);
  const newId = 'custom-0123456789abcdef0123456789abcdef';
  const newer = await call('saveDraft',{...updates,updatedAt:saved.updatedAt,items:[
    {...updates.items[0],...replaced},
    {...updates.items[0],id:newId,imageUrl:'',photoPath:'',included:false},
  ]},otherStaff);
  assert.equal((await db.doc(`bazaarProducts/${newId}`).get()).exists,false);
  process.env.BAZAAR_SMTP_HOST = 'localhost';
  process.env.BAZAAR_SMTP_USER = 'test@example.test';
  process.env.BAZAAR_SMTP_PASSWORD = 'emulator-only';
  await call('publishDraft', { id: draft.id, updatedAt: newer.updatedAt },otherStaff);
  assert.equal((await db.doc(`bazaarProducts/${newId}`).get()).exists,true);
  await Promise.all([
    call('saveProduct',{eventId:draft.id,id:productId,product:{...updates.items[0],...replaced,titleKo:'현재 행사 상품'}},otherStaff),
    ...[
      ['saveProduct',{id:productId,product}],
      ['archiveProduct',{id:productId,archive:true}],
      ['reorder',{ids:[productId,newId]}],
      ['addProduct',{id:'custom-1123456789abcdef0123456789abcdef',product:{...product,imageUrl:'',photoPath:''}}],
    ].map(([op,args])=>assert.rejects(call(op,{...args,eventId}),failure)),
  ]);
  const current = await call('dashboard',{eventId:draft.id});
  assert.equal(current.products[0].titleKo,'현재 행사 상품');
  assert.equal(current.products[0].photoPath,replaced.photoPath);
  assert.equal((await bucket.file(product.photoPath).download())[0].toString('base64'),originalBytes);
  assert.equal((await bucket.file(replaced.photoPath).download())[0].toString('base64'),replacedBytes);
  assert.deepEqual((await shop(eventId)).event, { eventId, status: 'closed' });
  assert.equal((await shop(draft.id)).products[0].priceCents, 650);
  await assert.rejects(bazaarCreateOrder.run({ data: { ...buyer, requestId: randomBytes(16).toString('hex') } }), failure);
  const historical = await call('dashboard', { eventId });
  assert.equal(historical.readOnly, true);
  assert.equal(historical.products[0].retailCents, 450);
  assert.equal(historical.products[0].imageUrl, product.imageUrl);
  assert.equal(historical.products[0].boxPriceTtcCents, 700);
  const prior=historical.orders.find(item=>item.id===receipt.id);
  assert.equal(prior.totalCents,900);
  assert.ok(prior.bankConfirmedAt);
  assert.equal(prior.buyerToken,undefined);
  assert.equal(historical.orders.find(item=>item.id===noted.id).pickupNote,pickupNote);

  const baseCatalog = await call('getCatalog');
  const newCatalog = await call('saveCatalog',{
    revision:baseCatalog.revision,items:baseCatalog.items.map(p=>({...p,titleKo:'기본 상품',limitMode:'box',plannedBoxes:3,manualLimit:null})).reverse(),
  });
  await assert.rejects(call('saveCatalog',baseCatalog,otherStaff),failure);
  const savedBase=await call('getCatalog');
  assert.equal(savedBase.items[0].titleKo,'기본 상품');
  assert.deepEqual(savedBase.items.map(p=>p.id),baseCatalog.items.map(p=>p.id).reverse());
  assert.ok(savedBase.items.every(p=>p.limitMode==='box'&&p.plannedBoxes===3));
  assert.equal((await shop(draft.id)).products[0].titleKo,'현재 행사 상품');
  const loadedDraft=(await call('createDraft')).draft;
  assert.deepEqual(loadedDraft.items,[]);
  const selectedBase=(await call('getCatalog')).items.find(item=>item.id===productId);
  assert.equal(selectedBase.titleKo,'기본 상품');
  const copiedSave=await call('saveDraft',{id:loadedDraft.id,updatedAt:loadedDraft.updatedAt,
    event:loadedDraft.event,items:[{...selectedBase,included:true}]});
  const storedCopy=(await call('getDraft',{id:loadedDraft.id})).draft;
  assert.equal(storedCopy.updatedAt,copiedSave.updatedAt);
  const storedProduct=storedCopy.items.find(item=>item.id===productId);
  assert.equal(storedProduct.limitMode,'box');
  assert.equal(storedProduct.plannedBoxes,3);
  assert.match(storedProduct.photoPath,new RegExp(`^bazaar-photos/${loadedDraft.id}/`));
  assert.equal((await bucket.file(storedProduct.photoPath).download())[0].toString('base64'),originalBytes);

  const unlimitedCatalog=await call('saveCatalog',{revision:newCatalog.revision,items:savedBase.items.map(p=>({...p,limitMode:'unlimited',plannedBoxes:5}))});
  const unlimitedBase=await call('getCatalog');
  assert.ok(unlimitedBase.items.every(p=>p.limitMode==='unlimited'&&p.plannedBoxes===5));
  assert.equal((await call('getDraft',{id:loadedDraft.id})).draft.items.find(p=>p.id===productId).plannedBoxes,3);

  const edits={eventId:draft.id,revision:current.event.productRevision,
    items:current.products.map(p=>({...p,titleKo:'행사 상품만 변경'}))};
  await assert.rejects(call('saveEventProducts',{...edits,eventId},otherStaff),failure);
  await call('saveEventProducts',edits);
  await assert.rejects(call('saveEventProducts',edits,otherStaff),failure);
  assert.equal((await call('getCatalog')).revision,unlimitedCatalog.revision);
  assert.equal((await call('getCatalog')).items[0].titleKo,'기본 상품');
  assert.equal((await call('dashboard',{eventId})).products[0].retailCents,450);
  // Removing reference products must never modify saved event copies or orders.
  const beforeCatalogDelete=await call('getCatalog');
  const remaining=beforeCatalogDelete.items.filter(p=>p.id!==productId);
  const afterCatalogDelete=await call('saveCatalog',{revision:beforeCatalogDelete.revision,items:remaining});
  assert.deepEqual(afterCatalogDelete.items.map(p=>p.id),remaining.map(p=>p.id));
  assert.ok(!(await call('getCatalog')).items.some(p=>p.id===productId));
  assert.ok((await call('getDraft',{id:loadedDraft.id})).draft.items.some(p=>p.id===productId));
  assert.ok((await call('dashboard',{eventId:draft.id})).products.some(p=>p.id===productId));
  assert.equal((await call('dashboard',{eventId})).orders.find(p=>p.id===receipt.id).totalCents,900);
  // Restore fixture catalog for later test cases, using the latest revision.
  await call('saveCatalog',{revision:afterCatalogDelete.revision,items:beforeCatalogDelete.items});

  const purchase={eventId:draft.id,vendor:'누리커넥트',revision:0,info:{date:'2026-11-27',number:'TEST-PO-1'},
    lines:[{id:productId,name:'상품',unit:'박스',qty:2,priceCents:700,amountCents:1400,ordered:13,per:12}]};
  const savedPurchase=await call('savePurchaseOrder',purchase);
  await assert.rejects(call('savePurchaseOrder',purchase,otherStaff),failure);
  const confirmed=await call('savePurchaseOrder',{...purchase,revision:savedPurchase.revision,confirm:true});
  await assert.rejects(call('savePurchaseOrder',{...purchase,revision:confirmed.revision}),failure);
  await assert.rejects(call('savePurchaseOrder',{...purchase,revision:confirmed.revision,confirmClosedEdit:true}),failure);
  assert.deepEqual((await call('listPurchaseOrders',{eventId:draft.id})).documents.map(d=>d.confirmed),[true]);

  delete process.env.BAZAAR_SMTP_HOST;
  const manual={eventId:draft.id,requestId:fresh(),source:'phone',name:'Phone Buyer',phone:buyer.phone,
    items:[{id:productId,qty:2,priceCents:650}]};
  await assert.rejects(call('createManualOrder',manual,{uid:'bazaar-member',token:{email_verified:true}}),{code:'permission-denied'});
  await assert.rejects(call('createManualOrder',{...manual,eventId}),failure);
  const phoneOrder=await call('createManualOrder',manual);
  assert.match(phoneOrder.orderRef,/^ASICC-TEL-/);
  assert.deepEqual(await call('createManualOrder',manual),phoneOrder);
  const orderRef=db.doc(`bazaarOrders/${phoneOrder.id}`);
  const original=(await orderRef.get()).data();
  assert.equal(original.source,'phone');
  assert.equal(original.email,'');
  assert.equal((await db.doc(`bazaarOutbox/${phoneOrder.id}_receipt`).get()).exists,false);
  const correction={eventId:draft.id,id:phoneOrder.id,revision:0,confirm:true,reason:'전화로 수량 확인',
    items:[{id:productId,qty:1}]};
  await assert.rejects(call('correctOrder',{...correction,reason:''}),{code:'invalid-argument'});
  await assert.rejects(call('correctOrder',{...correction,confirm:false}),{code:'invalid-argument'});
  await call('correctOrder',correction,otherStaff);
  await assert.rejects(call('correctOrder',correction),failure);
  const [history]=(await call('orderCorrections',correction)).history;
  assert.deepEqual(history.before,{items:original.items,totalCents:1300});
  assert.equal(history.after.totalCents,650);
  assert.equal(history.by,otherStaff.uid);
  await call('bankConfirm',{id:phoneOrder.id,eventId:draft.id});
  await assert.rejects(call('correctOrder',{...correction,revision:1,items:[{id:productId,qty:2}]}),failure);
  const additional=await call('createManualOrder',{...manual,requestId:fresh(),source:'additional',
    parentId:phoneOrder.id,email:'addon@example.test'});
  assert.match(additional.orderRef,/^ASICC-ADD-/);
  assert.notEqual(additional.id,phoneOrder.id);
  assert.equal((await db.doc(`bazaarOrders/${additional.id}`).get()).data().parentOrderRef,phoneOrder.orderRef);
  assert.equal((await db.doc(`bazaarOutbox/${additional.id}_receipt`).get()).exists,true);
  const additionalRecord=(await db.doc(`bazaarOrders/${additional.id}`).get()).data();
  await assert.rejects(bazaarBuyerAction.run({data:{id:additional.id,token:additionalRecord.buyerToken,action:'edit'}}),{code:'invalid-argument'});
  await call('bankConfirm',{id:additional.id,eventId:draft.id});
  assert.equal((await orderRef.get()).data().totalCents,650);

  await assert.rejects(call('finalizeUnpaid',{eventId:draft.id,confirm:false}),{code:'invalid-argument'});
  await assert.rejects(call('finalizeUnpaid',{eventId:draft.id,confirm:true}),{code:'invalid-argument'});
  delete process.env.BAZAAR_SMTP_HOST;
  const place=()=>bazaarCreateOrder.run({data:{...buyer,eventId:draft.id,requestId:fresh(),
    items:[{id:productId,qty:2,priceCents:650}]}});
  const paid=await place(), unpaid=await place();
  await bazaarBuyerAction.run({data:{id:unpaid.id,token:unpaid.token,action:'report'}});
  await call('bankConfirm',{id:paid.id,eventId:draft.id});
  await db.doc('bazaarMeta/event').update({
    orderCutoff:'2026-01-02T11:00:00.000Z',transferCutoff:'2026-01-02T17:00:00.000Z',
    finalizeNotBefore:'2026-01-05T08:00:00.000Z',
  });
  await bazaarReminders.run({});
  assert.equal((await db.doc(`bazaarOrders/${unpaid.id}`).get()).data().canceledAt,null);
  const final=await call('finalizeUnpaid',{eventId:draft.id,confirm:true});
  assert.equal(final.canceled,1);
  await assert.rejects(call('createManualOrder',{...manual,requestId:fresh()}),failure);
  assert.equal((await db.doc(`bazaarOrders/${unpaid.id}`).get()).data().cancelReason,'unpaidFinalization');
  assert.equal((await db.doc(`bazaarOrders/${paid.id}`).get()).data().canceledAt,null);
  assert.equal((await call('finalizeUnpaid',{eventId:draft.id,confirm:true})).canceled,0);
  assert.equal((await call('listPurchaseOrders',{eventId:draft.id})).documents[0].confirmed,true);

  const originalPaidOrder=(await db.doc(`bazaarOrders/${paid.id}`).get()).data();
  const adjustment={...purchase,revision:confirmed.revision,lines:[
    {...purchase.lines[0],qty:3,amountCents:2100},
    {id:'manual-extra',name:'전화로 추가 요청한 품목',unit:'박스',qty:1,priceCents:800,amountCents:800,manual:true},
  ]};
  await assert.rejects(call('savePurchaseOrder',adjustment),failure);
  const adjusted=await call('savePurchaseOrder',{...adjustment,confirmClosedEdit:true},otherStaff);
  assert.equal(adjusted.confirmed,true);
  assert.equal(adjusted.updatedBy,otherStaff.uid);
  assert.deepEqual(adjusted.lines.map(line=>[line.qty,line.amountCents]),[[3,2100],[1,800]]);
  await assert.rejects(call('savePurchaseOrder',{...adjustment,confirmClosedEdit:true}),failure);

  // Publish the next event, then add a vendor to the archived event.
  const nextEvent={...storedCopy.event,orderCutoff:new Date(Date.now()+3600000).toISOString(),
    transferCutoff:new Date(Date.now()+7200000).toISOString(),pickupKo:active.pickupKo,pickupFr:active.pickupFr};
  const nextDraft=await call('saveDraft',{id:storedCopy.id,updatedAt:storedCopy.updatedAt,event:nextEvent,items:storedCopy.items});
  process.env.BAZAAR_SMTP_HOST='localhost';
  await call('publishDraft',{id:storedCopy.id,updatedAt:nextDraft.updatedAt});
  const extra={...purchase,vendor:'추가 공급업체',revision:0,confirmClosedEdit:true};
  await call('savePurchaseOrder',extra);
  await assert.rejects(call('savePurchaseOrder',{...extra,eventId:'bazaar-unknown-event'}),failure);
  await assert.rejects(call('savePurchaseOrder',extra,{uid:'bazaar-member',token:{email_verified:true}}),{code:'permission-denied'});
  const docs=(await call('listPurchaseOrders',{eventId:draft.id})).documents;
  assert.equal(docs.length,2);
  assert.equal(docs.find(doc=>doc.vendor===purchase.vendor).revision,adjusted.revision);
  assert.equal((await call('listPurchaseOrders',{eventId:storedCopy.id})).documents.length,0);
  assert.deepEqual((await db.doc(`bazaarOrders/${paid.id}`).get()).data(),originalPaidOrder);
  const stored=(await db.collection('bazaarPurchaseOrders').where('eventId','==',draft.id).get()).docs.find(doc=>doc.data().vendor===purchase.vendor);
  assert.deepEqual((await stored.ref.collection('revisions').doc(String(confirmed.revision)).get()).data(),confirmed);
  assert.deepEqual((await shop(draft.id)).event,{eventId:draft.id,status:'closed'});

});
