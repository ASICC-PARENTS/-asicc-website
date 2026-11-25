export function orderPaymentSummary(order){
 const original=order.originalTotalCents??order.totalCents;
 const deposited=order.depositedCents??(order.bankConfirmedAt?original:0);
 const refunded=order.refundedCents??0;
 const due=order.canceledAt?0:order.totalCents;
 const net=deposited-refunded;
 const refundDue=Math.max(0,net-due);
 const additionalDue=Math.max(0,due-net);
 const state=refundDue?'refund-due':additionalDue?(deposited?'additional-due':'unpaid'):
   refunded?(net===0?'refunded':'partially-refunded'):'paid';
 return {original,deposited,refunded,due,net,refundDue,additionalDue,state,reservedRefund:order.reservedRefundCents||0};
}
