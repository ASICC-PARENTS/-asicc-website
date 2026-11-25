import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('event expenses use an admin-only, revisioned record separate from event closure and purchase orders',async()=>{
  const service=await read('../firebase-functions-bazaar/bazaar/service.mjs');
  assert.match(service,/const eventFinancials=db\.collection\('bazaarEventFinancials'\)/);
  assert.match(service,/op==='saveEventExpenses'/);
  assert.match(service,/op==='finalizeEventFinancials'/);
  assert.match(service,/if\(old\.finalizedAt\)throw new HttpsError\('failed-precondition'/);
  assert.match(service,/eventArchives\.doc\(eventId\)/);
  assert.match(service,/eventFinancials\.doc\(planned\?'planned-'\+eventId:eventId\)/);
});

test('settlement UI keeps vendor purchase orders and adds independent event profit and expense controls',async()=>{
  const app=await read('../src/lib/bazaar/admin/app.js');
  assert.match(app,/전체 바자회 수익 결산/);
  assert.match(app,/예상 매출총이익/);
  assert.match(app,/상품 매입비용 TTC/);
  assert.match(app,/data-action="expense-add"/);
  assert.match(app,/data-action="profit-excel"/);
  assert.match(app,/data-action="profit-pdf"/);
  assert.match(app,/data-action="settlement-finalize"/);
  assert.match(app,/data-action="settlement-reopen"/);
  assert.match(app,/구매발주서 미리보기/);
});

test('French bazaar administrator route has translated shell and dynamic administration labels',async()=>{
  const screen=await read('../src/lib/bazaar/admin/Screen.astro');
  const locale=await read('../src/lib/bazaar/admin/i18n.js');
  assert.match(screen,/fr:'Gestion du bazar en ligne'/);
  assert.match(screen,/data-lang=\{lang\}/);
  assert.match(locale,/observeAdminLocale/);
  assert.match(locale,/Commandes par produit/);
  assert.match(locale,/Résultat global du bazar/);
});

test('product editor uses TTC-only costs, bidirectional selling prices and checks every row before saving',async()=>{
  const app=await read('../src/lib/bazaar/admin/app.js');
  const service=await read('../firebase-functions-bazaar/bazaar/service.mjs');
  assert.match(app,/모든 가격은 TTC 기준입니다/);
  assert.match(app,/매입가\/박스 TTC/);
  assert.match(app,/data-key="sale"/);
  assert.match(app,/if\(k!==\x27roi\x27\)margin\.value/);
  assert.match(app,/updateCalculatedPrice\(p,val\)/);
  assert.match(app,/필수입력 항목이 누락되었거나 유효하지 않은 상품/);
  assert.match(app,/현재 숨겨진 열입니다/);
  assert.match(app,/data-action="product-validation-focus"/);
  assert.match(service,/TTC 판매가격이 없거나 0 이하입니다/);
  assert.doesNotMatch(service,/out\.boxPriceTtcCents=Math\.round\(out\.boxPriceHtCents/);
});

test('product table exposes direct column gestures and buyer-row preview without a real order action',async()=>{
  const app=await read('../src/lib/bazaar/admin/app.js');
  assert.match(app,/h\.oncontextmenu=/);
  assert.match(app,/h\.ondrop=/);
  assert.match(app,/fitColumn\(table,names\[i\]\)/);
  assert.match(app,/data-col-menu="hide"/);
  assert.match(app,/data-col-menu="pin"/);
  assert.match(app,/renderShopProducts\(products\.map/);
  assert.match(await read('../src/pages/[lang]/bazaar/index.astro'),/renderShopProducts\(products,lang/);
  assert.doesNotMatch(app,/data-action="preview-add"/);
  assert.match(app,/changeCartQuantity\(previewCart/);
  assert.match(app,/class="bz-btn" disabled/);
});
