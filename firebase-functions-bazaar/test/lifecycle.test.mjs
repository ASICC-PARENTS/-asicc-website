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
const { bazaarAdmin, bazaarCreateOrder, bazaarPublic } = await import('../index.mjs');
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
  assert.equal(draft.items[0].imageUrl,product.imageUrl);
  assert.equal(draft.items[0].retailCents,product.retailCents);
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
});
