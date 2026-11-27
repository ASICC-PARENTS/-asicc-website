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
  return {doc,collection:path=>({doc:id=>doc(`${path}/${id}`),where:(field,operator,value)=>({limit:count=>({get:async()=>({docs:[...values.keys()].filter(key=>key.startsWith(path+'/')&&values.get(key)[field]===value).slice(0,count).map(key=>snapshot(doc(key)))})})})}),getAll:async(...refs)=>refs.map(snapshot),values,
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
  const calls=[],lookups=[];
  const mail=createMail({BAZAAR_MODE:'test',MAIL_MODE:'api',MAIL_PROVIDER:'brevo',BAZAAR_MAIL_FROM:'sender@example.test',BAZAAR_MAIL_API_KEY:'mock-only',TEST_MAIL_TO:'sink@example.test'},db,async(url,options)=>{
    if(options.method==='GET'){lookups.push(new URL(url));return responses.shift()??Response.json({events:[]});}
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
  const single=(kind='receipt',extra={})=>manager.admin('mailSingleSend',{eventId,orderId,kind,expectedEmail:originalOrder.email,requestId:'request-000000000001',confirm:true,...extra},'test-admin',envelope);
  const check=(extra={})=>manager.admin('mailCheckDelivery',{eventId,id:jobId,...extra},'test-admin',envelope);
  const status=()=>manager.admin('mailStatus',{id:orderId,eventId,includeManual:true},'test-admin',envelope);
  return {db,calls,lookups,mail,dispatch,single,check,status,get,untouched};
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

test('selected mail type can be created before any outbox record exists, without touching order and inventory',async()=>{
  const f=fixture();
  const r=await f.single('pickup');
  assert.equal(r.status,'sent');assert.equal(r.jobId,orderId+'_pickup');assert.equal(f.calls.length,1);
  assert.match(f.calls[0].subject,/^pickup /);
  assert.equal((await f.single('pickup')).jobId,r.jobId);assert.equal(f.calls.length,1);
  const repeat=await f.single('pickup',{requestId:'request-000000000002'});
  assert.equal(repeat.status,'sent');assert.notEqual(repeat.jobId,r.jobId);assert.equal(f.calls.length,2);
  assert.equal(f.get(r.jobId).providerId,'mock-1');assert.equal(f.get(repeat.jobId).resendOf,r.jobId);f.untouched();
});
test('explicit resend preserves original and refuses duplicate concurrent request, wrong address, wrong state and off policy',async()=>{
  const f=fixture({status:'sent',sentAt:when(-2000),providerId:'original'});
  const [a,b]=await Promise.all([f.single(),f.single()]);
  assert.equal(a.jobId,b.jobId);assert.equal(f.calls.length,1);assert.equal(f.get(jobId).providerId,'original');
  await assert.rejects(f.single('pickup',{expectedEmail:'other@example.test'}),{code:'failed-precondition'});
  await assert.rejects(f.single('confirmed'),{code:'failed-precondition'});
  await assert.rejects(f.single('adminCancel'),{code:'failed-precondition'});
  await assert.rejects(f.single('refundCompleted',{jobId:jobId}),{code:'failed-precondition'});
  await f.db.doc('bazaarMailPolicies/'+eventId).set({modes:{pickup:'off'}});
  await assert.rejects(f.single('pickup'),{code:'failed-precondition'});
  assert.equal(f.calls.length,1);f.untouched();
});
test('explicit reminder may be repeated without modifying the order or its reminder timestamp',async()=>{
  const f=fixture();
  await f.db.doc('bazaarEventProjects/'+eventId).set({eventId,status:'published',transferCutoff:when(3600000)});
  const a=await f.single('reminderFinal');assert.equal(a.status,'sent');
  const b=await f.single('reminderFinal',{requestId:'request-000000000002'});assert.equal(b.status,'sent');
  assert.equal(f.calls.length,2);f.untouched();
});
test('direct queued record uses existing quota/lease and refuses an unverified prior delivery',async()=>{
  const f=fixture({status:'failed',deliveryUncertain:true});
  await assert.rejects(f.single(),{code:'failed-precondition'});assert.equal(f.calls.length,0);
  const g=fixture();await g.db.doc('bazaarMailUsage/brevo-rolling').set({slots:[],pauseUntil:Date.now()+3600000});
  assert.equal((await g.single()).status,'delayed');assert.equal(g.calls.length,0);g.untouched();
});
test('delivery lookup exact provider id and actual recipient, marks delivery separately, never sends',async()=>{
  const id='<old@provider.example>',date=when(-1000);
  const f=fixture({status:'sent',providerId:id,sentAt:when(-5000),sentSnapshot:{to:originalOrder.email}},[
    Response.json({events:[{messageId:id,email:'sink@example.test',event:'delivered',date},
      {messageId:'another',email:'sink@example.test',event:'hardBounce',date:when(0)},
      {messageId:id,email:'someone@example.test',event:'hardBounce',date:when(0)}]}),
    Response.json({events:[]}),new Response('{}',{status:403})]);
  const r=await f.check();assert.equal(r.delivery.state,'delivered');assert.equal(f.get(jobId).status,'sent');
  assert.equal(f.lookups[0].searchParams.get('messageId'),id);assert.equal(f.calls.length,0);
  assert.equal((await f.check()).delivery.state,'delivered');
  await assert.rejects(f.check(),{code:'failed-precondition'});assert.equal(f.get(jobId).delivery.state,'delivered');
  await assert.rejects(f.check({eventId:'another-bazaar-event'}),{code:'failed-precondition'});f.untouched();
});
test('delivery failure and missing event are not misrepresented as delivered or as failed send',async()=>{
  const id='<old@provider.example>';
  const f=fixture({status:'sent',providerId:id,sentAt:when(-5000)},[
    Response.json({events:[]}),Response.json({events:[{messageId:id,email:'sink@example.test',event:'hardBounce',date:when(-1000)}]})]);
  assert.equal((await f.check()).delivery.state,'unknown');
  assert.equal((await f.check()).delivery.state,'failed');assert.equal(f.get(jobId).status,'sent');assert.equal(f.calls.length,0);f.untouched();
  const g=fixture({status:'sent',providerId:'captured',sentAt:when(-5000)});
  await assert.rejects(g.check(),{code:'failed-precondition'});assert.equal(g.lookups.length,0);
});
test('individual send and delivery lookup are exposed in email-only UI',()=>{
  const ui=readFileSync(new URL('../src/lib/bazaar/admin/mail.js',import.meta.url),'utf8');
  assert.match(ui,/mailSingleSend/);assert.match(ui,/mailCheckDelivery/);assert.match(ui,/수신 서버 전달 완료/);
  assert.match(ui,/data-mail-kind/);assert.match(ui,/expectedEmail:manual.email/);
});

test('order mail selector shows only eligible ordinary kinds, including mail kinds with no prior history',async()=>{
  const f=fixture();let result=await f.status();
  assert.equal(result.manual.email,originalOrder.email);
  assert.deepEqual(result.manual.options.map(option=>option.kind).sort(),['other','pickup','receipt']);
  await f.db.doc('bazaarMailPolicies/'+eventId).set({modes:{pickup:'off'}});
  result=await f.status();assert.deepEqual(result.manual.options.map(option=>option.kind).sort(),['other','receipt']);
  await f.db.doc('bazaarOrders/'+orderId).set({...originalOrder,canceledAt:when(-1000),cancelReason:'buyer'});
  result=await f.status();assert.deepEqual(result.manual.options.map(option=>option.kind),['buyerCancel']);
  assert.equal(f.calls.length,0);
});

test('manual reminder after personal deadline is allowed until event cutoff; automatic eligibility is unchanged',async()=>{
 const f=fixture();
 const event={eventId,status:'published',transferCutoff:when(3600000)};
 const expired={...originalOrder,paymentDeadline:when(-3600000)};
 await f.db.doc('bazaarEventProjects/'+eventId).set(event);
 await f.db.doc('bazaarOrders/'+orderId).set(expired);
 const r=await f.single('reminderFinal');assert.equal(r.status,'sent');assert.equal(f.calls.length,1);
 assert.deepEqual(f.db.values.get('bazaarOrders/'+orderId),expired);
 const {eligibleReminder}=await import('../worker/bazaar/mail.mjs');
 assert.equal(eligibleReminder(expired,event,{reminderMode:'auto'},Date.now()),false);
 const g=fixture();await g.db.doc('bazaarEventProjects/'+eventId).set({...event,transferCutoff:when(-1000),priorTransferCutoff:when(3600000)});
 await assert.rejects(g.single('reminderFinal'),{code:'failed-precondition'});assert.equal(g.calls.length,0);
});
test('bulk reminder preparation and immediate delivery allow overdue unpaid orders, but reject paid and event cutoff',async()=>{
 const f=fixture();const event={eventId,status:'published',transferCutoff:when(3600000)};
 const overdue={...originalOrder,paymentDeadline:when(-3600000)};
 await f.db.doc('bazaarEventProjects/'+eventId).set(event);
 await f.db.doc('bazaarOrders/'+orderId).set(overdue);
 await f.db.doc('bazaarOrders/'+anotherOrder).set({...originalOrder,id:anotherOrder,bankConfirmedAt:when(-1000)});
 const manager=createMailAdmin(f.db,f.mail);
 const params={eventId,type:'reminderFinal',audience:'unpaid',excludeReported:true,ids:[orderId,anotherOrder]};
 const prep=await manager.admin('mailManualPrepare',params,'test-admin',envelope);
 assert.deepEqual(prep.recipients.map(x=>x.id),[orderId]);
 assert.deepEqual(prep.skipped,[{id:anotherOrder,reason:'audience-mismatch'}]);
 const queued=await manager.admin('mailManualQueue',params,'test-admin',envelope);
 assert.equal(queued.recipients.length,1);
 const sent=await manager.admin('mailJobAction',{eventId,id:queued.recipients[0].jobId,action:'sendNow',confirm:true},'test-admin',envelope);
 assert.equal(sent.status,'sent');assert.equal(f.calls.length,1);
 const {reminderFinalAt,...unchanged}=f.db.values.get('bazaarOrders/'+orderId);
 assert.ok(reminderFinalAt);assert.deepEqual(unchanged,overdue);
 assert.deepEqual(f.db.values.get('bazaarEventProjects/'+eventId+'/products/product'),{soldQty:7});
 assert.deepEqual(f.db.values.get('bazaarEventFinancials/'+eventId),{expenses:[]});
 const again=await manager.admin('mailManualPrepare',params,'test-admin',envelope);
 assert.equal(again.recipients.length,0);assert.equal(again.skipped[0].reason,'already-sent');
 await f.db.doc('bazaarEventProjects/'+eventId).set({...event,transferCutoff:when(-1000)});
 await assert.rejects(manager.admin('mailManualPrepare',params,'test-admin',envelope),{code:'failed-precondition'});
});

test('selected custom bilingual copy is persisted only on selected manual job; default ignores custom draft',async()=>{
 const {selectedMailCopy}=await import('../src/lib/bazaar/admin/mail-copy.mjs');
 const defaults={subjectKo:'기본 제목',introKo:'기본 안내',subjectFr:'Objet standard',introFr:'Texte standard'};
 const custom={subjectKo:'개별 제목',introKo:'개별 안내',subjectFr:'Objet personnalisé',introFr:'Texte personnalisé'};
 for(const mode of ['default','custom']){
  const f=fixture(),manager=createMailAdmin(f.db,f.mail);
  const policy={templates:{pickup:defaults}};
  await f.db.doc('bazaarMailPolicies/'+eventId).set(policy);
  const params={eventId,type:'pickup',audience:'valid',ids:[orderId]};
  const preview=(order,type,event,template)=>({subject:template.subjectKo,text:template.introKo,html:'<p>'+template.introFr+'</p>'});
  const prep=await manager.admin('mailManualPrepare',params,'test-admin',preview);
  assert.deepEqual(prep.recipients.map(row=>row.id),[orderId]);assert.equal(f.calls.length,0);
  const override=selectedMailCopy(mode,custom,defaults);
  assert.deepEqual(override,mode==='custom'?custom:{});
  const queued=await manager.admin('mailManualQueue',{...params,override},'test-admin',preview);
  assert.equal(f.calls.length,0);assert.equal(queued.recipients.length,1);
  const id=queued.recipients[0].jobId;
  assert.deepEqual(f.get(id).template,override);
  const result=await manager.admin('mailJobAction',{eventId,id,action:'sendNow',confirm:true},'test-admin',preview);
  assert.equal(result.status,'sent');assert.equal(f.calls.length,1);
  const expected=mode==='custom'?custom:defaults;
  assert.equal(f.calls[0].subject,expected.subjectKo);
  assert.equal(f.calls[0].textContent,expected.introKo);
  assert.equal(f.calls[0].htmlContent,'<p>'+expected.introFr+'</p>');
  assert.deepEqual(f.db.values.get('bazaarMailPolicies/'+eventId),policy);
  assert.equal(f.db.values.has('bazaarOutbox/'+anotherOrder+'_pickup'),false);
  f.untouched();
 }
});
