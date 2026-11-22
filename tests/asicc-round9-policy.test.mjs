import test from 'node:test';
import assert from 'node:assert/strict';
import {dmAllowed} from '../src/scripts/members/dm-policy.ts';
const base={status:'approved',role:'special'};const now=Date.UTC(2026,10,22);
const cases=[
 ['legacy admin',{role:'admin'},true],['adult parent',{accountType:'adult'},true],['legacy alumni parent',{memberKind:'alumni-parent'},true],
 ['legacy unknown',{},false],['general adult',{role:'general',accountType:'adult'},false],['general override',{role:'general',dmMode:'on'},false],
 ['minor default',{accountType:'student',birthDate:'2015-01-01'},false],['minor explicit ON',{accountType:'student',birthDate:'2015-01-01',dmMode:'on'},true],
 ['missing age explicit ON',{accountType:'student',dmMode:'on'},true],['student missing birth',{accountType:'student'},false],
 ['adult birthday',{accountType:'student',birthDate:'2008-11-22'},true],['day before birthday',{accountType:'student',birthDate:'2008-11-23'},false],
 ['adult alumni',{memberKind:'alumnus',birthDate:'2000-01-01'},true],['legacy alumni unknown',{memberKind:'alumnus'},false],
 ['explicit off adult',{accountType:'adult',dmMode:'off'},false],['explicit off admin',{role:'admin',dmMode:'off'},false],
 ['suspended ON',{status:'suspended',dmMode:'on'},false],['invalid date',{accountType:'student',birthDate:'2008-02-30'},false],
 ['student overrides conflicting parent type',{accountType:'student',memberKind:'parent'},false],['unknown manually enabled',{dmMode:'on'},true]
];
for(const [name,fields,expected] of cases)test(name,()=>assert.equal(dmAllowed({...base,...fields},now),expected));
test('leap birthday does not activate early',()=>{
 const p={...base,accountType:'student',birthDate:'2008-02-29'};
 assert.equal(dmAllowed(p,Date.UTC(2026,1,28,23,59)),false);
 assert.equal(dmAllowed(p,Date.UTC(2026,2,1)),true);
});

import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('signup and server agree general aliases cannot receive messages',()=>{
 assert.match(read('src/pages/[lang]/membres/signup.astro'),/role:'general',canReceiveDM:false/);
 assert.match(read('firestore.rules.PROPOSED_ONLY'),/p\.role in \['member','special','admin'\]/);
});
test('admin summary precedes settings and initialization is explicitly one-time',()=>{
 const a=read('src/pages/[lang]/membres/admin.astro');
 assert.ok(a.indexOf('id="ops-inbox-heading"')<a.indexOf('id="operations-heading"'));
 assert.match(a,/const mark=await tx\.get\(marker\);if\(mark\.exists\(\)\)throw Error\('already-initialised'\)/);
 assert.match(a,/getDocsFromServer\(collection\(db,'members'\)\)/);
 assert.doesNotMatch(a,/admin-edit-dm-project|admin-edit-birth-verified/);
});
test('gallery review uses only pending; hidden is separate from deletion',()=>{
 const g=read('src/scripts/members/gallery.ts');
 assert.match(g,/view==='review'\?admin\(\)&&p\.status==='pending'/);
 assert.match(g,/이 사진을 공개하시겠습니까/);assert.match(g,/비공개하시겠습니까/);
 assert.doesNotMatch(g,/tr\('반려','Refuser'\)/);
});
test('author and selected recipient check server eligibility, rather than stale alias',()=>{
 const a=read('src/scripts/members/member-access.ts'),m=read('src/scripts/members/messages.ts');
 assert.match(a,/canContact\(db,authorUid\)/);assert.match(a,/✉ 쪽지 보내기/);
 assert.doesNotMatch(m,/getDocs\(collection\(db,'publicNames'\)\)/);assert.match(m,/canContact\(db,to\)/);
});
test('completed operations are visible through shared toast and admin settings dispatch',()=>{
 assert.match(read('src/scripts/members/admin-ops.ts'),/asicc-ops-toast/);
 assert.match(read('src/styles/global.css'),/\.asicc-toast-global\[hidden\]/);
 assert.match(read('src/scripts/members/gallery.ts'),/await updateDoc\(doc\(db,'galleryItems',photo\.id\),\{status:state,updatedAt:serverTimestamp\(\)\}\);\s*msg\(/);
});
