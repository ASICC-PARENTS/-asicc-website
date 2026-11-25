export function evidenceControls({event,record,vendors,expected,request,modal,close,run,refresh,t,esc,money}){
 const entries=(record.evidence||[]).filter(row=>!row.voidedAt);
 const purchases=entries.filter(row=>row.scope==='purchase');
 const actual=purchases.reduce((total,row)=>total+(row.kind==='credit'?-1:1)*row.amountCents,0);
 const missing=vendors.filter(vendor=>!purchases.some(row=>row.kind!=='credit'&&row.vendor===vendor));
 const frozen=!!record.finalizedAt;
 const kindLabels={invoice:t('청구서','Facture'),receipt:t('영수증','Reçu'),credit:t('차감전표','Avoir')};
 const statusLabels={paid:t('결제 완료','Payé'),unpaid:t('미결제','Non payé'),partial:t('부분 결제','Paiement partiel')};
 const methodLabels={'':'—',bank:t('계좌이체','Virement'),card:t('카드','Carte'),cash:t('현금','Espèces'),other:t('기타','Autre')};
 const expenseName=row=>record.expenses?.find(expense=>expense.id===row.expenseId)?.name||row.expenseId;
 const requestFile=(row,file)=>request('getEvidence',{eventId:event,id:row.id,fileId:file.id});
 const save=(blob,name)=>{
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=name;
  link.click();const url=link.href;setTimeout(()=>URL.revokeObjectURL(url),10000);
 };
 const option=(value,label,selected)=>'<option value="'+esc(value)+'" '+(value===selected?'selected':'')+'>'+esc(label)+'</option>';
 const options=(values,selected)=>Object.entries(values).map(([value,label])=>option(value,label,selected)).join('');
 const button=(text,attrs='',style='neutral')=>'<button class="btn '+style+'" '+attrs+'>'+text+'</button>';
 const closeButton=button(t('닫기','Fermer'),'data-action="close"');
 function form(scope,row){
  const optionsList=scope==='purchase'?vendors:record.expenses||[];
  if(!optionsList.length)throw new Error(scope==='purchase'?t('발주서를 먼저 등록해 주세요.','Enregistrez d’abord le bon de commande.'):t('지출 항목을 먼저 등록해 주세요.','Enregistrez d’abord une dépense.'));
  const id=row?.id||crypto.randomUUID().replaceAll('-','');
  const optional=(key,label,value='',max=120)=>'<label class="field">'+label+'<input name="'+key+'" maxlength="'+max+'" value="'+esc(value)+'"></label>';
  modal(t('증빙 등록','Justificatif'),'',
   '<form id="evidence-form" class="form-grid"><label class="field">'+(scope==='purchase'?t('공급업체','Fournisseur'):t('지출 항목','Dépense'))+
   '<select name="target">'+optionsList.map(value=>scope==='purchase'?option(value,value,row?.vendor):option(value.id,value.name,row?.expenseId)).join('')+'</select></label>'+
   '<label class="field">'+t('증빙 종류','Type')+'<select name="kind">'+options(scope==='purchase'?kindLabels:{invoice:kindLabels.invoice,receipt:kindLabels.receipt},row?.kind)+'</select></label>'+
   optional('number',t('증빙 번호 (선택)','Numéro (facultatif)'),row?.number)+
   '<label class="field">'+t('발행일','Date d’émission')+'<input name="date" type="date" required value="'+esc(row?.date)+'"></label>'+
   '<label class="field">'+t('금액 TTC (€)','Montant TTC (€)')+'<input name="amount" type="number" min="0.01" step="0.01" required value="'+(row?row.amountCents/100:'')+'"></label>'+
   '<label class="field">'+t('결제 상태','État du paiement')+'<select name="status">'+options(statusLabels,row?.paymentStatus||'paid')+'</select></label>'+
   '<label class="field">'+t('실제 지급액 (€)','Montant payé (€)')+'<input name="paid" type="number" min="0" step="0.01" value="'+(row?row.paidCents/100:'')+'"></label>'+
   '<label class="field">'+t('결제 방식 (선택)','Mode de paiement (facultatif)')+'<select name="method">'+options(methodLabels,row?.method||'')+'</select></label>'+
   optional('note',t('비고 (선택)','Note (facultative)'),row?.note,500)+
   (row?'<label class="field">'+t('수정 사유','Motif de modification')+'<input name="reason" maxlength="500" required></label>':'')+
   '<fieldset class="wide"><legend>'+t('증빙 파일','Fichiers')+'</legend>'+(row?.files||[]).map(file=>
   '<label><input type="checkbox" name="keep" value="'+file.id+'" checked> '+esc(file.name)+'</label><br>').join('')+
   '<input type="file" name="files" accept="application/pdf,image/jpeg,image/png" multiple></fieldset></form>',
   button(t('등록','Enregistrer'),'id="evidence-save"','primary')+button(t('취소','Annuler'),'data-action="close"'));
  const formNode=document.querySelector('#evidence-form');
  const uploaded=new WeakMap();
  const update=()=>{
   const fields=formNode.elements,partial=fields.status.value==='partial';
   fields.paid.readOnly=!partial;fields.paid.required=partial;
   if(!partial)fields.paid.value=fields.status.value==='paid'?fields.amount.value:'0';
  };
  if(scope==='expense'&&!row)formNode.elements.amount.value=optionsList[0].amountCents/100;
  formNode.addEventListener('input',event=>{
   if(scope==='expense'&&event.target.name==='target')formNode.elements.amount.value=optionsList.find(value=>value.id===event.target.value).amountCents/100;
   update();
  });update();
  document.querySelector('#evidence-save').addEventListener('click',ev=>{
   if(!formNode.reportValidity())return;
   const data=new FormData(formNode),files=[...formNode.elements.files.files],kept=data.getAll('keep').map(id=>row.files.find(file=>file.id===id));
   void run(ev.currentTarget,async()=>{
    if(!files.length&&!kept.length||files.length+kept.length>5)throw new Error(t('파일을 1~5개 선택해 주세요.','Sélectionnez entre un et cinq fichiers.'));
    for(const file of files)if(!uploaded.has(file))uploaded.set(file,await request('storeEvidence',{eventId:event,content:file}));
    const fields={eventId:event,id,revision:record.revision,scope,kind:data.get('kind'),date:data.get('date'),number:data.get('number'),
     vendor:scope==='purchase'?data.get('target'):'',expenseId:scope==='expense'?data.get('target'):'',method:data.get('method'),
     note:data.get('note'),reason:data.get('reason'),paymentStatus:data.get('status'),amountCents:Math.round(Number(data.get('amount'))*100),
     paidCents:Math.round(Number(data.get('paid'))*100),files:[...kept,...files.map(file=>uploaded.get(file))]};
    await request('saveEvidence',fields);close();await refresh();
   });
  });
 }
 function view(scope){
  const rows=entries.filter(row=>row.scope===scope);
  modal(t('증빙 목록','Justificatifs'),'',
   (rows.length?rows.map(row=>'<section class="panel pad"><h4>'+esc(scope==='purchase'?row.vendor:expenseName(row))+'</h4>'+
    '<p>'+esc(kindLabels[row.kind])+' · '+esc(row.date)+' · '+money((row.kind==='credit'?-1:1)*row.amountCents/100)+
    ' · '+esc(statusLabels[row.paymentStatus])+' · '+t('미지급','Reste à payer')+' '+money((row.amountCents-row.paidCents)/100)+'</p>'+
    '<p>'+esc([row.number,methodLabels[row.method],row.note].filter(Boolean).join(' · '))+'</p>'+
    row.files.map(file=>'<div class="modal-row"><span>'+esc(file.name)+'</span><div class="actions">'+
     button(t('미리보기','Aperçu'),'data-proof-view="'+file.id+'" data-proof-row="'+row.id+'"')+
     button(t('다운로드','Télécharger'),'data-proof-download="'+file.id+'" data-proof-row="'+row.id+'"')+'</div></div>').join('')+
    (frozen?'':'<div class="actions">'+button(t('수정','Modifier'),'data-proof-edit="'+row.id+'"')+
      button(t('등록 취소','Annuler l’enregistrement'),'data-proof-void="'+row.id+'"')+'</div>')+'</section>').join(''):
    '<p>'+t('등록된 증빙이 없습니다.','Aucun justificatif enregistré.')+'</p>'),
   (frozen?'':button(t('증빙 등록','Ajouter un justificatif'),'id="evidence-add"','primary'))+closeButton);
  document.querySelector('#evidence-add')?.addEventListener('click',ev=>void run(ev.currentTarget,()=>form(scope)));
  for(const el of document.querySelectorAll('[data-proof-edit]'))el.addEventListener('click',ev=>void run(ev.currentTarget,()=>form(scope,rows.find(row=>row.id===el.dataset.proofEdit))));
  for(const el of document.querySelectorAll('[data-proof-void]'))el.addEventListener('click',ev=>{
   const reason=prompt(t('증빙 등록 취소 사유','Motif de l’annulation'))?.trim();if(!reason)return;
   void run(ev.currentTarget,async()=>{await request('saveEvidence',{eventId:event,id:el.dataset.proofVoid,revision:record.revision,void:true,reason});close();await refresh();});
  });
  for(const el of document.querySelectorAll('[data-proof-row]'))el.addEventListener('click',ev=>void run(ev.currentTarget,async()=>{
   const row=rows.find(row=>row.id===el.dataset.proofRow),file=row.files.find(file=>file.id===(el.dataset.proofView||el.dataset.proofDownload));
   const blob=await requestFile(row,file);
   if(el.dataset.proofDownload){save(blob,file.name);return;}
   const url=URL.createObjectURL(blob);
   modal(file.name,'',file.mime==='application/pdf'?'<iframe title="'+esc(file.name)+'" src="'+url+'" sandbox style="width:100%;height:65vh"></iframe>':
    '<img alt="'+esc(file.name)+'" src="'+url+'" style="max-width:100%">',button(t('목록','Liste'),'id="evidence-return"')+closeButton);
   document.querySelector('#evidence-return').addEventListener('click',()=>{URL.revokeObjectURL(url);view(scope);});
  }));
 }
 async function exportAll(){
  const archive=XLSX.CFB.utils.cfb_new();
  const index=[['Scope','Reference','Name','Date','Amount EUR','Status','File']];
  for(const row of entries){
   for(const file of row.files){
    const folder=row.scope==='purchase'?'achats':'depenses';
    const path=folder+'/'+row.id+'/'+file.id+'-'+file.name;
    XLSX.CFB.utils.cfb_add(archive,path,new Uint8Array(await (await requestFile(row,file)).arrayBuffer()));
    index.push([folder,row.number,row.scope==='purchase'?row.vendor:expenseName(row),row.date,(row.kind==='credit'?-1:1)*row.amountCents/100,row.paymentStatus,path]);
   }
  }
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(index),'ASICC');
  XLSX.CFB.utils.cfb_add(archive,'index.xlsx',new Uint8Array(XLSX.write(book,{bookType:'xlsx',type:'array'})));
  save(new Blob([XLSX.CFB.write(archive,{fileType:'zip',type:'array'})],{type:'application/zip'}),'ASICC-justificatifs.zip');
 }
 return {view,exportAll,actual,
  panel:scope=>'<section class="panel pad"><h3>'+(scope==='purchase'?t('공급업체 매입 증빙','Justificatifs des achats'):t('기타 지출 증빙','Justificatifs des dépenses'))+'</h3>'+
   (scope==='purchase'?'<p>'+t('예상 매입비용','Achats prévus')+' '+money(expected)+' · '+t('증빙 기준 매입비용','Achats justifiés')+' '+money(actual/100)+
    ' · '+t('차액','Écart')+' '+money(actual/100-expected)+' · '+t('증빙 미등록 업체','Fournisseurs sans justificatif')+' '+missing.length+'</p>':'')+
   '<div class="actions">'+button(t('증빙 목록','Justificatifs'),'data-action="evidence-list" data-scope="'+scope+'"','primary')+
    (entries.length?button(t('행사 증빙 ZIP','Justificatifs ZIP'),'data-action="evidence-zip"'):'')+
    (scope==='purchase'&&!frozen?button(record.purchaseCostsConfirmedAt?t('매입비용 재확인','Reconfirmer les achats'):t('실제 매입비용 확정','Confirmer les achats réels'),'data-action="evidence-confirm"'):'')+'</div></section>'};
}
