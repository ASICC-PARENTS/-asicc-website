// Display-only eligibility. The server independently validates every selected ID.
export function matchesMailAudience(order,type,audience,excludeReported){
  if(!order.email)return false;
  const canceled=order.status==='canceled';
  const unpaid=!canceled&&!order.bankConfirmedAt&&(!excludeReported||!order.reportedAt);
  const confirmed=!canceled&&order.payment?.settled===true;
  const audienceMatches=audience==='unpaid'?unpaid:audience==='confirmed'?confirmed:audience==='canceled'?canceled:!canceled;
  if(!audienceMatches)return false;
  if(type==='receipt')return !canceled;
  if(type==='confirmed')return confirmed;
  if(type==='buyerCancel'||type==='adminCancel')return canceled&&order.mailCancelReason===(type==='buyerCancel'?'buyer':'admin');
  if(type==='bulkCancel')return canceled&&order.mailCancelReason==='unpaidFinalization';
  if(type==='reminderFinal')return unpaid;
  return true;
}
