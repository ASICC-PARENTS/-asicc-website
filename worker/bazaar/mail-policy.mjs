export const mailKinds = {receipt:'auto',confirmed:'auto',buyerCancel:'auto',adminCancel:'auto',reminderFinal:'manual',bulkCancel:'manual',pickup:'manual',other:'manual'};
export const mailKind = (type,order) => type==='cancel' ? (order.cancelReason==='buyer'?'buyerCancel':'adminCancel') : type;
export const policyMode = (policy,kind) => policy?.modes?.[kind] ?? mailKinds[kind];
export function autoMailAllowed(policy,job,order){
  const kind=mailKind(job.type,order);
  if(job.type==='reminderFinal'&&policy?.modes)return false;
  if(!policy?.modes)return true;
  const since=policy.autoSince?.[kind];
  return policyMode(policy,kind)==='auto'&&(!since||(job.createdAt||job.dueAt||'')>=since);
}
