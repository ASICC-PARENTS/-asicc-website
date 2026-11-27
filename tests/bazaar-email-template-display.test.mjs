import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultMailCopy,renderOrderEmail} from '../firebase-functions-bazaar/bazaar/order-email.mjs';
import {mailKinds} from '../worker/bazaar/mail-policy.mjs';
const event={nameKo:'예시 행사',nameFr:'Bazar exemple',transferCutoff:'2026-11-29T21:00:00Z',pickupAt:'2026-12-01T15:00:00Z'};
for(const kind of Object.keys(mailKinds))for(const lang of ['ko','fr'])test(kind+' '+lang+' complete default copy and shared product table',()=>{
 const type=['buyerCancel','adminCancel'].includes(kind)?'cancel':kind;
 const [title,intro]=defaultMailCopy(type,lang);
 assert.ok(title.trim()&&intro.trim());
 const order={lang,id:'preview',buyerToken:'preview-only',orderRef:'ASICC-PREVIEW',name:'Sample',totalCents:2350,items:[{titleKo:'예시 상품',titleFr:'Produit exemple',qty:2,priceCents:1175}],paymentDeadline:event.transferCutoff};
 const result=renderOrderEmail({type,order,event,site:'https://example.test',template:kind==='other'?{fields:['order','items','total']}:{}});
 assert.ok(result.subject.includes(title));
 assert.ok(result.text.includes(intro));
 assert.match(result.html,/<table class="mail-products"/);
 assert.match(result.html,/mail-product-qty/);
 assert.match(result.html,/mail-amount/);
 if(kind==='other')assert.doesNotMatch(renderOrderEmail({type,order,event,site:'https://example.test'}).html,/<table class="mail-products"/);
});
