import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
const read = relative => readFileSync(new URL('../'+relative,import.meta.url),'utf8');
const board=read('src/pages/[lang]/membres/board.astro');
const admin=read('src/pages/[lang]/membres/admin.astro');
const member=read('src/pages/[lang]/membres/index.astro');
const base=read('src/layouts/Base.astro');
const css=read('src/styles/global.css');
const rules=read('firestore.rules.PROPOSED_ONLY');
const activity=read('src/scripts/members/activity.ts');
const deploy=read('.github/workflows/deploy.yml');

test('nested replies use direct parents, end at level 5, and render recursively',()=>{
  assert.match(board, /const MAX_COMMENT_DEPTH=5;/);
  assert.match(board, /replyBody\(c\.id,text\)/);
  assert.match(board, /depth<MAX_COMMENT_DEPTH/);
  assert.match(board, /renderTree\(reply,depth\+1\)/);
  assert.match(board, /if\(seen\.has\(comment\.id\)\)continue/);
  assert.match(board, /isReply\?'답글':'댓글'/);
  assert.match(css, /\.board-replies\s*\{/);
});

test('existing board rich editor, photo logic, moderation and hard-delete logs remain present',()=>{
  for(const value of ['BOARD_PHOTO_API','serializeEditor','photo-adjust','hiddenComments','hiddenPosts','boardDeletionLogs','deleteComment'])assert.ok(board.includes(value),value);
});

test('member dashboard separates admin shortcuts and uses requested navigation labels',()=>{
  for(const value of ['member-staff-links','admin-shortcut','office-shortcut','학습자료실 가기','회원게시판 가기','갤러리 가기'])assert.ok(member.includes(value),value);
  assert.match(member,/\.member-staff-links\[hidden\]\s*\{display:none\}/);
});

test('admin dashboard offers external analytics; no fake last-activity timestamp or obsolete filters',()=>{
  for(const value of ['Cloudflare 방문 통계 열기','Firebase 로그인 기록 확인','admin-deletions-panel','탈퇴 요청일'])assert.ok(admin.includes(value),value);
  for(const obsolete of ['admin-today-visitors','lastSeenAt','admin-filter-to','admin-redact-legacy','recordMemberActivity'])assert.ok(!admin.includes(obsolete),obsolete);
  assert.match(admin, /addEventListener\('toggle'/);
});

test('visit tracking has no client Firestore writes and uses optional single Cloudflare beacon',()=>{
  assert.match(base,/members-icon-open/);
  assert.match(base,/cloudflareToken && <script is:inline defer/);
  assert.match(base,/static\.cloudflareinsights\.com\/beacon\.min\.js/);
  assert.match(deploy,/PUBLIC_ASICC_CLOUDFLARE_TOKEN/);
  assert.doesNotMatch(base,/recordMemberActivity|lastSeenAt/);
  assert.doesNotMatch(activity,/updateDoc|serverTimestamp|setDoc/);
  assert.doesNotMatch(rules,/validSelfActivityUpdate/);
  assert.match(rules,/allow update: if validSelfNicknameUpdate\(uid\) \|\| validAdminMemberUpdate\(uid\)/);
});

test('learning resources reuse the board list/detail layout and exclude draft dashboard previews',()=>{
  const learning=read('src/pages/[lang]/membres/[area].astro');
  const worker=read('worker/asicc-media-worker-extended.js');
  for(const key of ['resource-category-tabs','files-list-panel','files-detail','files-back','resource-show-drafts','board-title-link'])assert.ok(learning.includes(key),key);
  for(const value of ["'kindergarten','elementary','middle','common','other'",'data-resource-tab="common"','data-resource-tab="other"'])assert.ok(learning.includes(value),value);
  assert.match(member, /data\.status==='published'\|\|\(!data\.status&&typeof data\.storagePath/);
  assert.match(rules, /request\.resource\.data\.category in \['kindergarten','elementary','middle','common','other'\]/);
  assert.match(worker, /'\/api\/resource-upload'/);
  assert.match(worker, /'\/api\/resource'/);
  assert.match(worker, /const MAX_RESOURCE_FILES = 8;/);
});

test('learning editor reuses board sanitizer and photo editing with no post-upload refresh',()=>{
  const learning=read('src/pages/[lang]/membres/[area].astro');
  for(const item of ['serializeEditor(resourceEditor)','setEditorBody(resourceEditor','renderBoardBody(text,item.body)',
    'resource-photo-adjust','resource-rich-photo','resource-photo-width','data-resource-photo-align','populateResourcePhotos',
    'resource-comment-form','refreshResourceComments','MAX_COMMENT_DEPTH=5','nicknameOf(item.authorUid','editingResourceId'])assert.ok(learning.includes(item),item);
  assert.match(learning,/entries=\[published,\.\.\.entries\.filter/);
  assert.match(learning,/openResource\(published\)/);
  assert.match(rules,/function validLearningEdit\(\)/);
  assert.match(rules,/match \/learningResources\/\{id\} \{[\s\S]*?match \/comments\/\{commentId\}/);
});


test('recent learning preview refreshes from server after deletion and on browser history restore',()=>{
  assert.match(member, /getDocsFromServer\(feedQuery\)/);
  assert.match(member, /event\.persisted/);
  assert.match(member, /displayFeed\('recent-learning','learningResources'\)/);
});

test('learning editor lists old files, stages individual removal, and uploads new files safely',()=>{
  const learning=read('src/pages/[lang]/membres/[area].astro');
  const worker=read('worker/asicc-media-worker-extended.js');
  for(const value of ['resource-existing-file-list','renderExistingAttachments','removedAttachmentIds',
    'remainingAttachments','updateAttachmentSummary','updates.files=manifest','updates.bytesTotal=total'])
    assert.ok(learning.includes(value),value);
  assert.match(worker, /const editing=resource&&record\.status==='published'/);
  assert.match(worker, /deleteAll\?files\.map\(f=>f\.id\):\[fileId\]/);
  assert.match(rules, /learningAttachmentTotal\(request\.resource\.data\.files\)/);
});


test('text-only learning resources are permitted and resource cleanup supports an empty manifest',()=>{
  const learning=read('src/pages/[lang]/membres/[area].astro');
  const worker=read('worker/asicc-media-worker-extended.js');
  assert.doesNotMatch(learning,/첨부파일은 최소 1개를 남기거나 추가해야/);
  assert.match(learning,/status:files.length\?'draft':'published'/);
  assert.match(learning,/type="file" multiple accept=/);
  assert.match(rules,/a\.size\(\) == 0 \|\| validAttachment\(a\[0\]\)/);
  assert.match(rules,/a\.size\(\) > 0 \? a\[0\]\.size : 0/);
  assert.doesNotMatch(worker,/if\(!record\.files\.length/);
});
