import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const area=read('src/pages/[lang]/membres/[area].astro');
const board=read('src/pages/[lang]/membres/board.astro');
const gallery=read('src/scripts/members/gallery.ts');
const galleryPage=read('src/pages/[lang]/membres/gallery.astro');
const admin=read('src/pages/[lang]/membres/admin.astro');
const ops=read('src/scripts/members/admin-ops.ts');
const members=read('src/pages/[lang]/membres/index.astro');
const rules=read('firestore.rules.PROPOSED_ONLY');
const messages=read('src/scripts/members/messages.ts');
test('no legacy-member badge synchronization when registration has not started',()=>{
  assert.doesNotMatch(admin,/ops-sync-member-badges/);
  assert.doesNotMatch(ops,/ops-sync-member-badges/);
});
test('board, learning resources and gallery display public nickname plus current role',()=>{
  assert.match(board,/publicInfo\(post\.authorUid\)/);
  assert.match(board,/roleName\(info\.role\)/);
  assert.match(area,/publicAuthor\(item\.authorUid/);
  assert.match(area,/publicAuthor\(comment\.authorUid\)/);
  assert.match(area,/authorLabel\(authorInfo\)/);
  assert.match(gallery,/authorName\(photo\.authorUid\)/);
  assert.match(gallery,/authorName\(album\.ownerUid\)/);
});
test('board category IDs survive future label renaming',()=>{
  assert.match(board,/\[cat:\$\{category\}\]/);
  assert.match(board,/const stable=/);
  assert.match(board,/const legacy=/);
  assert.match(board,/info:'정보',question:'질문'/);
  assert.match(area,/cat==='general'/);
});
test('minor accounts are not selectable as message recipients and cannot send server side',()=>{
  assert.match(messages,/\.filter\(x=>!!x\.nickname&&x\.canReceiveDM\)/);
  assert.match(members,/messageLink\.hidden=data\.accountType!=='adult'/);
  assert.match(rules,/request\.resource\.data\.canReceiveDM == \(getAfter\(memberDoc\(uid\)\)\.data\.get\('accountType',''\) == 'adult'/);
  assert.match(rules,/isAdultAccount\(request\.resource\.data\.recipientUid\)/);
});
test('gallery is closed before launch and provides admin-only tools',()=>{
  assert.match(gallery,/opened=snapshot\.exists\(\)&&snapshot\.data\(\)\?\.isOpen===true/);
  assert.match(gallery,/if\(!opened&&!admin\(\)\)\{locked\(\);return false;/);
  assert.match(gallery,/if\(!admin\(\)\)return;\s*try\{const response=await getMedia\(filePath\(photo\)\)/);
  assert.match(gallery,/gallery-lightbox-prev/);
  assert.match(galleryPage,/id="gallery-lightbox-next"/);
  assert.match(gallery,/unlockAlbum\(album\)/);
  assert.match(gallery,/destination\.ownerUid!==photo\.authorUid&&!destination\.isShared/);
});
test('reports and all request categories appear in operational flow',()=>{
  assert.match(board,/reportBoardEntry\('post',post\.id\)/);
  assert.match(board,/reportBoardEntry\('comment',postId,c\.id\)/);
  assert.match(messages,/kind:'suggestion',id:record\.id/);
  assert.match(ops,/memberWithdrawalRequests/);
  assert.match(ops,/nameChangeRequests/);
});
test('gallery albums support admin merge and approved-photo cover selection',()=>{
  assert.match(gallery,/async function mergeAlbum\(album:Album\)/);
  assert.match(gallery,/if\(!admin\(\)\)return;/);
  assert.match(gallery,/async function setAlbumCover\(photo:Photo\)/);
  assert.match(gallery,/async function clearCoverReference\(photo:Photo\)/);
  assert.match(gallery,/await clearCoverReference\(photo\);/);
  assert.match(gallery,/coverItemId:''/);
  assert.match(rules,/function validAlbumCover\(id\)/);
  assert.match(rules,/request\.resource\.data\.coverItemId == ''/);
  assert.match(galleryPage,/:global\(\.gallery-album-cover\)/);
});
test('non-live member homepage also shows gallery consent review notice',()=>{
  assert.match(galleryPage,/갤러리는 초상권 보호 정책 협의가 완료될 때까지 비공개입니다/);
  assert.match(galleryPage,/학생 및 학부모의 초상권 보호 정책을 운영진 회의에서 협의 중입니다/);
});
