import {defaultMailCopy,renderOrderEmail} from '../../../../firebase-functions-bazaar/bazaar/order-email.mjs';
import {matchesMailAudience} from './mail-audience.mjs';
import { parisDeadline } from '../api';
import {mailKinds,policyMode} from '../../../../worker/bazaar/mail-policy.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const types={receipt:'주문 접수',confirmed:'입금 확인',cancel:'주문 취소',bulkCancel:'미입금 취소',
  reminderFinal:'마감 안내',pickup:'수령 안내',other:'기타 안내',reminder3:'이전 3시간 알림',reported:'이전 송금 신고'};
const states={queued:'대기',delayed:'지연',sending:'발송 중',sent:'발송 접수',failed:'실패',skipped:'발송 제외',
  canceled:'대기 취소',manualReserved:'OVH 발송 준비',manualSent:'OVH 발송 기록'};
const errors={'free-plan-limit':'무료 발송 한도', 'provider-limit':'Brevo 발송 제한',
  'provider-access-denied':'발송 권한 또는 IP 차단 확인','provider-result-uncertain':'Brevo 접수 여부 확인',
  'verify-provider-before-resending':'Brevo 발송 이력 확인','provider-rejected':'Brevo 요청 거절'};
const jobLabels={retry:'재발송',cancel:'대기 취소',completeManual:'OVH 완료 기록',releaseManual:'OVH 준비 해제'};

function mailRows(messages) {
  return messages.map(m=>{
    const timestamp=m.manualSentAt||m.sentAt||m.dueAt;
    const actions={failed:['retry'],queued:['cancel'],delayed:['cancel'],manualReserved:['completeManual','releaseManual']}[m.status]||[];
    return `<div class="modal-row"><span>${esc(types[m.type]||m.type)} · ${esc(states[m.status]||m.status)}
      ${timestamp?` · ${esc(parisDeadline(timestamp,'ko'))}`:''}${m.lastError?` · ${esc(errors[m.lastError]||m.lastError)}`:''}</span>
      ${m.sentSnapshot?'<details><summary>Message</summary><p>'+esc(m.sentSnapshot.to)+'</p><strong>'+esc(m.sentSnapshot.subject)+'</strong><pre>'+esc(m.sentSnapshot.text)+'</pre></details>':''}
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
    target.innerHTML=`${latePayment==='posted'?'<p>늦은 입금 장부 반영 완료</p>':latePayment==='pending'?'<p>최종 대조 후 입금 검토 대상</p>':''}${mailRows(messages)||'<p>발송 내역 없음</p>'}`;
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
  const renderKind=kind=>['buyerCancel','adminCancel'].includes(kind)?'cancel':kind;
  function effectiveCopy(kind){
    const [subjectKo,introKo]=defaultMailCopy(renderKind(kind),'ko');
    const [subjectFr,introFr]=defaultMailCopy(renderKind(kind),'fr');
    const defaults={subjectKo,introKo,subjectFr,introFr};
    return Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,templates[kind]?.[key]?.trim()||value]));
  }
  function sampleMail(kind,lang,override={}){
    return renderOrderEmail({type:renderKind(kind),order:{lang,id:'preview',buyerToken:'preview-only',orderRef:'ASICC-PREVIEW',name:lang==='fr'?'Client exemple':'예시 주문자',totalCents:2350,items:[{titleKo:'예시 상품 A',titleFr:'Produit exemple A',qty:2,priceCents:900},{titleKo:'예시 상품 B',titleFr:'Produit exemple B',qty:1,priceCents:550}],paymentDeadline:event.raw?.transferCutoff},event:event.raw||{},site:location.origin,template:{...templates[kind],...override},change:kind==='refundCompleted'?{amountCents:550}:kind==='additionalPayment'?{amountCents:550}:{}});
  }
  function samplePreview(kind,override={}){
    return ['ko','fr'].map(lang=>{
      const mail=sampleMail(kind,lang,override);
      return '<section class="field"><strong>'+t(lang==='ko'?'한국어 미리보기':'프랑스어 미리보기',lang==='ko'?'Aperçu coréen':'Aperçu français')+'</strong><div>'+esc(mail.subject)+'</div><iframe title="'+(lang==='ko'?'한국어 이메일 예시':'Aperçu français')+'" sandbox="" srcdoc="'+esc(mail.html)+'" style="width:100%;height:440px;border:1px solid #e7e1df;border-radius:8px"></iframe></section>';
    }).join('');
  }
  function displayManualCopy(){
    const form=body.querySelector('[data-manual-form]');if(!form)return;
    const kind=form.elements.type.value,copy=effectiveCopy(kind);
    const noticeLabel=form.querySelector('[data-notice-label]');noticeLabel.hidden=kind!=='other';noticeLabel.style.display=kind==='other'?'':'none';
    const target=form.querySelector('[data-manual-copy]');
    target.innerHTML='<h4>'+t('기본 발송 문구','Texte utilisé par défaut')+'</h4>'+['ko','fr'].map(lang=>{
      const suffix=lang==='ko'?'Ko':'Fr';
      return '<div class="panel pad"><strong>'+ (lang==='ko'?'한국어':'Français')+' · '+esc(copy['subject'+suffix])+'</strong><p style="white-space:pre-wrap">'+esc(copy['intro'+suffix])+'</p></div>';
    }).join('')+'<details><summary>'+t('전체 이메일 디자인 미리보기 (예시 주문)','Aperçu du message complet (commande fictive)')+'</summary>'+samplePreview(kind)+'</details>';
  }
  function editTemplate(kind){
    const editor=body.querySelector('[data-template-editor]');
    if(!editor)return;
    editor.hidden=false;editor.dataset.kind=kind;
    const fields={subjectKo:t('한국어 제목','Objet en coréen'),introKo:t('한국어 안내 문구','Texte en coréen'),
      subjectFr:t('프랑스어 제목','Objet en français'),introFr:t('프랑스어 안내 문구','Texte en français')};
    editor.innerHTML='<h4>'+esc(kinds[kind])+'</h4>'+Object.entries(fields).map(([key,label])=>'<label class="field">'+esc(label)+
      '<textarea name="'+key+'" maxlength="'+(key.startsWith('subject')?150:2500)+'">'+esc(effectiveCopy(kind)[key])+'</textarea></label>').join('')+
      '<p>'+t('주문과 행사 정보는 이메일 종류에 맞게 자동 삽입됩니다.','Les informations de commande et du bazar sont ajoutées selon le type de message.')+'</p>'+
      (kind==='other'?'<fieldset><legend>'+t('자동 삽입 정보','Informations à inclure')+'</legend>'+[['event',t('행사명','Bazar')],['order',t('주문번호','Référence')],['items',t('상품','Produits')],['total',t('금액','Montant')],['pickup',t('수령','Retrait')],['deadline',t('송금 기한','Échéance')]].map(([key,label])=>'<label><input type="checkbox" data-notice-field value="'+key+'" '+(templates[kind]?.fields?.includes(key)?'checked':'')+'> '+label+'</label>').join('')+'</fieldset>':'')+
      '<label>'+t('미리보기 주문','Commande exemple')+'<select data-preview-order><option value="">'+t('예시 주문','Commande fictive')+'</option>'+orders.map(order=>'<option value="'+esc(order.id)+'">'+esc(order.ref)+'</option>').join('')+'</select></label>'+
      '<label>'+t('언어','Langue')+'<select data-preview-lang><option value="ko">한국어</option><option value="fr">Français</option></select></label>'+
      button('template-reset',t('기본 양식 복원','Rétablir le modèle par défaut'))+button('template-preview',t('미리보기','Aperçu'))+'<pre data-template-preview hidden></pre><div data-template-html-preview></div>';
  }
  function collectTemplate(){
    const editor=body.querySelector('[data-template-editor]');
    if(!editor?.dataset.kind)return;
    const kind=editor.dataset.kind,previous=templates[kind]||{},defaults=effectiveCopy(kind);
    templates[kind]=Object.fromEntries([...editor.querySelectorAll('textarea')].map(el=>[el.name,el.value===defaults[el.name]?(previous[el.name]||''):el.value]));
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
    renderPrepared();displayManualCopy();syncManualSelection();chooseTab(tab);drawHistory();syncMailSwitches();renderTransactionManual(data.policy);
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
    '<p>'+t('전달 상태 미확인','Remise non vérifiée')+'</p>'+mailRows([row])+
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
      <label class="field" data-notice-label>기타 안내 제목 <input name="notice" maxlength="80"></label>
      <div data-manual-copy class="field wide"></div>
      <fieldset class="field wide"><legend>${t('발송 대상','Destinataires')} · <span data-mail-count aria-live="polite"></span></legend><label><input type="checkbox" data-order-select-all> ${t('전체 선택','Tout sélectionner')}</label><div class="manual-order-list"><div class="mail-order-head" aria-hidden="true"><span></span><span>${t('주문번호','Référence')}</span><span>${t('주문자','Client')}</span><span>${t('상태','État')}</span></div><div data-mail-order-rows></div></div></fieldset>
      <div class="actions">${button('prepare-selected',t('발송 준비','Préparer l’envoi'))}<a class="btn neutral" href="https://webmail.ovh.net/" target="_blank" rel="noopener noreferrer">OVH 웹메일 열기</a></div>
      <div data-mail-prepared></div></form>`;
    const fields=body.querySelector('[data-manual-form]').elements;
    fields.type.addEventListener('change',()=>{
      fields.audience.value=fields.type.value==='reminderFinal'?'unpaid':['bulkCancel','buyerCancel','adminCancel'].includes(fields.type.value)?'canceled':fields.type.value==='confirmed'?'confirmed':'valid';
      fields.excludeReported.checked=fields.type.value==='reminderFinal';
      renderManualAudience();displayManualCopy();
    });
    fields.audience.addEventListener('change',renderManualAudience);
    fields.excludeReported.addEventListener('change',renderManualAudience);
    renderManualAudience();
  }

  function renderManualAudience(){
    const form=body.querySelector('[data-manual-form]');
    const fields=form.elements;
    const eligible=orders.filter(order=>matchesMailAudience(order,fields.type.value,fields.audience.value,fields.excludeReported.checked));
    form.querySelector('[data-mail-order-rows]').innerHTML=eligible.map(o=>`<label class="modal-row"><input type="checkbox" name="ids" value="${esc(o.id)}" data-manual-order checked> <span class="mail-order-ref">${esc(o.ref)}</span><span class="mail-order-name">${esc(o.name)}</span><span class="mail-order-status" data-status="${esc(o.status)}">${esc(o.status)}</span></label>`).join('')||'<p style="padding:10px">'+t('조건에 맞는 주문이 없습니다.','Aucune commande correspondante.')+'</p>';
    syncManualSelection();
  }

  function syncManualSelection(){
    const form=body.querySelector('[data-manual-form]');if(!form)return;
    const boxes=[...form.querySelectorAll('[data-manual-order]')],count=boxes.filter(box=>box.checked).length;
    const master=form.querySelector('[data-order-select-all]');
    master.checked=boxes.length>0&&count===boxes.length;
    master.indeterminate=count>0&&count<boxes.length;
    master.disabled=!boxes.length||prepared.length>0;
    form.querySelector('[data-mail-count]').textContent=t('선택 '+count+' / '+boxes.length+'건',count+' / '+boxes.length+' sélectionnées');
    const prepare=form.querySelector('[data-mail=prepare-selected]');
    prepare.textContent=t('선택한 '+count+'건 발송 준비','Préparer '+count+' commande(s)');
    prepare.disabled=!count||prepared.length>0||pending;
    for(const input of [...boxes,form.elements.type,form.elements.audience,form.elements.excludeReported,form.elements.notice])input.disabled=prepared.length>0;
  }

  let showPreparedPreview=false;
  function renderPrepared(){
    const target=body.querySelector('[data-mail-prepared]');
    if(!target)return;
    const copy=effectiveCopy(preparedOptions?.type||'reminderFinal');
    const ko=target.querySelector('[data-override-ko]')?.value??copy.introKo,french=target.querySelector('[data-override-fr]')?.value??copy.introFr;
    if(!prepared.length)showPreparedPreview=false;
    target.innerHTML=prepared.length?`<p>Bcc 수신자 ${recipients().length}명 · 주문 ${prepared.length}건</p>
      <label class="field wide">OVH 메일의 숨은참조(Bcc)에 붙여넣을 주소 · 중복 제거 완료<textarea readonly aria-label="Bcc 주소">${esc(recipients().join('; '))}</textarea></label>
      <p>${t('Brevo 선택 주문','Commandes sélectionnées')} ${prepared.length} · ${t('일반 한도 예상 잔여','Solde interne estimé')} ${Math.max(0,(lastBudget?.normalRemaining??0)-prepared.length)}</p>
      <label>${t('이번 발송에만 적용할 한국어 안내','Texte coréen pour cet envoi uniquement')}<textarea data-override-ko maxlength="2500">${esc(ko)}</textarea></label>
      <label>${t('이번 발송에만 적용할 프랑스어 안내','Texte français pour cet envoi uniquement')}<textarea data-override-fr maxlength="2500">${esc(french)}</textarea></label>
      <div class="actions">${button('brevo-preview',t('발송 문구 미리보기','Aperçu du texte'))}${button('brevo-queue',t('Brevo 발송 대기 등록','Mettre en file Brevo'))}${button('copy','주소 복사')}${button('excel','Excel 다운로드')}
      ${button('complete','OVH 발송 완료 기록')}${button('release','발송 준비 해제')}</div>${showPreparedPreview?'<p>'+t('예시 주문으로 미리보기','Aperçu avec une commande fictive')+'</p>'+samplePreview(preparedOptions.type,{...(ko.trim()&&ko!==copy.introKo?{introKo:ko}:{}),...(french.trim()&&french!==copy.introFr?{introFr:french}:{})}):''}`:'';
  }

  panel.addEventListener('toggle',()=>{
    if(!panel.open||ready||pending)return;
    pending=true;
    void load().then(()=>{ready=true;},error=>{feedback.textContent=error.message;}).finally(()=>{pending=false;syncManualSelection();});
  });
  panel.addEventListener('submit',e=>e.preventDefault());
  panel.addEventListener('change',e=>{
    if(e.target.matches('[data-mail-master]'))form().querySelectorAll('input[role=switch]').forEach(input=>input.checked=e.target.checked);
    if(e.target.matches('[data-mail-master],input[role=switch]'))syncMailSwitches();
    if(e.target.matches('[data-order-select-all]'))panel.querySelectorAll('[data-manual-order]').forEach(box=>box.checked=e.target.checked);
    if(e.target.matches('[data-order-select-all],[data-manual-order]'))syncManualSelection();
  });
  panel.addEventListener('click',async e=>{
    const control=e.target.closest('[data-mail],[data-mail-job],[data-mail-template],[data-mail-tab]');
    if(!control||pending)return;
    if(control.dataset.mailTab){chooseTab(control.dataset.mailTab);return;}
    if(control.dataset.mailTemplate){collectTemplate();editTemplate(control.dataset.mailTemplate);return;}
    const click=control.dataset.mail;
    pending=true;control.disabled=true;feedback.textContent='';
    try{
      if(control.dataset.mailJob){await jobAction(control,request,eventId);await load();}
      if(click==='transaction-send'||click==='transaction-preview'){
        const row=messages.find(item=>item.id===body.querySelector('[data-transaction-job]').value);
        if(!row)return;
        if(click==='transaction-preview'){
          const preview=await action('mailPreview',{type:row.type,id:row.orderId,jobId:row.id,lang:orders.find(order=>order.id===row.orderId)?.lang||'ko'});
          const target=body.querySelector('[data-transaction-preview]');target.textContent=preview.subject+'\n\n'+preview.text;target.hidden=false;
        }else if(confirm((row.orderRef||'—')+' · '+kinds[row.type]+' · '+row.email+' · '+t('1통을 대기열에 추가할까요?','Ajouter 1 message à la file ?'))){
          await action('mailTransactionQueue',{jobId:row.id,confirm:true});await load();feedback.textContent=t('발송 대기열에 등록했습니다.','Ajouté à la file d’envoi.');
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
        editor.querySelector('[data-template-html-preview]').innerHTML='<p>'+t('HTML 디자인 예시 (가상 주문)','Exemple HTML (commande fictive)')+'</p>'+samplePreview(editor.dataset.kind);
      }
      if(click==='policy'){
        collectTemplate();
        const f=form().elements;
        const preferredModes=Object.fromEntries(Object.keys(kinds).map(kind=>[kind,f['mode-'+kind].value]));
        const modes=Object.fromEntries(Object.keys(kinds).map(kind=>[kind,f['on-'+kind].checked?preferredModes[kind]:'off']));
        await action('mailPolicy',{modes,preferredModes,templates});await load();
      }
      if(click==='prepare-selected'){
        if(prepared.length)throw new Error('기존 준비 건을 먼저 완료하거나 해제해 주세요.');
        const f=body.querySelector('[data-manual-form]').elements;
        preparedOptions={type:f.type.value,audience:f.audience.value,excludeReported:f.excludeReported.checked,notice:f.notice.value};
        const ids=[...body.querySelectorAll('[data-manual-order]:checked')].map(x=>x.value);
        if(!ids.length)throw new Error('선택 가능한 주문이 없습니다.');
        await chunks('mailManualPrepare',preparedOptions,ids,rows=>prepared.push(...rows));
        if(!prepared.length)feedback.textContent='조건에 맞는 발송 대상이 없습니다.';
        await load();
      }
      if(click==='brevo-preview'||click==='brevo-queue'){
        const copy=effectiveCopy(preparedOptions.type);
        const override=Object.fromEntries([['introKo',body.querySelector('[data-override-ko]').value.trim()],['introFr',body.querySelector('[data-override-fr]').value.trim()]].filter(([key,value])=>value&&value!==copy[key]));
        if(click==='brevo-preview'){
          showPreparedPreview=true;
          return;
        }
        const available=Math.min(lastBudget?.normalRemaining??0,lastBudget?.providerAccountRemaining??Infinity);
        if(prepared.length>available)throw new Error(t('확인된 발송 한도보다 선택 주문이 많습니다.','La sélection dépasse le quota disponible.'));
        if(!confirm(t('선택한 주문별로 Brevo 발송 대기에 등록할까요?','Ajouter un message Brevo par commande sélectionnée ?')))return;
        await chunks('mailManualQueue',{...preparedOptions,override},prepared.map(row=>row.id),rows=>{
          const done=new Set(rows.map(row=>row.id));
          prepared=prepared.filter(row=>!done.has(row.id));
        });
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
    finally{renderPrepared();pending=false;control.disabled=false;syncManualSelection();}
  });
}
