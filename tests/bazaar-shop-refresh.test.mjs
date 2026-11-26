import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {shouldRefreshShop} from '../src/lib/bazaar/shop-refresh.mjs';
const state={hidden:false,submitted:false,submitting:false,pending:false,closed:false,hasCart:false,lastAttempt:0};
const due=(now,overrides={})=>shouldRefreshShop({...state,now,...overrides});
test('empty cart refreshes every two minutes and nonempty cart every minute',()=>{
  assert.equal(due(119999),false);
  assert.equal(due(120000),true);
  assert.equal(due(59999,{hasCart:true}),false);
  assert.equal(due(60000,{hasCart:true}),true);
});
test('returning to visible page refreshes stale data without rapid repeat reads',()=>{
  assert.equal(due(29999,{resumed:true}),false);
  assert.equal(due(30000,{resumed:true}),true);
  assert.equal(due(100000,{resumed:true,lastAttempt:99000}),false);
});
test('background, closed, completed and in-flight or uncertain orders do not poll',()=>{
  for(const flag of ['hidden','submitted','submitting','pending','closed']){
    assert.equal(due(999999,{[flag]:true}),false,flag);
    assert.equal(due(999999,{[flag]:true,resumed:true}),false,flag);
  }
});
test('buyer page uses adaptive policy and retains server checkout validation',()=>{
  const page=readFileSync(new URL('../src/pages/[lang]/bazaar/index.astro',import.meta.url),'utf8');
  const service=readFileSync(new URL('../firebase-functions-bazaar/bazaar/service.mjs',import.meta.url),'utf8');
  assert.match(page,/setInterval\(\(\)=>refreshVisible\(\),SHOP_REFRESH_CHECK_MS\)/);
  assert.match(page,/await createOrder\(pendingOrder\)/);
  assert.match(service,/orderIntakeState\(e\)!=='open'/);
  assert.match(service,/assertAvailable\(data,qty,id\)/);
});
