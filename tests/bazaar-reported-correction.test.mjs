import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBazaar} from '../firebase-functions-bazaar/bazaar/service.mjs';
import {orderPaymentSummary} from '../firebase-functions-bazaar/bazaar/order-payments.mjs';

test('reported partial cancellation requires explicit acknowledgement and preserves actual payments',async()=>{
 const eventId='bazaar-reported-test',id='a12345678901234567890123456789012';
 const orderPath='bazaarOrders/'+id,products='bazaarEventProjects/'+eventId+'/products/';
 const token='a'.repeat(64);const before={id,eventId,orderRef:'BZTEST01',buyerToken:token,email:'fixture@example.test',transferReportedAt:'2026-11-27T10:00:00Z',bankConfirmedAt:null,canceledAt:null,
  items:[{id:'hotdog',qty:2,priceCents:500},{id:'rice',qty:1,priceCents:2300}],totalCents:3300,originalTotalCents:3300};
 const values=new Map([[orderPath,before],['bazaarEventProjects/'+eventId,{eventId,status:'published',scopedProducts:true}],
  [products+'hotdog',{bazaarEventId:eventId,visible:true,soldQty:2}],[products+'rice',{bazaarEventId:eventId,visible:true,soldQty:1}],
  ['members/admin',{role:'admin',status:'approved'}]]);
 const doc=path=>({path,id:path.split('/').at(-1),collection:name=>({doc:key=>doc(path+'/'+name+'/'+key)})});
 const snapshot=ref=>({id:ref.id,ref,exists:values.has(ref.path),data:()=>structuredClone(values.get(ref.path))});
 const db={doc,collection:name=>({doc:key=>doc(name+'/'+key)}),getAll:async(...refs)=>refs.map(snapshot),runTransaction:async fn=>{
  const writes=[];const tx={get:async ref=>snapshot(ref),create:(ref,value)=>writes.push(()=>values.set(ref.path,value)),
   update:(ref,patch)=>writes.push(()=>values.set(ref.path,{...values.get(ref.path),...Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,v?.increment!==undefined?values.get(ref.path)[k]+v.increment:v]))}))};
  const result=await fn(tx);writes.forEach(write=>write());return result;
 }};
 const svc=createBazaar({db,FieldValue:{increment:n=>({increment:n})},sendQueuedMail:async()=>false,siteUrl:()=> 'https://test.example.test'});
 const admin=(extra)=>svc.bazaarAdmin({auth:{uid:'admin',token:{email_verified:true}},data:{op:'correctOrder',eventId,id,revision:0,reason:'Partial cancellation',confirm:true,
  items:[{id:'hotdog',qty:0},{id:'rice',qty:1}],...extra}});
 await assert.rejects(admin({}),/환불 등록/);
 assert.deepEqual(values.get(orderPath),before);
 await assert.rejects(admin({ackReportedMismatch:true,items:[{id:'hotdog',qty:3},{id:'rice',qty:1}]}),/은행 입금/);
 const result=await admin({ackReportedMismatch:true});assert.equal(result.totalCents,2300);
 const updated=values.get(orderPath);assert.equal(updated.transferReportedAt,before.transferReportedAt);assert.equal(updated.bankConfirmedAt,null);
 assert.equal(updated.depositedCents,0);assert.equal(updated.refundedCents,0);assert.equal(updated.originalTotalCents,3300);
 assert.equal(values.get(products+'hotdog').soldQty,0);assert.equal(values.get(products+'rice').soldQty,1);
 assert.equal(orderPaymentSummary(updated).refundDue,0);
 assert.equal(orderPaymentSummary({...updated,bankConfirmedAt:'2026-11-27T12:00:00Z',depositedCents:3300}).refundDue,1000);
 const job=values.get('bazaarOutbox/'+id+'_partialRefund-1');assert.equal(job.change.totalCents,2300);assert.equal(job.change.items.length,1);
 assert.equal([...values.keys()].filter(k=>k.startsWith('bazaarOutbox/')).length,1);
 const requestId=job.change.requestId;
 const buyer=(action,extra={})=>svc.bazaarBuyerAction({data:{id,token,requestId,action,...extra}});
 await assert.rejects(buyer('refundAccountView',{token:'b'.repeat(64)}),{code:'permission-denied'});
 await assert.rejects(buyer('refundAccountView',{requestId:'b'.repeat(32)}),{code:'permission-denied'});
 const valid={beneficiary:'Synthetic Customer',iban:'FR1420041010050500013M02606',bic:'PSSTFRPPMON',confirm:true};
 await assert.rejects(buyer('refundAccountSubmit',{...valid,iban:'FR0000'}),{code:'invalid-argument'});
 const view=await buyer('refundAccountView');assert.equal(view.request.status,'awaitingAccount');
 const submitted=await buyer('refundAccountSubmit',valid);assert.equal(submitted.request.status,'awaitingPayment');
 assert.equal(submitted.request.ibanLast4,'2606');
 assert.ok(!JSON.stringify(submitted).includes(valid.iban));
 assert.equal(values.get(orderPath).reservedRefundCents,undefined);
 assert.equal(values.has(orderPath+'/refunds/'+requestId),false);
 const result2=await admin({op:'bankConfirm',requestId:'c'.repeat(32),amountCents:3300});
 assert.equal(result2.payment.refundDue,1000);assert.equal(result2.payment.reservedRefund,1000);
 const refund=values.get(orderPath+'/refunds/'+requestId);assert.equal(refund.status,'pending');assert.equal(refund.amountCents,1000);assert.equal(refund.iban,valid.iban);
 assert.equal(values.get(orderPath).refundedCents,0);
 assert.equal((await buyer('refundAccountView')).request.status,'pending');
 await assert.rejects(buyer('refundAccountSubmit',valid),{code:'failed-precondition'});
 assert.equal((await admin({op:'bankConfirm',requestId:'c'.repeat(32),amountCents:3300})).payment.reservedRefund,1000);
 assert.equal([...values.keys()].filter(k=>k.includes('/refunds/')).length,1);
 const finalized=await admin({op:'finishRefund',requestId,completedAt:new Date(Date.now()-1000).toISOString(),operator:'Synthetic admin',reason:'Completed mock transfer'});
 assert.equal(finalized.payment.refunded,1000);assert.equal(finalized.payment.reservedRefund,0);
 assert.equal((await buyer('refundAccountView')).request.status,'completed');
 assert.equal(values.get(products+'hotdog').soldQty,0);assert.equal(values.get(products+'rice').soldQty,1);
 assert.equal(values.get(orderPath).totalCents,2300);
});
