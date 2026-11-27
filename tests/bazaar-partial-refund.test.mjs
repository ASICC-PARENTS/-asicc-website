import {test} from 'node:test';
import assert from 'node:assert/strict';
import {partialRefundRequest,reservePartialRefund,normalizeRefundAccount,publicRefundRequest} from '../firebase-functions-bazaar/bazaar/partial-refunds.mjs';
import {renderOrderEmail} from '../firebase-functions-bazaar/bazaar/order-email.mjs';
const items=[{id:'rice',titleKo:'쌀',titleFr:'Riz',qty:1,priceCents:2300}];
const removed=[{id:'hotdog',titleKo:'비건 핫도그',titleFr:'Hot-dog végétalien',qty:2,priceCents:2000}];
const at='2026-11-27T12:00:00Z';
const original={id:'testorder1234567890',buyerToken:'a'.repeat(64),orderRef:'BZTEST01',eventId:'bazaar-test-refund',items:[...items,...removed],totalCents:6300,name:'Fixture',bankConfirmedAt:at,depositedCents:6300,refundedCents:0};
const change={revision:1,at,items,totalCents:2300,removed};
const valid={beneficiary:'Synthetic Account',iban:'FR1420041010050500013M02606',bic:'PSSTFRPPMON',confirm:true};
test('partial refund estimates are capped by actual unreserved funds and do not create refunds for unpaid orders',()=>{
 assert.equal(partialRefundRequest({...original,bankConfirmedAt:null,transferReportedAt:null,depositedCents:0},change),null);
 assert.equal(partialRefundRequest({...original,depositedCents:2300},change),null);
 const request=partialRefundRequest({...original,depositedCents:4300,reservedRefundCents:500},change);assert.equal(request.estimatedCents,1500);
 assert.equal(normalizeRefundAccount({...valid,confirm:false}),null);
 assert.equal(normalizeRefundAccount({...valid,bic:'BAD'}),null);
 assert.equal(normalizeRefundAccount({...valid,iban:'FR0012'}),null);
 assert.deepEqual(normalizeRefundAccount(valid),{beneficiary:valid.beneficiary,iban:valid.iban,bic:valid.bic});
});
test('confirmed bank payment + customer account is reserved once and never writes actual refund',()=>{
 const request={...partialRefundRequest(original,change),account:normalizeRefundAccount(valid),status:'registered'};
 const writes=[];const ref={collection:name=>({doc:id=>name+'/'+id})};
 const tx={create:(p,v)=>writes.push([p,v]),update:(p,v)=>writes.push([p,v])};
 const order={...original,items,totalCents:2300,reservedRefundCents:2000};
 const reserved=reservePartialRefund(tx,ref,order,request,null,at,2000);
 assert.equal(reserved,4000);assert.equal(writes.length,2);assert.equal(writes[0][1].amountCents,2000);assert.equal(writes[0][1].status,'pending');
 assert.equal(writes[0][1].iban,valid.iban);assert.equal(order.refundedCents,0);
 assert.equal(reservePartialRefund(tx,ref,order,request,writes[0][1],at,reserved),reserved);
 assert.equal(writes.length,2);
 const view=publicRefundRequest(order,request,writes[0][1]);
 assert.equal(view.status,'pending');assert.ok(!JSON.stringify(view).includes(valid.iban));
});
test('partial refund email uses bilingual change table and protected refund link; no account data',()=>{
 for(const lang of ['ko','fr']){
  const request=partialRefundRequest(original,change);
  const mail=renderOrderEmail({order:{...original,lang,items,totalCents:2300},type:'partialRefund',site:'https://test.example.test',event:{},testMode:true,
   change:{requestId:request.id,canceledItems:removed,estimatedCents:4000,previousTotalCents:6300},template:lang==='ko'?{introKo:'개별 문구'}:{introFr:'Texte personnalisé'}});
  assert.match(mail.subject,/\[TEST\]/);assert.ok(mail.text.includes(lang==='ko'?'비건 핫도그':'Hot-dog végétalien'));
  assert.ok(mail.text.includes(lang==='ko'?'개별 문구':'Texte personnalisé'));
  assert.ok(mail.text.includes(lang==='ko'?'변경된 주문내역':'Commande mise à jour'));
  assert.ok(mail.text.includes('/'+lang+'/bazaar/remboursement/?id='+original.id+'&request='+request.id+'#token='+original.buyerToken));
  assert.ok(!mail.text.includes(valid.iban));assert.match(mail.html,/40[,.]00/);
 }
});
