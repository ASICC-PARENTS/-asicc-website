import {mailKinds,policyMode} from './mail-policy.mjs';
import { createHash } from 'node:crypto';
import { BazaarError } from '../../firebase-functions-bazaar/bazaar/service.mjs';
import { eligibleReminder, mailFields } from './mail.mjs';
import {orderPaymentSummary} from '../../firebase-functions-bazaar/bazaar/order-payments.mjs';
import {latestTransferCutoff,orderTransferCutoff} from '../../firebase-functions-bazaar/bazaar/order-intake.mjs';

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

function formatJob(doc,order){
  const data=doc.data();
  const {orderId,type,status,sentAt,dueAt,lastError,deliveryUncertain,manualSentAt,notice,sentSnapshot}=data;
  const redact=text=>String(text??'').replace(/([#&?]token=)[^s&]+/g,'$1[redacted]');
  return {id:doc.id,orderId,type,status:status??(sentAt?'sent':'queued'),sentAt,dueAt,lastError,deliveryUncertain,manualSentAt,notice,
    createdAt:data.createdAt??null,requestedAt:data.requestedAt??null,mode:data.mode||((manualSentAt||data.manualBy)?'manual':'auto'),
    method:manualSentAt?'OVH':data.providerId==='captured'?'capture':data.providerId?'Brevo':null,
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
      return {messages,latePayment:entry?.status??null,
        latePaymentDetails:entry?.status==='pending'?Object.fromEntries(['amountCents','actualDate','payer','operator','reference','note']
          .map(key=>[key,entry[key]??null])):null};
    }
    const eventId=data.eventId;
    if(!idPattern.test(eventId??''))throw bad('바자회 행사를 확인해 주세요.');
    const policyRef=policies.doc(eventId);
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
        messages:documents.map(doc=>formatJob(doc,byId.get(doc.data().orderId))),cursor:page.docs.length>50?documents.at(-1).id:null,
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
        if(type==='reminderFinal'&&opening&&(active?.eventId!==eventId||active.finalizedAt
          ||active.reconciliationStartedAt||!(Date.now()<latestTransferCutoff(active))))throw conflict('송금 마감 이전의 현재 행사만 알림을 준비할 수 있습니다.');
        const rows=await Promise.all(targets.map(async target=>({order:(await tx.get(target.order)).data(),job:await tx.get(target.job)})));
        const recipients=[];
        for(const {order,job} of rows){
          if(order?.eventId!==eventId)continue;
          if(opening&&type==='reminderFinal'&&!(Date.now()<orderTransferCutoff(order,active)))continue;
          const stored=job.data();
          if(op==='mailManualPrepare'){
            if(!matchesManual(order,eventId,type,audience,data.excludeReported!==false)
              ||order.reminderFinalAt&&type==='reminderFinal'
              ||['sending','manualSent','sent'].includes(stored?.status)||stored?.sentAt||stored?.deliveryUncertain
              ||(stored?.status==='manualReserved'&&stored.manualBy!==uid))continue;
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
        return {recipients};
      });
    }
    throw bad('알 수 없는 메일 관리 작업입니다.');
  }
  return {admin,nextReminderBatch};
}
