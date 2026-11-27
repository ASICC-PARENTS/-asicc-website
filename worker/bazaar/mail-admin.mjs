import {mailKinds,policyMode} from './mail-policy.mjs';
import { createHash } from 'node:crypto';
import { BazaarError } from '../../firebase-functions-bazaar/bazaar/service.mjs';
import { eligibleReminder, mailFields, manualReminderWindow } from './mail.mjs';
import {orderPaymentSummary} from '../../firebase-functions-bazaar/bazaar/order-payments.mjs';
import {latestTransferCutoff} from '../../firebase-functions-bazaar/bazaar/order-intake.mjs';

const choices = ['manual','auto'];
const manualTypes=Object.keys(mailKinds).filter(kind=>!['orderChanged','additionalPayment','refundCompleted'].includes(kind));
const audiences = ['unpaid','confirmed','canceled','valid'];
const idPattern = /^[a-z0-9-]{12,60}$/;
const orderPattern = /^[a-zA-Z0-9]{15,40}$/;
const mailPattern = /^[a-zA-Z0-9_-]{16,110}$/;
const mailOrder = ref => ref.orderBy('__name__');
const now = () => new Date().toISOString();
const bad = message => new BazaarError('invalid-argument',message);
const conflict = message => new BazaarError('failed-precondition',message);

function formatJob(doc,order,mail){
  const data=doc.data();
  const {orderId,type,status,sentAt,dueAt,lastError,deliveryUncertain,manualSentAt,notice,sentSnapshot}=data;
  const redact=text=>String(text??'').replace(/([#&?]token=)[^s&]+/g,'$1[redacted]');
  return {id:doc.id,orderId,type,status:status??(sentAt?'sent':'queued'),sentAt,dueAt,lastError,deliveryUncertain,manualSentAt,notice,
    createdAt:data.createdAt??null,requestedAt:data.requestedAt??null,mode:data.mode||((manualSentAt||data.manualBy)?'manual':'auto'),
    method:manualSentAt?'OVH':data.providerId==='captured'?'capture':data.providerId?'Brevo':null,
    delivery:data.delivery??null,canCheckDelivery:mail.canCheckDelivery(data),
    actor:data.manualBy||data.retryBy||null,retries:data.retryHistory||[],
    orderRef:order?.orderRef??null,name:order?.name??null,email:order?.email??null,
    resendOf:data.resendOf??null,resendJobId:data.resendJobId??null,
    sentSnapshot:sentSnapshot?{...sentSnapshot,text:redact(sentSnapshot.text)}:null};
}

function matchesManual(order,eventId,type,audience,excludeReported) {
  if(!order?.email||order.eventId!==eventId)return false;
  if(type==='receipt')return !order.canceledAt;
  if(type==='confirmed')return orderPaymentSummary(order).settled;
  if(type==='buyerCancel'||type==='adminCancel')return !!order.canceledAt&&order.cancelReason===(type==='buyerCancel'?'buyer':'admin');
  if(type==='bulkCancel')return order.cancelReason==='unpaidFinalization';
  if(type==='reminderFinal'||audience==='unpaid'){
    return !order.canceledAt&&!order.bankConfirmedAt&&(!excludeReported||!order.transferReportedAt);
  }
  if(audience==='canceled')return !!order.canceledAt;
  if(audience==='confirmed')return orderPaymentSummary(order).settled;
  return !order.canceledAt;
}

const transactionKinds=['orderChanged','additionalPayment','refundCompleted'];
const storedType=kind=>['buyerCancel','adminCancel'].includes(kind)?'cancel':kind;
function directEligible(kind,order,event,policy,record){
  if(!order?.email||!Object.hasOwn(mailKinds,kind)||policyMode(policy,kind)==='off')return false;
  if(kind==='buyerCancel'||kind==='adminCancel')return !!order.canceledAt&&order.cancelReason===(kind==='buyerCancel'?'buyer':'admin');
  if(kind==='bulkCancel')return !!order.canceledAt&&order.cancelReason==='unpaidFinalization';
  if(kind==='confirmed')return !!order.bankConfirmedAt&&!order.canceledAt&&orderPaymentSummary(order).settled;
  if(kind==='reminderFinal')return !order.canceledAt&&!order.bankConfirmedAt&&!order.transferReportedAt
    &&manualReminderWindow(order,event,Date.now());
  if(kind==='refundCompleted')return record?.change?.amountCents>0&&!!record.change.at;
  if(kind==='additionalPayment')return !order.canceledAt&&record?.change?.amountCents>0&&orderPaymentSummary(order).additionalDue===record.change.amountCents;
  if(kind==='orderChanged')return !!record?.change&&!order.canceledAt;
  return !order.canceledAt;
}

export function createMailAdmin(db,mail) {
  const outbox=db.collection('bazaarOutbox');
  const orders=db.collection('bazaarOrders');
  const policies=db.collection('bazaarMailPolicies');
  const schedules=db.collection('bazaarMailSchedules');
  const eventRef=id=>db.doc(`bazaarEventProjects/${id}`);

  function finishManual(tx,job,order,completed) {
    const record=job.data();
    if(completed){
      tx.update(job.ref,{status:'manualSent',manualSentAt:now(),payload:null});
      if(record.type==='reminderFinal')tx.update(orders.doc(order.id),{reminderFinalAt:now()});
    }else if(record.manualPreviousStatus){
      tx.update(job.ref,{status:record.manualPreviousStatus,dueAt:record.manualPreviousDueAt??null,manualBy:null});
    }else{
      tx.delete(job.ref);
    }
  }

  async function nextReminderBatch() {
    const check=now();
    const ready=await schedules.where('runAt','>=','0').where('runAt','<=',check).orderBy('runAt').limit(1).get();
    const planRef=ready.docs[0]?.ref;
    if(!planRef)return;
    await db.runTransaction(async tx=>{
      const [planned,active,policy]=await Promise.all([tx.get(planRef),tx.get(eventRef(planRef.id)),tx.get(policies.doc(planRef.id))]);
      const plan=planned.data(),event=active.data(),config=policy.data();
      if(!plan?.runAt||plan.runAt>check)return;
      if(event?.eventId!==planRef.id||config?.reminderMode!=='auto'||event.finalizedAt||event.reconciliationStartedAt
        ||!(Date.now()<latestTransferCutoff(event))){
        tx.update(planRef,{runAt:null});
        return;
      }
      let page=mailOrder(orders.where('eventId','==',planRef.id)).limit(13);
      if(plan.cursor)page=page.startAfter(orders.doc(plan.cursor));
      const rows=(await tx.get(page)).docs;
      const matched=rows.slice(0,12).filter(order=>eligibleReminder(order.data(),event,config,Date.now()));
      const previous=await Promise.all(matched.map(order=>tx.get(outbox.doc(`${order.id}_reminderFinal`))));
      for(const [index,row] of matched.entries()){
        if(previous[index].exists)continue;
        tx.create(previous[index].ref,{...mailFields('reminderFinal',config.reminderAt),type:'reminderFinal',
          eventId:planRef.id,orderId:row.id,createdAt:check,attempts:0});
      }
      tx.update(planRef,{runAt:rows.length>12?check:null,cursor:rows.length>12?rows[11].id:null});
    });
  }

  async function admin(op,data,uid,message) {
    if(op==='mailStatus'){
      if(!orderPattern.test(data.id??''))throw bad('주문 번호를 확인해 주세요.');
      const [messages,review]=await Promise.all([mail.status(data.id),db.doc(`bazaarLatePayments/${data.id}`).get()]);
      const entry=review.data();
      let manual=null;
      if(data.includeManual===true&&idPattern.test(data.eventId??'')){
        const [order,event,policy]=await db.getAll(orders.doc(data.id),eventRef(data.eventId),policies.doc(data.eventId));
        const row=order.data(),config=policy.data();
        if(row?.eventId===data.eventId&&row.email)manual={email:row.email,orderRef:row.orderRef??null,
          options:Object.keys(mailKinds).filter(kind=>!transactionKinds.includes(kind)&&directEligible(kind,row,event.data(),config))
            .map(kind=>({kind})).concat(messages.filter(m=>transactionKinds.includes(m.type)&&m.hasChange&&policyMode(config,m.type)!=='off')
              .map(m=>({kind:m.type,jobId:m.id,at:m.sentAt||m.dueAt||null})))};
      }
      return {messages,manual,latePayment:entry?.status??null,
        latePaymentDetails:entry?.status==='pending'?Object.fromEntries(['amountCents','actualDate','payer','operator','reference','note']
          .map(key=>[key,entry[key]??null])):null};
    }
    const eventId=data.eventId;
    if(!idPattern.test(eventId??''))throw bad('바자회 행사를 확인해 주세요.');
    const policyRef=policies.doc(eventId);
    if(op==='mailCheckDelivery'){
      if(!mailPattern.test(data.id??''))throw bad('메일 기록을 확인해 주세요.');
      const ref=outbox.doc(data.id),record=(await ref.get()).data();
      if(!record||!orderPattern.test(record.orderId)||record.eventId&&record.eventId!==eventId)throw conflict('해당 행사의 메일 기록이 아닙니다.');
      const order=(await orders.doc(record.orderId).get()).data();
      if(order?.eventId!==eventId||!mail.canCheckDelivery(record))throw conflict('Brevo 전달 기록을 확인할 수 없는 이메일입니다.');
      let delivery;
      try{delivery=await mail.checkDelivery(record,order);}catch{throw conflict('Brevo 전달 내역 조회에 실패했습니다. 기존 발송 기록은 유지되었습니다.');}
      if(!delivery)throw conflict('전달 내역을 확인할 수 없습니다.');
      const saved=await db.runTransaction(async tx=>{
        const latest=(await tx.get(ref)).data();
        if(latest?.providerId!==record.providerId||latest?.status!=='sent')throw conflict('메일 기록이 변경되었습니다. 다시 조회해 주세요.');
        if(latest.delivery?.eventAt&&(!delivery.eventAt||latest.delivery.eventAt>delivery.eventAt))return latest.delivery;
        tx.update(ref,{delivery});return delivery;
      });
      return {jobId:data.id,delivery:saved,checkedDelivery:true};
    }
    if(op==='mailSingleSend'){
      const {orderId,kind,requestId,expectedEmail,jobId:sourceId}=data;
      if(!orderPattern.test(orderId??'')||!Object.hasOwn(mailKinds,kind)||!idPattern.test(requestId??'')||
        typeof expectedEmail!=='string'||data.confirm!==true||
        (transactionKinds.includes(kind)?!mailPattern.test(sourceId??''):!!sourceId))throw bad('주문, 수신자 및 메일 종류를 확인해 주세요.');
      if(!mail.canSend()||typeof message!=='function')throw conflict('현재 이메일 발송 서버를 사용할 수 없습니다.');
      const type=storedType(kind),baseId=sourceId||orderId+'_'+type;
      const digest=createHash('sha256').update([eventId,orderId,kind,baseId,requestId].join('|')).digest('hex');
      const ledger=db.doc('bazaarMailDispatchRequests/'+digest);
      const selected=await db.runTransaction(async tx=>{
        const [orderSnap,eventSnap,policySnap,baseSnap,replay]=await Promise.all([tx.get(orders.doc(orderId)),
          tx.get(eventRef(eventId)),tx.get(policyRef),tx.get(outbox.doc(baseId)),tx.get(ledger)]);
        const order=orderSnap.data(),record=baseSnap.data();
        if(order?.eventId!==eventId||order.email!==expectedEmail)throw conflict('수신자 또는 행사 정보가 변경되었습니다. 다시 확인해 주세요.');
        if(replay.exists)return replay.data().jobId;
        if(record&&(record.orderId!==orderId||record.type!==type||record.eventId&&record.eventId!==eventId))
          throw conflict('메일 기록과 주문 정보가 일치하지 않습니다.');
        if(!directEligible(kind,order,eventSnap.data(),policySnap.data(),record))throw conflict('현재 주문 상태 또는 발송 설정에서 이 종류의 메일을 발송할 수 없습니다.');
        if(record?.deliveryUncertain||record?.status==='sending'||record?.status==='manualReserved')
          throw conflict('발송 여부가 확실하지 않거나 발송 중입니다. 기존 이력을 먼저 확인해 주세요.');
        const requestedAt=now();
        const status=record?.status??(record?.sentAt?'sent':'queued');
        const alreadySent=record&&(record.sentAt||record.manualSentAt||['sent','manualSent'].includes(status));
        const previousChild=record?.resendJobId?await tx.get(outbox.doc(record.resendJobId)):null;
        const child=previousChild?.data();
        if(child&&(child.deliveryUncertain||['queued','delayed','sending','manualReserved','failed'].includes(child.status)))
          throw conflict('기존 재발송 건이 아직 처리되지 않았습니다. 해당 발송 이력을 먼저 확인해 주세요.');
        const newId=alreadySent?orderId+'_direct_'+digest.slice(0,24):baseId;
        const ref=outbox.doc(newId);
        const fields={...mailFields(type,requestedAt),type,eventId,orderId,mode:'manual',requestedAt,manualBy:uid,
          explicitDirect:true,expectedEmail,deliveryUncertain:false,lastError:null,sendingUntil:null};
        if(alreadySent){
          tx.create(ref,{...fields,createdAt:requestedAt,attempts:0,resendOf:baseId,
            ...(record.change?{change:record.change}:{}),...(record.template?{template:record.template}:{})});
          tx.update(baseSnap.ref,{resendJobId:newId});
        }else if(record){
          if(!['queued','delayed','failed','skipped','canceled'].includes(status))throw conflict('기존 발송 기록을 확인해 주세요.');
          tx.update(ref,{...fields,providerKey:record.providerKey??fields.providerKey,firstAttemptAt:null,
            ...(status==='failed'?{retryBy:uid,retryAt:requestedAt,retryHistory:[...(record.retryHistory||[]),{at:requestedAt,by:uid,reason:record.lastError||null}]}:{})});
        }else{
          tx.create(ref,{...fields,createdAt:requestedAt,attempts:0});
        }
        tx.create(ledger,{jobId:newId,eventId,orderId,kind,createdAt:requestedAt,actor:uid});
        return newId;
      });
      await mail.deliver(selected,message);
      const result=(await outbox.doc(selected).get()).data();
      return {jobId:selected,status:result?.status??'queued',lastError:result?.lastError??null,
        deliveryUncertain:result?.deliveryUncertain===true,method:result?.providerId==='captured'?'capture':result?.providerId?'Brevo':null};
    }
    if(op==='mailOverview'){
      let query=mailOrder(outbox.where('eventId','==',eventId)).limit(51);
      if(data.cursor){
        if(!mailPattern.test(data.cursor))throw bad('메일 목록 위치가 올바르지 않습니다.');
        query=query.startAfter(outbox.doc(data.cursor));
      }
      const [policy,budget,page,schedule]=await Promise.all([policyRef.get(),mail.budget(),query.get(),schedules.doc(eventId).get()]);
      const documents=page.docs.slice(0,50);
      const ids=[...new Set(documents.map(doc=>doc.data().orderId).filter(id=>orderPattern.test(id)))];
      const orderSnaps=ids.length?await db.getAll(...ids.map(id=>orders.doc(id))):[];
      const byId=new Map(orderSnaps.map(doc=>[doc.id,doc.data()]));
      return { policy:{reminderMode:'manual',bulkCancel:'manual',reminderAt:null,...policy.data()},budget,
        messages:documents.map(doc=>formatJob(doc,byId.get(doc.data().orderId),mail)),cursor:page.docs.length>50?documents.at(-1).id:null,
        nextReminderAt:schedule.data()?.runAt??null };
    }
    if(op==='mailTransactionQueue'){
      const id=data.jobId;
      if(!mailPattern.test(id)||data.confirm!==true)throw bad('발송할 거래의 이메일을 확인해 주세요.');
      const ref=outbox.doc(id);
      return db.runTransaction(async tx=>{
        const [snapshot,policy]=await Promise.all([tx.get(ref),tx.get(policyRef)]);
        const job=snapshot.data();
        if(!job||job.eventId!==eventId||!['orderChanged','additionalPayment','refundCompleted'].includes(job.type)||
          !job.change||!orderPattern.test(job.orderId)||!['queued','skipped'].includes(job.status)||job.sentAt||job.deliveryUncertain)
          throw conflict('아직 발송하지 않은 거래 이메일만 선택할 수 있습니다.');
        const order=(await tx.get(orders.doc(job.orderId))).data();
        if(!order?.email||order.eventId!==eventId||policyMode(policy.data(),job.type)!=='manual')
          throw conflict('해당 종류의 수동 발송 설정 및 수신 이메일을 확인해 주세요.');
        if(job.mode==='manual'&&job.status==='queued')return {queued:true};
        const requestedAt=now();
        tx.update(ref,{...mailFields(job.type,requestedAt),status:'queued',mode:'manual',requestedAt,manualBy:uid});
        return {queued:true};
      });
    }
    if(op==='mailAccountUsage'){
      if(!Number.isInteger(data.remaining)||data.remaining<0||data.remaining>300)throw bad('Brevo 잔여량은 0~300통입니다.');
      await mail.recordAccountUsage(data.remaining);
      return {ok:true};
    }
    if(op==='mailPolicy'){
      const {modes,templates}=data;
      const reminderMode=modes?'manual':data.reminderMode;
      const bulkCancel=modes?(modes.bulkCancel==='auto'?'auto':'manual'):data.bulkCancel;
      if(modes&&Object.entries(mailKinds).some(([kind,defaultMode])=>!['off','manual',...(defaultMode==='auto'||kind==='bulkCancel'?['auto']:[])].includes(modes[kind])))throw bad('이메일 종류별 발송 방식을 확인해 주세요.');
      const safeTemplates={};
      if(templates&&typeof templates==='object')for(const kind of Object.keys(mailKinds)){
        const template=templates[kind];if(!template)continue;
        safeTemplates[kind]=Object.fromEntries(['subjectKo','subjectFr','introKo','introFr'].map(key=>[key,String(template[key]??'').trim().slice(0,key.startsWith('subject')?150:2500)]));
        if(kind==='other'&&Array.isArray(template.fields))safeTemplates[kind].fields=[...new Set(template.fields.filter(key=>['event','order','items','total','pickup','deadline'].includes(key)))];
      }
      if(!choices.includes(reminderMode)||!choices.includes(bulkCancel))throw bad('발송 방식을 확인해 주세요.');
      const at=Date.parse(data.reminderAt);
      return db.runTransaction(async tx=>{
        const [current,draft,previous]=await Promise.all([tx.get(eventRef(eventId)),tx.get(db.doc(`bazaarDrafts/${eventId}`)),tx.get(policyRef)]);
        const isCurrent=current.data()?.eventId===eventId;
        const event=isCurrent?current.data():draft.data()?.event;
        if(!event||(isCurrent&&(event.finalizedAt||event.reconciliationStartedAt)))throw conflict('현재 행사 또는 임시저장의 정책만 변경할 수 있습니다.');
        if(reminderMode==='auto'&&!(Number.isFinite(at)&&at>Date.now()&&at>=Date.parse(event.orderCutoff)
          &&at<latestTransferCutoff(event))){
          throw bad('알림 시각은 주문 마감 이후, 송금 마감 이전이어야 합니다.');
        }
        const policy={reminderMode,bulkCancel,reminderAt:reminderMode==='auto'?new Date(at).toISOString():null};
        if(modes){
          policy.modes=modes;
          policy.preferredModes=Object.fromEntries(Object.keys(mailKinds).map(kind=>[kind,(mailKinds[kind]==='auto'||kind==='bulkCancel')&&data.preferredModes?.[kind]==='auto'?'auto':'manual']));
          policy.templates=templates?safeTemplates:(previous.data()?.templates||{});
          policy.autoSince={...(previous.data()?.autoSince||{})};
          policy.enabledSince={...(previous.data()?.enabledSince||{})};
          for(const kind of Object.keys(mailKinds))if(modes[kind]!=='off'&&policyMode(previous.data(),kind)==='off')policy.enabledSince[kind]=now();
          for(const kind of Object.keys(mailKinds))if(modes[kind]==='auto'&&policyMode(previous.data(),kind)!=='auto')policy.autoSince[kind]=now();
        }
        tx.set(policyRef,{...policy,updatedAt:now(),updatedBy:uid},{merge:true});
        if(previous.data()?.reminderMode!==reminderMode||previous.data()?.reminderAt!==policy.reminderAt){
          tx.set(schedules.doc(eventId),{runAt:policy.reminderAt,cursor:null});
        }
        return {policy};
      });
    }
    // Dispatch only the explicitly selected outbox record; never drain unrelated orders.
    if(op==='mailJobAction'&&['sendNow','resend'].includes(data.action)){
      if(!mailPattern.test(data.id??'')||data.confirm!==true)throw bad('발송할 이메일을 확인해 주세요.');
      if(!mail.canSend()||typeof message!=='function')throw conflict('현재 이메일 발송 서버를 사용할 수 없습니다.');
      const jobId=await db.runTransaction(async tx=>{
        const ref=outbox.doc(data.id);
        const record=(await tx.get(ref)).data();
        if(!record||!orderPattern.test(record.orderId)||record.eventId&&record.eventId!==eventId)
          throw conflict('해당 행사의 이메일 기록을 찾을 수 없습니다.');
        const [orderSnap,policySnap]=await Promise.all([tx.get(orders.doc(record.orderId)),tx.get(policyRef)]);
        const order=orderSnap.data(),policy=policySnap.data();
        if(order?.eventId!==eventId||!order.email)throw conflict('행사와 수신자를 확인해 주세요.');
        const kind=record.type==='cancel'?(order.cancelReason==='buyer'?'buyerCancel':'adminCancel'):record.type;
        if(!Object.hasOwn(mailKinds,kind)||policyMode(policy,kind)==='off')throw conflict('이 이메일 종류의 발송이 꺼져 있습니다.');
        const requestedAt=now();
        const status=record.status??(record.sentAt?'sent':'queued');
        if(data.action==='resend'){
          // Keep the original delivery record, and allow only one child per original.
          // Another deliberate resend must select the new history row.
          if(!['receipt','confirmed'].includes(record.type)||order.canceledAt||
            !['sent','manualSent'].includes(status)||record.deliveryUncertain||
            (record.type==='confirmed'&&(!order.bankConfirmedAt||!orderPaymentSummary(order).settled)))
            throw conflict('유효한 주문의 접수 또는 입금 확인 메일만 다시 보낼 수 있습니다.');
          const resendId=`${record.orderId}_resend_${createHash('sha256').update(data.id).digest('hex').slice(0,24)}`;
          const resendRef=outbox.doc(resendId);
          const existing=await tx.get(resendRef);
          if(existing.exists)return resendId;
          tx.create(resendRef,{...mailFields(record.type,requestedAt),type:record.type,eventId,orderId:record.orderId,
            status:'queued',createdAt:requestedAt,attempts:0,mode:'manual',requestedAt,manualBy:uid,resendOf:data.id});
          tx.update(ref,{resendJobId:resendId});
          return resendId;
        }
        // A scheduler or another administrator may have already started/completed this job.
        // Return its actual status without resetting the lease or making a second delivery.
        if(['sent','sending','manualSent','skipped','canceled'].includes(status)||record.sentAt||record.manualSentAt)return data.id;
        if(!['queued','delayed','failed'].includes(status)||record.sendingUntil>requestedAt||
          record.deliveryUncertain&&(status!=='failed'||data.providerConfirmedUnsent!==true))
          throw conflict('발송 대기 또는 미발송이 확인된 실패 이메일만 즉시 발송할 수 있습니다.');
        if(status==='queued'&&record.dueAt>requestedAt)throw conflict('아직 발송 예정 시각이 되지 않았습니다.');
        const fields=mailFields(record.type,requestedAt);
        tx.update(ref,{...fields,providerKey:record.providerKey??fields.providerKey,mode:'manual',eventId,requestedAt,manualBy:uid,
          deliveryUncertain:false,lastError:null,firstAttemptAt:null,sendingUntil:null,
          ...(status==='failed'?{retryBy:uid,retryAt:requestedAt,retryHistory:[...(record.retryHistory||[]),
            {at:requestedAt,by:uid,reason:record.lastError||null}]}:{})});
        return data.id;
      });
      // Await the existing leased, quota-limited delivery path, not a queue-only acknowledgement.
      await mail.deliver(jobId,message);
      const result=(await outbox.doc(jobId).get()).data();
      return {jobId,status:result?.status??(result?.sentAt?'sent':'queued'),lastError:result?.lastError??null,
        deliveryUncertain:result?.deliveryUncertain===true,method:result?.providerId==='captured'?'capture':result?.providerId?'Brevo':null};
    }
    if(op==='mailJobAction'){
      if(!mailPattern.test(data.id??'')||!['retry','cancel','completeManual','releaseManual'].includes(data.action))throw bad('메일 작업을 확인해 주세요.');
      return db.runTransaction(async tx=>{
        const ref=outbox.doc(data.id);
        const job=await tx.get(ref),record=job.data();
        if(!record||!orderPattern.test(record.orderId))throw conflict('메일 기록을 찾을 수 없습니다.');
        const order=(await tx.get(orders.doc(record.orderId))).data();
        if(order?.eventId!==eventId)throw conflict('행사가 일치하지 않습니다.');
        if(data.action==='completeManual'||data.action==='releaseManual'){
          if(record.status!=='manualReserved'||record.manualBy!==uid)throw conflict('이 계정에서 준비 중인 OVH 메일만 처리할 수 있습니다.');
          finishManual(tx,job,order,data.action==='completeManual');
        }else if(data.action==='cancel'){
          if(!['queued','delayed'].includes(record.status)||record.deliveryUncertain)throw conflict('안전하게 취소할 수 있는 대기 메일만 선택해 주세요.');
          tx.update(ref,{status:'canceled',dueAt:null,urgentDueAt:null,canceledBy:uid,canceledAt:now()});
        }else{
          if(record.status!=='failed'||(record.deliveryUncertain&&data.providerConfirmedUnsent!==true)){
            throw conflict('Brevo 발송 이력에서 미발송을 확인한 실패 메일만 다시 보낼 수 있습니다.');
          }
          const fields=mailFields(record.type);
          tx.update(ref,{...fields,providerKey:record.providerKey??fields.providerKey,deliveryUncertain:false,
            lastError:null,firstAttemptAt:null,sendingUntil:null,retryBy:uid,retryAt:now(),retryHistory:[...(record.retryHistory||[]),{at:now(),by:uid,reason:record.lastError||null}]});
        }
        return {ok:true};
      });
    }
    if(['mailManualPrepare','mailManualComplete','mailManualRelease','mailManualQueue'].includes(op)){
      const type=data.type;
      const audience=data.audience;
      const notice=type==='other'?String(data.notice??'').trim():'';
      if(!manualTypes.includes(type)||!audiences.includes(audience)||!Array.isArray(data.ids)
        ||!data.ids.length||data.ids.length>30||data.ids.some(id=>!orderPattern.test(id))
        ||(type==='other'&&(!notice||notice.length>80)))throw bad('공지 종류와 대상을 확인해 주세요.');
      const key=notice?`other-${createHash('sha256').update(notice).digest('hex').slice(0,16)}`:['buyerCancel','adminCancel'].includes(type)?'cancel':type;
      const jobType=key==='cancel'?'cancel':type;
      const ids=[...new Set(data.ids)];
      const queueManual=op==='mailManualQueue';
      const opening=op==='mailManualPrepare'||queueManual;
      const template=Object.fromEntries(['subjectKo','subjectFr','introKo','introFr'].map(key=>[key,String(data.override?.[key]??'').trim().slice(0,key.startsWith('subject')?150:2500)]).filter(([,value])=>value));
      const targets=ids.map(id=>({order:orders.doc(id),job:outbox.doc(`${id}_${key}`)}));
      return db.runTransaction(async tx=>{
        if(opening&&policyMode((await tx.get(policyRef)).data(),type)==='off')throw conflict('이 이메일은 발송이 꺼져 있습니다.');
        const active=type==='reminderFinal'&&opening?(await tx.get(eventRef(eventId))).data():null;
        if(type==='reminderFinal'&&opening&&!manualReminderWindow({eventId},active,Date.now()))throw conflict('행사 전체 송금 마감 이전의 현재 행사만 알림을 준비할 수 있습니다.');
        const rows=await Promise.all(targets.map(async target=>({order:(await tx.get(target.order)).data(),job:await tx.get(target.job)})));
        const recipients=[],skipped=[];
        for(const {order,job} of rows){
          if(order?.eventId!==eventId)continue;
          if(opening&&type==='reminderFinal'&&!manualReminderWindow(order,active,Date.now()))continue;
          const stored=job.data();
          if(op==='mailManualPrepare'){
            const reason=!matchesManual(order,eventId,type,audience,data.excludeReported!==false)?'audience-mismatch':
              order.reminderFinalAt&&type==='reminderFinal'?'already-sent':
              stored?.deliveryUncertain?'delivery-uncertain':
              ['sending','manualSent','sent'].includes(stored?.status)||stored?.sentAt?'already-sent-or-sending':
              stored?.status==='manualReserved'&&stored.manualBy!==uid?'reserved-by-other':null;
            if(reason){skipped.push({id:order.id,reason});continue;}
            if(stored?.status!=='manualReserved')tx.set(job.ref,{
              orderId:order.id,eventId,type:jobType,notice,createdAt:stored?.createdAt??now(),
              status:'manualReserved',manualBy:uid,dueAt:null,urgentDueAt:null,
              manualPreviousStatus:stored?.status??null,manualPreviousDueAt:stored?.dueAt??null
            },{merge:true});
            recipients.push({id:order.id,email:order.email});
          }else if(queueManual&&stored?.status==='manualReserved'&&stored.manualBy===uid){
            if(!matchesManual(order,eventId,type,audience,data.excludeReported!==false)||type==='reminderFinal'&&order.reminderFinalAt)continue;
            const requestedAt=now();
            tx.update(job.ref,{...mailFields(jobType,requestedAt),status:'queued',mode:'manual',requestedAt,template,
              manualPreviousStatus:null,manualPreviousDueAt:null});
            recipients.push({id:order.id,jobId:job.id});
          }else if(!queueManual&&stored?.status==='manualReserved'&&stored.manualBy===uid){
            finishManual(tx,job,order,op==='mailManualComplete');
            recipients.push({id:order.id});
          }
        }
        return {recipients,skipped};
      });
    }
    throw bad('알 수 없는 메일 관리 작업입니다.');
  }
  return {admin,nextReminderBatch};
}
