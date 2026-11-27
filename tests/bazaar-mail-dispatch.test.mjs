import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createMail, mailFields } from '../worker/bazaar/mail.mjs';
import { createMailAdmin } from '../worker/bazaar/mail-admin.mjs';

// An isolated, serial-transaction fixture. Provider HTTP is always stubbed;
// no Firebase, real addresses, external mail, or production credentials are used.
function memoryDb(initial={}) {
  const values=new Map(Object.entries(structuredClone(initial)));
  let tail=Promise.resolve();
  const snapshot=ref=>({id:ref.id,ref,exists:values.has(ref.path),data:()=>structuredClone(values.get(ref.path))});
  const doc=path=>({path,id:path.split('/').at(-1),get:async()=>snapshot(doc(path)),set:async(v,{merge=false}={})=>write(path,v,merge)});
  const write=(path,value,merge)=>values.set(path,structuredClone(merge?{...values.get(path),...value}:value));
  return {doc,collection:path=>({doc:id=>doc(`${path}/${id}`)}),getAll:async(...refs)=>refs.map(snapshot),values,
    runTransaction(fn){
      const result=tail.then(async()=>{
        const writes=[];
        const tx={get:async ref=>snapshot(ref),set:(ref,value,options)=>writes.push(()=>write(ref.path,value,options?.merge)),
          update:(ref,value)=>writes.push(()=>{assert(values.has(ref.path));write(ref.path,value,true);}),
          create:(ref,value)=>writes.push(()=>{assert(!values.has(ref.path));write(ref.path,value,false);})};
        const response=await fn(tx);for(const apply of writes)apply();return response;
      });tail=result.catch(()=>{});return result;
    }};
}
const eventId='bazaar-test-mail-dispatch';
const orderId='a12345678901234567890123456789012';
const anotherOrder='b12345678901234567890123456789012';
const jobId=orderId+'_receipt';
const anotherJob=anotherOrder+'_receipt';
const when=offset=>new Date(Date.now()+offset).toISOString();
const originalOrder={id:orderId,eventId,email:'person@example.test',orderRef:'BZ990001',lang:'ko',totalCents:850,items:[{id:'product',qty:1}],createdAt:when(-1000)};
const envelope=(order,type)=>({subject:`${type} ${order.orderRef}`,text:'Test only',html:'<p>Test only</p>'});
function fixture(record={},responses=[]){
  const db=memoryDb({[`bazaarOrders/${orderId}`]:originalOrder,[`bazaarOrders/${anotherOrder}`]:{...originalOrder,id:anotherOrder},
    [`bazaarOutbox/${jobId}`]:{...mailFields('receipt',when(-1000)),eventId,orderId,type:'receipt',createdAt:when(-1000),attempts:0,...record},
    [`bazaarOutbox/${anotherJob}`]:{...mailFields('receipt',when(-1000)),eventId,orderId:anotherOrder,type:'receipt'},
    [`bazaarEventProjects/${eventId}`]:{eventId,status:'published'},[`bazaarEventProjects/${eventId}/products/product`]:{soldQty:7},
    [`bazaarEventFinancials/${eventId}`]:{expenses:[]}});
  const calls=[];
  const mail=createMail({BAZAAR_MODE:'test',MAIL_MODE:'api',MAIL_PROVIDER:'brevo',BAZAAR_MAIL_FROM:'sender@example.test',BAZAAR_MAIL_API_KEY:'mock-only',TEST_MAIL_TO:'sink@example.test'},db,async(url,options)=>{
    assert.equal(url,'https://api.brevo.com/v3/smtp/email');
    const body=JSON.parse(options.body);assert.deepEqual(body.messageVersions[0].to,[{email:'sink@example.test'}]);calls.push(body);
    return responses.shift()??Response.json({messageId:'mock-'+calls.length},{status:201});
  });
  const manager=createMailAdmin(db,mail);
  const dispatch=(action='sendNow',extra={})=>manager.admin('mailJobAction',{eventId,id:jobId,action,confirm:true,...extra},'test-admin',envelope);
  const get=id=>db.values.get('bazaarOutbox/'+id);
  const untouched=()=>{
    assert.deepEqual(db.values.get('bazaarOrders/'+orderId),originalOrder);
    assert.deepEqual(db.values.get('bazaarOrders/'+anotherOrder),{...originalOrder,id:anotherOrder});
    assert.equal(get(anotherJob).status,'queued');
    assert.deepEqual(db.values.get(`bazaarEventProjects/${eventId}/products/product`),{soldQty:7});
    assert.deepEqual(db.values.get(`bazaarEventFinancials/${eventId}`),{expenses:[]});
  };
  return {db,calls,mail,dispatch,get,untouched};
}

test('immediate dispatch sends only selected queued email, returns provider result and leaves actual order data untouched',async()=>{
  const f=fixture();const key=f.get(jobId).providerKey;
  const outcome=await f.dispatch();assert.equal(outcome.status,'sent');assert.equal(outcome.method,'Brevo');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].headers.idempotencyKey,key);
  assert.equal(f.get(jobId).manualBy,'test-admin');assert.equal(f.get(jobId).providerId,'mock-1');
  assert.equal((await f.dispatch()).status,'sent');assert.equal(f.calls.length,1);f.untouched();
});
test('known failures retry using original key; uncertain provider outcome requires confirmation before retry',async()=>{
  const f=fixture({status:'failed',lastError:'provider-result-uncertain',deliveryUncertain:true,dueAt:null});
  const key=f.get(jobId).providerKey;
  await assert.rejects(f.dispatch(),{code:'failed-precondition'});assert.equal(f.calls.length,0);
  const outcome=await f.dispatch('sendNow',{providerConfirmedUnsent:true});assert.equal(outcome.status,'sent');
  assert.equal(f.get(jobId).retryHistory[0].reason,'provider-result-uncertain');
  assert.equal(f.calls[0].headers.idempotencyKey,key);f.untouched();
});
test('resending an accepted receipt preserves original acceptance, uses a new key and deduplicates concurrent requests',async()=>{
  const sentAt=when(-5000),f=fixture({status:'sent',sentAt,providerId:'old-accepted',dueAt:null});
  const key=f.get(jobId).providerKey;
  const outcomes=await Promise.all([f.dispatch('resend'),f.dispatch('resend')]);
  const id=outcomes[0].jobId;assert.equal(id,outcomes[1].jobId);assert.notEqual(id,jobId);assert.equal(f.calls.length,1);
  assert.equal(f.get(jobId).sentAt,sentAt);assert.equal(f.get(jobId).providerId,'old-accepted');assert.equal(f.get(jobId).resendJobId,id);
  assert.equal(f.get(id).status,'sent');assert.equal(f.get(id).resendOf,jobId);assert.notEqual(f.get(id).providerKey,key);
  await f.dispatch('resend');assert.equal(f.calls.length,1);f.untouched();
});
test('immediate dispatch does not bypass limits, off policy, future scheduling or event boundary',async()=>{
  const f=fixture({status:'delayed',dueAt:when(3600000)});
  await f.db.doc('bazaarMailUsage/brevo-rolling').set({slots:[],pauseUntil:Date.now()+3600000});
  assert.equal((await f.dispatch()).status,'delayed');assert.equal(f.calls.length,0);
  await f.db.doc('bazaarMailPolicies/'+eventId).set({modes:{receipt:'off'}});
  await assert.rejects(f.dispatch(),{code:'failed-precondition'});assert.equal(f.calls.length,0);
  await assert.rejects(f.dispatch('sendNow',{eventId:'another-bazaar-event'}),{code:'failed-precondition'});
  await assert.rejects(f.dispatch('sendNow',{confirm:false}),{code:'invalid-argument'});f.untouched();
  const future=fixture({status:'queued',dueAt:when(3600000)});await assert.rejects(future.dispatch(),{code:'failed-precondition'});assert.equal(future.calls.length,0);
});
test('provider failures are returned explicitly without claiming acceptance or retrying silently',async()=>{
  const f=fixture({},[new Response('{}',{status:403})]);
  const result=await f.dispatch();assert.equal(result.status,'failed');assert.equal(result.lastError,'provider-access-denied');assert.equal(f.calls.length,1);f.untouched();
  const g=fixture({},[new Response('{}',{status:503})]);const uncertain=await g.dispatch();
  assert.equal(uncertain.status,'failed');assert.equal(uncertain.deliveryUncertain,true);assert.equal(g.calls.length,1);
  await assert.rejects(g.dispatch(),{code:'failed-precondition'});assert.equal(g.calls.length,1);g.untouched();
});
test('admin UI offers immediate delivery and separates acceptance from inbox delivery',()=>{
  const ui=readFileSync(new URL('../src/lib/bazaar/admin/mail.js',import.meta.url),'utf8');
  assert.match(ui,/queued:\['sendNow','cancel'\]/);assert.match(ui,/failed:\['sendNow'\]/);
  assert.match(ui,/brevo-send-now/);assert.match(ui,/수신함 도착 여부는 미확인/);
  const service=readFileSync(new URL('../firebase-functions-bazaar/bazaar/service.mjs',import.meta.url),'utf8');
  assert.match(service,/await requireAdmin\(req\);/);assert.match(service,/mailAdmin\(op,data,req.auth.uid,message\)/);
});

test('canceled order is not re-mailed, and a reserved OVH message cannot be sent concurrently',async()=>{
  const canceled=fixture();
  await canceled.db.doc('bazaarOrders/'+orderId).set({...originalOrder,canceledAt:when(-1000),cancelReason:'buyer'});
  assert.equal((await canceled.dispatch()).status,'skipped');assert.equal(canceled.calls.length,0);
  const accepted=fixture({status:'sent',sentAt:when(-1000)});
  await accepted.db.doc('bazaarOrders/'+orderId).set({...originalOrder,canceledAt:when(-1000),cancelReason:'buyer'});
  await assert.rejects(accepted.dispatch('resend'),{code:'failed-precondition'});assert.equal(accepted.calls.length,0);
  const ovh=fixture({status:'manualReserved',manualBy:'other-admin'});
  await assert.rejects(ovh.dispatch(),{code:'failed-precondition'});assert.equal(ovh.calls.length,0);
});
