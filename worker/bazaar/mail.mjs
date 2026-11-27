import {orderPaymentSummary} from '../../firebase-functions-bazaar/bazaar/order-payments.mjs';
import {orderTransferCutoff} from '../../firebase-functions-bazaar/bazaar/order-intake.mjs';
import {autoMailAllowed,mailKind} from './mail-policy.mjs';
import { randomUUID } from 'node:crypto';

const minute = 60_000;
export const mailboxWindow = 25 * 60 * minute;
const urgentTypes = new Set(['receipt', 'cancel']);
const retiredTypes = new Set(['reminder3', 'reported']);
const quotaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const iso = time => new Date(time).toISOString();
const isTestAddress = address => typeof address === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
export const mailFields = (type, dueAt = iso(Date.now())) => ({
  dueAt, urgentDueAt: urgentTypes.has(type) ? dueAt : null, status: 'queued', providerKey: randomUUID()
});
const reschedule = (type, dueAt) => ({ dueAt, urgentDueAt: urgentTypes.has(type) ? dueAt : null });
// Manual reminders may follow an expired personal deadline, but not the event deadline.
export const manualReminderWindow=(order,event,time)=>order?.eventId===event?.eventId&&!!event&&!event.finalizedAt&&!event.reconciliationStartedAt&&time<Date.parse(event.transferCutoff);
export const eligibleReminder = (order, event, policy, time) => order?.email && order.eventId === event?.eventId
  && policy?.reminderMode === 'auto' && !event.finalizedAt && !event.reconciliationStartedAt
  && !order.transferReportedAt && !order.bankConfirmedAt && !order.canceledAt
  && time < orderTransferCutoff(order,event);

function mailMatchesOrder(job,order){
  if(job.type==='confirmed')return !!order.bankConfirmedAt&&!order.canceledAt&&orderPaymentSummary(order).additionalDue===0;
  if(job.type==='additionalPayment')return !order.canceledAt&&job.change?.amountCents>0&&orderPaymentSummary(order).additionalDue===job.change.amountCents;
  if(job.type==='orderChanged')return !order.canceledAt;
  return true;
}
function manualStillEligible(job,order,event,time){
  if(job.type==='cancel')return !!order.canceledAt&&['buyer','admin'].includes(order.cancelReason);
  if(job.type==='refundCompleted')return job.change?.amountCents>0&&!!job.change.at;
  if(job.type==='confirmed')return mailMatchesOrder(job,order);
  if(job.type==='bulkCancel')return order.cancelReason==='unpaidFinalization';
  if(job.type==='reminderFinal')return manualReminderWindow(order,event,time)&&!order.canceledAt&&!order.bankConfirmedAt&&!order.transferReportedAt&&(job.explicitDirect||!order.reminderFinalAt);
  return job.type==='other'||!order.canceledAt;
}

export function createMail(env, db, send = fetch) {
  const outbox = db.collection('bazaarOutbox');
  const provider = env.MAIL_PROVIDER;
  const isCapture = env.MAIL_MODE === 'capture';
  const testRecipient = env.TEST_MAIL_TO;
  const testMailSince = Date.parse(env.BAZAAR_TEST_MAIL_SINCE ?? '');
  const directTestMail = env.BAZAAR_MODE === 'test' && env.FIREBASE_PROJECT_ID === 'asicc-bazaar-test'
    && provider === 'brevo' && Number.isFinite(testMailSince);
  // Never send direct rehearsal mail to an address supplied by an arbitrary visitor.
  // Explicit, comma-separated recipients; empty/malformed configuration fails closed.
  const approvedTestRecipients = new Set(String(env.BAZAAR_TEST_MAIL_RECIPIENTS ?? '')
    .split(',').map(address=>address.trim().toLowerCase()).filter(isTestAddress));
  const approvedRecipient = address => typeof address === 'string' && approvedTestRecipients.has(address.trim().toLowerCase());
  const key = env.BAZAAR_MAIL_API_KEY;
  const from = env.BAZAAR_MAIL_FROM;
  const canSend = () => isCapture || (env.MAIL_MODE === 'api' && ['resend', 'brevo'].includes(provider) && !!key && isTestAddress(from)
    && (env.BAZAAR_MODE === 'production' || (directTestMail ? approvedTestRecipients.size > 0 : isTestAddress(testRecipient))));

  const usage = db.collection('bazaarMailUsage');
  const budgetRef = usage.doc(`${provider || 'brevo'}-rolling`);
  const todayRef = time => usage.doc(`${isCapture ? 'capture' : provider}-accepted-${quotaDate.format(time)}`);
  const freshSlots = (budget, time) => (budget?.slots ?? []).filter(slot => time - slot.at < mailboxWindow);

  async function providerSend(job, payload) {
    if (isCapture) return { ok: true, id: 'captured' };
    const to = env.BAZAAR_MODE === 'production' || directTestMail ? payload.to : testRecipient;
    if (directTestMail && !approvedRecipient(to)) return { skip:true, code:'test-recipient-not-approved' };
    // Workers supports manual redirects. Keep the credentials on the configured provider host.
    const common = { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000) };
    const response = provider === 'resend'
      ? await send('https://api.resend.com/emails', {
        ...common, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          'Idempotency-Key': job.providerKey },
        body: JSON.stringify({ ...payload, to: [to], from: `ASICC <${from}>` })
      })
      : await send('https://api.brevo.com/v3/smtp/email', {
        ...common, headers: { 'api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { name: directTestMail ? 'ASICC · TEST' : 'ASICC', email: from },
          headers: { idempotencyKey: job.providerKey }, subject: payload.subject,
          htmlContent: payload.html, textContent: payload.text, messageVersions: [{ to: [{ email: to }] }] })
      });
    if (response.status >= 300 && response.status < 400) return { code: 'provider-rejected' };
    const result = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, id: result.id ?? result.messageId ?? result.messageIds?.[0] ?? 'accepted' };
    if (provider === 'brevo' && result.code === 'duplicate_parameter') return { ok: true, id: 'deduplicated' };
    if (response.status === 429 || response.status === 402) {
      const hint = response.headers.get('Retry-After');
      const wait = Number(hint) * 1000 || Date.parse(hint) - Date.now() || 0;
      return { retry: Math.max(15 * minute, Math.min(24 * 60 * minute, wait)), code: 'provider-limit' };
    }
    if (response.status >= 500 || response.status === 408 || response.status === 409) {
      console.error('Bazaar mail provider uncertain HTTP status', response.status);
      return { uncertain: true };
    }
    if (response.status === 401 || response.status === 403) return { code: 'provider-access-denied' };
    return { code: 'provider-rejected' };
  }

  async function deliver(mailId, message) {
    if (!canSend()) return false;
    const ref = outbox.doc(mailId);
    const time = Date.now();
    const lease = randomUUID();
    const job = await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const job = snapshot.data();
      if (!job || job.sentAt || !['queued', 'delayed', 'sending'].includes(job.status ?? 'queued')
        || job.sendingUntil > iso(time) || job.dueAt > iso(time)) return null;
      if (job.status === 'sending') {
        tx.update(ref, { status: 'failed', lastError: 'verify-provider-before-resending', deliveryUncertain: true,
          payload: null, ...reschedule(job.type,null) });
        return null;
      }
      const order = (await tx.get(db.doc(`bazaarOrders/${job.orderId}`))).data();
      const active = order?.eventId && (!job.eventId || job.eventId===order.eventId) && ['receipt','reminderFinal','confirmed','pickup','other'].includes(job.type)
        ? await tx.get(db.doc(`bazaarEventProjects/${order.eventId}`)) : null;
      const policy = order?.eventId
        ? (await tx.get(db.doc(`bazaarMailPolicies/${order.eventId}`))).data() : undefined;
      if (directTestMail && (!Number.isFinite(Date.parse(order?.createdAt)) || Date.parse(order.createdAt) < testMailSince
        || !Number.isFinite(Date.parse(job.createdAt)) || Date.parse(job.createdAt) < testMailSince)) {
        tx.update(ref, {status:'skipped',lastError:'before-test-mail-activation',payload:null,...reschedule(job.type,null)});
        return null;
      }
      if (directTestMail && !approvedRecipient(order?.email)) {
        tx.update(ref,{status:'skipped',lastError:'test-recipient-not-approved',payload:null,...reschedule(job.type,null)});
        return null;
      }
      if (!order?.email || (job.explicitDirect&&job.expectedEmail!==order.email) || !autoMailAllowed(policy,job,order) || !mailMatchesOrder(job,order) || retiredTypes.has(job.type) || (job.mode==='manual'?!manualStillEligible(job,order,active?.data(),time):job.type==='bulkCancel'&&policy?.bulkCancel!=='auto')
        || (job.type==='reminderFinal' && active && job.mode!=='manual' && (!eligibleReminder(order,active.data(),policy,time) || order.reminderFinalAt))) {
        tx.update(ref, { status: 'skipped', payload:null, ...reschedule(job.type,null) });
        return null;
      }
      if (job.type==='reminderFinal' && active && job.mode!=='manual' && Date.parse(policy.reminderAt)>time) {
        tx.update(ref,reschedule(job.type,policy.reminderAt));
        return null;
      }
      if (job.deliveryUncertain) {
        tx.update(ref, { status: 'failed', lastError: 'verify-provider-before-resending', payload:null,
          ...reschedule(job.type,null) });
        return null;
      }
      const kind=mailKind(job.type,order);
      const checkout = active?.data();
      const mailEvent = {...order.eventSnapshot};
      if (checkout && checkout.eventId === order.eventId) {
        for (const field of ['pickupAt','pickupEndAt','pickupPlace','pickupKo','pickupFr']) {
          if (checkout[field]) mailEvent[field] = checkout[field];
        }
      }
      const payload = { ...message({...order,...job.change}, job.type, mailEvent,
        {...policy?.templates?.[kind],...job.template},job.change,
        {testMode:env.BAZAAR_MODE==='test',liveEvent:checkout?.eventId===order.eventId?checkout:{status:'closed'}}), to: order.email };
      const providerKey = job.providerKey ?? randomUUID();
      if (!isCapture) {
        const monthly = provider==='resend' ? usage.doc(`resend-month-${quotaDate.format(time).slice(0,7)}`) : null;
        const [budgetSnap,monthSnap] = await Promise.all([tx.get(budgetRef),monthly&&tx.get(monthly)]);
        const budget = budgetSnap.data();
        const slots = freshSlots(budget,time);
        const urgent = urgentTypes.has(job.type);
        const maximum = directTestMail ? (urgent ? 30 : 25) : provider==='resend' ? 100 : urgent ? 300 : 250;
        const count = monthSnap?.data()?.count ?? 0;
        const pause = Number(budget?.pauseUntil) || 0;
        const observation=budget?.accountObservation;
        const observedEmpty=observation && time-observation.at<mailboxWindow
          && slots.filter(slot=>slot.at>=observation.at).length>=observation.remaining;
        if (pause>time || slots.length>=maximum || count>=3000 || observedEmpty) {
          const dueAt=iso(Math.max(time+60*minute,pause));
          tx.update(ref,{status:'delayed',lastError:'free-plan-limit',...reschedule(job.type,dueAt)});
          return null;
        }
        tx.set(budgetRef,{slots:[...slots,{at:time}]},{merge:true});
        if(monthly)tx.set(monthly,{count:count+1});
      }
      const until = iso(time + 2 * minute);
      tx.update(ref, { lease, sendingUntil: until, status: 'sending', ...reschedule(job.type,until),
        firstAttemptAt: job.firstAttemptAt ?? iso(time), attempts: (job.attempts ?? 0) + 1, payload:null, providerKey });
      return { ...job, providerKey, payload, eventId:order.eventId };
    });
    if (!job) return false;
    let result;
    try {
      if(job.eventId){
        const [current,active,policy]=await db.getAll(db.doc(`bazaarOrders/${job.orderId}`),db.doc(`bazaarEventProjects/${job.eventId}`),
          db.doc(`bazaarMailPolicies/${job.eventId}`));
        const order=current.data();
        const obsolete=!order||(job.explicitDirect&&job.expectedEmail!==order.email)||!autoMailAllowed(policy.data(),job,order)||!mailMatchesOrder(job,order)||(job.mode==='manual'?!manualStillEligible(job,order,active.data(),Date.now()):job.type==='reminderFinal'
          ? !eligibleReminder(current.data(),active.data(),policy.data(),Date.now())
          : job.type==='bulkCancel'&&(policy.data()?.bulkCancel!=='auto'||!order.canceledAt));
        if(directTestMail&&!approvedRecipient(order?.email)) result={skip:true,code:'test-recipient-not-approved'};
        else if(obsolete) result={skip:true};
      }
      result ??= await providerSend(job, job.payload);
    }
    catch (error) {
      const name = /^[A-Za-z]{1,24}$/.test(error?.name) ? error.name : 'Error';
      console.error('Bazaar mail transport uncertain', name);
      result = { uncertain: true };
    }
    return db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.lease !== lease) return false;
      if (result.ok) {
        const sentAt = iso(Date.now());
        const [order,accepted]=await Promise.all([job.type==='reminderFinal'&&!job.explicitDirect?tx.get(db.doc(`bazaarOrders/${job.orderId}`)):null,
          tx.get(todayRef(Date.now()))]);
        if (order?.exists) {
          tx.update(order.ref, { reminderFinalAt: sentAt });
        }
        tx.set(accepted.ref,{count:(accepted.data()?.count??0)+1});
        tx.update(ref, { sentAt, providerId: result.id, status: 'sent', ...reschedule(job.type,null),
          sendingUntil: null, lastError: null, payload: null,
          sentSnapshot:{subject:job.payload.subject,text:job.payload.text,to:job.payload.to,mode:job.mode||'auto'} });
        return true;
      }
      if(result.retry&&!isCapture){
        const budget=await tx.get(budgetRef);
        tx.set(budgetRef,{pauseUntil:Math.max(budget.data()?.pauseUntil??0,Date.now()+result.retry)},{merge:true});
      }
      tx.update(ref, { status: result.skip ? 'skipped' : result.retry ? 'delayed' : 'failed',
        ...reschedule(job.type,result.retry ? iso(Date.now()+result.retry) : null),
        sendingUntil: null, lastError: result.skip ? result.code??null : result.code ?? 'provider-result-uncertain',
        deliveryUncertain: result.uncertain === true });
      return false;
    });
  }

  const canCheckDelivery = job => provider==='brevo'&&!isCapture&&!!key&&job?.status==='sent'
    &&typeof job.providerId==='string'&&job.providerId.length>0&&job.providerId.length<=300
    &&!['captured','accepted','deduplicated'].includes(job.providerId);
  async function checkDelivery(job,order) {
    if(!canCheckDelivery(job))return null;
    const target=job.sentSnapshot?.to||order?.email;
    const recipient=env.BAZAAR_MODE==='production'?target:directTestMail?(approvedRecipient(target)?target:null):testRecipient;
    if(!isTestAddress(recipient))return null;
    const params=new URLSearchParams({messageId:job.providerId,days:'90',limit:'100',sort:'desc'});
    const response=await send('https://api.brevo.com/v3/smtp/statistics/events?'+params,{
      method:'GET',redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'api-key':key}});
    if(!response.ok)throw new Error('delivery-lookup-failed');
    const result=await response.json();
    if(!Array.isArray(result.events))throw new Error('invalid-delivery-response');
    const normalize=id=>String(id??'').trim().replace(/^<|>$/g,'');
    const status={requests:'accepted',request:'accepted',sent:'accepted',delivered:'delivered',deferred:'delayed',softbounce:'delayed',
      hardbounce:'failed',invalid:'failed',blocked:'failed',error:'failed'};
    const events=result.events.filter(e=>normalize(e.messageId)===normalize(job.providerId)
      &&String(e.email??'').trim().toLowerCase()===recipient.trim().toLowerCase()
      &&Object.hasOwn(status,String(e.event).toLowerCase())&&Number.isFinite(Date.parse(e.date)))
      .sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    const latest=events[0],checkedAt=iso(Date.now());
    if(!latest)return {...(job.delivery||{state:'unknown'}),checkedAt};
    const eventAt=iso(Date.parse(latest.date));
    if(job.delivery?.eventAt&&job.delivery.eventAt>eventAt)return {...job.delivery,checkedAt};
    return {state:status[String(latest.event).toLowerCase()],eventAt,checkedAt};
  }

  return {
    canCheckDelivery,checkDelivery,
    canSend,
    deliver,
    async budget() {
      const time=Date.now();
      const [reserved,today]=await db.getAll(budgetRef,todayRef(time));
      const count=freshSlots(reserved.data(),time).length;
      const observed=reserved.data()?.accountObservation;
      return { acceptedToday:isCapture?0:today.data()?.count??0,capturedToday:isCapture?today.data()?.count??0:0,
        reserved:count, normalRemaining:Math.max(0,(directTestMail?25:250)-count), totalRemaining:Math.max(0,(directTestMail?30:300)-count),
        providerAccountRemaining:observed?.remaining??null, providerObservationAt:observed?.at??null };
    },
    recordAccountUsage(remaining) {
      return budgetRef.set({accountObservation:{remaining,at:Date.now()}},{merge:true});
    },
    async run(message) {
      if (!canSend()) return;
      // One indexed field excludes terminal jobs. Small batches bound CPU and subrequests.
      const time=iso(Date.now());
      const query=field=>outbox.where(field,'>=','0').where(field,'<=',time).orderBy(field).limit(3).get();
      const [urgent,regular]=await Promise.all([query('urgentDueAt'),query('dueAt')]);
      const ids=[...new Set([...urgent.docs,...regular.docs].map(job=>job.id))].slice(0,3);
      for (const id of ids) await deliver(id,message).catch(() => {});
    },
    async status(orderId) {
      const result = await outbox.where('orderId', '==', orderId).limit(25).get();
      return result.docs.map(doc => {
        const { type, status, sentAt, lastError, dueAt, deliveryUncertain, manualSentAt } = doc.data();
        return { id:doc.id, type, status: status ?? (sentAt ? 'sent' : 'queued'), sentAt,lastError,dueAt,
          deliveryUncertain,manualSentAt,delivery:doc.data().delivery??null,canCheckDelivery:canCheckDelivery(doc.data()),
          hasChange:!!doc.data().change,resendJobId:doc.data().resendJobId??null,resendOf:doc.data().resendOf??null };
      });
    }
  };
}
