import {defaultHomePopup,normalizeHomePopup,publicHomePopup} from '../firebase-functions-bazaar/bazaar/home-popup.mjs';
import {eventFormFields,eventViewModel,productOrderSummary,validManualPhone} from '../src/lib/bazaar/admin/data.js';
import {validRefundIban} from '../firebase-functions-bazaar/bazaar/iban.mjs';
import {orderPaymentSummary} from '../firebase-functions-bazaar/bazaar/order-payments.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const screen=read('src/lib/bazaar/admin/Screen.astro');
const app=read('src/lib/bazaar/admin/app.js');
const mail=read('src/lib/bazaar/admin/mail.js');

test('bazaar dashboard returns to the homepage operations center and lists event states',()=>{
  assert.match(screen,/운영센터로 돌아가기/);
  assert.match(app,/현재 진행 중인 바자회가 없습니다\./);
  assert.match(app,/발행|진행 중/);
  assert.match(app,/all\.filter\(e=>matches\(e,key\)\)\.length/);
  for(const status of ["['draft','임시저장',","['published','진행 중',","['completed','종료',"])
    assert.ok(app.includes(status));
  assert.match(app,/data-action="new-event"/);
  assert.match(app,/data-action="event-filter"/);
});

test('draft creation supports prior event product copies and bulk catalog selection',()=>{
  assert.match(app,/지난 바자회 상품 복사/);
  assert.match(app,/request\('dashboard',\{eventId:\$\('#copy-products-from'\)\.value\}\)/);
  assert.match(app,/data-import-all/);
  assert.match(app,/data-action="import-apply"/);
});

test('product table supports direct ordering and operator-specific column preferences',()=>{
  assert.match(app,/\['순서','사진'/);
  assert.match(app,/data-action="product-up"/);
  assert.match(app,/data-sort-row/);
  assert.doesNotMatch(app,/data-action="reorder-products">진열 순서 변경/);
  assert.match(app,/data-column-pinned/);
  assert.match(app,/data-col-resize/);
  assert.match(app,/bazaar-cols-'.*currentUser\?\.uid/s);
});

test('planned purchase boxes stay editable independently of sales limit mode',()=>{
  assert.match(app,/data-key="boxes" value=/);
  assert.ok(!app.includes("catalog&&p.limitMode!=='auto'"));
  assert.ok(!app.includes("row.querySelector('[data-key=boxes]').disabled"));
  assert.ok(app.includes("limit.disabled=p.limitMode!=='manual'"));
});

test('past-event product import copies product fields into isolated product snapshots',()=>{
  assert.match(app,/지난 행사에서 가져오기/);
  assert.match(app,/request\('dashboard',\{eventId:selected\.id\}\)/);
  assert.match(app,/id:newId\(\),active:true/);
  assert.match(app,/주문, 고객, 입금 및 정산 기록은 복사하지 않습니다/);
  assert.match(app,/선택 상품 0개/);
});

test('product columns use stable IDs and allow individual hidden-column restore',()=>{
  assert.match(app,/data-column-id=/);
  assert.match(app,/dataset\.columnId\|\|`column-\$\{i\}`/);
  assert.match(app,/data-col-menu="restore"/);
  assert.match(app,/column-drop-before/);
  assert.match(app,/column-drop-after/);
  assert.match(app,/columns-desktop/);
  assert.match(app,/columns-mobile/);
});

test('buyer preview supports unsaved content, language and viewport controls without enabling orders',()=>{
  assert.match(app,/preview-draft-form/);
  assert.match(app,/data-action="preview-lang"/);
  assert.match(app,/data-action="preview-device"/);
  assert.doesNotMatch(app,/data-action="preview-(publish|save)"/);
  assert.match(app,/data-action="preview-edit"/);
  assert.match(app,/실제 주문·재고 차감·이메일 발송은 실행되지 않습니다/);
});

test('OVH recipient preparation retains deduplication, Bcc output and send history controls',()=>{
  assert.match(mail,/data-manual-order/);
  assert.match(mail,/data-order-select-all/);
  assert.match(mail,/webmail\.ovh\.net/);
  assert.match(mail,/숨은참조\(Bcc\)/);
  assert.match(mail,/new Set\(prepared\.map/);
  assert.match(mail,/completeManual/);
});

test('telephone review accepts French domestic and international input',()=>{
 for(const number of ['06 12 34 56 78','+33 6 12 34 56 78','06-12-34-56-78'])assert.equal(validManualPhone(number),true);
 for(const number of ['', 'abcdef', '06abc12345678', '1234'])assert.equal(validManualPhone(number),false);
});


test('event form saves absent or complete Paris date pairs',()=>{
 const values={'event-name':'  Draft  ','event-order-date':'2026-11-27','event-order-time':'18:00','event-transfer-date':'2026-11-27','event-transfer-time':'22:00'};
 const read=id=>values[id]||'';
 assert.deepEqual(eventFormFields(read),{
  paymentHours:'',orderStartsAt:'',orderCutoff:'2026-11-27T17:00:00.000Z',transferCutoff:'2026-11-27T21:00:00.000Z',
  pickupAt:'',pickupPlace:'',nameKo:'Draft',nameFr:'',introKo:'',introFr:'',pickupKo:'',pickupFr:'',beneficiary:'',iban:'',
 });
 values['event-pickup-date']='2026-11-28';
 assert.throws(()=>eventFormFields(read),/date et l’heure/);
 values['event-pickup-time']='09:00';
 assert.equal(eventFormFields(read).pickupAt,'2026-11-28T08:00:00.000Z');
});

test('order quantities keep partial cancellation history after full cancellation',()=>{
 const item=(qty,priceCents)=>({id:'sku',titleKo:'상품',titleFr:'Article',qty,priceCents});
 const event=eventViewModel({},[],[
  {id:'a',originalItems:[item(3,100)],canceledItems:[item(1,100)],items:[item(2,100)],canceledAt:'2026-11-22'},
  {id:'b',items:[item(2,125)]},
  {id:'c',items:[item(1,175)]},
 ]);
 const [row]=productOrderSummary(event.products,event.orders);
 assert.deepEqual([row.initialQty,row.canceledQty,row.qty,row.amountCents],[6,3,3,425]);
});

test('payment receipts distinguish partial, settled, surplus, and refund reservations',()=>{
 const order={totalCents:5000,bankConfirmedAt:'2026-11-25'};
 const cases=[[0,5000,0,false],[4000,1000,0,false],[5000,0,0,true],[6000,0,1000,true]];
 for(const [depositedCents,additionalDue,overpayment,settled] of cases){
  const value=orderPaymentSummary({...order,depositedCents});
  assert.deepEqual([value.additionalDue,value.overpayment,value.settled],[additionalDue,overpayment,settled]);
 }
 const reserved=orderPaymentSummary({...order,depositedCents:6000,reservedRefundCents:600});
 assert.deepEqual([reserved.net,reserved.refundDue,reserved.reservedRefund],[6000,1000,600]);
});

test('refund IBAN validation checks European registry lengths and mod-97',()=>{
 for(const iban of ['FR1420041010050500013M02606','DE89370400440532013000','BE68539007547034'])assert.equal(validRefundIban(iban),true);
 for(const iban of ['FR1520041010050500013M02606','FR1420041010050500013M0260','ZY1420041010050500013M02606'])assert.equal(validRefundIban(iban),false);
});

test('homepage popup is test-only by default and respects campaign schedule and order intake',()=>{
  const event={eventId:'bazaar-1234567890',status:'published'};
  const cfg=defaultHomePopup(event,true);
  assert.ok(normalizeHomePopup(cfg));
  assert.equal(publicHomePopup(cfg,event,'open').identity,event.eventId);
  assert.equal(publicHomePopup(cfg,event,'closed'),null);
  assert.equal(publicHomePopup(cfg,{...event,eventId:'bazaar-9876543210'},'open'),null);
  assert.equal(publicHomePopup(defaultHomePopup(event,false),event,'open'),null);
  assert.equal(publicHomePopup({...cfg,enabled:false},event,'open'),null);
  assert.equal(publicHomePopup({...cfg,startsAt:'2026-11-26T12:00:00.000Z'},event,'open',Date.parse('2026-11-25T12:00:00Z')),null);
  assert.equal(publicHomePopup({...cfg,endsAt:'2026-11-26T12:00:00.000Z'},event,'open',Date.parse('2026-11-26T12:00:00Z')),null);
  assert.ok(publicHomePopup({...cfg,bazaarOnly:false,link:'news/example/'},null,'closed'));
  assert.equal(normalizeHomePopup({...cfg,link:'javascript:alert(1)'}),null);
  assert.equal(normalizeHomePopup({...cfg,image1:'http://example.test/image.jpg'}),null);
  assert.equal(normalizeHomePopup({...cfg,startsAt:'2026-11-26T12:00:00.000Z',endsAt:'2026-11-25T12:00:00.000Z'}),null);
  const normalized=normalizeHomePopup({...cfg,privateData:'not public'});
  assert.equal(normalized.privateData,undefined);
});
test('homepage popup uses a native dismissible dialog and an uncached public request',()=>{
  const popup=read('src/components/HomePopup.astro');
  const worker=read('worker/bazaar/index.mjs');
  assert.match(popup,/<dialog id="home-popup"/);
  assert.match(popup,/showModal\(\)/);
  assert.match(popup,/data-popup-today/);
  assert.match(popup,/Europe\/Paris/);
  assert.match(worker,/data\.op!=='homePopup'/);
});

test('homepage popup and campaign copy prefer whole-word wrapping without truncation',()=>{
  const popup=read('src/components/HomePopup.astro');
  const campaign=read('src/components/HomeCampaigns.astro');
  assert.match(popup,/word-break:keep-all;overflow-wrap:break-word;hyphens:none/);
  assert.match(popup,/object-fit:contain/);
  assert.match(popup,/max-height:calc\(100dvh - 28px\);overflow:auto/);
  assert.match(campaign,/word-break:keep-all/);
  assert.match(campaign,/align-self:center/);
});

test('bulk removal is draft-only and published products use sales controls',()=>{
  assert.match(app,/const productSelection=new Set\(\)/);
  assert.match(app,/data-product-select-all/);
  assert.match(app,/data-product-select="/);
  assert.match(app,/data-action="product-select-invert"/);
  assert.match(app,/data-action="product-delete-selected"[\s\S]*?data-action="refresh-products"/);
  assert.match(app,/selectedVisibleProducts=\(\)=>shownProducts\(\)\.filter/);
  assert.match(app,/productSelection\.clear\(\);productFilter=el\.value/);
  assert.match(app,/canSelectProducts=\(\)=>productView==='event'&&selectedEvent\(\)\?\.status==='draft'/);
  assert.match(app,/rows=store\.products;/);
  assert.match(app,/querySelectorAll\('\[data-action=product-delete-selected\]'\)\.forEach/);
  assert.match(app,/selectedEvent\(\)\?\.status==='active'\?'product-sales':'delete-product'/);
  assert.match(app,/a==='delete-product'&&\(productView==='catalog'\|\|selectedEvent\(\)\?\.status==='draft'\)/);
  const service=read('firebase-functions-bazaar/bazaar/service.mjs');
  assert.match(service,/some\(doc=>!doc\.data\(\)\.archivedAt&&!ids\.includes\(doc\.id\)\)/);
  assert.match(service,/if\(data\.archive===true\)throw new HttpsError\('failed-precondition'/);
  assert.match(app,/productSelection\.clear\(\);markProductDirty\(\);rerender\(\)/);
  assert.match(app,/data-import-invert/);
  assert.match(app,/master\.indeterminate=n>0&&n<boxes\.length/);
});


test('first test bazaar uses the supplied one-image poster without changing future campaign defaults',()=>{
  const event={eventId:'bazaar-1795524749706-cf2ffb3aa60b',status:'published'};
  const p=defaultHomePopup(event,true);
  assert.equal(p.image1,'/popup-assets/asicc-bazaar-2026.webp');
  assert.equal(p.image2,'');
  assert.equal(p.bodyKo,'');
  assert.equal(p.bodyFr,'');
  assert.ok(normalizeHomePopup(p));
  assert.equal(publicHomePopup(p,event,'open').link,'bazaar/?event='+event.eventId);
  assert.equal(publicHomePopup(p,event,'closed'),null);
  assert.equal(publicHomePopup(defaultHomePopup(event,false),event,'open'),null);
  assert.notEqual(defaultHomePopup({...event,eventId:'bazaar-9876543210'},true).image1,p.image1);
  assert.equal(normalizeHomePopup({...p,image1:'/popup-assets/../secret.png'}),null);
  assert.equal(normalizeHomePopup({...p,image1:'//example.test/a.png'}),null);
  const html=read('src/components/HomePopup.astro');
  assert.match(html,/data-layout="poster"/);
  assert.match(html,/object-fit:contain/);
});

test('catalog opens as an independent dialog and refreshes only reference products',()=>{
  assert.match(app,/standaloneCatalog=page==='products'&&params\.has\('catalog'\)/);
  assert.match(app,/if\(standaloneCatalog\)\{\s+const catalog=await request\('getCatalog'\)/);
  assert.match(app,/app\.innerHTML=\(catalog\?'':eventHead\(\)\+tabs\(\)\)/);
  assert.match(app,/dialog\.showModal\(\)/);
  assert.match(app,/frame\.src=url\('products',''\)\+'\?catalog=1&popup=1'/);
  assert.match(app,/event\.origin!==location\.origin/);
  assert.match(app,/event\.source!==catalogFrame\?\.contentWindow/);
  assert.match(app,/if\(productDirty&&!confirm\(fr\?'Fermer sans enregistrer/);
  const close=app.slice(app.indexOf('async function finishCatalogClose'),app.indexOf('function closeStandaloneCatalog'));
  assert.match(close,/request\('getCatalog'\)/);
  assert.doesNotMatch(close,/await load\(|saveCatalog|saveDraft|saveEventProducts/);
  assert.match(read('src/lib/bazaar/admin/style.css'),/\.standalone-catalog \.site>header,\.standalone-catalog \.topline\{display:none\}/);
});

test('event list shows a persistent EV number and management actions without changing the order reference',()=>{
 const backend=read('firebase-functions-bazaar/bazaar/service.mjs');
 assert.ok(app.includes("['createdAt',fr?'Création':'생성일'],['managementNumber'"));
 assert.ok(app.includes("'EV'+String(number).padStart(4,'0')"));
 assert.ok(app.includes('data-action="list-event-delete"'));
 assert.ok(app.includes('data-action="list-event-archive"'));
 assert.ok(app.includes("request('deleteDraft',{id,confirm:true})"));
 assert.ok(app.includes("request('deleteClosedEvent',{eventId:id,name,confirm:true})"));
 assert.ok(backend.includes("db.doc('bazaarMeta/eventManagementSequence')"));
 assert.ok(backend.includes("db.collection('bazaarEventNumbers')"));
 assert.ok(backend.includes("return 'BZ'+String(serial).padStart(2,'0')+String(next).padStart(4,'0')"));
});
