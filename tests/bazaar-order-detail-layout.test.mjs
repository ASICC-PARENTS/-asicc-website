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

test('product detail is opened only by product name, not the carton row or quantity',()=>{
 const code=src.slice(src.indexOf('function renderProductOrders(){'),src.indexOf('function productOrderDetail(id)'));
 assert.doesNotMatch(code,/<tr data-action="product-order-detail"/);
 assert.match(code,/<button type="button" class="linkbtn product-order-name" data-action="product-order-detail"/);
 assert.match(code,/data-action="arrival-save"/);
 assert.doesNotMatch(code,/data-action="carton-confirm"/);
 assert.doesNotMatch(src,/data-action="carton-confirm"/);
 assert.match(src,/if\(action==='order-detail'\)\{openOrderDetail\(id\);return true;/);
});

test('order list pins headers and body in the same order, using actual column width',()=>{
 const code=src.slice(src.indexOf('function orderPinnedColumns('),src.indexOf('function applyColumns('));
 vm.runInContext(code,ctx);
 const cell=(name,width=100)=>({dataset:{columnId:name},style:{},hidden:false,
  classList:{remove(){}},toggleAttribute(name,value){this[name]=value},getBoundingClientRect(){return {width}}});
 const headers=[cell('ref',137),cell('name',91),cell('manage')];
 const body=[cell(),cell(),cell()];
 const table={tHead:{rows:[{cells:headers}]},rows:[{cells:headers,parentElement:{tagName:'THEAD'}},{cells:body,parentElement:{tagName:'TBODY'}}]};
 ctx.orderPinnedColumns(table,null);
 assert.equal(headers[0].style.left,'0px');
 assert.equal(headers[0].style.zIndex,'5');
 assert.equal(headers[1].style.left,'137px');
 assert.equal(body[1].style.left,'137px');
 ctx.orderPinnedColumns(table,{pinned:['name']});
 assert.equal(headers[0].style.left,'');
 assert.equal(headers[1].style.left,'0px');
 assert.equal(body[1].style.left,'0px');
});
