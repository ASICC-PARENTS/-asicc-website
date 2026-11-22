let timeout:ReturnType<typeof setTimeout>|undefined;
export function toast(message:string,error=false){
  if(!message)return;
  let host=document.getElementById('asicc-toast-global');
  if(!host){host=document.createElement('div');host.id='asicc-toast-global';host.className='asicc-toast-global';document.body.append(host);}
  host.replaceChildren();host.hidden=false;host.dataset.error=String(error);host.setAttribute('role',error?'alert':'status');host.setAttribute('aria-live',error?'assertive':'polite');
  const mark=document.createElement('span');mark.textContent=error?'!':'✓';mark.setAttribute('aria-hidden','true');
  const text=document.createElement('span');text.textContent=message;
  const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label',document.documentElement.lang==='fr'?'Fermer':'닫기');close.onclick=()=>{host!.hidden=true;if(timeout)clearTimeout(timeout);};
  host.append(mark,text,close);if(timeout)clearTimeout(timeout);timeout=setTimeout(()=>{host!.hidden=true;},8500);
}
// Existing inline state helpers also remain in place. Show transient alerts for
// completed operations/errors only, not for initialization or upload progress.
export function toastResult(message:string,error=false){
  if(error||/완료|저장되었|저장했|등록되었|등록했|삭제되었|삭제했|발송되었|접수되었|변경되었|수정되었|공개되었|비공개되었|\b(enregistr[ée]e?|publi[ée]e?|supprim[ée]e?|termin[ée]e?|envoy[ée]e?|restaur[ée]e?|modifi[ée]e?|masqu[ée]e?|cr[ée][ée]e?|transmis)s?(?:[\s.,;:!?]|$)/i.test(message))toast(message,error);
}
