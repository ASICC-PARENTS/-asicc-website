import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const publicPage=read('../src/pages/[lang]/bazaar/index.astro');
const legacy=read('../src/pages/[lang]/bazaar/admin/legacy.astro');
const adminPage=read('../src/lib/bazaar/admin/app.js');
const backend=read('../firebase-functions-bazaar/bazaar/index.mjs');
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
 assert.match(adminPage,/data-action="end-event"/);
 assert.match(adminPage,/request\('endEvent',\{eventId:e.id,confirm:true\}/);
 assert.match(backend,/if\(op==='endEvent'\)/);
 assert.match(backend,/status:'closed',endedAt/);
});
test('manual closed status also stops server order creation',()=>{
 assert.match(backend,/e\.status!=='published'\|\|e\.finalizedAt/);
 assert.match(backend,/closed\(current\).*status:'closed'/);
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
