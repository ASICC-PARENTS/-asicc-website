import test from 'node:test';
import assert from 'node:assert/strict';
import {productOrderSummary} from '../src/lib/bazaar/admin/data.js';

test('product order summary keeps zero-order products, skips canceled orders and uses order-time prices',()=>{
  const products=[{id:'a',ko:'사과',fr:'Pomme',photo:'/a.jpg',sale:9},{id:'b',ko:'배',fr:'Poire',photo:'',sale:4}];
  const orders=[
    {id:'o1',ref:'A1',name:'Mina',status:'confirmed',items:[['사과',2,3.5,'a',{titleFr:'Pomme'}]]},
    {id:'o2',ref:'A2',name:'Noah',status:'unpaid',items:[['사과',1,4,'a',{titleFr:'Pomme'}]]},
    {id:'o3',ref:'A3',name:'Cancelled',status:'canceled',items:[['사과',20,9,'a',{titleFr:'Pomme'}]]},
  ];
  const rows=productOrderSummary(products,orders);
  assert.equal(rows.length,2);
  const apple=rows.find(row=>row.id==='a'),pear=rows.find(row=>row.id==='b');
  assert.equal(apple.qty,3);
  assert.equal(apple.amountCents,1100);
  assert.equal(apple.price,9);
  assert.equal(apple.orders.length,2);
  assert.equal(pear.qty,0);
  assert.equal(pear.amountCents,0);
});

test('product order summary retains snapshot items whose product row is absent',()=>{
  const rows=productOrderSummary([],[{id:'o1',ref:'A1',name:'Mina',status:'reported',items:[['명칭 보존',2,1.25,'legacy-id',{titleFr:'Titre conservé',imageUrl:'/old.jpg'}]]}]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].ko,'명칭 보존');
  assert.equal(rows[0].fr,'Titre conservé');
  assert.equal(rows[0].amountCents,250);
});
