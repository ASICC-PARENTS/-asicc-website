import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {parse} from 'acorn';

const target=process.argv[2], reference=process.argv[3], replacement=process.argv[4];
const source=readFileSync(target,'utf8');
const astOptions={ecmaVersion:'latest',sourceType:'module'};
function functions(code){
 const found=[];
 function visit(node){
  if(!node||typeof node!=='object')return;
  if(node.type==='FunctionDeclaration'&&node.id?.name==='requireAdmin')found.push(node);
  for(const [key,value] of Object.entries(node))if(key!=='start'&&key!=='end'&&key!=='loc'){
   if(Array.isArray(value))value.forEach(visit);else if(typeof value==='object')visit(value);
  }
 }
 visit(parse(code,astOptions));return found;
}
const normalized=node=>JSON.stringify(node,(key,v)=>['start','end','loc','raw'].includes(key)?undefined:v);
const old=functions(readFileSync(reference,'utf8'));
const next=functions(readFileSync(replacement,'utf8'));
const live=functions(source);
assert.equal(old.length,1);assert.equal(next.length,1);assert.equal(live.length,1);
assert.equal(normalized(live[0]),normalized(old[0]),'Live authorization function differs; no update made');
const updated=source.slice(0,live[0].start)+readFileSync(replacement,'utf8').slice(next[0].start,next[0].end)+source.slice(live[0].end);
assert.equal(normalized(functions(updated)[0]),normalized(next[0]));
writeFileSync(target,updated);
console.log('Verified exact authorization function; all other script bytes preserved.');
