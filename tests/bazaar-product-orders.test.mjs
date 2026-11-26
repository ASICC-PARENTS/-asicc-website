import test from 'node:test';
import assert from 'node:assert/strict';
import {productOrderSummary,purchaseDemandRows} from '../src/lib/bazaar/admin/data.js';

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

test('product order overview calculates required cartons and remaining saleable stock',()=>{
  const products=[{id:'tofu',ko:'두부',vendor:'K',pack:12,sale:2.2},{id:'snack',ko:'홈런볼',vendor:'K',pack:30,sale:2.05},{id:'zero',ko:'미주문',vendor:'N',pack:5,sale:7}];
  const orders=[
    {status:'confirmed',items:[['두부',10,2.2,'tofu',{supplier:'K',packQty:12,boxPriceTtcCents:2625}]]},
    {status:'unpaid',items:[['두부',3,2.2,'tofu',{supplier:'K',packQty:12,boxPriceTtcCents:2600}],['홈런볼',17,2.05,'snack',{}]]},
    {status:'canceled',items:[['두부',100,2.2,'tofu',{supplier:'K',packQty:12}]]}
  ];
  const rows=productOrderSummary(products,orders),tofu=rows.find(p=>p.id==='tofu'),snack=rows.find(p=>p.id==='snack'),zero=rows.find(p=>p.id==='zero');
  assert.deepEqual([tofu.qty,tofu.packSizes,tofu.boxes,tofu.purchaseQty,tofu.remainingQty,tofu.amountCents],[13,[12],2,24,11,2860]);
  assert.deepEqual([snack.qty,snack.boxes,snack.purchaseQty,snack.remainingQty],[17,1,30,13]);
  assert.deepEqual([zero.qty,zero.boxes,zero.purchaseQty,zero.remainingQty],[0,0,0,0]);
  const changed=productOrderSummary(products,[...orders,{status:'reported',items:[['두부',1,2.2,'tofu',{supplier:'K',packQty:6}]]}]).find(p=>p.id==='tofu');
  assert.deepEqual([changed.packSizes,changed.boxes,changed.purchaseQty,changed.remainingQty],[[6,12],3,30,16]);
  const unknown=productOrderSummary([],[{status:'confirmed',items:[['기타',2,5,'missing',{}]]}])[0];
  assert.deepEqual([unknown.qty,unknown.boxes,unknown.purchaseQty,unknown.remainingQty],[2,null,null,null]);
});


test('confirmed cartons remain fixed after order cancellation and unconfirmed products retain old calculation',()=>{
 const product={id:'a',ko:'호떡',vendor:'K',pack:12,sale:13,boxes:2,limitMode:'auto',cartonConfirmed:true};
 const orders=[{status:'confirmed',items:[['호떡',3,13,'a',{supplier:'K',packQty:12}]]}];
 const [fixed]=productOrderSummary([product],orders);
 assert.deepEqual([fixed.boxes,fixed.purchaseQty,fixed.remainingQty],[2,24,21]);
 const [normal]=productOrderSummary([{...product,cartonConfirmed:false}],orders);
 assert.deepEqual([normal.boxes,normal.purchaseQty,normal.remainingQty],[1,12,9]);
});

test('confirmed procurement uses fixed cartons for paid or all-order scopes, including zero demand',()=>{
 const products=[{id:'a',ko:'호떡',vendor:'K',pack:12,buy:10,boxes:2,limitMode:'auto',cartonConfirmed:true},
 {id:'b',ko:'떡',vendor:'K',pack:10,buy:20,limitMode:'auto'}];
 const paid={status:'confirmed',items:[['호떡',3,13,'a',{supplier:'K',packQty:12,boxPriceTtcCents:900}],['떡',7,5,'b',{}]]};
 const unpaid={status:'unpaid',items:[['호떡',10,13,'a',{supplier:'K',packQty:12,boxPriceTtcCents:1000}]]};
 const [fixed,normal]=purchaseDemandRows(products,[paid,unpaid]);
 assert.deepEqual([fixed.minimum,fixed.ordered,fixed.buy,fixed.revenue],[2,13,10,169]);
 assert.deepEqual([normal.minimum,normal.ordered,normal.buy],[1,7,20]);
 assert.deepEqual(purchaseDemandRows(products,[paid]).map(r=>r.minimum),[2,1]);
 assert.deepEqual(purchaseDemandRows(products,[]).map(r=>[r.minimum,r.ordered]),[[2,0]]);
 assert.equal(purchaseDemandRows([{...products[0],cartonConfirmed:false}],[paid])[0].minimum,1);
});

test('order overview reflects saved product carton quantity in both directions',()=>{
 const product={id:'a',ko:'호떡',vendor:'K',pack:12,sale:13,boxes:4,limitMode:'auto'};
 const orders=[{status:'confirmed',items:[['호떡',13,13,'a',{supplier:'K',packQty:12}]]}];
 for(const [boxes,expected] of [[4,35],[3,23],[2,11]]) {
  const [row]=productOrderSummary([{...product,boxes}],orders,true);
  assert.deepEqual([row.boxes,row.purchaseQty,row.remainingQty],[boxes,boxes*12,expected]);
 }
});
