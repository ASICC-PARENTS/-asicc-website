import assert from 'node:assert/strict';
import test from 'node:test';
import {changeCartQuantity,renderShopEvent,renderShopProducts,stockNotice} from '../src/lib/bazaar/shop-view.js';
import {autoMailAllowed} from '../worker/bazaar/mail-policy.mjs';
import {formatParisDateTime,formatParisPaymentDeadline} from '../firebase-functions-bazaar/bazaar/payment-window.mjs';

test('storefront and preview use one notice per stock level',()=>{
  assert.equal(stockNotice(null,'ko'),'');
  assert.match(stockNotice(11,'ko'),/한정수량 11개/);
  assert.match(stockNotice(10,'ko'),/is-low.*남은 수량 10개/);
  assert.equal(stockNotice(0,'fr'),'');
  const html=renderShopProducts([{id:'p',titleKo:'<abc>',storage:'chilled',priceCents:300,stockRemaining:0}],'ko',{
    quantity:()=>0,controls:(_p,_qty,sold)=>sold?'Sold':'Available',price:()=> '3 €'
  });
  assert.match(html,/&lt;abc&gt;/);
  assert.match(html,/aria-label="냉장"/);
  assert.match(html,/Sold/);
  assert.equal((html.match(/매진/g)||[]).length,1);
});

test('shared event header uses Paris time and escapes editor text',()=>{
  const html=renderShopEvent({nameFr:'<201>',orderCutoff:'2026-11-27T17:00:00Z'},'fr');
  assert.match(html,/&lt;201&gt;/);
  assert.match(html,/Vendredi 27 novembre 2026 à 18h00/);
});

test('event mail settings discard older queued messages after reenabling automatic mail',()=>{
  const previous={type:'receipt',createdAt:'2026-11-25T12:00:00.000Z'};
  assert.equal(autoMailAllowed({modes:{receipt:'off'}},previous,{}),false);
  assert.equal(autoMailAllowed({modes:{receipt:'manual'}},previous,{}),false);
  const enabled={modes:{receipt:'auto'},autoSince:{receipt:'2026-11-25T12:10:00.000Z'}};
  assert.equal(autoMailAllowed(enabled,previous,{}),false);
  assert.equal(autoMailAllowed(enabled,{...previous,createdAt:'2026-11-25T12:11:00.000Z'},{}),true);
  assert.equal(autoMailAllowed({modes:{buyerCancel:'off',adminCancel:'auto'}},{type:'cancel'},{cancelReason:'buyer'}),false);
  assert.equal(autoMailAllowed({modes:{buyerCancel:'off',adminCancel:'auto'}},{type:'cancel'},{cancelReason:'admin'}),true);
});

test('quantity changes update one cart and respect available stock',()=>{
  const cart={};
  assert.equal(changeCartQuantity(cart,'sample',1,1),1);
  assert.equal(changeCartQuantity(cart,'sample',1,1),1);
  assert.equal(changeCartQuantity(cart,'sample',-1,1),0);
  assert.deepEqual(cart,{});
  assert.equal(changeCartQuantity(cart,'sold-out',1,0),0);
});

test('all displayed dates include full year and Paris-local weekday in both languages',()=>{
 const event={orderCutoff:'2026-11-27T17:00:00Z',transferCutoff:'2026-11-27T21:00:00Z',pickupAt:'2026-12-02T15:00:00Z'};
 const ko=renderShopEvent(event,'ko'),fr=renderShopEvent(event,'fr');
 for(const expected of ['2026년 11월 27일 (금) 18:00','2026년 11월 27일 (금) 22:00','2026년 12월 2일 (수) 16:00'])assert.ok(ko.includes(expected));
 for(const expected of ['Vendredi 27 novembre 2026 à 18h00','Vendredi 27 novembre 2026 à 22h00','Mercredi 2 décembre 2026 à 16h00'])assert.ok(fr.includes(expected));
 assert.equal(formatParisDateTime('2026-12-31T23:30:00Z','ko'),'2027년 1월 1일 (금) 00:30');
 assert.equal(formatParisDateTime('2026-07-20T22:30:00Z','fr'),'Mardi 21 juillet 2026 à 00h30');
 assert.equal(formatParisDateTime(event.pickupAt,'ko',{dateOnly:true}),'2026년 12월 2일 (수)');
 assert.equal(formatParisPaymentDeadline(event.transferCutoff,'ko'),'2026년 11월 27일 (금) 22:00 (파리 현지 시간)');
 assert.equal(formatParisPaymentDeadline(event.transferCutoff,'fr'),'Vendredi 27 novembre 2026 à 22h00 (heure de Paris)');
 assert.equal(formatParisDateTime(undefined,'ko'),'—');
});
