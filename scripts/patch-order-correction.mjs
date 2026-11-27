import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
const [livePath,oldPath,newPath]=process.argv.slice(2);
const [live,old,next]=[livePath,oldPath,newPath].map(p=>readFileSync(p,'utf8'));
const parseCode=code=>parse(code,{ecmaVersion:'latest',sourceType:'module'});
const ignored=new Set(['start','end','loc','raw']);
const normalize=x=>JSON.stringify(x,(k,v)=>ignored.has(k)?undefined:v);
function find(tree,predicate){const found=[];function visit(x){if(!x||typeof x!=='object')return;if(predicate(x))found.push(x);for(const [k,v] of Object.entries(x))if(!ignored.has(k)){if(Array.isArray(v))v.forEach(visit);else if(typeof v==='object')visit(v);}}visit(tree);return found;}
function one(nodes){assert.equal(nodes.length,1,'Expected exactly one order correction guard');return nodes[0];}
function scope(code,needle){
 const ast=parseCode(code);
 const msg=one(find(ast,x=>x.type==='Literal'&&x.value===needle));
 const guard=find(ast,x=>x.type==='IfStatement'&&x.start<msg.start&&x.end>msg.end&&x.test?.type==='LogicalExpression').sort((a,b)=>(a.end-a.start)-(b.end-b.start)).find(x=>x.test.start<msg.start&&x.test.end<msg.start&&code.slice(x.test.start,x.test.end).includes('transferReportedAt'));
 assert.ok(guard,'Missing guarded reported-transfer condition');
 const transaction=find(ast,x=>x.type==='ArrowFunctionExpression'&&x.start<guard.start&&x.end>guard.end&&x.body?.type==='BlockStatement').sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
 assert.ok(transaction,'Missing correction transaction');
 return {guard,transaction};
}
const oldMsg='송금 신고 주문은 은행 입금을 먼저 확인해 주세요.';
const newMsg='송금 신고 주문의 상품 추가 또는 증액은 은행 입금을 먼저 확인해 주세요.';
const a=scope(old,oldMsg),b=scope(next,newMsg),c=scope(live,oldMsg);
assert.equal(normalize(a.transaction),normalize(c.transaction),'Live correction transaction differs from verified baseline; no deploy');
const patched=live.slice(0,c.guard.start)+next.slice(b.guard.start,b.guard.end)+live.slice(c.guard.end);
assert.equal(normalize(scope(patched,newMsg).transaction),normalize(b.transaction),'Patched transaction differs from tested release');
writeFileSync(livePath,patched);
console.log('Verified exact existing correction transaction; changed only reported-transfer guard.');
