import {displayIban} from './iban.mjs';
import {defaultPaymentHours,formatParisPaymentDeadline,paymentGuidance,transferIdentification} from './payment-window.mjs';
import {orderTerms,pickupContact,pickupTerms} from './order-terms.mjs';

const palette={background:'#EFF2F5',white:'#FFFFFF',navy:'#233D55',text:'#334155',muted:'#64748B',
  line:'#E2E8F0',soft:'#F4F6F8',success:'#397653',pending:'#A25232',canceled:'#A04D4D'};
const font="'Segoe UI','Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif";
const html=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const multiline=value=>html(value).replace(/\r?\n/g,'<br>');
const eur=cents=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format((cents??0)/100);
const table=(content,style='',attributes='')=>`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;${style}" ${attributes}>${content}</table>`;
const row=content=>'<tr>'+content+'</tr>';
const td=(content,style='',attributes='')=>`<td style="${style}" ${attributes}>${content}</td>`;
const paragraph=(text,style='')=>`<p style="margin:0 0 12px;font-size:15px;line-height:1.65;${style}">${multiline(text)}</p>`;
const heading=(text,style='')=>`<h2 style="margin:0 0 12px;color:${palette.navy};font-size:19px;line-height:1.3;${style}">${html(text)}</h2>`;
const section=(title,content)=>table(row(td((title?heading(title):'')+content,'padding:24px 0 0;')));
const panel=(content,background=palette.soft)=>table(row(td(content,'padding:16px;background:'+background+';')));
const muted='color:'+palette.muted+';font-size:13px;';
const emphasis='font-size:25px;line-height:1.2;font-weight:700;color:'+palette.navy+';';

function parisPickup(value,lang){
  const time=Date.parse(value??'');
  if(!Number.isFinite(time))return [];
  const locale=lang==='fr'?'fr-FR':'ko-KR';
  const date=new Intl.DateTimeFormat(locale,{timeZone:'Europe/Paris',dateStyle:'full'}).format(time);
  const clock=new Intl.DateTimeFormat(locale,{timeZone:'Europe/Paris',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(time);
  return lang==='fr'?[['Date',date],['Heure de Paris',clock]]:[['수령 날짜',date],['시간 (파리)',clock]];
}

function facts(rows){
  return table(rows.map(([label,value,style=''])=>row(
    td(html(label),'padding:8px 10px 8px 0;vertical-align:top;'+muted,'width="42%"')+
    td(multiline(value),'padding:8px 0;vertical-align:top;overflow-wrap:anywhere;word-break:break-word;'+style)
  )).join(''));
}

function productTable(items,labels,title){
  const style='padding:10px 6px;border-bottom:1px solid '+palette.line+';';
  const th=(label,align,width='')=>`<th scope="col" ${width} align="${align}" style="${style}${muted}text-align:${align};">${html(label)}</th>`;
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;border-collapse:collapse;">'+
    '<thead>'+row(th(labels.name,'left')+th(labels.qty,'center','width="18%"')+th(labels.amount,'right','width="30%"'))+'</thead><tbody>'+
    items.map(item=>row(td(multiline(title(item)),style+'overflow-wrap:anywhere;word-break:break-word;')+
      td(html(item.qty),style+'text-align:center;')+td(html(eur(item.priceCents*item.qty)),style+'text-align:right;white-space:nowrap;'))).join('')+
    '</tbody></table>';
}

function button(label,url,variant='primary'){
  const primary=variant==='primary', color=variant==='danger'?palette.canceled:palette.navy;
  return table(row(td(`<a href="${html(url)}" style="display:block;padding:13px 8px;font:700 14px/20px ${font};text-align:center;color:${primary?'#FFFFFF':color};text-decoration:none;mso-padding-alt:0;">${html(label)}</a>`,
    'border:1px solid '+color+';background:'+(primary?color:palette.white)+';border-radius:6px;mso-padding-alt:13px 8px;','align="center"')));
}

function actionTable({view,report,cancel}){
  if(!view&&!report&&!cancel)return '';
  const primary=report?button(...report):'';
  if(!cancel&&!report)return view?button(...view):'';
  if(!cancel)return primary+table(row(td(button(...view,'secondary'),'padding-top:10px;')));
  return primary+table(row(td(button(...view,'secondary'),'padding:10px 5px 0 0;','class="mail-button-col" width="50%"')+
    td(button(...cancel,'danger'),'padding:10px 0 0 5px;','class="mail-button-col" width="50%"')));
}

function mailLayout({lang,logoUrl,title,brand,body,footer,testNotice}){
  const header=td(`<img src="${html(logoUrl)}" width="44" height="44" alt="ASICC" style="display:block;margin:0 auto 10px;border:0;">
    <div style="font-size:23px;line-height:1.25;font-weight:700;color:#FFFFFF;">ASICC</div>
    <p style="margin:6px 0 0;color:#FFFFFF;font-size:13px;line-height:1.45;">${brand.map(html).join('<br>')}</p>`,
    'padding:20px 16px;text-align:center;background:'+palette.navy+';','align="center"');
  const ribbon=testNotice?row(td(paragraph(testNotice,'color:'+palette.pending+';font-size:13px;margin:0;'),
    'padding:12px 16px;background:#F9F2EA;text-align:center;')):'';
  const contents=table(row(header)+ribbon+row(td(body,'padding:30px;','class="mail-content"'))+
    row(td(footer,'padding:21px 16px;background:'+palette.navy+';color:#FFFFFF;text-align:center;font-size:13px;line-height:1.65;')),
    'max-width:600px;background:#FFFFFF;color:'+palette.text+';font:15px/1.65 '+font+';');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${html(title)}</title><style>@media only screen and (max-width:480px){
    .mail-content{padding:18px !important}.mail-button-col{display:block!important;width:auto!important;padding-left:0!important;padding-right:0!important}}</style></head>
    <body style="padding:0;margin:0;background:${palette.background};">
    ${table(row(td('<!--[if mso]><table role="presentation" align="center" width="600"><tr><td><![endif]-->'+
      contents+'<!--[if mso]></td></tr></table><![endif]-->','padding:16px 6px;','align="center" valign="top"')))}
    </body></html>`;
}

export function renderOrderEmail({order,type,event={},template={},change={},site,canCancel=false,testMode=false}){
  const lang=order.lang==='fr'?'fr':'ko',t=(ko,fr)=>lang==='fr'?fr:ko;
  const eventName=t(event.nameKo,event.nameFr)||event.nameKo||event.nameFr||'';
  const [defaultTitle,introDefault,tone]=({
    receipt:[t('주문 접수 안내','Commande reçue'),t('바자회에 참여해 주셔서 감사합니다. 입금 확인 후 주문이 최종 확정됩니다.','Merci de participer au bazar. Votre commande sera confirmée après réception du virement.'),'pending'],
    reported:[t('송금 신고 접수','Virement signalé'),t('송금 신고가 접수되었습니다. 협회의 입금 확인을 기다려 주세요.','Votre signalement a été reçu. L’association doit encore confirmer la réception du paiement.'),'pending'],
    confirmed:[t('주문 확정 안내','Commande confirmée'),t('입금을 확인했습니다. 지정된 장소와 시간에 상품을 수령해 주세요.','Votre paiement a bien été reçu. Retrouvez ci-dessous les informations de retrait.'),'success'],
    reminder3:[t('송금 기한 안내','Rappel de paiement'),t('아직 송금 신고가 접수되지 않았습니다.','Votre virement n’a pas encore été signalé.'),'pending'],
    reminderFinal:[t('송금 기한 안내','Rappel de paiement'),t('송금 기한이 다가오고 있습니다. 송금 후 주문 페이지에서 알려 주세요.','La date limite approche. Une fois le virement effectué, signalez-le depuis votre commande.'),'pending'],
    additionalPayment:[t('추가 입금 안내','Complément de paiement'),t('변경된 주문의 추가 송금 금액을 확인해 주세요.','Veuillez vérifier le complément à verser pour votre commande.'),'pending'],
    orderChanged:[t('주문 변경 안내','Commande modifiée'),t('변경이 반영된 주문과 금액을 확인해 주세요.','Consultez les articles et le montant de votre commande mise à jour.'),'navy'],
    cancel:[t('주문 취소 안내','Commande annulée'),t('주문이 취소되었습니다. 문의가 있으면 협회에 연락해 주세요.','Votre commande a été annulée. Contactez l’association si vous avez une question.'),'canceled'],
    bulkCancel:[t('주문 취소 안내','Commande annulée faute de paiement'),t('기한 내 입금이 확인되지 않았습니다. 이미 송금했다면 협회에 주문번호와 송금일을 알려 주세요.','Le paiement n’a pas été confirmé à temps. Si vous avez déjà payé, communiquez à l’association la référence et la date du virement.'),'canceled'],
    refundPending:[t('환불 안내','Remboursement'),t('환불을 처리 중입니다.','Votre remboursement est en cours.'),'pending'],
    refundCompleted:[t('환불 안내','Remboursement'),t('환불 처리가 완료되었습니다.','Votre remboursement a été effectué.'),'success'],
    pickup:[t('상품 수령 안내','Retrait de votre commande'),t('아래 수령 일정과 준비물을 확인해 주세요.','Vérifiez la date, le lieu et les consignes de retrait ci-dessous.'),'success'],
    pickupCompleted:[t('상품 수령 완료','Commande retirée'),t('상품 수령이 완료되었습니다. 참여해 주셔서 감사합니다.','Votre retrait est enregistré. Merci d’avoir participé au bazar.'),'success'],
  })[type]||[t('바자회 안내','Informations sur la vente solidaire'),t('주문 관련 안내를 확인해 주세요.','Retrouvez les informations relatives à votre commande.'),'navy'];
  const title=t(template.subjectKo,template.subjectFr)||defaultTitle;
  const intro=t(template.introKo,template.introFr)||introDefault;
  const subject=(testMode?'[TEST] ':'')+'[ASICC] '+title+' · '+order.orderRef;
  const testNotice=testMode?t('ASICC 테스트 — 검수 주문이며 송금할 필요가 없습니다.',
    'TEST ASICC — Commande de test. Aucun virement n’est nécessaire.'):'';
  const url=new URL('/'+lang+'/bazaar/commande/',site);
  url.searchParams.set('id',order.id);
  url.hash='token='+encodeURIComponent(order.buyerToken);
  const anchor=focus=>url.href+'&focus='+focus;
  const viewLabels={
    receipt:[t('주문내역 확인하기','Voir ma commande')],
    confirmed:[t('확정 주문 확인하기','Voir ma commande confirmée')],
    reminder3:[t('주문내역 확인하기','Voir ma commande')],
    reminderFinal:[t('주문내역 확인하기','Voir ma commande')],
    additionalPayment:[t('추가 입금 내역 확인하기','Voir le complément à verser')],
    orderChanged:[t('변경내역 확인하기','Voir les modifications')],
    cancel:[t('취소내역 확인하기','Voir les détails de l’annulation')],
    buyerCancel:[t('취소내역 확인하기','Voir les détails de l’annulation')],
    adminCancel:[t('취소내역 확인하기','Voir les détails de l’annulation')],
    bulkCancel:[t('취소내역 확인하기','Voir les détails de l’annulation')],
    refundPending:[t('환불내역 확인하기','Voir mon remboursement')],
    refundCompleted:[t('환불내역 확인하기','Voir mon remboursement')],
    pickupCompleted:[t('확정 주문 확인하기','Voir ma commande confirmée')],
  };
  const view=viewLabels[type]?[viewLabels[type][0],url.href]:null;
  const receipt=type==='receipt';
  const reminders=['reminder3','reminderFinal'].includes(type);
  const balance=type==='additionalPayment';
  const pending=!(order.transferReportedAt||order.bankConfirmedAt||order.canceledAt);
  const report=pending&&(receipt||reminders)?[t('송금 완료 알리기','Signaler mon virement'),anchor('report')]:null;
  const cancel=report&&canCancel?[t('주문 취소하기','Annuler ma commande'),anchor('cancel')]:null;
  const notice=type==='other';
  const choice=field=>!notice||template.fields?.includes(field);
  const items=order.items||[];
  const productName=item=>t(item.titleKo||item.titleFr,item.titleFr||item.titleKo);
  const amountTitle=t('총 주문 금액','Total de la commande');
  const paymentTitle=t('송금 정보','Coordonnées bancaires');
  const pickupTitle=t('상품 수령 안내','Retrait de la commande');
  const deadlineTitle=t('송금 마감','Date limite de virement');
  const deadline=formatParisPaymentDeadline(order.paymentDeadline||event.transferCutoff,lang);
  const plain=[...(testNotice?[testNotice,'']:[]),title,choice('event')?eventName:undefined,intro].filter(line=>line!==undefined);
  const body=[];
  const addFacts=(title,rows,boxed=true)=>{
    const visible=rows.filter(([,value])=>value!==undefined&&value!==null&&value!=='');
    if(!visible.length)return;
    body.push(section(title,boxed?panel(facts(visible)):facts(visible)));
    plain.push('',...(title?[title]:[]),...visible.map(([label,value])=>label+': '+value));
  };
  const addNotes=(title,lines,boxed=false)=>{
    if(!lines.length)return;
    const content=lines.map(line=>paragraph(line)).join('');
    body.push(section(title,boxed?panel(content):content));
    plain.push('',title,...lines);
  };

  body.push(`<div style="text-align:center;">
    <p style="margin:0 0 6px;color:${palette[tone]};font-size:22px;line-height:1;">${tone==='success'||receipt?'✓':tone==='canceled'?'×':'•'}</p>
    <h1 style="margin:0 0 10px;color:${palette.navy};font-size:26px;line-height:1.2;">${html(receipt&&!t(template.subjectKo,template.subjectFr)?t('주문이 접수되었습니다','Votre commande a été reçue'):title)}</h1>
    ${choice('event')&&eventName?paragraph(eventName,muted):''}${paragraph(intro)}</div>`);
  const state=type==='reported'?t('입금 확인 대기','Vérification du virement en attente')
    :type==='confirmed'?t('입금 확인 완료','Paiement confirmé')
    :type==='cancel'||type==='bulkCancel'?t('주문 취소','Commande annulée')
    :type==='refundPending'?t('환불 처리 중','Remboursement en cours')
    :type==='refundCompleted'?t('환불 완료','Remboursement effectué')
    :type==='pickupCompleted'?t('수령 완료','Commande retirée')
    :receipt||reminders||balance?t('송금 대기 중','En attente de virement'):'';
  if(choice('order')){
    const labels=[t('주문번호','Référence de commande'),t('주문자','Nom')];
    body.push(section('',panel(table(row(td(paragraph(labels[0],muted)+`<strong style="${emphasis}">${html(order.orderRef)}</strong>`,'vertical-align:top;padding-right:10px;word-break:break-word;','width="55%"')+
      td(paragraph(labels[1],muted)+`<strong>${html(order.name)}</strong>`,'vertical-align:top;word-break:break-word;')))+
      (state?`<p style="margin:12px 0 0;color:${palette[tone]};font-weight:700;">${html(state)}</p>`:''))));
    plain.push('',labels[0]+': '+order.orderRef,labels[1]+': '+order.name,...(state?[state]:[]));
  }
  if(choice('items')||choice('total')){
    const label=type==='cancel'||type==='bulkCancel'?t('취소된 주문 내역','Articles annulés'):t('주문 내역','Votre commande');
    const list=choice('items')&&items.length?productTable(items,{name:t('상품명','Article'),qty:t('수량','Qté'),amount:t('금액','Montant')},productName):'';
    const total=choice('total')?panel(`<p style="margin:0;text-align:right;">${html(amountTitle)}<br><strong style="${emphasis}">${html(eur(order.totalCents))}</strong></p>`):'';
    body.push(section(label,list+total));
    plain.push('',label,...(choice('items')?items.map(i=>'• '+productName(i)+' × '+i.qty+' = '+eur(i.priceCents*i.qty)):[]),
      ...(choice('total')?[amountTitle+': '+eur(order.totalCents)]:[]));
  }
  if(receipt&&order.pickupNote)addNotes(t('판매자에게 전달할 사항','Informations complémentaires pour le retrait'),[order.pickupNote],true);
  if(type==='orderChanged'&&Number.isFinite(change.previousTotalCents)&&change.previousTotalCents!==order.totalCents)
    addFacts(t('주문 금액 변경','Écart de montant'),[[t('이전 금액','Ancien total'),eur(change.previousTotalCents)],
      [t('차액','Différence'),eur(order.totalCents-change.previousTotalCents)]]);
  if(receipt||reminders||balance){
    const amount=balance?(change.amountCents??order.payment?.additionalDue??0):order.totalCents;
    const rows=[[balance?t('추가 송금액','Complément à verser'):t('송금 금액','Montant du virement'),eur(amount),emphasis],
      [t('수취인','Bénéficiaire'),event.beneficiary],[ 'IBAN',displayIban(event.iban)],
      [t('송금 메모','Libellé du virement'),order.orderRef,'background:#E7EEF4;'+emphasis],
      ...(!balance?[[deadlineTitle,deadline,'font-weight:700;color:'+palette.pending+';']]:[])];
    addFacts(paymentTitle,rows);
    const instruction=transferIdentification(lang);
    body.push(paragraph(instruction,muted+'margin-top:10px;'));
    plain.push(instruction);
  }else if(notice&&choice('deadline')){
    addFacts('',[[deadlineTitle,deadline]]);
  }
  if(type==='refundPending'||type==='refundCompleted'){
    addFacts(t('환불 정보','Détails du remboursement'),[
      [t('환불액','Montant remboursé'),Number.isFinite(change.amountCents)?eur(change.amountCents):''],
      [t('처리 상태','État'),state],
      [t('처리 일시','Date de traitement'),change.at?formatParisPaymentDeadline(change.at,lang):'']]);
  }
  const actions=actionTable({view,report,cancel});
  if(actions)body.push(section('',actions));
  for(const action of [report,view,cancel].filter(Boolean))plain.push('',action[0]+': '+action[1]);
  if(receipt||reminders)addNotes(t('송금 시 유의사항','Conseils pour votre virement'),
    paymentGuidance(lang,order.paymentHours??event.paymentHours??defaultPaymentHours).slice(1,5),true);
  if(['receipt','confirmed','reminderFinal','pickup'].includes(type)||notice&&choice('pickup')){
    addFacts(pickupTitle,[...parisPickup(event.pickupAt,lang),[t('수령 장소','Lieu'),event.pickupPlace],
      [t('추가 안내','Informations complémentaires'),t(event.pickupKo||event.pickupFr,event.pickupFr||event.pickupKo)]],false);
    if(!notice)addNotes(pickupTerms[lang].title,[t('냉장·냉동 상품은 보냉 가방을 준비해 주세요.','Prévoyez un sac isotherme pour les produits réfrigérés ou surgelés.'),
      ...pickupTerms[lang].lines,pickupTerms[lang].contact+': '+pickupContact]);
  }
  if(['receipt','confirmed','reminderFinal','pickup'].includes(type))addNotes(orderTerms[lang].title,orderTerms[lang].lines);
  const together=t('함께 만들어 가는 ASICC 바자회','Ensemble, faisons vivre le bazar de l’ASICC');
  const purpose=t('바자회 수익금은 한국어 국제섹션 학생들의 교육·문화 활동과 학부모협회의 공익 활동에 사용됩니다.',
    'Les bénéfices du bazar soutiennent les activités éducatives et culturelles des élèves de la section internationale coréenne et les actions d’intérêt général de l’association.');
  body.push(section('',`<div style="text-align:center;border-top:1px solid ${palette.line};padding-top:18px;">${heading(together)}${paragraph(purpose,muted)}
    ${paragraph(t('여러분의 참여와 협조에 감사드립니다.','Merci pour votre participation.'),muted)}</div>`));
  plain.push('',together,purpose,t('문의','Contact')+': '+pickupContact,'www.asicc-parents.fr');
  const footer=`ASICC · Association loi 1901<br><a style="color:#FFFFFF;" href="mailto:${pickupContact}">${pickupContact}</a><br>
    <a style="color:#FFFFFF;" href="https://www.asicc-parents.fr">www.asicc-parents.fr</a>`;
  const logoUrl=new URL('/bazaar-email-logo.png',site).href;
  return {subject,text:plain.join('\n'),html:mailLayout({lang,logoUrl,title,body:body.join(''),footer,testNotice,
    brand:['쿠르브부아 한국어 국제섹션 학부모협회','Association de la Section Internationale Coréenne à Courbevoie']})};
}
