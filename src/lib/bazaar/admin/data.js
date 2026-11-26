import {validPickupEnd} from '../../../../firebase-functions-bazaar/bazaar/payment-window.mjs';
const storageLabels = {ambient:'상온', chilled:'냉장', frozen:'냉동'};
const storageValues = Object.fromEntries(Object.entries(storageLabels).map(([key,value])=>[value,key]));
const paris = new Intl.DateTimeFormat('sv-SE',{
  timeZone:'Europe/Paris', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', hourCycle:'h23',
});
const local = value => value ? paris.format(new Date(value)).replace(' ','T') : '';
export function parisToIso(value) {
  if (!value) return '';
  const time = Date.parse(value+'Z');
  const candidates = [1,2].map(offset=>new Date(time-offset*3600000)).filter(date=>local(date)===value);
  if (candidates.length!==1) throw new Error('프랑스 현지시간으로 확정할 수 없는 시각입니다. 다른 시각을 선택하세요.');
  return candidates[0].toISOString();
}
export function eventFormFields(value){
 const time=id=>{
  const date=value(id+'-date'),hour=value(id+'-time');
  if(!date&&!hour)return '';
  if(!date||!hour)throw new Error('날짜와 시간을 모두 입력해 주세요. / Saisissez la date et l’heure.');
  return parisToIso(date+'T'+hour);
 };
 const pickupAt=time('event-pickup');
 const end=value('event-pickup-end-time');
 if(end&&!pickupAt)throw new Error('수령 시작 날짜와 시간을 입력해 주세요. / Saisissez la date et l’heure de début du retrait.');
 const pickupEndAt=end?parisToIso(value('event-pickup-date')+'T'+end):'';
 if(!validPickupEnd(pickupAt,pickupEndAt))throw new Error('수령 종료 시간은 시작 시간보다 늦어야 합니다. / L’heure de fin doit être postérieure à l’heure de début.');
 return {
  paymentHours:value('event-payment-hours'),
  orderStartsAt:time('event-opening'),orderCutoff:time('event-order'),
  transferCutoff:time('event-transfer'),pickupAt,pickupEndAt,
  pickupPlace:value('event-pickup-place').trim(),nameKo:value('event-name').trim(),
  nameFr:value('event-name-fr').trim(),introKo:value('event-intro-ko'),introFr:value('event-intro-fr'),
  pickupKo:value('event-pickup-ko'),pickupFr:value('event-pickup-fr'),
  beneficiary:value('event-beneficiary'),iban:value('event-iban'),
 };
}
export function productViewModel(p) {
  return {
    id:p.id, saved:true, soldQty:Number.isSafeInteger(p.soldQty)?p.soldQty:null, hasOrderHistory:p.hasOrderHistory===true, ko:p.titleKo, fr:p.titleFr, koDesc:p.descriptionKo, frDesc:p.descriptionFr,
    vendor:p.supplier, photo:p.imageUrl||'', photoPath:p.photoPath||'', emoji:'📦',
    buy:p.boxPriceTtcCents==null?'':p.boxPriceTtcCents/100, originalBuy:p.boxPriceTtcCents/100, boxHt:p.boxPriceHtCents??null,
    sale:p.retailCents==null?'':p.retailCents/100, pack:p.packQty??'',
    storage:storageLabels[p.storage]||p.storage,
    boxes:p.plannedBoxes??'', limitMode:p.limitMode==='box'?'auto':p.limitMode||'unlimited',
    manualLimit:p.manualLimit??'', active:p.included??(p.visible&&!p.archivedAt),
    stopped:p.included===undefined&&!p.visible&&(!p.archivedAt||p.hasOrderHistory===true),
  };
}
export function productPayload(p) {
  return {
    id:p.id, titleKo:p.ko, titleFr:p.fr, descriptionKo:p.koDesc, descriptionFr:p.frDesc,
    supplier:p.vendor, imageUrl:p.photo, photoPath:p.photoPath, packQty:p.pack===''?null:Number(p.pack),
    storage:storageValues[p.storage]||p.storage||'',
    boxPriceTtcCents:p.buy===''?null:Math.round(p.buy*100), boxPriceHtCents:p.buy===p.originalBuy?p.boxHt:null,
    retailCents:p.sale===''?null:Math.round(p.sale*100), plannedBoxes:p.boxes===''?null:Number(p.boxes),
    manualLimit:p.manualLimit===''?null:Number(p.manualLimit), limitMode:p.limitMode==='auto'?'box':p.limitMode,
    included:p.active, visible:p.active,
  };
}
export function eventViewModel(event, items=[], orders=[], financialFinalizedAt=null) {
  const products = items.map(productViewModel);
  return {
    id:event.eventId, name:event.nameKo, round:event.serial, raw:event, products, financialFinalizedAt,
    status:event.status==='published'?'active':event.status==='closed'?'past':'draft',
    orderDeadline:local(event.orderCutoff), transferDeadline:local(event.transferCutoff),
    pickupKo:event.pickupKo, pickupFr:event.pickupFr,
    orders:orders.map(order=>({
      id:order.id, ref:order.orderRef, name:order.name, email:order.email, phone:order.phone,
      lang:order.lang,payment:order.payment,transferReportSource:order.transferReportSource,originalItems:order.originalItems||order.items,
      canceledItems:[...(order.canceledItems||[]),...(order.canceledAt?order.items:[])],
      priceAdjustmentCents:order.priceAdjustmentCents||0, bankConfirmedAt:order.bankConfirmedAt, hasRefundRecords:order.reservedRefundCents!==undefined,
      source:order.source||'web', parentOrderRef:order.parentOrderRef||'', revision:order.revision??0,
      paymentDeadline:order.paymentDeadline||order.eventSnapshot?.transferCutoff||'',memo:order.pickupNote||'', createdAt:order.createdAt,date:local(order.createdAt).replace('T',' '),
      reportedAt:local(order.transferReportedAt).replace('T',' '),
      verifiedAt:local(order.bankConfirmedAt).replace('T',' '),
      status:order.canceledAt?'canceled':order.bankConfirmedAt?(order.payment?.additionalDue>0?'partial':'confirmed'):order.transferReportedAt?'reported':'unpaid',
      items:order.items.map(item=>[item.titleKo,item.qty,item.priceCents/100,item.id,item]),
    })),
    poDrafts:Object.create(null), poMeta:Object.create(null),
  };
}

export function productOrderSummary(products=[], orders=[]) {
  const rows=new Map();
  for(const product of products){
    const key=product.id||`legacy:${product.ko||product.fr||''}`;
    rows.set(key,{id:key,ko:product.ko||'',fr:product.fr||'',photo:product.photo||'',price:product.sale===''?null:Number(product.sale)||0,qty:0,initialQty:0,canceledQty:0,amountCents:0,orders:[]});
  }
  const countHistory=(item,field)=>{
    const key=item.id||'legacy:'+(item.titleKo||'');
    const row=rows.get(key)||{id:key,ko:item.titleKo||'',fr:item.titleFr||'',photo:item.imageUrl||'',price:null,
      qty:0,initialQty:0,canceledQty:0,amountCents:0,orders:[]};
    row[field]+=item.qty;
    rows.set(key,row);
  };
  for(const order of orders){
    for(const item of order.originalItems||[])countHistory(item,'initialQty');
    for(const item of order.canceledItems||[])countHistory(item,'canceledQty');
    if(order.status==='canceled')continue;
    for(const item of order.items||[]){
      const key=item[3]||`legacy:${item[0]||''}`;
      const row=rows.get(key)||{id:key,ko:item[0]||'',fr:item[4]?.titleFr||'',photo:item[4]?.imageUrl||'',price:null,qty:0,initialQty:0,canceledQty:0,amountCents:0,orders:[]};
      const qty=Math.max(0,Number(item[1])||0),priceCents=Math.max(0,Math.round((Number(item[2])||0)*100));
      row.qty+=qty;row.amountCents+=qty*priceCents;
      row.orders.push({id:order.id,ref:order.ref,name:order.name,email:order.email,qty,amountCents:qty*priceCents});
      rows.set(key,row);
    }
  }
  return [...rows.values()];
}

/** Current accepted-order figures, using the saved order cost snapshot when present.
 * Estimated gross margin is for sold units only, before other expenses. */
export function orderIntakeSummary(orders=[], products=[]){
 const byId=new Map(products.map(product=>[product.id,product]));
 let orderCount=0,canceledCount=0,salesCents=0,costCents=0,missingCosts=0;
 const validCost=(pack,box)=>Number.isSafeInteger(pack)&&pack>0&&Number.isSafeInteger(box)&&box>=0;
 for(const order of orders){
  if(order.status==='canceled'){canceledCount++;continue;}
  orderCount++;
  const items=order.items||[];
  const due=order.payment?.due;
  salesCents+=Number.isSafeInteger(due)&&due>=0?due:items.reduce((sum,item)=>sum+Math.round(Number(item[2])*100)*Number(item[1]),0);
  for(const item of items){
   const quantity=Number(item[1]);
   if(!Number.isSafeInteger(quantity)||quantity<=0)continue;
   const snapshot=item[4],product=byId.get(item[3]);
   let pack=snapshot?.packQty,box=snapshot?.boxPriceTtcCents;
   if(!validCost(pack,box)){
    pack=Number(product?.pack);
    box=product?.buy===''||product?.buy==null?null:Math.round(Number(product.buy)*100);
   }
   if(!validCost(pack,box)){missingCosts++;continue;}
   costCents+=quantity*box/pack;
  }
 }
 const estimatedCostCents=missingCosts?null:Math.round(costCents);
 return {orderCount,canceledCount,salesCents,estimatedCostCents,
  estimatedGrossCents:estimatedCostCents==null?null:salesCents-estimatedCostCents,missingCosts};
}

export function estimateEvent(products,expenses=[]){
 const amount=value=>value!==''&&value!=null&&Number.isFinite(Number(value))?Number(value):null;
 const rows=products.filter(p=>p.active).map(p=>{
  const pack=amount(p.pack),boxes=amount(p.boxes),cost=amount(p.buy),price=amount(p.sale);
  const units=pack==null||boxes==null?null:pack*boxes;
  const limit=p.limitMode==='auto'?units:p.limitMode==='manual'?amount(p.manualLimit):null;
  const buy=boxes==null||cost==null?null:boxes*cost;
  const sales=limit==null||price==null?null:limit*price;
  const gross=sales==null||cost==null||!pack?null:sales-limit*(cost/pack);
  return {p,pack,boxes,cost,limit,buy,sales,gross,short:limit!=null&&units!=null&&limit>units};
 });
 const sum=key=>rows.some(row=>row[key]==null)?null:rows.reduce((total,row)=>total+row[key],0);
 const other=expenses.reduce((total,row)=>total+row.amountCents,0)/100;
 const buy=sum('buy'),sales=sum('sales'),gross=sum('gross');
 const net=buy==null||sales==null?null:sales-buy-other;
 return {rows,buy,sales,gross,other,net,margin:net!=null&&sales>0?net/sales:null};
}

export function validManualPhone(value){
 const phone=value.trim();
 return phone.length<=40&&/^[+0-9().\s-]+$/.test(phone)&&phone.replace(/[^0-9]/g,'').length>=8;
}
