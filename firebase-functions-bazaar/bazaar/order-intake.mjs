export function hasCheckoutAccount(event) {
  return /^FR\d{2}[A-Z0-9]{23}$/.test(String(event?.iban??'').replaceAll(' ',''));
}

export function orderIntakeLocked(event) {
  return Boolean(event?.orderIntakeLocked||event?.finalizedAt||event?.reconciliationStartedAt||event?.reconciledAt);
}

export function orderIntakeState(event, time=Date.now()) {
  if(event?.status!=='published'||orderIntakeLocked(event)||event.orderIntakeClosedAt) return 'closed';
  const cutoff=Date.parse(event.orderCutoff);
  if(!Number.isFinite(cutoff)||time>=cutoff) return 'closed';
  const starts=Date.parse(event.orderStartsAt);
  if(Number.isFinite(starts)&&time<starts) return 'scheduled';
  return hasCheckoutAccount(event)?'open':'unavailable';
}

export function latestTransferCutoff(event) {
  return Math.max(...[event?.transferCutoff,event?.priorTransferCutoff].map(Date.parse).filter(Number.isFinite));
}

export function orderTransferCutoff(order,event) {
  return Date.parse(order?.paymentDeadline||order?.eventSnapshot?.transferCutoff||event?.transferCutoff);
}
