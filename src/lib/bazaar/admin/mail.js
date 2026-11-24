import { parisDeadline } from '../api';
import { parisToIso } from './data';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const types={receipt:'주문 접수',confirmed:'입금 확인',cancel:'주문 취소',bulkCancel:'미입금 취소',
  reminderFinal:'마감 안내',pickup:'수령 안내',other:'기타 안내',reminder3:'이전 3시간 알림',reported:'이전 송금 신고'};
const states={queued:'대기',delayed:'지연',sending:'발송 중',sent:'발송 접수',failed:'실패',skipped:'발송 제외',
  canceled:'대기 취소',manualReserved:'OVH 발송 준비',manualSent:'OVH 발송 기록'};
const errors={'free-plan-limit':'무료 발송 한도', 'provider-limit':'Brevo 발송 제한',
  'provider-access-denied':'발송 권한 또는 IP 차단 확인','provider-result-uncertain':'Brevo 접수 여부 확인',
  'verify-provider-before-resending':'Brevo 발송 이력 확인','provider-rejected':'Brevo 요청 거절'};
const local=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'short',hourCycle:'h23'});
const jobLabels={retry:'재발송',cancel:'대기 취소',completeManual:'OVH 완료 기록',releaseManual:'OVH 준비 해제'};

function mailRows(messages) {
  return messages.map(m=>{
    const timestamp=m.manualSentAt||m.sentAt||m.dueAt;
    const actions={failed:['retry'],queued:['cancel'],delayed:['cancel'],manualReserved:['completeManual','releaseManual']}[m.status]||[];
    return `<div class="modal-row"><span>${esc(types[m.type]||m.type)} · ${esc(states[m.status]||m.status)}
      ${timestamp?` · ${esc(parisDeadline(timestamp,'ko'))}`:''}${m.lastError?` · ${esc(errors[m.lastError]||m.lastError)}`:''}</span>
      ${actions.map(action=>`<button type="button" class="linkbtn" data-mail-job="${action}" data-id="${esc(m.id)}" data-uncertain="${m.deliveryUncertain===true}">${jobLabels[action]}</button>`).join('')}</div>`;
  }).join('');
}

async function jobAction(button,request,eventId) {
  const action=button.dataset.mailJob;
  const verified=button.dataset.uncertain==='true';
  const prompt=verified?'Brevo 이력에서 이 이메일이 접수 또는 발송되지 않았음을 확인했습니까?':{
    retry:'이 이메일을 다시 발송 대기 목록에 넣을까요?',cancel:'대기 중인 이메일을 취소할까요?',
    completeManual:'OVH에서 이 수신자에게 실제 발송을 마쳤나요?',releaseManual:'아직 발송하지 않은 준비를 해제할까요?'
  }[action];
  if(confirm(prompt))await request('mailJobAction',{eventId,id:button.dataset.id,action,providerConfirmedUnsent:verified});
}

export async function showOrderMail(id,target,eventId,request) {
  try {
    const {messages,latePayment}=await request('mailStatus',{id});
    target.innerHTML=`${latePayment?'<p>최종 대조 후 입금 검토 대상</p>':''}${mailRows(messages)||'<p>발송 내역 없음</p>'}`;
    target.onclick=async event=>{
      const button=event.target.closest('[data-mail-job]');
      if(!button||button.disabled)return;
      button.disabled=true;
      try{await jobAction(button,request,eventId);await showOrderMail(id,target,eventId,request);}
      catch(error){alert(error.message);}
      finally{button.disabled=false;}
    };
  }catch{target.textContent='발송 상태를 조회하지 못했습니다.';}
}

export function mountMailManager(parent,event,orders,request,editable) {
  if(!event?.id)return;
  const panel=document.createElement('details');
  panel.className='panel pad';
  panel.innerHTML='<summary>이메일 발송 관리</summary><div data-mail-panel></div><p data-mail-notice role="status"></p>';
  parent.append(panel);
  const body=panel.querySelector('[data-mail-panel]');
  const feedback=panel.querySelector('[data-mail-notice]');
  const eventId=event.id;
  let ready=false, pending=false, cursor=null, messages=[], prepared=[], preparedOptions;
  const recipients=()=>[...new Set(prepared.map(row=>row.email.trim().toLowerCase()))].sort();
  const form=()=>body.querySelector('[data-mail-form]');
  const action=(name,fields={})=>request(name,{eventId,...fields});
  const select=(name,values)=>`<select class="select" name="${name}">${values.map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select>`;
  const button=(name,label)=>`<button type="button" class="btn neutral" data-mail="${name}">${label}</button>`;
  const chunks=async (name,options,ids,onResult)=>{
    for(let i=0;i<ids.length;i+=30){
      const result=await action(name,{...options,ids:ids.slice(i,i+30)});
      onResult(result.recipients);
    }
  };

  async function load(append=false) {
    const data=await action('mailOverview',append?{cursor}:{});
    cursor=data.cursor;
    messages=append?[...messages,...data.messages]:data.messages;
    const b=data.budget;
    const previous=body.querySelector('[data-mail-manual]');
    const upcoming=[data.nextReminderAt,...messages.map(m=>m.dueAt)].filter(Boolean).sort()[0];
    const due=messages.filter(m=>['queued','delayed','sending'].includes(m.status)).length;
    const failed=messages.filter(m=>m.status==='failed').length;
    body.innerHTML=`<p>오늘 발송 접수 ${b.acceptedToday}통 · 테스트 기록 ${b.capturedToday}통 · 내부 예약 ${b.reserved}통</p>
      <p>일반 잔여 ${b.normalRemaining}통 · 예비 포함 잔여 ${b.totalRemaining}통 · Brevo 계정 확인값
        ${b.providerAccountRemaining==null?'미확인':`${b.providerAccountRemaining}통 (${esc(parisDeadline(new Date(b.providerObservationAt).toISOString(),'ko'))})`}</p>
      <div class="actions"><label>Brevo에서 확인한 잔여 통수 <input name="remaining" type="number" min="0" max="300"></label>${button('account','확인값 기록')}</div>
      ${editable?`<form data-mail-form class="form-grid">
        <label class="field">마감 전 알림 ${select('reminderMode',[['manual','OVH 수동'],['auto','자동']])}</label>
        <label class="field">알림 시각 (파리) <input type="datetime-local" name="reminderAt"></label>
        <label class="field">미입금 일괄 취소 ${select('bulkCancel',[['manual','OVH 수동'],['auto','자동']])}</label>
        <div class="actions">${button('policy','행사 발송 설정 저장')}</div></form>`:''}
      <p>불러온 이력의 대기 ${due}건 · 실패 ${failed}건 · 다음 예정 ${upcoming?esc(parisDeadline(upcoming,'ko')):'—'}</p>
      <div>${mailRows(messages)||'발송 이력 없음'}</div>
      <div class="actions">${cursor?button('more','이력 더 보기'):''}${button('refresh','새로고침')}</div><div data-mail-manual></div>`;
    if(editable){
      const policy=form().elements;
      policy.reminderMode.value=data.policy.reminderMode;
      policy.bulkCancel.value=data.policy.bulkCancel;
      policy.reminderAt.value=data.policy.reminderAt?local.format(new Date(data.policy.reminderAt)).replace(' ','T'):'';
    }
    if(previous)body.querySelector('[data-mail-manual]').replaceWith(previous);
    else initManual();
    renderPrepared();
  }

  function initManual() {
    body.querySelector('[data-mail-manual]').innerHTML=`<h3>OVH 수동 발송</h3><form data-manual-form class="form-grid">
      <label class="field">안내 종류 ${select('type',[['reminderFinal','미입금 독촉'],['bulkCancel','최종 미입금 취소'],['pickup','수령 안내'],['other','기타 안내']])}</label>
      <label class="field">대상 ${select('audience',[['unpaid','미입금'],['valid','전체 유효 주문'],['confirmed','입금 확인'],['canceled','취소 주문']])}</label>
      <label><input name="excludeReported" type="checkbox" checked> 송금 신고 완료 제외</label>
      <label class="field">기타 안내 제목 <input name="notice" maxlength="80"></label>
      <fieldset class="field wide"><legend>주문 선택</legend><label><input type="checkbox" data-order-select-all> 전체 선택</label><div class="manual-order-list">${orders.filter(o=>o.email)
        .map(o=>`<label class="modal-row"><input type="checkbox" name="ids" value="${esc(o.id)}" data-manual-order> <span>${esc(o.ref)} · ${esc(o.name)} · ${esc(o.status)}</span></label>`).join('')}</div></fieldset>
      <div class="actions">${button('prepare-selected','선택 주문 주소 준비')}${button('prepare-all','조건에 맞는 전체 주문 주소 준비')}<a class="btn neutral" href="https://webmail.ovh.net/" target="_blank" rel="noopener noreferrer">OVH 웹메일 열기</a></div>
      <div data-mail-prepared></div></form>`;
    const fields=body.querySelector('[data-manual-form]').elements;
    fields.type.addEventListener('change',()=>{
      fields.audience.value=fields.type.value==='reminderFinal'?'unpaid':fields.type.value==='bulkCancel'?'canceled':'valid';
      fields.excludeReported.checked=fields.type.value==='reminderFinal';
    });
  }

  function renderPrepared(){
    const target=body.querySelector('[data-mail-prepared]');
    if(!target)return;
    target.innerHTML=prepared.length?`<p>Bcc 수신자 ${recipients().length}명 · 주문 ${prepared.length}건</p>
      <label class="field wide">OVH 메일의 숨은참조(Bcc)에 붙여넣을 주소 · 중복 제거 완료<textarea readonly aria-label="Bcc 주소">${esc(recipients().join('; '))}</textarea></label>
      <div class="actions">${button('copy','주소 복사')}${button('excel','Excel 다운로드')}
      ${button('complete','OVH 발송 완료 기록')}${button('release','발송 준비 해제')}</div>`:'';
  }

  panel.addEventListener('toggle',()=>{
    if(!panel.open||ready||pending)return;
    pending=true;
    void load().then(()=>{ready=true;},error=>{feedback.textContent=error.message;}).finally(()=>{pending=false;});
  });
  panel.addEventListener('submit',e=>e.preventDefault());
  panel.addEventListener('change',e=>{if(e.target.matches('[data-order-select-all]'))panel.querySelectorAll('[data-manual-order]').forEach(box=>box.checked=e.target.checked);});
  panel.addEventListener('click',async e=>{
    const control=e.target.closest('[data-mail],[data-mail-job]');
    if(!control||pending)return;
    const click=control.dataset.mail;
    pending=true;control.disabled=true;feedback.textContent='';
    try{
      if(control.dataset.mailJob){await jobAction(control,request,eventId);await load();}
      if(click==='refresh'||click==='more')await load(click==='more');
      if(click==='account'){
        const value=body.querySelector('[name=remaining]').value;
        if(value==='')throw new Error('Brevo 대시보드의 잔여량을 입력해 주세요.');
        await action('mailAccountUsage',{remaining:Number(value)});await load();
      }
      if(click==='policy'){
        const f=form().elements;
        await action('mailPolicy',{reminderMode:f.reminderMode.value,bulkCancel:f.bulkCancel.value,
          reminderAt:f.reminderMode.value==='auto'?parisToIso(f.reminderAt.value):null});await load();
      }
      if(click==='prepare-selected'||click==='prepare-all'){
        if(prepared.length)throw new Error('기존 준비 건을 먼저 완료하거나 해제해 주세요.');
        const f=body.querySelector('[data-manual-form]').elements;
        preparedOptions={type:f.type.value,audience:f.audience.value,excludeReported:f.excludeReported.checked,notice:f.notice.value};
        const ids=click==='prepare-all'?orders.filter(o=>o.email).map(o=>o.id):[...body.querySelectorAll('[data-manual-order]:checked')].map(x=>x.value);
        if(!ids.length)throw new Error('선택 가능한 주문이 없습니다.');
        await chunks('mailManualPrepare',preparedOptions,ids,rows=>prepared.push(...rows));
        if(!prepared.length)feedback.textContent='조건에 맞는 발송 대상이 없습니다.';
        await load();
      }
      if(click==='copy')await navigator.clipboard.writeText(recipients().join('; '));
      if(click==='excel'){
        if(!window.XLSX)throw new Error('Excel 모듈을 불러오지 못했습니다.');
        const workbook=window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(workbook,window.XLSX.utils.aoa_to_sheet([['이메일'],...recipients().map(email=>[email])]),'수신자');
        window.XLSX.writeFile(workbook,'ASICC-OVH-수신자.xlsx');
      }
      if(click==='complete'||click==='release'){
        if(!confirm(click==='complete'?'OVH에서 이 수신자에게 실제 발송을 마쳤나요?':'아직 발송하지 않은 준비 목록을 해제할까요?'))return;
        await chunks(click==='complete'?'mailManualComplete':'mailManualRelease',preparedOptions,prepared.map(r=>r.id),
          rows=>{const done=new Set(rows.map(r=>r.id));prepared=prepared.filter(r=>!done.has(r.id));});
        await load();
      }
    }catch(error){feedback.textContent=error.message;}
    finally{renderPrepared();pending=false;control.disabled=false;}
  });
}
