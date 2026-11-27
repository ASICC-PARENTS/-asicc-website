import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBazaar} from '../firebase-functions-bazaar/bazaar/service.mjs';
import {orderPaymentSummary} from '../firebase-functions-bazaar/bazaar/order-payments.mjs';

test('reported partial cancellation requires explicit acknowledgement and preserves actual payments',async()=>{
 const eventId='bazaar-reported-test',id='a12345678901234567890123456789012';
 const orderPath='bazaarOrders/'+id,products='bazaarEventProjects/'+eventId+'/products/';
 const before={id,eventId,email:'fixture@example.test',transferReportedAt:'2026-11-27T10:00:00Z',bankConfirmedAt:null,canceledAt:null,
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
 const svc=createBazaar({db,FieldValue:{increment:n=>({increment:n})},sendQueuedMail:()=>assert.fail('Real sending not permitted')});
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
 const job=values.get('bazaarOutbox/'+id+'_orderChanged-1');assert.equal(job.change.totalCents,2300);assert.equal(job.change.items.length,1);
 assert.equal([...values.keys()].filter(k=>k.startsWith('bazaarOutbox/')).length,1);
});
