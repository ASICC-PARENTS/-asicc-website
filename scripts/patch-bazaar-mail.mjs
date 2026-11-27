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
function replace(oldNode,newNode,liveNode,label){
  if(!eq(oldNode,liveNode))throw new Error('Live '+label+' differs from the tested baseline at '+diffPath(oldNode,liveNode)+'; stopped without deploying');
  edits.push({start:liveNode.start,end:liveNode.end,text:next.slice(newNode.start,newNode.end),label});
}
for(const name of ['manualStillEligible','createMail','formatJob','createMailAdmin']){
  replace(fn(o,name),fn(n,name),fn(l,name),name);
}
const helperNames=['transactionKinds','storedType','directEligible'];
for(const name of helperNames){
  const hits=l.body.filter(x=>x.type==='FunctionDeclaration'&&x.id?.name===name||x.type==='VariableDeclaration'&&x.declarations.some(d=>d.id?.name===name));
  assert.equal(hits.length,0,'helper name already in live bundle: '+name);
}
const newHelpers=[variable(n,'transactionKinds'),variable(n,'storedType'),fn(n,'directEligible')];
const mainEdit=edits.find(e=>e.label==='createMailAdmin');
mainEdit.text=newHelpers.map(x=>next.slice(x.start,x.end)).join('\n')+'\n'+mainEdit.text;
function mailCall(root){
  const svc=fn(root,'createBazaar');
  return one(find(svc,x=>x.type==='CallExpression'&&x.callee.type==='Identifier'&&x.callee.name==='mailAdmin'),'email admin dispatch');
}
const oldCall=mailCall(o),newCall=mailCall(n),liveCall=mailCall(l);
assert.equal(oldCall.arguments.length,3);assert.equal(newCall.arguments.length,4);
assert.equal(newCall.arguments[3].name,'message');
const liveRenderer=one(find(fn(l,'createBazaar'),x=>x.type==='FunctionDeclaration'&&x.id?.name==='message'),'message renderer');
const oldRenderer=one(find(fn(o,'createBazaar'),x=>x.type==='FunctionDeclaration'&&x.id?.name==='message'),'baseline message renderer');
assert.ok(eq(liveRenderer,oldRenderer),'Live message renderer differs; stopped without deploying');
replace(oldCall,newCall,liveCall,'email admin dispatch');
// Disjoint source ranges, all unrelated byte sequences must stay exactly as deployed.
edits.sort((a,b)=>a.start-b.start);
let cursor=0,result='';
for(const e of edits){assert.ok(e.start>=cursor,'overlapping edit');result+=live.slice(cursor,e.start)+e.text;cursor=e.end;}
result+=live.slice(cursor);
const out=parse(result,{ecmaVersion:'latest',sourceType:'module'});
for(const name of ['manualStillEligible','createMail','formatJob','createMailAdmin','directEligible'])assert.ok(eq(fn(out,name),fn(n,name)),name+' result mismatch');
for(const name of ['transactionKinds','storedType'])assert.ok(eq(variable(out,name),variable(n,name)),name+' result mismatch');
assert.ok(eq(mailCall(out),newCall),'dispatch result mismatch');
assert.notEqual(live,result);
writeFileSync(livePath,result);
console.log('Exact baseline matched; replaced 4 email functions and 1 email-only call, added 3 email helpers. All other bytes preserved.');
