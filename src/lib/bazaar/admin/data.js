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
    id:p.id, saved:true, cartonConfirmed:p.cartonConfirmed===true, proposedBoxes:Number.isSafeInteger(p.proposedBoxes)?p.proposedBoxes:null, soldQty:Number.isSafeInteger(p.soldQty)?p.soldQty:null, hasOrderHistory:p.hasOrderHistory===true, ko:p.titleKo, fr:p.titleFr, koDesc:p.descriptionKo, frDesc:p.descriptionFr,
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


/** Estimate whole-carton procurement from active order quantities, without modifying orders.
 * Different supplier/pack snapshots must be ordered separately; different prices alone do not split cartons. */
function cartonPlan(product,groups,qty){
 const packValue=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
 const groupList=[...(groups?.values()||[])];
 const packSizes=[...new Set(groupList.map(g=>g.pack).filter(Boolean))].sort((a,b)=>a-b);
 if(!groupList.length&&packValue(product?.pack))packSizes.push(packValue(product.pack));
 const suppliers=[...new Set(groupList.map(g=>g.supplier).filter(Boolean))];
 if(!suppliers.length&&product?.vendor)suppliers.push(product.vendor);
 const known=groupList.every(g=>g.pack!=null);
 const boxes=known?groupList.reduce((n,g)=>n+Math.ceil(g.qty/g.pack),0):null;
 const purchaseQty=known?groupList.reduce((n,g)=>n+Math.ceil(g.qty/g.pack)*g.pack,0):null;
 return {packSizes,suppliers,boxes,purchaseQty,remainingQty:purchaseQty==null?null:purchaseQty-qty};
}

export function productOrderSummary(products=[], orders=[], usePlanned=false) {
  const rows=new Map(),cartonGroups=new Map(),productById=new Map(products.map(p=>[p.id||'legacy:'+(p.ko||p.fr||''),p]));
  const validPack=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
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
      if(qty>0){
        const product=productById.get(key),snapshot=item[4];
        const pack=validPack(snapshot?.packQty)??validPack(product?.pack);
        const supplier=snapshot?.supplier||product?.vendor||'';
        const groups=cartonGroups.get(key)||new Map(),groupKey=JSON.stringify([supplier,pack]);
        const group=groups.get(groupKey)||{supplier,pack,qty:0};
        group.qty+=qty;groups.set(groupKey,group);cartonGroups.set(key,groups);
      }
      row.orders.push({id:order.id,ref:order.ref,name:order.name,email:order.email,qty,amountCents:qty*priceCents});
      rows.set(key,row);
    }
  }
  return [...rows.values()].map(row=>{
    const product=productById.get(row.id),plan=cartonPlan(product,cartonGroups.get(row.id),row.qty);
    const compatible=product&&plan.packSizes.length===1&&plan.packSizes[0]===Number(product.pack)&&plan.suppliers.length<=1&&(!plan.suppliers.length||plan.suppliers[0]===product.vendor);
    if((usePlanned&&compatible&&product.boxes!==''&&product.boxes!=null)||(!usePlanned&&product?.cartonConfirmed===true&&product.limitMode==='auto')){
      const boxes=Number(product.boxes),pack=Number(product.pack);
      if(Number.isSafeInteger(boxes)&&boxes>=0&&Number.isSafeInteger(pack)&&pack>0){
        const purchaseQty=boxes*pack;
        return {...row,...plan,boxes,purchaseQty,remainingQty:purchaseQty-row.qty,cartonConfirmed:!usePlanned&&product.cartonConfirmed===true};
      }
    }
    return {...row,...plan};
  });
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

/** Procurement forecast: confirmed cartons are physical purchase plans, independent of payment scope.
 * Existing unconfirmed historical supplier/pack/cost grouping remains unchanged. */
export function purchaseDemandRows(products=[],orders=[]){
 const byId=new Map(products.map(p=>[p.id,p])),records=new Map();
 const key=(id,vendor,pack,buy)=>[id,vendor==='K커머셜'?'k':vendor==='누리커넥트'?'n':'u',pack,buy].join('-');
 const confirmed=p=>p?.cartonConfirmed===true&&p.limitMode==='auto'&&Number.isSafeInteger(Number(p.boxes))&&Number(p.boxes)>=0&&Number.isSafeInteger(Number(p.pack))&&Number(p.pack)>0;
 for(const p of products.filter(confirmed)){
  const vendor=p.vendor||'공급업체 미지정',pack=Number(p.pack),buy=Math.round(Number(p.buy)*100);
  const id=key(p.id,vendor,pack,buy);
  records.set(id,{id,ko:p.ko,vendor,pack,buy:buy/100,ordered:0,revenue:0,minimum:Number(p.boxes),cartonConfirmed:true});
 }
 for(const order of orders)for(const item of order.items||[]){
  const snapshot=item[4],p=byId.get(item[3]),fixed=confirmed(p);
  const vendor=(fixed?p.vendor:snapshot?.supplier||p?.vendor)||'공급업체 미지정';
  const pack=fixed?Number(p.pack):snapshot?.packQty??p?.pack??0;
  const buy=fixed?Math.round(Number(p.buy)*100):snapshot?.boxPriceTtcCents??Math.round((p?.buy??0)*100);
  const id=key(item[3],vendor,pack,buy);
  const row=records.get(id)||{id,ko:item[0],vendor,pack,buy:buy/100,ordered:0,revenue:0};
  row.ordered+=item[1];
  row.revenue=Math.round((row.revenue+item[1]*item[2])*100)/100;
  records.set(id,row);
 }
 return [...records.values()].map(p=>({...p,minimum:p.cartonConfirmed?p.minimum:p.pack>0?Math.ceil(p.ordered/p.pack):0}));
}

/** Product sales are independent of editable supplier purchase orders.
 * Split historical supplier/pack/cost versions rather than overwrite saved snapshots. */
export function productSalesReport(products=[],orders=[],scope='all'){
 const byId=new Map(products.map(p=>[p.id,p])),rows=new Map(),soldIds=new Set();
 const selected=orders.filter(o=>scope==='confirmed'?o.status==='confirmed':o.status!=='canceled');
 const positiveInt=n=>Number.isSafeInteger(n)&&n>0;
 const validPrice=n=>Number.isSafeInteger(n)&&n>=0;
 const basis=(product,snapshot)=>{
  const pack=snapshot?.packQty,box=snapshot?.boxPriceTtcCents;
  const fallbackPack=Number(product?.pack);
  const fallbackBox=product?.buy===''||product?.buy==null?null:Math.round(Number(product.buy)*100);
  const useSnapshot=positiveInt(pack)&&validPrice(box);
  return {vendor:snapshot?.supplier||product?.vendor||'',pack:useSnapshot?pack:positiveInt(fallbackPack)?fallbackPack:null,
   boxCents:useSnapshot?box:validPrice(fallbackBox)?fallbackBox:null};
 };
 let dueCents=0;
 for(const order of selected){
  let subtotal=0;
  for(const item of order.items||[]){
   const qty=Number(item[1]),price=Math.round(Number(item[2])*100);
   if(!positiveInt(qty)||!validPrice(price))continue;
   const id=item[3]||'legacy:'+(item[0]||''),p=byId.get(id),snap=item[4],b=basis(p,snap);
   const key=JSON.stringify([id,b.vendor,b.pack,b.boxCents]);
   const r=rows.get(key)||{id,ko:item[0]||p?.ko||'',fr:snap?.titleFr||p?.fr||'',...b,qty:0,revenueCents:0};
   r.qty+=qty;r.revenueCents+=qty*price;subtotal+=qty*price;
   rows.set(key,r);soldIds.add(id);
  }
  dueCents+=validPrice(order.payment?.due)?order.payment.due:subtotal;
 }
 for(const p of products){
  if(soldIds.has(p.id))continue;
  const b=basis(p,null),id=p.id||'legacy:'+(p.ko||p.fr||'');
  rows.set(JSON.stringify([id,b.vendor,b.pack,b.boxCents]),{id,ko:p.ko||'',fr:p.fr||'',...b,qty:0,revenueCents:0});
 }
 const result=[...rows.values()].map(r=>{
  const known=positiveInt(r.pack)&&validPrice(r.boxCents);
  const boxes=r.qty===0?0:positiveInt(r.pack)?Math.ceil(r.qty/r.pack):null;
  const remaining=boxes==null?null:r.qty===0?0:boxes*r.pack-r.qty;
  const soldCostCents=r.qty===0?0:known?Math.round(r.qty*r.boxCents/r.pack):null;
  const purchaseCents=r.qty===0?0:known?boxes*r.boxCents:null;
  const remainingCostCents=purchaseCents==null?null:purchaseCents-soldCostCents;
  const grossCents=soldCostCents==null?null:r.revenueCents-soldCostCents;
  return {...r,boxes,remaining,soldCostCents,purchaseCents,remainingCostCents,grossCents};
 });
 const sum=(list,field)=>list.some(r=>r[field]==null)?null:list.reduce((n,r)=>n+r[field],0);
 const total=list=>Object.fromEntries(['qty','revenueCents','boxes','remaining','soldCostCents','purchaseCents','remainingCostCents','grossCents'].map(field=>[field,sum(list,field)]));
 const totals=total(result);
 const groups=[...new Set(result.map(r=>r.vendor))].map(vendor=>{
  const items=result.filter(r=>r.vendor===vendor);return {vendor,rows:items,totals:total(items)};
 });
 return {rows:result,groups,totals,orderCount:selected.length,dueCents,adjustmentCents:dueCents-totals.revenueCents};
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
