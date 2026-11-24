import {mailKinds,policyMode} from './mail-policy.mjs';
import { createHash } from 'node:crypto';
import { BazaarError } from '../../firebase-functions-bazaar/bazaar/service.mjs';
import { eligibleReminder, mailFields } from './mail.mjs';

const choices = ['manual','auto'];
const manualTypes = ['reminderFinal','bulkCancel','pickup','other'];
const audiences = ['unpaid','confirmed','canceled','valid'];
const idPattern = /^[a-z0-9-]{12,60}$/;
const orderPattern = /^[a-zA-Z0-9]{15,40}$/;
const mailPattern = /^[a-zA-Z0-9_-]{16,110}$/;
const mailOrder = ref => ref.orderBy('__name__');
const now = () => new Date().toISOString();
const bad = message => new BazaarError('invalid-argument',message);
const conflict = message => new BazaarError('failed-precondition',message);

function formatJob(doc) {
  const { orderId,type,status,sentAt,dueAt,lastError,deliveryUncertain,manualSentAt,notice,sentSnapshot }=doc.data();
  return {id:doc.id,orderId,type,status:status??(sentAt?'sent':'queued'),sentAt,dueAt,lastError,
    deliveryUncertain,manualSentAt,notice,sentSnapshot};
}

function matchesManual(order,eventId,type,audience,excludeReported) {
  if(!order?.email||order.eventId!==eventId)return false;
  if(type==='bulkCancel')return order.cancelReason==='unpaidFinalization';
  if(type==='reminderFinal'||audience==='unpaid'){
    return !order.canceledAt&&!order.bankConfirmedAt&&(!excludeReported||!order.transferReportedAt);
  }
  if(audience==='canceled')return !!order.canceledAt;
  if(audience==='confirmed')return !order.canceledAt&&!!order.bankConfirmedAt;
  return !order.canceledAt;
}

export function createMailAdmin(db,mail) {
  const outbox=db.collection('bazaarOutbox');
  const orders=db.collection('bazaarOrders');
  const policies=db.collection('bazaarMailPolicies');
  const schedules=db.collection('bazaarMailSchedules');
  const activeRef=db.doc('bazaarMeta/event');

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
      const [planned,active,policy]=await Promise.all([tx.get(planRef),tx.get(activeRef),tx.get(policies.doc(planRef.id))]);
      const plan=planned.data(),event=active.data(),config=policy.data();
      if(!plan?.runAt||plan.runAt>check)return;
      if(event?.eventId!==planRef.id||config?.reminderMode!=='auto'||event.finalizedAt||event.reconciliationStartedAt
        ||!(Date.now()<Date.parse(event.transferCutoff))){
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

  async function admin(op,data,uid) {
    if(op==='mailStatus'){
      if(!orderPattern.test(data.id??''))throw bad('주문 번호를 확인해 주세요.');
      const [messages,review]=await Promise.all([mail.status(data.id),db.doc(`bazaarLatePayments/${data.id}`).get()]);
      return {messages, latePayment:review.data()?.status??null};
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
      return { policy:{reminderMode:'manual',bulkCancel:'manual',reminderAt:null,...policy.data()},budget,
        messages:documents.map(formatJob),cursor:page.docs.length>50?documents.at(-1).id:null,
        nextReminderAt:schedule.data()?.runAt??null };
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
      }
      if(!choices.includes(reminderMode)||!choices.includes(bulkCancel))throw bad('발송 방식을 확인해 주세요.');
      const at=Date.parse(data.reminderAt);
      return db.runTransaction(async tx=>{
        const [current,draft,previous]=await Promise.all([tx.get(activeRef),tx.get(db.doc(`bazaarDrafts/${eventId}`)),tx.get(policyRef)]);
        const event=current.data()?.eventId===eventId?current.data():draft.data()?.event;
        if(!event||event.finalizedAt||event.reconciliationStartedAt)throw conflict('현재 행사 또는 임시저장의 정책만 변경할 수 있습니다.');
        if(reminderMode==='auto'&&!(Number.isFinite(at)&&at>Date.now()&&at>=Date.parse(event.orderCutoff)
          &&at<Date.parse(event.transferCutoff))){
          throw bad('알림 시각은 주문 마감 이후, 송금 마감 이전이어야 합니다.');
        }
        const policy={reminderMode,bulkCancel,reminderAt:reminderMode==='auto'?new Date(at).toISOString():null};
        if(modes){
          policy.modes=modes;
          policy.templates=templates?safeTemplates:(previous.data()?.templates||{});
          policy.autoSince={...(previous.data()?.autoSince||{})};
          for(const kind of Object.keys(mailKinds))if(modes[kind]==='auto'&&policyMode(previous.data(),kind)!=='auto')policy.autoSince[kind]=now();
        }
        tx.set(policyRef,{...policy,updatedAt:now(),updatedBy:uid},{merge:true});
        if(previous.data()?.reminderMode!==reminderMode||previous.data()?.reminderAt!==policy.reminderAt){
          tx.set(schedules.doc(eventId),{runAt:policy.reminderAt,cursor:null});
        }
        return {policy};
      });
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
            lastError:null,firstAttemptAt:null,sendingUntil:null,retryBy:uid,retryAt:now()});
        }
        return {ok:true};
      });
    }
    if(['mailManualPrepare','mailManualComplete','mailManualRelease'].includes(op)){
      const type=data.type;
      const audience=data.audience;
      const notice=type==='other'?String(data.notice??'').trim():'';
      if(!manualTypes.includes(type)||!audiences.includes(audience)||!Array.isArray(data.ids)
        ||!data.ids.length||data.ids.length>30||data.ids.some(id=>!orderPattern.test(id))
        ||(type==='other'&&(!notice||notice.length>80)))throw bad('공지 종류와 대상을 확인해 주세요.');
      const key=notice?`other-${createHash('sha256').update(notice).digest('hex').slice(0,16)}`:type;
      const ids=[...new Set(data.ids)];
      const targets=ids.map(id=>({order:orders.doc(id),job:outbox.doc(`${id}_${key}`)}));
      return db.runTransaction(async tx=>{
        if(op==='mailManualPrepare'&&policyMode((await tx.get(policyRef)).data(),type)==='off')throw conflict('이 이메일은 발송이 꺼져 있습니다.');
        const active=type==='reminderFinal'&&op==='mailManualPrepare'?(await tx.get(activeRef)).data():null;
        if(type==='reminderFinal'&&op==='mailManualPrepare'&&(active?.eventId!==eventId||active.finalizedAt
          ||active.reconciliationStartedAt||!(Date.now()<Date.parse(active.transferCutoff))))throw conflict('송금 마감 이전의 현재 행사만 알림을 준비할 수 있습니다.');
        const rows=await Promise.all(targets.map(async target=>({order:(await tx.get(target.order)).data(),job:await tx.get(target.job)})));
        const recipients=[];
        for(const {order,job} of rows){
          if(order?.eventId!==eventId)continue;
          const stored=job.data();
          if(op==='mailManualPrepare'){
            if(!matchesManual(order,eventId,type,audience,data.excludeReported!==false)
              ||order.reminderFinalAt&&type==='reminderFinal'
              ||['sending','manualSent','sent'].includes(stored?.status)||stored?.sentAt||stored?.deliveryUncertain
              ||(stored?.status==='manualReserved'&&stored.manualBy!==uid))continue;
            if(stored?.status!=='manualReserved')tx.set(job.ref,{
              orderId:order.id,eventId,type,notice,createdAt:stored?.createdAt??now(),
              status:'manualReserved',manualBy:uid,dueAt:null,urgentDueAt:null,
              manualPreviousStatus:stored?.status??null,manualPreviousDueAt:stored?.dueAt??null
            },{merge:true});
            recipients.push({id:order.id,email:order.email});
          }else if(stored?.status==='manualReserved'&&stored.manualBy===uid){
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
