import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogue,initialEvent} from '../firebase-functions-bazaar/bazaar/products.mjs';
const by=id=>catalogue.find(x=>x.id===id);
test('suppliers and product counts',()=>{
 assert.equal(catalogue.length,15);
 assert.equal(catalogue.filter(x=>x.supplier==='K커머셜').length,7);
 assert.equal(catalogue.filter(x=>x.supplier==='누리커넥트').length,8);
 assert.equal(new Set(catalogue.map(x=>x.id)).size,15);
});
test('K커머셜 case HT + 5.5% = TTC price',()=>{
 for(const p of catalogue.filter(x=>x.boxPriceHtCents!=null))
  assert.equal(Math.round(p.boxPriceHtCents*1.055),p.boxPriceTtcCents,p.id);
});
test('누리커넥트 special supply price is already TTC',()=>{
 assert.equal(by('nuri-gimmari').boxPriceTtcCents,6000);
 assert.equal(by('nuri-gimmari').packQty,20);
 assert.equal(by('nuri-seok8').boxPriceTtcCents,6800);
 assert.equal(by('nuri-hotdog').boxPriceTtcCents,18200);
 assert.equal(by('nuri-dakgalbi').boxPriceTtcCents,1250);
});
test('unconfirmed sale prices and discounts not guessed',()=>{
 assert.equal(by('k-pogi1').visible,false);
 assert.equal(by('k-pogi10').visible,false);
 assert.equal(by('k-rice').visible,false);
 assert.equal(by('nuri-bibimbap'),undefined);
});
test('event deadlines are Europe/Paris converted into UTC',()=>{
 assert.equal(initialEvent.orderCutoff,'2026-11-27T11:00:00.000Z');
 assert.equal(initialEvent.transferCutoff,'2026-11-27T17:00:00.000Z');
});

test('initial event is identified so future events can be isolated',()=>{
 assert.equal(initialEvent.eventId,'bazaar-2026-11');
});
