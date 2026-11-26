import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createFirestore } from './firestore.mjs';
import { createPhotos } from './photos.mjs';
import { renderOrderEmail } from '../../firebase-functions-bazaar/bazaar/order-email.mjs';
import { createMail, mailFields } from './mail.mjs';

const project = 'demo-asicc-bazaar';
const origin = (process.env.ASICC_TEST_WORKER_URL || 'http://127.0.0.1:8787');
const firestore = (process.env.ASICC_TEST_FIRESTORE_URL || 'http://127.0.0.1:8080');
const authOrigin = (process.env.ASICC_TEST_AUTH_URL || 'http://127.0.0.1:9099')+'/identitytoolkit.googleapis.com/v1';
const db = createFirestore({ projectId: project, token: () => 'owner', emulator: firestore });
const eventId = 'bazaar-worker-integration';
const productId = 'test-product';
const id = () => randomBytes(16).toString('hex');
const when = offset => new Date(Date.now() + offset).toISOString();
const productRef = db.doc(`bazaarEventProjects/${eventId}/products/${productId}`);
const eventRef = db.doc('bazaarEventProjects/'+eventId);

async function call(route, data, token, expected = 200) {
  const { status, result } = await callTimed(route, data, token);
  assert.equal(status, expected, JSON.stringify(result));
  return result.data ?? result.error;
}

async function callTimed(route, data, token, ip, discardResponse = false) {
  const start = performance.now();
  const response = await fetch(`${origin}/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4321',
      ...(token && { Authorization: `Bearer ${token}` }), ...(ip && { 'CF-Connecting-IP': ip }) },
    body: JSON.stringify({ data })
  });
  if (discardResponse) await response.body.cancel();
  return { status: response.status, result: discardResponse ? null : await response.json(), elapsed: performance.now() - start };
}

async function authRequest(path, data, owner) {
  const response = await fetch(`${authOrigin}/${path}?key=demo-asicc-bazaar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner && { Authorization: 'Bearer owner' }) },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  assert.ok(response.ok, result.error?.message);
  return result;
}

async function identity(role, verified) {
  const email = `${id()}@example.test`;
  const password = id();
  const { localId } = await authRequest('accounts:signUp', { email, password, returnSecureToken: true });
  if (verified) await authRequest(`projects/${project}/accounts:update`, { localId, emailVerified: true }, true);
  await db.doc(`members/${localId}`).set({ role, status: 'approved' });
  const { idToken } = await authRequest('accounts:signInWithPassword', { email, password, returnSecureToken: true });
  return { localId, idToken };
}

async function until(check) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Timed out waiting for a queued update');
}

test('Worker API with Firebase emulators preserves checkout, admin, inventory, email and settlement', { timeout: 120000 }, async () => {
  const flush = await fetch(`${firestore}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' });
  assert.ok(flush.ok);
  const staff = await identity('admin', true);
  const unverified = await identity('admin', false);
  const member = await identity('member', true);
  const admin = (op, fields, expected) => call('bazaarAdmin', { op, ...fields }, staff.idToken, expected);
  await call('bazaarAdmin', { op: 'listEvents' }, undefined, 401);
  await call('bazaarAdmin', { op: 'listEvents' }, unverified.idToken, 403);
  await call('bazaarAdmin', { op: 'listEvents' }, member.idToken, 403);
  await db.doc('bazaarMeta/access').set({ adminUids: [] });
  await admin('listEvents', {}, 403);
  await db.doc('bazaarMeta/access').set({ adminUids: [staff.localId] });
  await admin('listEvents');
  const event = {
    eventId, serial: 1, status: 'published', nameKo: '행사', nameFr: 'Bazar',
    createdAt: when(-7200000), publishedAt: when(-3600000), orderCutoff: when(7200000),
    transferCutoff: when(14400000), finalizeNotBefore: when(-1000), pickupKo: '픽업', pickupFr: 'Retrait',
    beneficiary: 'ASICC', contactEmail: 'contact@example.test', iban: 'FR7612345678901234567890123'
  };
  await eventRef.set(event);
  const emptyFinancials=await admin('eventFinancials',{eventId});
  assert.deepEqual(emptyFinancials.expenses,[]);
  const directPhoto = await fetch(`${origin}/api/bazaarAdmin?eventId=${eventId}&id=${productId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${staff.idToken}` },
    body: new Uint8Array([1, 2, 3])
  });
  assert.equal(directPhoto.status, 400);
  assert.match((await directPhoto.json()).error.message, /JPEG/);
  await productRef.set({
    titleKo: '상품', titleFr: 'Produit', supplier: '테스트 업체', imageUrl: '', storage: 'ambient',
    visible: true, retailCents: 450, packQty: 12, boxPriceTtcCents: 700, limitMode: 'manual', plannedBoxes: 0,
    manualLimit: 1, soldQty: 0, displayOrder: 1
  });
  const shop = await call('bazaarPublic', { eventId });
  assert.equal(shop.products[0].stockRemaining, 1);
  assert.equal(shop.products[0].boxPriceTtcCents, undefined);
  // Published product records are immutable with respect to deletion, even with zero orders.
  await admin('saveEventProducts',{eventId,revision:0,items:[]},412);
  await admin('archiveProduct',{eventId,id:productId,archive:true},412);
  assert.equal((await productRef.get()).exists,true);
  await admin('setProductSales',{eventId,id:productId,revision:0,visible:false});
  assert.deepEqual((await call('bazaarPublic',{eventId})).products,[]);
  assert.equal((await productRef.get()).data().visible,false);
  await admin('setProductSales',{eventId,id:productId,revision:1,visible:true});
  assert.equal((await call('bazaarPublic',{eventId})).products[0].stockRemaining,1);
  // Independent emulator-only fixture: preserve the existing manual product and checkout tests.
  const cartonId='carton-confirm-fixture', cartonRef=db.doc(`bazaarEventProjects/${eventId}/products/${cartonId}`);
  await cartonRef.set({titleKo:'확정 테스트',titleFr:'Cartons',supplier:'Test',imageUrl:'',storage:'ambient',
    visible:true,retailCents:100,packQty:12,boxPriceTtcCents:900,limitMode:'box',plannedBoxes:4,soldQty:13,displayOrder:2});
  const fields={eventId,id:cartonId,revision:2,confirmed:true,expectedSoldQty:13,expectedBoxes:2};
  await admin('setCartonConfirmation',{...fields,expectedSoldQty:12},400);
  await admin('setCartonConfirmation',fields);
  assert.equal((await cartonRef.get()).data().plannedBoxes,2);
  assert.equal((await cartonRef.get()).data().cartonConfirmed,true);
  assert.equal((await call('bazaarPublic',{eventId})).products.find(p=>p.id===cartonId).stockRemaining,11);
  await admin('setCartonConfirmation',{...fields,confirmed:false},412);
  await admin('setCartonConfirmation',{...fields,revision:3,confirmed:false});
  assert.equal((await cartonRef.get()).data().plannedBoxes,2);
  assert.equal((await cartonRef.get()).data().cartonConfirmed,false);
  await cartonRef.delete();
  const buyer = { eventId, name: 'Test Buyer', phone: '0612345678', email: 'buyer@example.test',
    consent: true, lang: 'fr', items: [{ id: productId, qty: 1, priceCents: 450 }] };
  await call('bazaarCreateOrder', { ...buyer, requestId: id(), items: [{ ...buyer.items[0], priceCents: 1 }] }, undefined, 412);
  const bids = [{ ...buyer, requestId: id() }, { ...buyer, requestId: id() }];
  const results = await Promise.allSettled(bids.map(bid => call('bazaarCreateOrder', bid)));
  const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [{ ...result.value, bid: bids[index] }] : []);
  assert.equal(winners.length, 1, results.map(result => result.reason?.message).join('; '));
  const first = winners[0];
  const { bid, ...receipt } = first;
  assert.notEqual(receipt.id,bid.requestId);
  assert.equal(receipt.orderRef,'BZ010001');
  assert.equal(receipt.receiptMailStatus,'capture');
  assert.equal(receipt.pickupKo,event.pickupKo);
  assert.equal(receipt.pickupFr,event.pickupFr);
  assert.equal(receipt.transferCutoff,event.transferCutoff);
  assert.deepEqual(await call('bazaarCreateOrder', bid), receipt);
  assert.equal((await productRef.get()).data().soldQty, 1);
  await call('bazaarBuyerAction', { id: first.id, orderRef: first.orderRef, action: 'view' }, undefined, 400);
  await call('bazaarBuyerAction', { id: first.id, token: '0'.repeat(64), action: 'view' }, undefined, 403);
  const buyerAction = (order, action) => call('bazaarBuyerAction', { id: order.id, token: order.token, action, ackNoTransfer: true });
  const viewed=(await buyerAction(first,'view')).order;
  assert.deepEqual(Object.keys(viewed.items[0]).sort(),['priceCents','qty','titleFr','titleKo']);
  assert.equal(viewed.iban,event.iban);
  assert.equal(viewed.pickupKo,event.pickupKo);
  assert.equal(viewed.pickupFr,event.pickupFr);
  assert.equal(viewed.transferCutoff,event.transferCutoff);
  assert.equal(viewed.email,undefined);
  assert.equal(viewed.eventSnapshot,undefined);
  const legacyId=id(),legacyToken=randomBytes(32).toString('hex');
  const legacyRef=db.doc('bazaarOrders/'+legacyId);
  const legacyNumber='ASICC-26-LEGACY0001';
  await legacyRef.create({...((await db.doc('bazaarOrders/'+first.id).get()).data()),
    id:legacyId,buyerToken:legacyToken,orderRef:legacyNumber});
  try{
    const legacy=await buyerAction({id:legacyId,token:legacyToken},'view');
    assert.equal(legacy.order.orderRef,legacyNumber);
  }finally{
    const cleanup=db.batch();
    cleanup.delete(legacyRef);
    await cleanup.commit();
  }
  await buyerAction(first, 'cancel');
  await call('bazaarBuyerAction', { id: first.id, token: first.token, action: 'cancel', ackNoTransfer: true }, undefined, 412);
  assert.equal((await productRef.get()).data().soldQty, 0);
  const confirmed = await call('bazaarCreateOrder', { ...buyer, requestId: id() });
  assert.equal(confirmed.orderRef,'BZ010002');
  await buyerAction(confirmed, 'report');
  await admin('bankConfirm', { id: confirmed.id, eventId, requestId:id(), amountCents:confirmed.totalCents });
  await until(async () => (await admin('mailStatus', { id: confirmed.id })).messages.some(mail => mail.status === 'sent' && mail.type === 'confirmed'));
  const mail = await admin('mailStatus', { id: confirmed.id });
  assert.equal(mail.messages.filter(row => row.type === 'confirmed').length, 1);
  assert.equal((await db.doc(`bazaarOutbox/${confirmed.id}_reported`).get()).exists,false);
  assert.equal((await db.doc(`bazaarOutbox/${confirmed.id}_reminder3`).get()).exists,false);
  const obsolete=db.doc(`bazaarOutbox/${confirmed.id}_reminderFinal`);
  await db.doc(`bazaarMailPolicies/${eventId}`).set({reminderMode:'auto',bulkCancel:'manual',reminderAt:when(-1000)});
  await obsolete.set({...mailFields('reminderFinal',when(-1000)),orderId:confirmed.id,eventId,type:'reminderFinal',
    payload:{subject:'Previously prepared email'}});
  const cron = await fetch(`${origin}/__scheduled?cron=*`);
  assert.ok(cron.ok);
  assert.equal((await obsolete.get()).data().status, 'skipped');

  await productRef.update({ manualLimit: 30 });
  const phone = await admin('createManualOrder', { ...buyer, requestId: id(), source: 'phone', email: '' });
  const addition = await admin('createManualOrder', { ...buyer, requestId: id(), source: 'additional', parentId: phone.id });
  const correction = await admin('correctOrder', { id: phone.id, eventId, revision: 0, reason: 'Test correction',
    items: [{ id: productId, qty: 2 }], confirm: true });
  assert.equal(correction.totalCents, 900);
  assert.equal((await admin('orderCorrections', { id: phone.id, eventId })).history[0].revision, 1);
  assert.ok(addition.id);
  const manualFields={eventId,type:'reminderFinal',audience:'unpaid',ids:[first.id,confirmed.id,addition.id]};
  assert.deepEqual((await admin('mailManualPrepare',manualFields)).recipients.map(row=>row.id),[addition.id]);
  assert.equal((await db.doc(`bazaarOutbox/${addition.id}_reminderFinal`).get()).data().status,'manualReserved');
  await admin('mailJobAction',{eventId,id:`${addition.id}_reminderFinal`,action:'releaseManual'});
  assert.equal((await db.doc(`bazaarOutbox/${addition.id}_reminderFinal`).get()).exists,false);
  assert.deepEqual((await admin('mailManualPrepare',manualFields)).recipients.map(row=>row.id),[addition.id]);
  await admin('mailManualComplete',manualFields);
  assert.equal((await db.doc(`bazaarOutbox/${addition.id}_reminderFinal`).get()).data().status,'manualSent');
  assert.equal((await admin('mailManualPrepare',manualFields)).recipients.length,0);
  const savedPolicy=await admin('mailPolicy',{eventId,reminderMode:'auto',bulkCancel:'manual',
    reminderAt:new Date(Date.parse(event.orderCutoff)+60000).toISOString()});
  assert.equal(savedPolicy.policy.reminderMode,'auto');
  const scheduledOrder=db.doc(`bazaarOrders/${id()}`);
  const scheduledJob=db.doc(`bazaarOutbox/${scheduledOrder.id}_reminderFinal`);
  const reminderAt=when(-1000);
  await scheduledOrder.set({id:scheduledOrder.id,eventId,email:'scheduled@example.test',lang:'fr',orderRef:'TEST',
    totalCents:450,items:[],eventSnapshot:event});
  await db.doc(`bazaarMailPolicies/${eventId}`).update({reminderAt});
  await db.doc(`bazaarMailSchedules/${eventId}`).update({runAt:reminderAt});
  assert.ok((await fetch(`${origin}/__scheduled?cron=*`)).ok);
  assert.equal((await scheduledJob.get()).exists,false,'Legacy automatic reminder schedules must not send');
  const reminderFields={eventId,type:'reminderFinal',audience:'unpaid',ids:[scheduledOrder.id]};
  assert.equal((await admin('mailManualPrepare',reminderFields)).recipients.length,1);
  assert.equal((await admin('mailManualQueue',{...reminderFields,override:{introFr:'Texte de test'}})).recipients.length,1);
  assert.equal((await admin('mailManualQueue',reminderFields)).recipients.length,0);
  assert.ok((await fetch(origin+'/__scheduled?cron=*')).ok);
  const capturedReminder=(await scheduledJob.get()).data();
  assert.equal(capturedReminder?.status,'sent');
  assert.equal(capturedReminder.sentSnapshot.mode,'manual');
  assert.match(capturedReminder.sentSnapshot.text,/Texte de test/);
  await scheduledOrder.delete();
  for (let i = 0; i < 4; i++) await admin('createManualOrder', { ...buyer, requestId: id(), source: 'phone', email: '' });
  const purchase = { eventId, vendor: '테스트 업체', revision: 0,
    lines: [{ name: '상품', unit: '박스', qty: 1, priceCents: 700, amountCents: 700 }], info: {} };
  await admin('savePurchaseOrder', purchase);
  await admin('endEvent', { eventId, confirm: true });
  assert.equal((await call('bazaarPublic', { eventId })).event.status, 'closed');
  const savedExpenses=await admin('saveEventExpenses',{eventId,revision:0,expenses:[{id:'expense-test-0001',name:'테스트 지출',amountCents:1234}]});
  assert.equal(savedExpenses.revision,1);
  const closedFinancials=await admin('eventFinancials',{eventId});
  assert.equal(closedFinancials.expenses[0].amountCents,1234);
  assert.equal(closedFinancials.finalizedAt,null);
  await admin('finalizeEventFinancials',{eventId,action:'finalize',confirm:true},412);
  assert.equal((await admin('eventFinancials',{eventId})).finalizedAt,null);
  await call('bazaarCreateOrder',{...buyer,requestId:id()},undefined,412);
  assert.equal((await admin('savePurchaseOrder', { ...purchase, revision: 1, confirmClosedEdit: true })).revision, 2);
  await admin('finalizeUnpaid', { eventId, confirm: true },400);
  await eventRef.update({ orderCutoff: when(-2000), transferCutoff: when(-1000) });
  let result, count = 0, pages = 0;
  do {
    result = await admin('finalizeUnpaid', { eventId, confirm: true });
    count += result.canceled;
    pages++;
    assert.ok(pages <= 3);
  } while (result.pending);
  assert.equal(count, 6);
  assert.equal(pages, 2);
  assert.equal((await productRef.get()).data().soldQty, 1);
  assert.equal((await admin('finalizeUnpaid', { eventId, confirm: true })).canceled, 0);
  await call('bazaarBuyerAction',{id:confirmed.id,token:confirmed.token,action:'report'},undefined,412);
  await admin('createManualOrder',{...buyer,requestId:id(),source:'phone',email:''},412);
  const late=await admin('bankConfirm',{id:addition.id,eventId,requestId:id(),amountCents:addition.totalCents});
  assert.equal(late.needsReview,true);
  assert.equal((await db.doc(`bazaarOrders/${addition.id}`).get()).data().bankConfirmedAt,null);
  assert.equal((await admin('mailStatus',{id:addition.id})).latePayment,'pending');
  await admin('finalizeEventFinancials',{eventId,action:'finalize',confirm:true},412);
  const apply={id:addition.id,eventId,applyReview:true,requestId:id(),amountCents:addition.totalCents};
  const [firstPost,duplicatePost]=await Promise.all([admin('bankConfirm',apply),admin('bankConfirm',{...apply,requestId:id()})]);
  assert.equal([firstPost,duplicatePost].filter(result=>result.changed).length,1);
  assert.equal((await admin('bankConfirm',apply)).changed,false);
  assert.equal((await admin('mailStatus',{id:addition.id})).latePayment,'posted');
  const posted=await admin('orderPayments',{id:addition.id,eventId});
  assert.equal(posted.records.length,1);
  assert.equal(posted.payment.refundDue,addition.totalCents);
  assert.ok((await db.doc(`bazaarOrders/${addition.id}`).get()).data().canceledAt);
  assert.equal((await productRef.get()).data().soldQty,1);
  await admin('recordOrderPayment',{id:addition.id,eventId,requestId:id(),amountCents:addition.totalCents,type:'refund',reason:'Synthetic late deposit refund'});
  assert.equal((await db.doc(`bazaarOutbox/${addition.id}_bulkCancel`).get()).exists,false);
  await admin('savePurchaseOrder',{...purchase,revision:2,confirm:true,confirmClosedEdit:true,info:{number:'PO-TEST',date:'2026-11-25'}});
  const upload=async name=>{
    const endpoint=`${origin}/api/bazaarAdmin?`+new URLSearchParams({upload:'evidence',eventId,name});
    const reply=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream',Authorization:'Bearer '+staff.idToken},
      body:Buffer.from('%PDF-1.4\nSynthetic fixture '+name)});
    const body=await reply.json();
    assert.equal(reply.status,200,JSON.stringify(body));
    return body.data;
  };
  const purchaseProof=await admin('saveEvidence',{eventId,id:id(),revision:1,scope:'purchase',kind:'invoice',vendor:purchase.vendor,
    date:'2026-11-25',paymentStatus:'paid',amountCents:700,paidCents:700,files:[await upload('invoice.pdf')]});
  const expenseProof=await admin('saveEvidence',{eventId,id:id(),revision:purchaseProof.revision,scope:'expense',kind:'receipt',expenseId:'expense-test-0001',
    date:'2026-11-25',paymentStatus:'paid',amountCents:1234,paidCents:1234,files:[await upload('expense.pdf')]});
  const costConfirmation=await admin('confirmPurchaseCosts',{eventId,revision:expenseProof.revision,confirm:true});
  const finalFinancials=await admin('finalizeEventFinancials',{eventId,action:'finalize',confirm:true});
  assert.ok(finalFinancials.finalizedAt);
  assert.deepEqual([finalFinancials.snapshot.salesCents,finalFinancials.snapshot.purchaseCents,finalFinancials.snapshot.expenseCents],[450,700,1234]);
  assert.equal(finalFinancials.revision,costConfirmation.revision+1);
  await admin('saveEventExpenses',{eventId,revision:finalFinancials.revision,expenses:[]},412);
  await admin('finalizeEventFinancials',{eventId,action:'reopen',confirm:true,reason:'Synthetic correction'});
  assert.equal((await admin('eventFinancials',{eventId})).finalizedAt,null);
  const overview=await admin('mailOverview',{eventId});
  assert.ok(overview.messages.some(row=>row.status==='manualSent'));
  assert.equal(overview.budget.acceptedToday,0);
  const priorListing=await admin('listEvents');
  const draft = (await admin('createDraft')).draft;
  assert.ok(Number.isSafeInteger(draft.managementNumber)&&draft.managementNumber>0);
  const listingWithDraft=await admin('listEvents');
  assert.equal(listingWithDraft.drafts.find(d=>d.id===draft.id).managementNumber,draft.managementNumber);
  for(const previous of priorListing.events){
    assert.equal(listingWithDraft.events.find(e=>e.id===previous.id).managementNumber,previous.managementNumber);
  }
  await admin('deleteDraft', { id: draft.id, confirm: true });
  const afterDelete=(await admin('createDraft')).draft;
  assert.ok(afterDelete.managementNumber>draft.managementNumber);
  assert.equal((await db.doc('bazaarEventNumbers/'+draft.id).get()).data().number,draft.managementNumber);
  await admin('deleteDraft',{id:afterDelete.id,confirm:true});
});

test('B2 transport mock isolates object keys and exposes posted photos only', async () => {
  const scope = { eventId, status: 'published' };
  const product = { visible: true, retailCents: 450 };
  const objects = new Map();
  const photos = createPhotos({
    BAZAAR_MODE: 'test', BAZAAR_PHOTO_SIGNING_KEY: 'only-for-local-photo-tests',
    B2_S3_ENDPOINT: 'https://s3.test.backblazeb2.com', B2_BUCKET: 'test-bucket', B2_KEY_ID: 'test-id', B2_APPLICATION_KEY: 'test-key'
  }, { doc: path => path, getAll: async () => [{ data: () => scope }, { data: () => product }] }, origin, null,
  async (url, init) => {
    const path = new URL(url).pathname;
    assert.match(path, /^\/test-bucket\/bazaar\/test\/photos\/[a-f0-9]{64}$/);
    assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(init.redirect, 'manual');
    if (init.method !== 'PUT') assert.equal(Object.hasOwn(init, 'body'), false);
    if (init.method === 'PUT') objects.set(path, { bytes: init.body, type: init.headers['content-type'] });
    const entry = objects.get(path);
    return new Response(init.method === 'GET' ? entry?.bytes : null, {
      status: entry ? 200 : 404, headers: entry ? { 'Content-Type': entry.type } : {}
    });
  });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7hoAAAAASUVORK5CYII=';
  const saved = await photos.storePhoto(eventId, productId, { content: png });
  assert.equal((await photos.serve(new URL(saved.imageUrl))).status, 404);
  const preview = photos.preview(saved);
  assert.equal((await photos.serve(new URL(preview.imageUrl))).status, 200);
  Object.assign(product, saved);
  assert.equal((await photos.serve(new URL(saved.imageUrl))).headers.get('Content-Type'), 'image/png');
  const copied = await photos.storePhoto('another-event-123', productId, { sourcePath: saved.photoPath });
  assert.notEqual(copied.photoPath, saved.photoPath);
  assert.equal(objects.size, 1);
  scope.status = 'closed';
  assert.equal((await photos.serve(new URL(saved.imageUrl))).status, 404);
  assert.equal((await photos.serve(new URL(preview.imageUrl))).status, 200);
});

test('Brevo retries quota-limited delivery with one idempotency key and a test-only recipient', async () => {
  const orderId = id();
  const job = db.doc(`bazaarOutbox/${orderId}_receipt`);
  await db.doc(`bazaarOrders/${orderId}`).set({ id: orderId, email: 'synthetic-customer@example.test' });
  await job.set({ ...mailFields(), orderId, type: 'receipt', attempts: 0 });
  const observed = [];
  const mail = createMail({
    BAZAAR_MODE: 'test', MAIL_MODE: 'api', MAIL_PROVIDER: 'brevo', BAZAAR_MAIL_FROM: 'sender@example.test',
    BAZAAR_MAIL_API_KEY: 'test-api-key', TEST_MAIL_TO: 'sink@example.test'
  }, db, async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    const { headers, messageVersions } = JSON.parse(init.body);
    observed.push(headers.idempotencyKey);
    assert.deepEqual(messageVersions[0].to, [{ email: 'sink@example.test' }]);
    return observed.length === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '60' } })
      : Response.json({ messageIds: ['test-message'] });
  });
  const message = () => ({ subject: 'Test only', html: '<p>Test</p>', text: 'Test' });
  assert.equal(await mail.deliver(job.id, message), false);
  assert.equal((await job.get()).data().status, 'delayed');
  assert.equal(await mail.deliver(job.id, message), false);
  await job.update({ dueAt: when(-100) });
  const counter = db.doc('bazaarMailUsage/brevo-rolling');
  await counter.update({ pauseUntil: 0 });
  assert.equal(await mail.deliver(job.id, message), true);
  assert.equal(await mail.deliver(job.id, message), false);
  assert.equal(observed.length, 2);
  assert.equal(observed[0], observed[1]);
  assert.equal((await job.get()).data().status, 'sent');
  assert.equal((await counter.get()).data().slots.length,2);
  await counter.set({slots:Array.from({length:250},()=>({at:Date.now()}))});
  await db.doc(`bazaarOrders/${orderId}`).update({bankConfirmedAt:when(-1000),totalCents:500,depositedCents:500});
  const limited = db.doc(`bazaarOutbox/${orderId}_confirmed`);
  await limited.set({ ...mailFields('confirmed'), orderId, type: 'confirmed' });
  assert.equal(await mail.deliver(limited.id, message), false);
  assert.equal((await limited.get()).data().lastError, 'free-plan-limit');
  assert.equal(observed.length, 2);
  const urgent=db.doc(`bazaarOutbox/${orderId}_cancel`);
  await urgent.set({...mailFields('cancel'),orderId,type:'cancel'});
  assert.equal(await mail.deliver(urgent.id,message),true);
  assert.equal((await mail.budget()).totalRemaining,49);
  await counter.set({slots:Array.from({length:300},()=>({at:Date.now()}))});
  const capped=db.doc(`bazaarOutbox/${orderId}_receipt2`);
  await capped.set({...mailFields('receipt'),orderId,type:'receipt'});
  assert.equal(await mail.deliver(capped.id,message),false);
  assert.equal(observed.length,3);
  await counter.set({slots:Array.from({length:299},()=>({at:Date.now()}))});
  const competing=['slot-a','slot-b'].map(suffix=>db.doc(`bazaarOutbox/${orderId}_${suffix}`));
  await Promise.all(competing.map(ref=>ref.set({...mailFields('receipt'),orderId,type:'receipt'})));
  assert.equal((await Promise.all(competing.map(ref=>mail.deliver(ref.id,message)))).filter(Boolean).length,1);
  assert.equal(observed.length,4);
  await counter.set({slots:[]});
  const uncertain=db.doc(`bazaarOutbox/${orderId}_uncertain`);
  await uncertain.set({...mailFields('receipt'),orderId,type:'receipt'});
  let failedCalls=0;
  const fault=createMail({BAZAAR_MODE:'test',MAIL_MODE:'api',MAIL_PROVIDER:'brevo',BAZAAR_MAIL_FROM:'sender@example.test',
    BAZAAR_MAIL_API_KEY:'test-api-key',TEST_MAIL_TO:'sink@example.test'},db,async()=>{
    failedCalls++;
    return new Response('{}',{status:503});
  });
  assert.equal(await fault.deliver(uncertain.id,message),false);
  assert.equal(await fault.deliver(uncertain.id,message),false);
  assert.equal(failedCalls,1);
  assert.equal((await uncertain.get()).data().deliveryUncertain,true);
});

test('direct Brevo rehearsal delivers only new test orders to an approved entered address', async () => {
  const eventId='test-mail-scope-'+id();
  const since=when(-60000);
  const sent=[];
  const mail=createMail({
    BAZAAR_MODE:'test',FIREBASE_PROJECT_ID:'asicc-bazaar-test',MAIL_MODE:'api',MAIL_PROVIDER:'brevo',
    BAZAAR_MAIL_FROM:'sender@example.test',BAZAAR_MAIL_API_KEY:'mock',TEST_MAIL_TO:'override@example.test',
    BAZAAR_TEST_MAIL_SINCE:since,BAZAAR_TEST_MAIL_RECIPIENTS:'new-buyer@example.test'
  },db,async (url,options)=>{
    assert.equal(url,'https://api.brevo.com/v3/smtp/email');
    sent.push(JSON.parse(options.body));
    return Response.json({messageId:'mock-test-delivery'},{status:201});
  });
  const orderId=id();
  const order=db.doc('bazaarOrders/'+orderId);
  const previous=db.doc('bazaarOutbox/'+orderId+'_old');
  const fresh=db.doc('bazaarOutbox/'+orderId+'_new');
  const job={...mailFields('receipt',when(-1000)),orderId,eventId,type:'receipt',createdAt:when(-120000)};
  const template=(order,type,event,template,change,options)=>renderOrderEmail({order,type,event,template,change,...options,site:'https://example.test'});
  await order.set({id:orderId,eventId,lang:'fr',orderRef:'BZ010001',buyerToken:id()+id(),totalCents:500,email:'new-buyer@example.test',createdAt:when(-120000)});
  await previous.set(job);
  await fresh.set({...job,createdAt:when(-1000)});
  assert.equal(await mail.deliver(previous.id,template),false);
  assert.equal(await mail.deliver(fresh.id,template),false);
  assert.equal(sent.length,0);
  await order.update({createdAt:when(-1000)});
  await fresh.set({...job,createdAt:when(-1000)});
  assert.equal(await mail.deliver(fresh.id,template),true);
  assert.equal(await mail.deliver(fresh.id,template),false);
  assert.equal(sent.length,1);
  assert.equal(sent[0].subject,'[TEST] [ASICC] Commande reçue · BZ010001');
  assert.equal(sent[0].messageVersions[0].to[0].email,'new-buyer@example.test');
  assert.match(sent[0].textContent,/Aucun virement/);
  assert.match(sent[0].htmlContent,/^<!doctype html>[\s\S]*<table/);
  assert.doesNotMatch(sent[0].htmlContent,/<pre\b/i);
  assert.match(sent[0].htmlContent,/https:\/\/example\.test\/bazaar-email-wordmark\.png/);
  assert.match(sent[0].htmlContent,/width="160" height="59"/);
  assert.match(sent[0].htmlContent,/-webkit-text-size-adjust:100%/);
  assert.match(sent[0].htmlContent,/\.mail-copy\{font-size:12px!important\}/);
  assert.match(sent[0].htmlContent,/\.mail-reference\{font-size:16px!important;white-space:nowrap!important/);
  assert.match(sent[0].htmlContent,/<strong class="mail-reference" style="[^"]*white-space:nowrap;[^"]*">BZ010001<\/strong>/);
  assert.match(sent[0].htmlContent,/class="mail-reference"[^>]*>BZ010001<\/td>/);
  assert.match(sent[0].htmlContent,/class="mail-title" style="[^"]*font-size:17px/);

  assert.doesNotMatch(sent[0].htmlContent,/bazaar-email-logo\.png|>ASICC<\/div>/);
  assert.match(sent[0].htmlContent,/Association de la Section Internationale Coréenne à Courbevoie/);
  const rejected=db.doc('bazaarOutbox/'+orderId+'_unapproved');
  await order.update({email:'unapproved@example.test'});
  await rejected.set({...job,createdAt:when(-1000)});
  assert.equal(await mail.deliver(rejected.id,template),false);
  assert.equal(sent.length,1);
  assert.equal((await rejected.get()).data().lastError,'test-recipient-not-approved');
  const disabled=createMail({BAZAAR_MODE:'test',FIREBASE_PROJECT_ID:'asicc-bazaar-test',MAIL_MODE:'api',
    MAIL_PROVIDER:'brevo',BAZAAR_MAIL_FROM:'sender@example.test',BAZAAR_MAIL_API_KEY:'mock',
    BAZAAR_TEST_MAIL_SINCE:since},db,async()=>{throw Error('Unexpected provider call');});
  assert.equal(disabled.canSend(),false);
});

test('concurrent checkouts preserve stock, receipts and administrator changes', { timeout: 150000 }, async t => {
  const fixtureEvent = 'bazaar-stock-' + id();
  const eventRef = db.doc('bazaarEventProjects/'+fixtureEvent);
  const staff = await identity('admin', true);
  const accessRef = db.doc('bazaarMeta/access');
  const [previousEvent, previousAccess] = await db.getAll(eventRef, accessRef);
  const createdProducts = [];
  t.after(async () => {
    const [orders, receipts, active] = await Promise.all([
      db.collection('bazaarOrders').where('eventId', '==', fixtureEvent).get(),
      db.collection('bazaarOutbox').where('eventId', '==', fixtureEvent).get(),
      eventRef.get()
    ]);
    const deleteRefs = new Map([...orders.docs, ...receipts.docs].map(snapshot => [snapshot.ref.name, snapshot.ref]));
    for (const ref of createdProducts) deleteRefs.set(ref.name, ref);
    const counter = db.doc('bazaarOrderSequences/' + fixtureEvent);
    deleteRefs.set(counter.name, counter);
    deleteRefs.set(db.doc('members/' + staff.localId).name, db.doc('members/' + staff.localId));
    const refs = [...deleteRefs.values()];
    const commitCleanup = async batch => {
      for (let attempt = 0; ; attempt++) {
        try { await batch.commit(); return; }
        catch (error) {
          const message = String(error?.message || '');
          const status = String(error?.status || '');
          const transient = /lock timeout|aborted|deadline exceeded|temporarily unavailable/i.test(message + ' ' + status);
          if (!transient || attempt >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    };
    for (let offset = 0; offset < refs.length; offset += 50) {
      const cleanup = db.batch();
      for (const ref of refs.slice(offset, offset + 50)) cleanup.delete(ref);
      await commitCleanup(cleanup);
    }
    const restore = db.batch();
    if (active.data()?.eventId === fixtureEvent) {
      if (previousEvent.exists) restore.set(eventRef, previousEvent.data());
      else restore.delete(eventRef);
    }
    if (previousAccess.exists) restore.set(accessRef, previousAccess.data());
    else restore.delete(accessRef);
    await commitCleanup(restore);
    await authRequest('projects/' + project + '/accounts:delete', { localId: staff.localId }, true);
  });
  await accessRef.set({ adminUids: [staff.localId] });
  await eventRef.set({
    eventId: fixtureEvent, serial: 2, status: 'published', scopedProducts: true, orderCutoff: when(300000),
    transferCutoff: when(600000), beneficiary: 'Synthetic fixture', iban: 'FR7612345678901234567890123'
  });
  const preset = {
    titleKo: '테스트 품목', titleFr: 'Produit test', supplier: 'K커머셜', imageUrl: '', storage: 'ambient',
    visible: true, retailCents: 450, packQty: 12, boxPriceTtcCents: 700, limitMode: 'manual', plannedBoxes: 0,
    soldQty: 0, displayOrder: 1, bazaarEventId: fixtureEvent
  };
  const createProduct = async limit => {
    const ref = db.collection('bazaarEventProjects/'+fixtureEvent+'/products').doc('stock-' + id());
    await ref.create({ ...preset, manualLimit: limit });
    createdProducts.push(ref);
    return ref;
  };
  const buyer = (...products) => ({
    eventId: fixtureEvent, requestId: id(), name: 'Synthetic Buyer', phone: '0612345678', email: 'buyer@example.test',
    consent: true, lang: 'fr', items: products.map(ref => ({ id: ref.id, qty: 1, priceCents: 450 }))
  });
  let address = 0;
  const submit = (payload, discardResponse = false) => callTimed('bazaarCreateOrder', payload, undefined, '192.0.2.' + ++address, discardResponse);
  const failures = [];
  function record(label, rows, expected) {
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    const averageMs = Math.round(rows.reduce((total, row) => total + row.elapsed, 0) / rows.length);
    console.log(JSON.stringify({ label, counts, averageMs, maxMs: Math.round(Math.max(...rows.map(row => row.elapsed))) }));
    try { assert.deepEqual(counts, expected, label); } catch (error) { failures.push(error.message); }
  }
  async function checkReceipts(rows) {
    const ids = [...new Set(rows.flatMap(row => row.result.data?.id ? [row.result.data.id] : []))];
    assert.ok((await db.getAll(...ids.map(orderId => db.doc('bazaarOutbox/' + orderId + '_receipt'))))
      .every(doc => doc.data()?.type === 'receipt'));
    return ids;
  }
  let expectedOrders = 0;
  for (const [label, stock, number, expected] of [
    ['stock 1 / 3', 1, 3, { 200: 1, 412: 2 }], ['stock 5 / 10', 5, 10, { 200: 5, 412: 5 }],
    ['sufficient stock / 10', 20, 10, { 200: 10 }]
  ]) {
    const product = await createProduct(stock);
    const rows = await Promise.all(Array.from({ length: number }, () => submit(buyer(product))));
    record(label, rows, expected);
    for (const row of rows.filter(row => row.status === 412)) {
      assert.deepEqual(row.result.error.details, { reason: 'stock', productId: product.id, available: 0 });
    }
    const accepted = await checkReceipts(rows);
    expectedOrders += accepted.length;
    assert.equal((await product.get()).data().soldQty, accepted.length);
    assert.ok(accepted.length <= stock);
  }
  const bundled = [await createProduct(1), await createProduct(3)];
  const bundleRows = await Promise.all(Array.from({ length: 3 }, () => submit(buyer(...bundled))));
  record('multiple products / 3', bundleRows, { 200: 1, 412: 2 });
  const bundleIds = await checkReceipts(bundleRows);
  expectedOrders += bundleIds.length;
  for (const ref of bundled) assert.equal((await ref.get()).data().soldQty, bundleIds.length);

  const repeated = await createProduct(5);
  const payload = buyer(repeated);
  const clicks = await Promise.all([submit(payload), submit(payload), submit(payload)]);
  record('duplicate clicks / 3', clicks, { 200: 3 });
  const original = clicks.find(row => row.status === 200)?.result.data;
  assert.ok(original);
  for (const row of clicks.filter(row => row.status === 200)) assert.deepEqual(row.result.data, original);
  assert.deepEqual(await checkReceipts(clicks), [original.id]);
  expectedOrders++;

  const lostProduct = await createProduct(3);
  const lostRequest = buyer(lostProduct);
  const discarded = await submit(lostRequest, true);
  const savedId = createHash('sha256').update('bazaar-order:' + lostRequest.requestId).digest('hex').slice(0, 32);
  const stored = (await db.doc('bazaarOrders/' + savedId).get()).data();
  assert.ok(stored);
  const recovered = await submit(lostRequest);
  record('discarded response and retry', [discarded, recovered], { 200: 2 });
  assert.equal(recovered.result.data.id, savedId);
  assert.equal(recovered.result.data.token, stored.buyerToken);
  assert.equal(recovered.result.data.orderRef, stored.orderRef);
  await checkReceipts([recovered]);
  assert.equal((await lostProduct.get()).data().soldQty, 1);
  expectedOrders++;

  const cancel = () => callTimed('bazaarBuyerAction', { id: original.id, token: original.token, action: 'cancel', ackNoTransfer: true });
  record('repeat cancellations / 2', [await cancel(), await cancel()], { 200: 1, 412: 1 });
  assert.equal((await repeated.get()).data().soldQty, 0);

  const edited = await createProduct(2);
  const invalidEdit = await callTimed('bazaarAdmin', {
    op: 'saveProduct', eventId: fixtureEvent, id: edited.id,
    product: { ...preset, plannedBoxes: undefined, manualLimit: undefined }
  }, staff.idToken);
  assert.equal(invalidEdit.status, 400);
  assert.deepEqual(invalidEdit.result.error, {
    code: 'invalid-argument',
    message: '수동 입력 방식은 최대 판매수량을 입력해 주세요.'
  });
  const [saved, bought] = await Promise.all([
    callTimed('bazaarAdmin', { op: 'saveProduct', eventId: fixtureEvent, id: edited.id, product: { ...preset, plannedBoxes: null, manualLimit: 1 } }, staff.idToken),
    submit(buyer(edited))
  ]);
  record('administrator stock update and checkout', [saved, bought], { 200: 2 });
  await checkReceipts([bought]);
  expectedOrders += bought.status === 200 ? 1 : 0;
  const finalProduct = (await edited.get()).data();
  assert.equal(finalProduct.manualLimit, saved.status === 200 ? 1 : 2);
  assert.equal(finalProduct.soldQty, bought.status === 200 ? 1 : 0);
  // Real competing operations: confirm one carton or accept a 12-unit order, never both.
  const carton = await createProduct(2);
  await carton.update({limitMode:'box',plannedBoxes:2,manualLimit:null});
  const firstCartonOrder=await submit(buyer(carton));
  assert.equal(firstCartonOrder.status,200);
  await checkReceipts([firstCartonOrder]);expectedOrders++;
  const revision=(await eventRef.get()).data().productRevision??0;
  const large=buyer(carton);large.items[0].qty=12;
  const [fixed,largeOrder]=await Promise.all([
    callTimed('bazaarAdmin',{op:'setCartonConfirmation',eventId:fixtureEvent,id:carton.id,revision,confirmed:true,expectedSoldQty:1,expectedBoxes:1},staff.idToken),
    submit(large)
  ]);
  assert.ok(fixed.status===200||fixed.status===400,JSON.stringify(fixed.result));
  assert.ok(largeOrder.status===200||largeOrder.status===412,JSON.stringify(largeOrder.result));
  assert.notEqual(fixed.status===200,largeOrder.status===200,'Only one conflicting operation may succeed');
  const fixedProduct=(await carton.get()).data();
  assert.ok(fixedProduct.soldQty<=fixedProduct.packQty*fixedProduct.plannedBoxes);
  if(largeOrder.status===200){await checkReceipts([largeOrder]);expectedOrders++;}
  if(fixed.status===200){
    assert.equal(fixedProduct.cartonConfirmed,true);
    assert.equal(fixedProduct.plannedBoxes,1);
    const forbidden=await callTimed('bazaarAdmin',{op:'saveProduct',eventId:fixtureEvent,id:carton.id,product:{...fixedProduct,plannedBoxes:2}},staff.idToken);
    assert.equal(forbidden.status,400);
  }
  const orders = await db.collection('bazaarOrders').where('eventId', '==', fixtureEvent).get();
  const queue = await db.collection('bazaarOutbox').where('eventId', '==', fixtureEvent).get();
  assert.equal(orders.size, expectedOrders);
  assert.deepEqual(orders.docs.map(doc => doc.data().orderRef).sort(),
    Array.from({length:expectedOrders}, (_,i) => 'BZ02' + String(i + 1).padStart(4,'0')));
  assert.equal(queue.docs.filter(job => job.data().type === 'receipt').length, orders.size);
  assert.equal(queue.docs.filter(job => job.data().type === 'cancel').length, 1);
  assert.deepEqual(failures, []);
});

test('compact email keeps Korean and French quantity headers and values on one line',()=>{
  for(const lang of ['ko','fr']){
    const order={id:'fixture-order',lang,orderRef:'BZ010007',buyerToken:'fixture-token',name:'Test',
      totalCents:6500,items:[{titleKo:'부뚜막 포기김치 8kg (4kg×2)',titleFr:'Kimchi de chou Bbutumak 8 kg',qty:1,priceCents:6500}]};
    const rendered=renderOrderEmail({order,type:'receipt',event:{},site:'https://example.test',testMode:true,canCancel:true});
    const header=rendered.html.match(/<th[^>]*class="mail-product-label mail-qty-label"[^>]*>[^<]*<\/th>/)?.[0];
    assert.ok(header);
    assert.match(header,/width="16%"/);
    assert.match(header,/nowrap="nowrap"/);
    assert.match(header,/white-space:nowrap/);
    assert.ok(header.endsWith((lang==='ko'?'수량':'Qté')+'</th>'));
    assert.match(rendered.html,/<td style="[^"]*white-space:nowrap;[^"]*" class="mail-product-qty" nowrap="nowrap">1<\/td>/);
    assert.match(rendered.html,/<td style="[^"]*word-break:keep-all;[^"]*" class="mail-product-name">/);
    assert.match(rendered.html,/width="160" height="59"/);
    assert.match(rendered.html,/class="mail-reference"[^>]*>BZ010007<\/strong>/);
    assert.match(rendered.html,/focus=report/);
    assert.match(rendered.html,/focus=cancel/);
  }
});
