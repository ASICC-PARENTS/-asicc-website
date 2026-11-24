import assert from 'node:assert/strict';
import test from 'node:test';
import {renderShopEvent,renderShopProducts,stockNotice} from '../src/lib/bazaar/shop-view.js';
import {autoMailAllowed} from '../worker/bazaar/mail-policy.mjs';

test('storefront and preview use one notice per stock level',()=>{
  assert.equal(stockNotice(null,'ko'),'');
  assert.match(stockNotice(11,'ko'),/한정수량 11개/);
  assert.match(stockNotice(10,'ko'),/is-low.*남은 수량 10개/);
  assert.match(stockNotice(0,'fr'),/is-sold.*Épuisé/);
  const html=renderShopProducts([{id:'p',titleKo:'<abc>',storage:'chilled',priceCents:300,stockRemaining:0}],'ko',{
    quantity:()=>0,controls:(_p,_qty,sold)=>sold?'Sold':'Available',price:()=> '3 €'
  });
  assert.match(html,/&lt;abc&gt;/);
  assert.match(html,/aria-label="냉장"/);
  assert.match(html,/Sold/);
  assert.equal((html.match(/품절/g)||[]).length,1);
});

test('shared event header uses Paris time and escapes editor text',()=>{
  const html=renderShopEvent({nameFr:'<201>',orderCutoff:'2026-11-27T17:00:00Z'},'fr');
  assert.match(html,/&lt;201&gt;/);
  assert.match(html,/27 novembre.*18:00/);
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
