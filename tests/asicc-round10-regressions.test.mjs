import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const msg=read('src/scripts/members/messages.ts'),page=read('src/pages/[lang]/membres/messages.astro'),rules=read('firestore.rules.PROPOSED_ONLY'),base=read('src/layouts/Base.astro'),admin=read('src/pages/[lang]/membres/admin.astro'),css=read('src/styles/global.css'),gallery=read('src/scripts/members/gallery.ts'),gp=read('src/pages/[lang]/membres/gallery.astro'),author=read('src/scripts/members/member-access.ts');
test('no directory or recipient dropdown; clicked source is fixed and checked',()=>{
 assert.doesNotMatch(page,/message-search|<select/);assert.doesNotMatch(msg,/getDocs|message-search|HTMLSelectElement/);
 assert.match(author,/new URLSearchParams\(\{to:authorUid,kind:source.kind,post:source.post,comment:source.comment\}\)/);
 assert.match(msg,/await canContact\(db,to\)&&await validSource\(to,source\)/);
 assert.match(msg,/recipientUid:to,body,source/);
 assert.match(rules,/validDmSource\(request.resource.data.source,request.resource.data.recipientUid\)/);
 assert.match(rules,/match \/publicNames\/\{uid\} \{\s*allow get: if isActive\(\);\s*allow list: if isAdmin\(\);/);
 for(const file of ['board','[area]'])assert.match(read(`src/pages/[lang]/membres/${file}.astro`),/post:postId,comment:/);
});
test('composer has full-width textarea, small action buttons, local result',()=>{
 assert.match(page,/#message-body\{display:block;width:100%;min-height:170px/);
 assert.match(page,/message-compose-actions[\s\S]*?id="message-send-result"/);
 assert.match(msg,/result\('message-send-result',tr\('쪽지가 발송되었습니다\.'/);
 assert.doesNotMatch(msg,/toastResult/);
});
test('inbox directly displays safe text and offers reply and recipient-only deletion',()=>{
 assert.match(msg,/const body=node\('p',item.body\)/);assert.doesNotMatch(msg,/createElement\('details'\)|reportMessage|innerHTML/);
 assert.match(msg,/openCompose\(partner,\{kind:'reply',post:item.id,comment:''\}\)/);
 assert.match(msg,/recipientDeletedAt:serverTimestamp\(\)/);assert.match(msg,/!incoming\|\|!x.recipientDeletedAt/);
 assert.match(rules,/resource.data.recipientUid == request.auth.uid\s*&& \(\(/);
 assert.match(rules,/hasOnly\(\['recipientDeletedAt'\]\)/);
});
test('inbox marks received messages read on server snapshot and header excludes deleted',()=>{
 assert.match(msg,/if\(!snap.metadata.fromCache\)markRead\(items,seq\)/);
 assert.match(msg,/if\(item.readAt\|\|item.recipientDeletedAt\|\|marking.has\(item.id\)\)continue/);
 assert.match(msg,/readAt:serverTimestamp\(\)/);assert.match(base,/!d.data\(\).readAt&&!d.data\(\).recipientDeletedAt/);
 assert.match(msg,/where\('senderUid','==',uid\)/);
});
test('one all-photo button resets filters and switches view; year first',()=>{
 assert.doesNotMatch(gp,/gallery-photo-view/);assert.doesNotMatch(gallery,/gallery-photo-view/);
 assert.ok(gp.indexOf('id="album-year-filter"')<gp.indexOf('id="album-school-filter"'));
 assert.match(gallery,/gallery-all-view'\)\?\.addEventListener[\s\S]*?changeView\('photos'\)/);
 assert.match(gallery,/el.value='all'/);assert.match(gallery,/search.value=''/);
});
test('admin row controls compact, local save response, no compose links',()=>{
 assert.match(admin,/admin-dm-controls/);assert.match(admin,/feedback\(tr\('저장 완료'/);
 assert.doesNotMatch(admin,/messages\/\?to=/);
 assert.match(css,/\.admin-dm-save\{width:auto;min-width:0;min-height:27px/);
});
