import { parisDeadline } from '../api';
import {mailKinds,policyMode} from '../../../../worker/bazaar/mail-policy.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const types={receipt:'주문 접수',confirmed:'입금 확인',cancel:'주문 취소',bulkCancel:'미입금 취소',
  buyerCancel:'고객 주문 취소',adminCancel:'운영진 주문 취소',orderChanged:'주문 변경',additionalPayment:'추가 송금',refundCompleted:'환불 완료',
  reminderFinal:'마감 안내',pickup:'수령 안내',other:'기타 안내',reminder3:'이전 3시간 알림',reported:'이전 송금 신고'};
const states={queued:'대기',delayed:'지연',sending:'발송 중',sent:'발송 접수',failed:'실패',skipped:'발송 제외',
  canceled:'대기 취소',manualReserved:'OVH 발송 준비',manualSent:'OVH 발송 기록'};
const errors={'free-plan-limit':'무료 발송 한도', 'provider-limit':'Brevo 발송 제한',
  'provider-access-denied':'발송 권한 또는 IP 차단 확인','provider-result-uncertain':'Brevo 접수 여부 확인',
  'verify-provider-before-resending':'Brevo 발송 이력 확인','provider-rejected':'Brevo 요청 거절'};
const jobLabels={retry:'재발송',cancel:'대기 취소',completeManual:'OVH 완료 기록',releaseManual:'OVH 준비 해제'};

const deliveryLabel=(delivery,fr=false)=>{
  const labels={unknown:['전달 상태 미확인','Remise non vérifiée'],accepted:['발송 서버 접수 · 전달 미확인','Accepté · remise non vérifiée'],
    delivered:['수신 서버 전달 완료','Remis au serveur destinataire'],delayed:['수신 서버 전달 지연','Remise différée'],failed:['수신 서버 전달 실패','Échec de remise']};
  return (labels[delivery?.state]||labels.unknown)[fr?1:0]+(delivery?.checkedAt?' · '+parisDeadline(delivery.checkedAt,'ko'):'');
};
function mailRows(messages,fr=false) {
  return messages.map(m=>{
    const timestamp=m.manualSentAt||m.sentAt||m.dueAt;
    const actions={failed:['sendNow'],queued:['sendNow','cancel'],delayed:['sendNow','cancel'],manualReserved:['completeManual','releaseManual']}[m.status]||[];
    if(['sent','manualSent'].includes(m.status)&&['receipt','confirmed'].includes(m.type)&&!m.resendJobId)actions.push('resend');
    if(m.canCheckDelivery)actions.push('checkDelivery');
    const label=action=>action==='checkDelivery'?(fr?'Vérifier la remise':'전달 상태 확인'):action==='sendNow'?(m.status==='failed'?(fr?'Renvoyer maintenant':'즉시 재발송'):(fr?'Envoyer maintenant':'즉시 발송')):action==='resend'?(fr?'Renvoyer une copie':'재발송'):jobLabels[action];
    return `<div class="modal-row"><span>${esc(types[m.type]||m.type)} · ${esc(states[m.status]||m.status)}
      ${timestamp?` · ${esc(parisDeadline(timestamp,'ko'))}`:''}${m.lastError?` · ${esc(errors[m.lastError]||m.lastError)}`:''}</span>
      ${['sent','manualSent'].includes(m.status)?'<p>'+esc(deliveryLabel(m.delivery,fr))+'</p>':''}
      ${m.sentSnapshot?'<details><summary>Message</summary><p>'+esc(m.sentSnapshot.to)+'</p><strong>'+esc(m.sentSnapshot.subject)+'</strong><pre>'+esc(m.sentSnapshot.text)+'</pre></details>':''}
      ${m.resendOf?` · ${fr?'Renvoi':'재발송 건'}`:''}${m.resendJobId?` · ${fr?'Renvoi créé':'재발송 기록 있음'}`:''}
      ${actions.map(action=>`<button type="button" class="linkbtn" data-mail-job="${action}" data-id="${esc(m.id)}" data-uncertain="${m.deliveryUncertain===true}">${label(action)}</button>`).join('')}</div>`;
  }).join('');
}

async function jobAction(button,request,eventId,fr=false) {
  const action=button.dataset.mailJob;
  if(action==='checkDelivery')return request('mailCheckDelivery',{eventId,id:button.dataset.id});
  const verified=button.dataset.uncertain==='true';
  const t=(ko,french)=>fr?french:ko;
  const prompt=verified?t('Brevo 이력에서 이 이메일이 접수 또는 발송되지 않았음을 확인했습니까?','Avez-vous vérifié dans Brevo que cet e-mail n’a pas été accepté ou envoyé ?'):{
    sendNow:t('선택한 이메일 1통을 지금 발송할까요? 발송 한도와 주문 상태는 그대로 확인합니다.','Envoyer cet e-mail maintenant ? Les quotas et l’état de la commande seront vérifiés.'),
    resend:t('이미 발송 접수된 이메일입니다. 현재 주문 정보로 같은 종류의 이메일 1통을 다시 보낼까요?','Ce message a déjà été accepté. Renvoyer un e-mail de ce type avec les informations actuelles ?'),
    retry:'이 이메일을 다시 발송 대기 목록에 넣을까요?',cancel:'대기 중인 이메일을 취소할까요?',
    completeManual:'OVH에서 이 수신자에게 실제 발송을 마쳤나요?',releaseManual:'아직 발송하지 않은 준비를 해제할까요?'
  }[action];
  if(!confirm(prompt))return null;
  return request('mailJobAction',{eventId,id:button.dataset.id,action,confirm:true,providerConfirmedUnsent:verified});
}

function dispatchFeedback(result,fr=false){
  if(!result?.jobId)return '';
  if(result.checkedDelivery)return deliveryLabel(result.delivery,fr);
  const t=(ko,french)=>fr?french:ko;
  if(result.status==='sent')return result.method==='capture'?t('테스트 발송 기록 완료 (실제 메일 미전송)','Envoi de test enregistré (aucun e-mail réel)'):t('발송 서버 접수 완료 · 수신함 도착 여부는 미확인','Accepté par le serveur · remise non vérifiée');
  const message={delayed:t('발송 제한으로 지연되었습니다. 제한을 우회하지 않습니다.','Envoi différé en raison du quota.'),
    failed:t('발송에 실패했습니다.','Échec de l’envoi.'),skipped:t('현재 주문 상태 또는 발송 정책에 따라 발송하지 않았습니다.','Envoi exclu selon la commande ou la politique.'),
    sending:t('발송 중입니다. 새로고침하여 결과를 확인해 주세요.','Envoi en cours. Actualisez pour vérifier.'),
    queued:t('아직 발송 대기 상태입니다. 결과를 다시 확인해 주세요.','Toujours en attente. Vérifiez à nouveau.') }[result.status]||t('발송 상태를 확인해 주세요.','Vérifiez l’état du message.');
  return message+(result.lastError?' · '+(errors[result.lastError]||result.lastError):'');
}

export async function showOrderMail(id,target,eventId,request) {
  const fr=target.closest('[data-lang]')?.dataset.lang==='fr';
  try {
    const {messages,latePayment,manual}=await request('mailStatus',{id,eventId,includeManual:true});
    const t=(ko,french)=>fr?french:ko;
    const options=manual?.options||[];
    let requestId=null,selection=null,busy=false;
    const single=options.length?'<div class="modal-row"><strong>'+t('개별 이메일 즉시 발송 / 재발송','Envoi ou renvoi individuel immédiat')+'</strong>'+
      '<p>'+esc(manual.orderRef||'')+' · '+esc(manual.email)+'</p><label>'+t('메일 종류','Type de message')+' <select data-mail-kind>'+
      options.map((option,index)=>'<option value="'+index+'">'+esc(types[option.kind]||option.kind)+(option.at?' · '+esc(parisDeadline(option.at,'ko')):'')+'</option>').join('')+
      '</select></label><button type="button" class="btn neutral" data-single-mail>'+t('즉시 발송','Envoyer maintenant')+'</button></div>':'';
    target.innerHTML=`${latePayment==='posted'?'<p>늦은 입금 장부 반영 완료</p>':latePayment==='pending'?'<p>최종 대조 후 입금 검토 대상</p>':''}${single}${mailRows(messages,fr)||'<p>발송 내역 없음</p>'}<p data-mail-result role="status"></p>`;
    target.onclick=async event=>{
      const button=event.target.closest('[data-mail-job],[data-single-mail]');
      if(!button||button.disabled||busy)return;
      busy=true;button.disabled=true;
      try{
        let result;
        if(button.hasAttribute('data-single-mail')){
          const index=Number(target.querySelector('[data-mail-kind]').value),option=options[index];
          if(!option)return;
          const label=types[option.kind]||option.kind;
          if(!confirm(t('이 수신자에게 해당 종류의 메일 1통을 발송합니다. 기존 발송 이력이 있으면 새 메일로 재발송합니다.','Envoyer un message de ce type à ce destinataire ? Un nouvel envoi sera créé si le message a déjà été envoyé.')+'\n'+manual.orderRef+' · '+manual.email+'\n'+label))return;
          if(selection!==index||!requestId){selection=index;requestId=crypto.randomUUID();}
          result=await request('mailSingleSend',{eventId,orderId:id,kind:option.kind,jobId:option.jobId||null,
            expectedEmail:manual.email,requestId,confirm:true});
          requestId=null;
        }else result=await jobAction(button,request,eventId,fr);
        if(result){await showOrderMail(id,target,eventId,request);const notice=target.querySelector('[data-mail-result]');if(notice)notice.textContent=dispatchFeedback(result,fr);}
      }catch(error){alert(error.message);}
      finally{busy=false;button.disabled=false;}
    };
  }catch{target.textContent='발송 상태를 조회하지 못했습니다.';}
}

export function mountMailManager(parent,event,orders,request,editable,expanded=false) {
  if(!event?.id)return;
  const panel=document.createElement('details');
  panel.className='panel pad';
  panel.innerHTML='<summary>이메일 발송 관리</summary><div data-mail-panel></div><p data-mail-notice role="status"></p>';
  parent.append(panel);
  if(expanded)panel.open=true;
  const body=panel.querySelector('[data-mail-panel]');
  const feedback=panel.querySelector('[data-mail-notice]');
  const eventId=event.id;
  const fr=parent.closest('[data-lang]')?.dataset.lang==='fr';
  const t=(ko,french)=>fr?french:ko;
  const kinds={
    receipt:t('주문 접수 및 송금 안내','Commande reçue et virement'),
    confirmed:t('입금 확인 및 주문 확정','Paiement reçu et commande confirmée'),
    buyerCancel:t('고객 주문 취소 안내','Annulation par le client'),
    adminCancel:t('운영진 주문 취소 안내','Annulation par l’association'),
    reminderFinal:t('송금 독촉 안내','Rappel de virement'),
    bulkCancel:t('최종 미입금 주문 취소 안내','Annulation pour non-paiement'),
    pickup:t('상품 수령 안내','Retrait des produits'),
    other:t('기타 공지','Autre annonce'),
    orderChanged:t('주문 변경 안내','Commande modifiée'),additionalPayment:t('추가 송금 안내','Virement complémentaire'),refundCompleted:t('환불 완료 안내','Remboursement effectué'),
  };
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

  let templates={},lastBudget,tab='settings';
  function chooseTab(name){
    tab=name;body.querySelectorAll('[data-mail-section]').forEach(section=>section.hidden=section.dataset.mailSection!==name);
    body.querySelectorAll('[data-mail-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mailTab===name)));
  }
  function policyEditor(policy){
    const rows=Object.entries(kinds).map(([kind,label])=>{
      const mode=policyMode(policy,kind),automatic=mailKinds[kind]==='auto'||kind==='bulkCancel';
      const retained=policy.preferredModes?.[kind]||(mode==='off'?mailKinds[kind]:mode);
      const toggle='<label class="mail-switch"><input role="switch" type="checkbox" name="on-'+kind+'" '+(mode!=='off'?'checked':'')+'><span></span></label>';
      const choices=automatic?['auto','manual'].map(value=>'<label><input type="radio" name="mode-'+kind+'" value="'+value+'" '+
        (retained===value?'checked':'')+(mode==='off'?' disabled':'')+'><span>'+ (value==='auto'?t('자동','Automatique'):t('수동','Manuel'))+'</span></label>').join(''):
        '<input type="hidden" name="mode-'+kind+'" value="manual">'+t('수동 전용','Manuel uniquement');
      return '<tr><th scope="row">'+esc(label)+'</th><td>'+toggle+'</td><td class="mail-mode">'+choices+'</td>'+
        '<td><button type="button" data-mail-template="'+kind+'">'+t('내용 수정','Modifier le contenu')+'</button></td></tr>';
    }).join('');
    return '<form data-mail-form><div class="sheet"><table><thead><tr><th scope="col">'+t('이메일 종류','Type de message')+
      '</th><th scope="col"><label><input type="checkbox" data-mail-master> ON/OFF</label></th><th scope="col">'+t('발송 방식','Mode')+'</th><th scope="col">'+
      t('양식','Modèle')+'</th></tr></thead><tbody>'+rows+'</tbody></table></div><div data-template-editor hidden></div>'+
      button('policy',t('행사 발송 설정 저장','Enregistrer les paramètres'))+'</form>';
  }
  function syncMailSwitches(){
    const formNode=form();if(!formNode)return;
    const master=formNode.querySelector('[data-mail-master]'),switches=[...formNode.querySelectorAll('input[role=switch]')];
    for(const input of switches){
      input.parentElement.querySelector('span').textContent=input.checked?'ON':'OFF';
      input.closest('tr').querySelectorAll('input[type=radio]').forEach(radio=>radio.disabled=!input.checked);
    }
    const count=switches.filter(input=>input.checked).length;
    master.checked=count===switches.length;
    master.indeterminate=count>0&&count<switches.length;
  }
  function editTemplate(kind){
    const editor=body.querySelector('[data-template-editor]');
    if(!editor)return;
    editor.hidden=false;editor.dataset.kind=kind;
    const fields={subjectKo:t('한국어 제목','Objet en coréen'),introKo:t('한국어 안내 문구','Texte en coréen'),
      subjectFr:t('프랑스어 제목','Objet en français'),introFr:t('프랑스어 안내 문구','Texte en français')};
    editor.innerHTML='<h4>'+esc(kinds[kind])+'</h4>'+Object.entries(fields).map(([key,label])=>'<label class="field">'+esc(label)+
      '<textarea name="'+key+'" maxlength="'+(key.startsWith('subject')?150:2500)+'">'+esc(templates[kind]?.[key]||'')+'</textarea></label>').join('')+
      '<p>'+t('주문과 행사 정보는 이메일 종류에 맞게 자동 삽입됩니다.','Les informations de commande et du bazar sont ajoutées selon le type de message.')+'</p>'+
      (kind==='other'?'<fieldset><legend>'+t('자동 삽입 정보','Informations à inclure')+'</legend>'+[['event',t('행사명','Bazar')],['order',t('주문번호','Référence')],['items',t('상품','Produits')],['total',t('금액','Montant')],['pickup',t('수령','Retrait')],['deadline',t('송금 기한','Échéance')]].map(([key,label])=>'<label><input type="checkbox" data-notice-field value="'+key+'" '+(templates[kind]?.fields?.includes(key)?'checked':'')+'> '+label+'</label>').join('')+'</fieldset>':'')+
      '<label>'+t('미리보기 주문','Commande exemple')+'<select data-preview-order><option value="">'+t('예시 주문','Commande fictive')+'</option>'+orders.map(order=>'<option value="'+esc(order.id)+'">'+esc(order.ref)+'</option>').join('')+'</select></label>'+
      '<label>'+t('언어','Langue')+'<select data-preview-lang><option value="ko">한국어</option><option value="fr">Français</option></select></label>'+
      button('template-reset',t('기본 양식 복원','Rétablir le modèle par défaut'))+button('template-preview',t('미리보기','Aperçu'))+'<pre data-template-preview hidden></pre>';
  }
  function collectTemplate(){
    const editor=body.querySelector('[data-template-editor]');
    if(!editor?.dataset.kind)return;
    templates[editor.dataset.kind]=Object.fromEntries([...editor.querySelectorAll('textarea')].map(el=>[el.name,el.value]));
    if(editor.dataset.kind==='other')templates.other.fields=[...editor.querySelectorAll('[data-notice-field]:checked')].map(input=>input.value);
  }
  async function load(append=false) {
    const data=await action('mailOverview',append?{cursor}:{});
    cursor=data.cursor;
    messages=append?[...messages,...data.messages]:data.messages;
    const b=data.budget;
    lastBudget=b;
    templates=data.policy.templates||{};
    const previous=body.querySelector('[data-mail-manual]');
    const upcoming=[data.nextReminderAt,...messages.map(m=>m.dueAt)].filter(Boolean).sort()[0];
    const due=messages.filter(m=>['queued','delayed','sending'].includes(m.status)).length;
    const failed=messages.filter(m=>m.status==='failed').length;
    const tabs='<div class="actions">'+[['settings',t('발송 설정','Paramètres')],['manual',t('수동 발송','Envoi manuel')],['history',t('발송 이력','Historique')]].map(([key,label])=>'<button type="button" class="btn neutral" data-mail-tab="'+key+'">'+label+'</button>').join('')+'</div>';
    body.innerHTML=tabs+`<section data-mail-section="settings"><p>오늘 발송 접수 ${b.acceptedToday}통 · 테스트 기록 ${b.capturedToday}통 · 내부 예약 ${b.reserved}통</p>
      <p>일반 잔여 ${b.normalRemaining}통 · 예비 포함 잔여 ${b.totalRemaining}통 · Brevo 계정 확인값
        ${b.providerAccountRemaining==null?'미확인':`${b.providerAccountRemaining}통 (${esc(parisDeadline(new Date(b.providerObservationAt).toISOString(),'ko'))})`}</p>
      <div class="actions"><label>Brevo에서 확인한 잔여 통수 <input name="remaining" type="number" min="0" max="300"></label>${button('account','확인값 기록')}</div>
      ${editable?policyEditor(data.policy):''}</section>
      <section data-mail-section="history">
      <p>불러온 이력의 대기 ${due}건 · 실패 ${failed}건 · 다음 예정 ${upcoming?esc(parisDeadline(upcoming,'ko')):'—'}</p>
      <div class="actions"><input data-history-search placeholder="${t('주문번호, 이름, 이메일','Référence, nom ou e-mail')}"><input data-history-from type="date"><input data-history-to type="date"><select data-history-type><option value="">${t('모든 종류','Tous les types')}</option>${Object.entries(kinds).map(([id,label])=>'<option value="'+id+'">'+esc(label)+'</option>').join('')}</select><select data-history-state><option value="">${t('모든 상태','Tous les états')}</option>${Object.entries(states).map(([id,label])=>'<option value="'+id+'">'+esc(label)+'</option>').join('')}</select>${button('history-excel','Excel')}</div><div data-history-list></div>
      <div class="actions">${cursor?button('more','이력 더 보기'):''}${button('refresh','새로고침')}</div></section><section data-mail-section="manual"><div data-transaction-manual></div><div data-mail-manual></div></section>`;
    if(previous)body.querySelector('[data-mail-manual]').replaceWith(previous);
    else initManual();
    renderPrepared();chooseTab(tab);drawHistory();syncMailSwitches();renderTransactionManual(data.policy);
  }

  const parisDate=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',dateStyle:'short'});
  const timestamp=new Intl.DateTimeFormat(fr?'fr-FR':'ko-KR',{timeZone:'Europe/Paris',dateStyle:'short',timeStyle:'medium'});
  function historyResults(){
   const value=key=>body.querySelector('[data-history-'+key+']')?.value||'';
   const search=value('search').trim().toLowerCase();
   return messages.filter(row=>{
    const when=row.sentAt||row.manualSentAt||row.createdAt;
    const day=when?parisDate.format(new Date(when)):'';
    return (!value('type')||value('type')===row.type)&&(!value('state')||value('state')===row.status)
     &&(!value('from')||day>=value('from'))&&(!value('to')||day<=value('to'))
     &&[row.orderRef,row.name,row.email].join(' ').toLowerCase().includes(search);
   }).sort((a,b)=>String(b.sentAt||b.manualSentAt||b.createdAt||'').localeCompare(String(a.sentAt||a.manualSentAt||a.createdAt||'')));
  }
  function historyValues(row){
   const date=row.sentAt||row.manualSentAt||row.createdAt;
   return [date?timestamp.format(new Date(date)):'—',row.name,row.email,row.orderRef,kinds[row.type]||types[row.type]||row.type,
    row.mode,row.actor,row.method,row.status].map(value=>value??'—');
  }
  function drawHistory(){
   const target=body.querySelector('[data-history-list]');if(!target)return;
   target.innerHTML=historyResults().map(row=>'<section class="panel pad">'+historyValues(row).map(esc).join(' · ')+
    mailRows([row],fr)+
    (row.retries?.length?'<p>'+row.retries.map(retry=>esc(retry.at)+' · '+esc(retry.by)+' · '+esc(retry.reason)).join('<br>')+'</p>':'')+
    '</section>').join('')||t('발송 이력이 없습니다.','Aucun envoi.');
  }
  panel.addEventListener('input',event=>{if(event.target.matches('[data-history-search],[data-history-from],[data-history-to],[data-history-type],[data-history-state]'))drawHistory();});
  function renderTransactionManual(policy){
    const options=messages.filter(row=>['orderChanged','additionalPayment','refundCompleted'].includes(row.type)&&
     ['queued','skipped'].includes(row.status)&&row.email&&policyMode(policy,row.type)==='manual'&&!(row.mode==='manual'&&row.status==='queued'));
    const target=body.querySelector('[data-transaction-manual]');
    if(!options.length){target.replaceChildren();return;}
    target.innerHTML='<h3>'+t('주문 변경·추가 송금·환불 메일','Messages de modification, complément et remboursement')+'</h3>'+
     '<label class="field">'+t('거래별 이메일','Message par opération')+'<select data-transaction-job>'+options.map(row=>
     '<option value="'+esc(row.id)+'">'+esc((row.orderRef||'—')+' · '+kinds[row.type]+' · '+(row.createdAt?timestamp.format(new Date(row.createdAt)):''))+'</option>').join('')+
     '</select></label><div class="actions">'+button('transaction-send',t('이메일 보내기 (1통)','Envoyer un e-mail (1)'))+
     button('transaction-preview',t('미리보기','Aperçu'))+'</div><pre data-transaction-preview hidden></pre>';
  }
  function initManual() {
    body.querySelector('[data-mail-manual]').innerHTML=`<h3>${t('수동 발송 · Brevo 또는 OVH','Envoi manuel · Brevo ou OVH')}</h3><form data-manual-form class="form-grid">
      <label class="field">안내 종류 ${select('type',['reminderFinal','bulkCancel','pickup','other','receipt','confirmed','buyerCancel','adminCancel'].map(kind=>[kind,kinds[kind]]))}</label>
      <label class="field">대상 ${select('audience',[['unpaid','미입금'],['valid','전체 유효 주문'],['confirmed','입금 확인'],['canceled','취소 주문']])}</label>
      <label><input name="excludeReported" type="checkbox" checked> 송금 신고 완료 제외</label>
      <label class="field">기타 안내 제목 <input name="notice" maxlength="80"></label>
      <fieldset class="field wide"><legend>주문 선택</legend><label><input type="checkbox" data-order-select-all> 전체 선택</label><div class="manual-order-list">${orders.filter(o=>o.email)
        .map(o=>`<label class="modal-row"><input type="checkbox" name="ids" value="${esc(o.id)}" data-manual-order> <span>${esc(o.ref)} · ${esc(o.name)} · ${esc(o.status)}</span></label>`).join('')}</div></fieldset>
      <div class="actions">${button('prepare-selected','선택 주문 주소 준비')}${button('prepare-all','조건에 맞는 전체 주문 주소 준비')}<a class="btn neutral" href="https://webmail.ovh.net/" target="_blank" rel="noopener noreferrer">OVH 웹메일 열기</a></div>
      <div data-mail-prepared></div></form>`;
    const fields=body.querySelector('[data-manual-form]').elements;
    fields.type.addEventListener('change',()=>{
      fields.audience.value=fields.type.value==='reminderFinal'?'unpaid':['bulkCancel','buyerCancel','adminCancel'].includes(fields.type.value)?'canceled':fields.type.value==='confirmed'?'confirmed':'valid';
      fields.excludeReported.checked=fields.type.value==='reminderFinal';
    });
  }

  function renderPrepared(){
    const target=body.querySelector('[data-mail-prepared]');
    if(!target)return;
    const ko=target.querySelector('[data-override-ko]')?.value||'',french=target.querySelector('[data-override-fr]')?.value||'';
    target.innerHTML=prepared.length?`<p>Bcc 수신자 ${recipients().length}명 · 주문 ${prepared.length}건</p>
      <label class="field wide">OVH 메일의 숨은참조(Bcc)에 붙여넣을 주소 · 중복 제거 완료<textarea readonly aria-label="Bcc 주소">${esc(recipients().join('; '))}</textarea></label>
      <p>${t('Brevo 선택 주문','Commandes sélectionnées')} ${prepared.length} · ${t('일반 한도 예상 잔여','Solde interne estimé')} ${Math.max(0,(lastBudget?.normalRemaining??0)-prepared.length)}</p>
      <label>${t('이번 발송에만 적용할 한국어 안내','Texte coréen pour cet envoi uniquement')}<textarea data-override-ko maxlength="2500">${esc(ko)}</textarea></label>
      <label>${t('이번 발송에만 적용할 프랑스어 안내','Texte français pour cet envoi uniquement')}<textarea data-override-fr maxlength="2500">${esc(french)}</textarea></label>
      <div class="actions">${button('brevo-preview',t('발송 문구 미리보기','Aperçu du texte'))}${button('brevo-queue',t('Brevo 발송 대기 등록','Mettre en file Brevo'))}${button('brevo-send-now',t('Brevo 즉시 발송','Envoyer maintenant via Brevo'))}${button('copy','주소 복사')}${button('excel','Excel 다운로드')}
      ${button('complete','OVH 발송 완료 기록')}${button('release','발송 준비 해제')}</div>`:'';
  }

  panel.addEventListener('toggle',()=>{
    if(!panel.open||ready||pending)return;
    pending=true;
    void load().then(()=>{ready=true;},error=>{feedback.textContent=error.message;}).finally(()=>{pending=false;});
  });
  panel.addEventListener('submit',e=>e.preventDefault());
  panel.addEventListener('change',e=>{
    if(e.target.matches('[data-mail-master]'))form().querySelectorAll('input[role=switch]').forEach(input=>input.checked=e.target.checked);
    if(e.target.matches('[data-mail-master],input[role=switch]'))syncMailSwitches();
    if(e.target.matches('[data-order-select-all]'))panel.querySelectorAll('[data-manual-order]').forEach(box=>box.checked=e.target.checked);
  });
  panel.addEventListener('click',async e=>{
    const control=e.target.closest('[data-mail],[data-mail-job],[data-mail-template],[data-mail-tab]');
    if(!control||pending)return;
    if(control.dataset.mailTab){chooseTab(control.dataset.mailTab);return;}
    if(control.dataset.mailTemplate){collectTemplate();editTemplate(control.dataset.mailTemplate);return;}
    const click=control.dataset.mail;
    pending=true;control.disabled=true;feedback.textContent='';
    try{
      if(control.dataset.mailJob){const result=await jobAction(control,request,eventId,fr);if(result){await load();feedback.textContent=dispatchFeedback(result,fr);}}
      if(click==='transaction-send'||click==='transaction-preview'){
        const row=messages.find(item=>item.id===body.querySelector('[data-transaction-job]').value);
        if(!row)return;
        if(click==='transaction-preview'){
          const preview=await action('mailPreview',{type:row.type,id:row.orderId,jobId:row.id,lang:orders.find(order=>order.id===row.orderId)?.lang||'ko'});
          const target=body.querySelector('[data-transaction-preview]');target.textContent=preview.subject+'\n\n'+preview.text;target.hidden=false;
        }else if(confirm((row.orderRef||'—')+' · '+kinds[row.type]+' · '+row.email+' · '+t('1통을 즉시 발송할까요?','Envoyer 1 message maintenant ?'))){
          await action('mailTransactionQueue',{jobId:row.id,confirm:true});
          const result=await action('mailJobAction',{id:row.id,action:'sendNow',confirm:true});await load();feedback.textContent=dispatchFeedback(result,fr);
        }
      }
      if(click==='history-excel'){
        const workbook=XLSX.utils.book_new(),rows=historyResults().map(historyValues);
        XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([[t('발송 일시','Date'),t('수신자','Destinataire'),'E-mail',t('주문번호','Référence'),t('종류','Type'),'Mode',t('담당자','Agent'),t('방식','Canal'),t('결과','Résultat')],...rows]),'Historique');
        XLSX.writeFile(workbook,'ASICC-email-history.xlsx');
      }
      if(click==='refresh'||click==='more')await load(click==='more');
      if(click==='account'){
        const value=body.querySelector('[name=remaining]').value;
        if(value==='')throw new Error('Brevo 대시보드의 잔여량을 입력해 주세요.');
        await action('mailAccountUsage',{remaining:Number(value)});await load();
      }
      if(click==='enable-all'||click==='disable-all')form().querySelectorAll('input[type=checkbox]').forEach(input=>{input.checked=click==='enable-all';});
      if(click==='template-reset'){
        const editor=body.querySelector('[data-template-editor]');
        templates[editor.dataset.kind]={};editTemplate(editor.dataset.kind);
      }
      if(click==='template-preview'){
        collectTemplate();
        const editor=body.querySelector('[data-template-editor]'),preview=editor.querySelector('[data-template-preview]');
        const rendered=await action('mailPreview',{type:editor.dataset.kind,id:editor.querySelector('[data-preview-order]').value,lang:editor.querySelector('[data-preview-lang]').value,template:templates[editor.dataset.kind]});
        preview.textContent=rendered.subject+'\n\n'+rendered.text;
        preview.hidden=false;
      }
      if(click==='policy'){
        collectTemplate();
        const f=form().elements;
        const preferredModes=Object.fromEntries(Object.keys(kinds).map(kind=>[kind,f['mode-'+kind].value]));
        const modes=Object.fromEntries(Object.keys(kinds).map(kind=>[kind,f['on-'+kind].checked?preferredModes[kind]:'off']));
        await action('mailPolicy',{modes,preferredModes,templates});await load();
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
      if(['brevo-preview','brevo-queue','brevo-send-now'].includes(click)){
        const override={introKo:body.querySelector('[data-override-ko]').value.trim(),introFr:body.querySelector('[data-override-fr]').value.trim()};
        if(click==='brevo-preview'){
          alert([override.introKo,override.introFr].filter(Boolean).join('\n\n')||t('저장된 양식 또는 기본 문구를 사용합니다.','Le modèle enregistré ou le texte par défaut sera utilisé.'));
          return;
        }
        const available=Math.min(lastBudget?.normalRemaining??0,lastBudget?.providerAccountRemaining??Infinity);
        if(prepared.length>available)throw new Error(t('확인된 발송 한도보다 선택 주문이 많습니다.','La sélection dépasse le quota disponible.'));
        const immediate=click==='brevo-send-now';
        if(!confirm((immediate?t('선택한 주문에 즉시 발송할까요?','Envoyer maintenant aux commandes sélectionnées ?'):t('선택한 주문별로 Brevo 발송 대기에 등록할까요?','Ajouter un message Brevo par commande sélectionnée ?'))+' ('+prepared.length+')'))return;
        const queued=[];
        await chunks('mailManualQueue',{...preparedOptions,override},prepared.map(row=>row.id),rows=>{
          queued.push(...rows);
          const done=new Set(rows.map(row=>row.id));
          prepared=prepared.filter(row=>!done.has(row.id));
        });
        if(immediate){
          const results=[];
          for(const [index,row] of queued.entries()){
            feedback.textContent=t('즉시 발송 처리 중','Envoi immédiat en cours')+' '+(index+1)+'/'+queued.length;
            try{results.push(await action('mailJobAction',{id:row.jobId,action:'sendNow',confirm:true}));}
            catch{results.push({status:'unknown'});}
          }
          const accepted=results.filter(result=>result.status==='sent'&&result.method!=='capture').length;
          const captured=results.filter(result=>result.status==='sent'&&result.method==='capture').length;
          feedback.textContent=t('서버 접수','Acceptés')+' '+accepted+' · '+t('테스트 기록','Capturés')+' '+captured+' · '+t('대기·실패·미확인','En attente, échec ou état inconnu')+' '+(results.length-accepted-captured)+'. '+t('수신함 도착 여부는 미확인입니다.','Remise non vérifiée.');
        }
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
