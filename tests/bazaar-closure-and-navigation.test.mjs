import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {orderIntakeState} from '../firebase-functions-bazaar/bazaar/order-intake.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const publicPage=read('../src/pages/[lang]/bazaar/index.astro');
const legacy=read('../src/pages/[lang]/bazaar/admin/legacy.astro');
const adminPage=read('../src/lib/bazaar/admin/app.js');
const backend=read('../firebase-functions-bazaar/bazaar/service.mjs');
const adminHub=read('../src/pages/[lang]/membres/admin.astro');
const base=read('../src/layouts/Base.astro');

test('customer page hides product area until server status is checked',()=>{
 assert.match(publicPage, /id="bz-shop" hidden/);
 assert.match(publicPage, /\$\('#bz-shop'\)\.hidden=event\.status!=='published'/);
});
test('manual close shows dedicated notice without product/cart elements',()=>{
 assert.match(publicPage, /종료된 행사입니다\./);
 assert.match(publicPage, /event\.status==='closed'/);
 assert.match(publicPage, /id="bz-end-notice"/);
});
test('manager gets persistent dashboard link but public nav is not changed',()=>{
 assert.match(adminHub, /href=\{href\(lang,'bazaar\/admin\/'\)\}/);
 assert.doesNotMatch(base, /href\(lang,\s*'bazaar\/'\)/);
});
test('closure button and backend operation exist',()=>{
 assert.match(adminPage,/control\('end-event','행사 종료'/);
 assert.match(adminPage,/request\('endEvent',\{eventId:e.id,confirm:true\}/);
 assert.match(backend,/if\(op==='endEvent'\)/);
 assert.match(backend,/status:'closed',endedAt/);
});
test('manual closed status also stops server order creation',()=>{
 assert.match(backend,/orderIntakeState\(e\)!=='open'/);
 assert.match(backend,/closed\(current\).*status:'closed'/);
});
test('buyer storefront and server share the scheduled, open, expired, paused and ended intake states',()=>{
 const event={status:'published',orderStartsAt:'2026-11-25T12:00:00Z',orderCutoff:'2026-11-25T13:00:00Z',
  iban:'FR7612345678901234567890123'};
 const time=Date.parse('2026-11-25T12:30:00Z');
 assert.equal(orderIntakeState(event,time-60*60000),'scheduled');
 assert.equal(orderIntakeState(event,time),'open');
 assert.equal(orderIntakeState(event,Date.parse(event.orderCutoff)),'closed');
 assert.equal(orderIntakeState({...event,orderIntakeClosedAt:event.orderStartsAt},time),'closed');
 assert.equal(orderIntakeState({...event,orderIntakeLocked:true},time),'closed');
 assert.equal(orderIntakeState({...event,status:'closed'},time),'closed');
 assert.match(publicPage,/orderIntakeState\(event,Date\.now\(\)\+serverOffset\)/);
 assert.match(adminPage,/\$\('#modal'\)\.addEventListener\('click',[^\n]*\nif\(a==='save-reopen-intake'\)\{handleScreenAction\(a,b\);return;/);
});
test('draft intro and final financial reconciliation remain',()=>{
 assert.match(legacy,/name="introKo"/);
 assert.match(legacy,/name="introFr"/);
 assert.match(backend,/if\(op==='finalizeUnpaid'\)/);
});

test('banner links can target any event without reserving a banner',()=>{
 const banners=read('../src/components/HomeCampaigns.astro');
 assert.match(legacy,/bazaar\/\?\$\{search\}/);
 assert.match(publicPage,/new URLSearchParams\(location.search\).get\('event'\)/);
 assert.match(banners,/\['bazaar','admissions'\]/);
 assert.match(banners,/\$\{BASE\}\$\{lang\}\/\$\{item.link\}/);
});
