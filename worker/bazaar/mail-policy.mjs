export const mailKinds = {receipt:'auto',confirmed:'auto',buyerCancel:'auto',adminCancel:'auto',reminderFinal:'manual',bulkCancel:'manual',pickup:'manual',other:'manual',orderChanged:'auto',additionalPayment:'auto',refundCompleted:'auto'};
export const mailKind = (type,order) => type==='cancel' ? (order.cancelReason==='buyer'?'buyerCancel':'adminCancel') : type;
export const policyMode = (policy,kind) => policy?.modes?.[kind] ?? mailKinds[kind];
export function autoMailAllowed(policy,job,order){
  const kind=mailKind(job.type,order);
  if(job.mode==='manual')return policyMode(policy,kind)!=='off'&&(!policy?.enabledSince?.[kind]||job.requestedAt>=policy.enabledSince[kind]);
  if(job.type==='reminderFinal')return false;
  if(!policy?.modes)return true;
  const since=policy.autoSince?.[kind];
  return policyMode(policy,kind)==='auto'&&(!since||(job.createdAt||job.dueAt||'')>=since);
}
