import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {parse} from 'acorn';

const [livePath,oldPath,newPath]=process.argv.slice(2);
const [live,old,next]=[livePath,oldPath,newPath].map(p=>readFileSync(p,'utf8'));
const asts=[live,old,next].map(code=>parse(code,{ecmaVersion:'latest',sourceType:'module'}));
const [l,o,n]=asts;
const ignored=new Set(['start','end','loc','raw']);
const normalize=x=>JSON.stringify(x,(key,value)=>ignored.has(key)?undefined:value);
const eq=(a,b)=>normalize(a)===normalize(b);
const find=(tree,predicate)=>{
  const found=[];
  function visit(x){
    if(!x||typeof x!=='object')return;
    if(predicate(x))found.push(x);
    for(const [k,v] of Object.entries(x))if(!ignored.has(k)){
      if(Array.isArray(v))v.forEach(visit);else if(typeof v==='object')visit(v);
    }
  }
  visit(tree);return found;
};
function one(list,label){assert.equal(list.length,1,label+' must be unique');return list[0];}
function fn(tree,name){return one(tree.body.filter(x=>x.type==='FunctionDeclaration'&&x.id?.name===name),name)}
function variable(tree,name){return one(tree.body.filter(x=>x.type==='VariableDeclaration'&&x.declarations.length===1&&x.declarations[0].id?.name===name),name)}
function diffPath(a,b,path='$'){
  if(eq(a,b))return '';
  if(a==null||b==null||typeof a!=='object'||typeof b!=='object')
    return path+(path.endsWith('.name')&&typeof a==='string'&&typeof b==='string'?' ('+a+' vs '+b+')':'');
  if(Array.isArray(a)!==Array.isArray(b)||Array.isArray(a)&&a.length!==b.length)return path+' length/shape';
  for(const k of new Set([...Object.keys(a),...Object.keys(b)]))if(!ignored.has(k)&&!eq(a[k],b[k]))return diffPath(a[k],b[k],path+'.'+k);
  return path;
}
const edits=[];
// Diagnostics contain identifiers/route names only, never deployed source or values.
const summarize=tree=>{
  const vars=body=>body.flatMap(x=>x.type==='VariableDeclaration'?x.declarations.map(d=>d.id?.name||d.id?.type):[]);
  const body=fn(tree,'createMail').body.body;
  const ma=fn(tree,'createMailAdmin');
  const admin=ma.body.body.find(x=>x.type==='FunctionDeclaration'&&x.id?.name==='admin');
  return {mailVars:vars(body),adminVars:vars(ma.body.body),
    adminRoutes:admin?.body.body.filter(x=>x.type==='IfStatement').map(x=>x.test?.right?.value??x.test.type),
    mailMethods:body.find(x=>x.type==='ReturnStatement')?.argument?.properties?.map(p=>p.key?.name)};
};
console.log('Live email structure:',JSON.stringify(summarize(l)));
function replace(oldNode,newNode,liveNode,label){
  if(!eq(oldNode,liveNode))throw new Error('Live '+label+' differs from the tested baseline at '+diffPath(oldNode,liveNode)+'; stopped without deploying');
  edits.push({start:liveNode.start,end:liveNode.end,text:next.slice(newNode.start,newNode.end),label});
}
replace(fn(o,'manualStillEligible'),fn(n,'manualStillEligible'),fn(l,'manualStillEligible'),'manual eligibility');

function byExact(scope,node,label){return one(find(scope,x=>eq(x,node)),label+' exact live anchor');}
function appendArg(oldNode,newNode,liveNode,label){
  if(!eq(oldNode,liveNode))throw new Error(label+' old arguments differ');
  edits.push({start:liveNode.end-1,end:liveNode.end-1,text:', '+next.slice(newNode.arguments.at(-1).start,newNode.arguments.at(-1).end),label});
}
function appendParam(oldFn,newFn,liveFn,label){
  assert.ok(eq(oldFn.params,liveFn.params),label+' old parameters differ');
  assert.equal(newFn.params.length,oldFn.params.length+1);
  const at=liveFn.params.at(-1).end;
  edits.push({start:at,end:at,text:', '+next.slice(newFn.params.at(-1).start,newFn.params.at(-1).end),label});
}
function objReturn(scope,label){return one(scope.body.body.filter(x=>x.type==='ReturnStatement'&&x.argument?.type==='ObjectExpression'),label);}
function addedProps(oldObj,newObj,liveObj,label){
  const getKey=x=>x.key?.name??x.key?.value;
  const previous=new Set(oldObj.properties.map(getKey));
  const present=new Set(liveObj.properties.map(getKey));
  const added=newObj.properties.filter(x=>!previous.has(getKey(x)));
  assert.ok(added.length>0,label+' no new properties');
  for(const x of added)assert.ok(!present.has(getKey(x)),label+' property already present: '+getKey(x));
  edits.push({start:liveObj.start+1,end:liveObj.start+1,text:added.map(x=>next.slice(x.start,x.end)).join(',\n')+',\n',label});
}
const oldFormat=fn(o,'formatJob'),newFormat=fn(n,'formatJob'),liveFormat=fn(l,'formatJob');
appendParam(oldFormat,newFormat,liveFormat,'mail overview projection parameter');
assert.ok(eq(oldFormat.body.body[0],liveFormat.body.body[0]),'Mail overview record source differs');
addedProps(objReturn(oldFormat,'old overview return').argument,objReturn(newFormat,'new overview return').argument,objReturn(liveFormat,'live overview return').argument,'mail overview projection fields');

const oldFactory=fn(o,'createMailAdmin'),newFactory=fn(n,'createMailAdmin'),liveFactory=fn(l,'createMailAdmin');
assert.ok(eq(oldFactory.params,liveFactory.params),'Live mail admin factory parameters differ');
const factoryVariable=(f,name)=>one(f.body.body.flatMap(x=>x.type==='VariableDeclaration'?x.declarations:[]).filter(d=>d.id?.name===name),'factory binding '+name);
for(const [name,path] of Object.entries({outbox:'bazaarOutbox',orders:'bazaarOrders',policies:'bazaarMailPolicies'})){
  const binding=factoryVariable(liveFactory,name);
  assert.ok(binding.init?.type==='CallExpression'&&binding.init.callee?.object?.name==='db'&&binding.init.callee?.property?.name==='collection'&&binding.init.arguments[0]?.value===path,'Live collection binding differs: '+name);
}
const eventBinding=factoryVariable(liveFactory,'eventRef');
assert.ok(find(eventBinding,x=>x.type==='TemplateElement'&&x.value?.cooked?.startsWith('bazaarEventProjects/')||x.type==='Literal'&&String(x.value).startsWith('bazaarEventProjects/')).length===1,'Live event binding differs');
const adminFn=f=>one(f.body.body.filter(x=>x.type==='FunctionDeclaration'&&x.id?.name==='admin'),'mail admin method');
const oa=adminFn(oldFactory),na=adminFn(newFactory),la=adminFn(liveFactory);
appendParam(oa,na,la,'mail admin immediate send parameter');
function route(admin,name){
  return one(admin.body.body.filter(x=>x.type==='IfStatement'&&x.test.type==='BinaryExpression'&&x.test.operator==='==='&&x.test.left.name==='op'&&x.test.right.value===name),name+' route');
}
const [oldStatus,newStatus,liveStatus]=[oa,na,la].map(a=>route(a,'mailStatus'));
const ret=x=>one(x.consequent.body.filter(s=>s.type==='ReturnStatement'&&s.argument.type==='ObjectExpression'),'mail status return');
const oldStatusReturn=ret(oldStatus),newStatusReturn=ret(newStatus),liveStatusReturn=ret(liveStatus);
const oldStatusNames=['messages','review','entry'];
// The status route's reads must still use the same data sources, prior to optional new lookup.
for(const statement of oldStatus.consequent.body.filter(x=>x.type==='VariableDeclaration')){
  byExact(liveStatus.consequent,statement,'mail status prerequisites');
}
const newStatusExtras=newStatus.consequent.body.filter(x=>x.type!=='ReturnStatement'&&!oldStatus.consequent.body.some(y=>eq(x,y)));
assert.equal(newStatusExtras.length,2,'mail status extra statements');
edits.push({start:liveStatusReturn.start,end:liveStatusReturn.start,text:newStatusExtras.map(x=>next.slice(x.start,x.end)).join('\n')+'\n',label:'optional manual send choices'});
addedProps(oldStatusReturn.argument,newStatusReturn.argument,liveStatusReturn.argument,'manual send choices result field');

const newCheck=route(na,'mailCheckDelivery'),newSingle=route(na,'mailSingleSend');
const policyDecl=one(oa.body.body.filter(x=>x.type==='VariableDeclaration'&&x.declarations.some(d=>d.id?.name==='policyRef')),'policy declaration');
const livePolicy=byExact(la,policyDecl,'event-scoped policy declaration');
assert.ok(!la.body.body.some(x=>x.type==='IfStatement'&&['mailCheckDelivery','mailSingleSend'].includes(x.test?.right?.value)),'New email route already exists');
edits.push({start:livePolicy.end,end:livePolicy.end,text:'\n'+[newCheck,newSingle].map(x=>next.slice(x.start,x.end)).join('\n'),label:'manual send and delivery lookup routes'});
const formatCall=routeNode=>one(find(routeNode,x=>x.type==='CallExpression'&&x.callee.name==='formatJob'),'mail overview format call');
appendArg(formatCall(route(oa,'mailOverview')),formatCall(route(na,'mailOverview')),formatCall(route(la,'mailOverview')),'mail overview includes delivery status');

const oldAction=route(oa,'mailJobAction'),liveAction=route(la,'mailJobAction');
assert.ok(eq(oldAction.test,liveAction.test),'Existing email action route differs');
const immediate=one(na.body.body.filter(x=>x.type==='IfStatement'&&x.test.type==='LogicalExpression'&&x.test.left?.left?.name==='op'&&x.test.left?.right?.value==='mailJobAction'),'immediate action route');
edits.push({start:liveAction.start,end:liveAction.start,text:next.slice(immediate.start,immediate.end)+'\n',label:'immediate dispatch route'});
const queueBranch=a=>one(find(a,x=>x.type==='IfStatement'&&x.test.type==='LogicalExpression'&&find(x.test,y=>y.type==='Identifier'&&y.name==='queueManual').length>0&&find(x.test,y=>y.type==='Literal'&&y.value==='manualReserved').length>0&&find(x.test,y=>y.type==='UnaryExpression'&&y.argument?.name==='queueManual').length===0),'manual queue branch');
const oldQueue=queueBranch(oa),newQueue=queueBranch(na),liveQueue=queueBranch(la);
const pushCall=branch=>one(find(branch.consequent,x=>x.type==='CallExpression'&&x.callee.object?.name==='recipients'&&x.callee.property?.name==='push'),'prepared recipients output');
replace(pushCall(oldQueue),pushCall(newQueue),pushCall(liveQueue),'return selected queue job id');
// Production has independent operational mail changes. Patch only the exact
// expression nodes changed by the verified feature, not the entire mail factory.
const oldMail=fn(o,'createMail'),newMail=fn(n,'createMail'),liveMail=fn(l,'createMail');
assert.ok(eq(oldMail.params,liveMail.params),'Mail factory parameters differ');
function expr(source){return parse('('+source+')',{ecmaVersion:'latest',sourceType:'module'}).body[0].expression;}
function replaceExpr(before,after,label){
  const a=expr(before),b=expr(after);
  const scope=tree=>one(find(tree,x=>x.type==='FunctionDeclaration'&&x.id?.name==='deliver'),'deliver method');
  const oldNode=one(find(scope(oldMail),x=>eq(x,a)),label+' baseline');
  const newNode=one(find(scope(newMail),x=>eq(x,b)),label+' release');
  const candidates=find(scope(liveMail),x=>eq(x,a));
  if(candidates.length!==1)throw new Error(label+' exact expression not unique in live mail delivery; no update');
  replace(oldNode,newNode,candidates[0],label);
}
replaceExpr('!order?.email || !autoMailAllowed(policy, job2, order)',
  '!order?.email || (job2.explicitDirect && job2.expectedEmail !== order.email) || !autoMailAllowed(policy, job2, order)','recipient check on lease');
replaceExpr('!order || !autoMailAllowed(policy.data(), job, order)',
  '!order || (job.explicitDirect && job.expectedEmail !== order.email) || !autoMailAllowed(policy.data(), job, order)','recipient check before provider');
replaceExpr('job.type === "reminderFinal" ? tx.get(db.doc(`bazaarOrders/${job.orderId}`)) : null',
  'job.type === "reminderFinal" && !job.explicitDirect ? tx.get(db.doc(`bazaarOrders/${job.orderId}`)) : null','explicit reminder does not change order record');
const returnNode=mail=>one(mail.body.body.filter(x=>x.type==='ReturnStatement'&&x.argument?.type==='ObjectExpression'),'mail factory return');
const prop=(ret,name)=>one(ret.argument.properties.filter(x=>x.type==='Property'&&x.key?.name===name),name+' return property');
const oldReturn=returnNode(oldMail),newReturn=returnNode(newMail),liveReturn=returnNode(liveMail);
const statusObject=method=>one(find(method,x=>x.type==='ReturnStatement'&&x.argument?.type==='ObjectExpression'&&x.argument.properties.some(p=>p.key?.name==='id')),'order status row').argument;
addedProps(statusObject(prop(oldReturn,'status')),statusObject(prop(newReturn,'status')),statusObject(prop(liveReturn,'status')),'order mail status fields');
const oldVars=new Map(oldMail.body.body.flatMap(x=>x.type==='VariableDeclaration'?x.declarations.map(d=>[d.id?.name,d]):[]));
const liveVars=new Map(liveMail.body.body.flatMap(x=>x.type==='VariableDeclaration'?x.declarations.map(d=>[d.id?.name,d]):[]));
const newVars=new Map(newMail.body.body.flatMap(x=>x.type==='VariableDeclaration'?x.declarations.map(d=>[d.id?.name,x]):[]));
for(const name of ['provider','isCapture','key','directTestMail','approvedRecipient','testRecipient']){
  assert.ok(liveVars.has(name),'Missing live delivery lookup dependency: '+name);
  assert.ok(oldVars.has(name),'Missing baseline dependency: '+name);
}
// These helpers already participate in the live provider/lease checks. Preserve
// their production-specific implementations, using the existing callable bindings.
for(const name of ['isTestAddress','iso']){
  const declaration=variable(l,name).declarations[0];
  const init=declaration.init;
  const callable=x=>['ArrowFunctionExpression','FunctionExpression'].includes(x?.type);
  assert.ok(callable(init)||(init?.type==='CallExpression'&&init.callee?.name==='__name'&&callable(init.arguments[0])&&init.arguments[1]?.value===name),'Live helper not callable: '+name+' ('+init?.type+', '+(init?.callee?.name||'no wrapper')+')');
  assert.ok(find(liveMail,x=>x.type==='CallExpression'&&x.callee?.name===name).length>0,'Live mail does not use helper: '+name);
}
const hashImport=one(l.body.filter(x=>x.type==='ImportDeclaration'&&x.source.value==='node:crypto'&&x.specifiers.some(s=>s.imported?.name==='createHash'&&s.local?.name==='createHash2')),'existing hash import');

assert.ok(!liveVars.has('canCheckDelivery')&&!liveMail.body.body.some(x=>x.type==='FunctionDeclaration'&&x.id?.name==='checkDelivery'),'Delivery helper already exists');
const lookupDeclaration=newVars.get('canCheckDelivery');
const lookupFn=one(newMail.body.body.filter(x=>x.type==='FunctionDeclaration'&&x.id?.name==='checkDelivery'),'delivery lookup method');
edits.push({start:liveReturn.start,end:liveReturn.start,text:[lookupDeclaration,lookupFn].map(x=>next.slice(x.start,x.end)).join('\n')+'\n',label:'delivery lookup helpers'});
assert.ok(!liveReturn.argument.properties.some(x=>['canCheckDelivery','checkDelivery'].includes(x.key?.name)),'Delivery return keys already exist');
edits.push({start:liveReturn.argument.start+1,end:liveReturn.argument.start+1,text:'canCheckDelivery, checkDelivery,',label:'enable delivery lookup'});
const helperNames=['transactionKinds','storedType','directEligible'];
for(const name of helperNames){
  const hits=l.body.filter(x=>x.type==='FunctionDeclaration'&&x.id?.name===name||x.type==='VariableDeclaration'&&x.declarations.some(d=>d.id?.name===name));
  assert.equal(hits.length,0,'helper name already in live bundle: '+name);
}
const newHelpers=[variable(n,'transactionKinds'),variable(n,'storedType'),fn(n,'directEligible')];
edits.push({start:liveFactory.start,end:liveFactory.start,text:newHelpers.map(x=>next.slice(x.start,x.end)).join('\n')+'\n',label:'new email helper functions'});
function mailCall(root){
  const svc=fn(root,'createBazaar');
  return one(find(svc,x=>x.type==='CallExpression'&&x.callee.type==='Identifier'&&x.callee.name==='mailAdmin'),'email admin dispatch');
}
const oldCall=mailCall(o),newCall=mailCall(n),liveCall=mailCall(l);
assert.equal(oldCall.arguments.length,3);assert.equal(newCall.arguments.length,4);
assert.equal(newCall.arguments[3].name,'message');
const liveRenderer=one(find(fn(l,'createBazaar'),x=>x.type==='FunctionDeclaration'&&x.id?.name==='message'),'message renderer');
const oldRenderer=one(find(fn(o,'createBazaar'),x=>x.type==='FunctionDeclaration'&&x.id?.name==='message'),'baseline message renderer');
assert.ok(eq(liveRenderer.params,oldRenderer.params),'Live message renderer signature differs; stopped without deploying');
replace(oldCall,newCall,liveCall,'email admin dispatch');
// Disjoint source ranges, all unrelated byte sequences must stay exactly as deployed.
edits.sort((a,b)=>a.start-b.start);
let cursor=0,result='';
for(const e of edits){assert.ok(e.start>=cursor,'overlapping edit');result+=live.slice(cursor,e.start)+e.text;cursor=e.end;}
result+=live.slice(cursor);
const out=parse(result,{ecmaVersion:'latest',sourceType:'module'});
for(const name of ['manualStillEligible','directEligible'])assert.ok(eq(fn(out,name),fn(n,name)),name+' result mismatch');
const patchedAdmin=adminFn(fn(out,'createMailAdmin'));
for(const name of ['mailCheckDelivery','mailSingleSend'])assert.ok(eq(route(patchedAdmin,name),route(na,name)),name+' result mismatch');
for(const name of ['canCheckDelivery','checkDelivery'])assert.ok(eq(prop(returnNode(fn(out,'createMail')),name),prop(newReturn,name)),name+' result mismatch');
for(const name of ['transactionKinds','storedType'])assert.ok(eq(variable(out,name),variable(n,name)),name+' result mismatch');
assert.ok(eq(mailCall(out),newCall),'dispatch result mismatch');
assert.notEqual(live,result);
writeFileSync(livePath,result);
console.log('Verified exact email function and expression anchors; preserved unrelated live mail behavior, bindings, and all other script bytes.');
