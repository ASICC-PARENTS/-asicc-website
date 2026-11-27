import { createHash } from 'node:crypto';
import {compactIban,validRefundIban} from './iban.mjs';
import {orderPaymentSummary} from './order-payments.mjs';

// Account data is exclusively stored in the private request/financial records, never the public order.
export const partialRefundKey=(id,revision)=>createHash('sha256').update(id+':partial-refund:'+revision).digest('hex').slice(0,32);
export const partialRefundRef=(ref,key)=>ref.collection('partialRefundRequests').doc(key);
export const normalizeRefundAccount=(data)=>{
 const beneficiary=typeof data.beneficiary==='string'?data.beneficiary.trim():'';
 const iban=compactIban(data.iban),bic=typeof data.bic==='string'?data.bic.trim().toUpperCase():'';
 if(!beneficiary||beneficiary.length>120||!validRefundIban(iban)||bic&&!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)||data.confirm!==true)return null;
 return {beneficiary,iban,bic};
};
export function partialRefundRequest(order,{revision,at,items,totalCents,removed}){
 const decrease=order.totalCents-totalCents;
 if(!(decrease>0)||!removed.length||!items.length||!(order.transferReportedAt||order.bankConfirmedAt))return null;
 const estimate=order.bankConfirmedAt?Math.min(decrease,Math.max(0,orderPaymentSummary({...order,totalCents}).refundDue-(order.reservedRefundCents||0))):decrease;
 if(estimate<=0)return null;
 return {id:partialRefundKey(order.id,revision),eventId:order.eventId,revision,createdAt:at,estimatedCents:estimate,
  previousTotalCents:order.totalCents,totalCents,items:removed,status:'awaitingAccount'};
}
export function requestStatus(order,request,refund){
 if(refund?.status==='completed')return 'completed';
 if(refund?.status==='void')return 'void';
 if(refund?.status==='pending')return 'pending';
 if(request.status==='reserved')return 'review';
 if(!request.account)return 'awaitingAccount';
 if(!order.bankConfirmedAt)return 'awaitingPayment';
 return 'awaitingBalance';
}
export function publicRefundRequest(order,request,refund){
 return {id:request.id,orderRef:order.orderRef,revision:request.revision,previousTotalCents:request.previousTotalCents,
  totalCents:request.totalCents,estimatedCents:request.estimatedCents,amountCents:refund?.amountCents??null,
  items:request.items.map(({titleKo,titleFr,qty,priceCents})=>({titleKo,titleFr,qty,priceCents})),
  currentItems:order.items.map(({titleKo,titleFr,qty,priceCents})=>({titleKo,titleFr,qty,priceCents})),
  currentTotalCents:order.totalCents,bankConfirmed:!!order.bankConfirmedAt,
  status:requestStatus(order,request,refund),accountRegistered:!!request.account,
  ibanLast4:request.account?.iban?.slice(-4)||'',editable:request.status!=='reserved'&&!order.canceledAt};
}
// Caller must read all requests/ledger entries before writing. Return only the new reserved total.
export function reservePartialRefund(tx,ref,order,request,existing,at,reserved){
 if(!order.bankConfirmedAt||order.canceledAt||!request.account||request.status==='reserved'||existing)return reserved;
 const amount=Math.min(request.estimatedCents,Math.max(0,orderPaymentSummary(order).refundDue-reserved));
 if(amount<=0)return reserved;
 const {beneficiary,iban,bic}=request.account;
 const record={id:request.id,eventId:order.eventId,kind:'balance',status:'pending',amountCents:amount,
  createdAt:at,createdBy:'customer-rib',reason:'Partial cancellation / RIB registered',method:'bank',operator:'ASICC',
  publicReason:'',note:'',beneficiary,iban,bic,restoreStock:false,calculatedCents:request.estimatedCents,differenceReason:'',
  items:request.items,revision:request.revision,partialRefundRequestId:request.id};
 tx.create(ref.collection('refunds').doc(request.id),record);
 tx.update(partialRefundRef(ref,request.id),{status:'reserved',reservedAt:at,amountCents:amount,account:request.account,accountUpdatedAt:request.accountUpdatedAt||at});
 return reserved+amount;
}
export async function reserveRegisteredPartialRefunds(tx,ref,order,at){
 let reserved=order.reservedRefundCents||0;
 if(!order.bankConfirmedAt||order.canceledAt||!order.partialRefundIds?.length)return reserved;
 const records=await Promise.all(order.partialRefundIds.map(async key=>({
  request:(await tx.get(partialRefundRef(ref,key))).data(),refund:(await tx.get(ref.collection('refunds').doc(key))).data()
 })));
 for(const {request,refund} of records)if(request)reserved=reservePartialRefund(tx,ref,order,request,refund,at,reserved);
 return reserved;
}
