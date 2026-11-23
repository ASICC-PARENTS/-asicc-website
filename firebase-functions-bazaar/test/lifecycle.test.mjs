import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deleteApp, getApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = 'demo-asicc-bazaar';
if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
  throw new Error('Run this test in the local Firestore emulator.');
}
initializeApp({ projectId });
const { bazaarAdmin, bazaarCreateOrder, bazaarPublic } = await import('../index.mjs');
const db = getFirestore();
after(() => deleteApp(getApp()));

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
    titleKo: '상품', titleFr: 'Produit', supplier: '누리커넥트', imageUrl: 'https://example.test/original.jpg',
    descriptionKo: '설명', descriptionFr: 'Description', storage: 'ambient', visible: true,
    retailCents: 450, packQty: 12, boxPriceTtcCents: 700, boxPriceHtCents: null,
    plannedBoxes: null, limitMode: 'unlimited', manualLimit: null, soldQty: 0, displayOrder: 1,
  };
  await db.doc('bazaarMeta/event').set(active);
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

  const draft = (await call('createDraft')).draft;
  const updates = {
    id: draft.id, updatedAt: draft.updatedAt,
    event: { ...active, nameKo: '다음 행사', nameFr: 'Vente suivante' },
    items: [{ ...product, id: productId, included: true, retailCents: 650, imageUrl: 'https://example.test/next.jpg' }],
  };
  const saved = await call('saveDraft', updates);
  await assert.rejects(call('saveDraft', updates), failure);
  process.env.BAZAAR_SMTP_HOST = 'localhost';
  process.env.BAZAAR_SMTP_USER = 'test@example.test';
  process.env.BAZAAR_SMTP_PASSWORD = 'emulator-only';
  await call('publishDraft', { id: draft.id, updatedAt: saved.updatedAt });
  assert.deepEqual((await shop(eventId)).event, { eventId, status: 'closed' });
  assert.equal((await shop(draft.id)).products[0].priceCents, 650);
  await assert.rejects(bazaarCreateOrder.run({ data: { ...buyer, requestId: randomBytes(16).toString('hex') } }), failure);
  const historical = await call('dashboard', { eventId });
  assert.equal(historical.readOnly, true);
  assert.equal(historical.products[0].retailCents, 450);
  assert.equal(historical.products[0].imageUrl, product.imageUrl);
  assert.equal(historical.products[0].boxPriceTtcCents, 700);
  assert.equal(historical.orders[0].totalCents, 900);
  assert.ok(historical.orders[0].bankConfirmedAt);
  assert.equal(historical.orders[0].buyerToken, undefined);
});
