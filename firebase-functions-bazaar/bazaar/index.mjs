import {onCall, HttpsError} from 'firebase-functions/v2/https';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {defineSecret} from 'firebase-functions/params';
import {initializeApp, getApps} from 'firebase-admin/app';
import {getFirestore, FieldValue} from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';
import {eventPhoto,storePhoto} from './photos.mjs';
import {initialEvent} from './products.mjs';
import {createBazaar} from './service.mjs';

if (!getApps().length) initializeApp();
const db=getFirestore();
const smtpPassword=defineSecret('BAZAAR_SMTP_PASSWORD');

const eventRef = db.doc('bazaarMeta/event');
const orders = db.collection('bazaarOrders');
const outbox = db.collection('bazaarOutbox');
const now = () => new Date().toISOString();
const canSendMail = () => Boolean(process.env.BAZAAR_SMTP_HOST && process.env.BAZAAR_SMTP_USER && smtpPassword.value());
const service = createBazaar({
  db, FieldValue, HttpsError, storePhoto, eventPhoto, canSendMail,
  siteUrl: () => process.env.FUNCTIONS_EMULATOR === 'true' ? 'http://127.0.0.1:4321' : 'https://asicc-parents.fr',
  sendQueuedMail: deliver
});
const {message, queue} = service;
export {message};
const options = {cors:['https://asicc-parents.fr','https://www.asicc-parents.fr','http://localhost:4321','http://127.0.0.1:4321'],region:'europe-west1',maxInstances:15};
export const bazaarPublic = onCall(options, service.bazaarPublic);
export const bazaarCreateOrder = onCall({...options,secrets:[smtpPassword]}, service.bazaarCreateOrder);
export const bazaarBuyerAction = onCall({...options,secrets:[smtpPassword]}, service.bazaarBuyerAction);
export const bazaarAdmin = onCall({...options,secrets:[smtpPassword]}, service.bazaarAdmin);
export const bazaarReminders = onSchedule({schedule:'every 15 minutes',timeZone:'Europe/Paris',region:'europe-west1',secrets:[smtpPassword],maxInstances:1}, runLegacyReminders);

async function deliver(mailId){
  if(!process.env.BAZAAR_SMTP_HOST||!process.env.BAZAAR_SMTP_USER||!smtpPassword.value()) return false;
  const ref=outbox.doc(mailId), lease=now();
  const ready=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);if(!snap.exists)return null;
    const v=snap.data();
    if(v.sentAt||(v.sendingUntil&&v.sendingUntil>lease))return null;
    tx.update(ref,{sendingUntil:new Date(Date.now()+90000).toISOString(),attempts:FieldValue.increment(1)});
    return v;
  });
  if(!ready)return false;
  try{
    const [orderSnap,evSnap]=await Promise.all([orders.doc(ready.orderId).get(),eventRef.get()]);
    if(!orderSnap.exists)throw new Error('Order missing');
    const transporter=nodemailer.createTransport({
      host:process.env.BAZAAR_SMTP_HOST,
      port:Number(process.env.BAZAAR_SMTP_PORT||465),
      secure:Number(process.env.BAZAAR_SMTP_PORT||465)===465,
      auth:{user:process.env.BAZAAR_SMTP_USER,pass:smtpPassword.value()}
    });
    const msg=message(orderSnap.data(),ready.type,orderSnap.data().eventSnapshot||evSnap.data());
    await transporter.sendMail({from:`ASICC <${process.env.BAZAAR_SMTP_USER}>`,to:orderSnap.data().email,...msg});
    await ref.update({sentAt:now(),sendingUntil:null,lastError:null});
    return true;
  }catch(err){await ref.update({sendingUntil:null,lastError:String(err?.message||err).slice(0,300)});return false;}
}
const parisParts=d=>{
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(p=>[p.type,p.value]));
  return{day:parts.weekday,hour:Number(parts.hour),minute:Number(parts.minute)};
};
async function runLegacyReminders(){
  const e=(await eventRef.get()).data();if(!e)return;
  const t=new Date(),{day,hour}=parisParts(t);
  const safeHours=hour>=9&&hour<20;
  const allCurrent=await orders.where('eventId','==',e.eventId||initialEvent.eventId).get();
  const pending=allCurrent.docs.filter(d=>!d.data().bankConfirmedAt);
  for(const snap of pending){
    const o=snap.data();if(o.canceledAt||!o.email)continue;
    // Retry all queued receipts and other messages regardless of reminder eligibility.
    const mails=await outbox.where('orderId','==',o.id).get();
    for(const m of mails.docs)if(!m.data().sentAt)await deliver(m.id);
    if(o.transferReportedAt||!safeHours)continue;
    const age=t.getTime()-Date.parse(o.createdAt);
    if(age>=3*3600000&&!o.reminder3At&&t.getTime()<Date.parse(e.transferCutoff)){
      let queued=false;
      await db.runTransaction(async tx=>{
        const fresh=await tx.get(snap.ref),v=fresh.data();
        if(v.reminder3At||v.transferReportedAt||v.bankConfirmedAt||v.canceledAt)return;
        tx.update(snap.ref,{reminder3At:now()});await queue(tx,o.id,'reminder3');queued=true;
      });
      if(queued)await deliver(`${o.id}_reminder3`);
    }
    const isFinal=day==='Fri'&&t.getTime()>=Date.parse(e.orderCutoff)&&t.getTime()<Date.parse(e.transferCutoff)&&hour>=15;
    if(isFinal&&!o.reminderFinalAt&&(!o.reminder3At||t.getTime()-Date.parse(o.reminder3At)>=3*3600000)){
      let queued=false;
      await db.runTransaction(async tx=>{
        const fresh=await tx.get(snap.ref),v=fresh.data();
        if(v.reminderFinalAt||v.transferReportedAt||v.bankConfirmedAt||v.canceledAt)return;
        tx.update(snap.ref,{reminderFinalAt:now()});await queue(tx,o.id,'reminderFinal');queued=true;
      });
      if(queued)await deliver(`${o.id}_reminderFinal`);
    }
  }
  // Retry email queue for confirmed/canceled orders too.
  const leftovers=await outbox.where('sentAt','==',null).limit(200).get();
  for(const m of leftovers.docs)await deliver(m.id);
}
