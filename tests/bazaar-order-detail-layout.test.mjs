import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const src=readFileSync(new URL('../src/lib/bazaar/admin/app.js',import.meta.url),'utf8');
const code=src.slice(src.indexOf('function orderLines(order){'),src.indexOf('function orderAmounts(order)'));
const ctx=vm.createContext({fr:false,esc:String,money:n=>String(n),language:(ko)=>ko});
vm.runInContext(code,ctx);
test('order list remains flat; only the order modal renders a nested item table',()=>{
 const order={status:'unpaid',items:[['김치',2,5,'id',{}]],canceledItems:[]};
 assert.doesNotMatch(ctx.orderLines(order),/<(?:table|thead|th)\b/);
 assert.match(ctx.orderDetailLines(order),/<table class="order-detail-items">/);
 assert.match(ctx.orderDetailLines(order),/<td>김치<\/td><td>2<\/td><td>10<\/td>/);
 assert.match(src,/article class="order-print-body"[\s\S]*?\+orderDetailLines\(order\)/);
});
