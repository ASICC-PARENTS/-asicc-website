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

test('member dashboard shows the current admin space switch only to admins',()=>{
  for(const label of ["ko:'학습자료실'","ko:'회원게시판'","ko:'갤러리'"])assert.ok(member.includes(label),label);
  assert.match(member,/<nav id="member-space-switch"[^\n]*hidden>/);
  assert.match(member,/href=\{href\(lang,'membres\/admin\/'\)\}[^\n]*관리자 공간/);
  assert.match(member,/spaceSwitch\.hidden=role!=='admin'/);
  assert.match(admin,/me\.data\(\)\.status!=='approved' \|\| me\.data\(\)\.role!=='admin'/);
  assert.match(admin,/href=\{href\(lang,'membres\/office\/'\)\}/);
  assert.match(admin,/href="https:\/\/app\.pagescms\.org\//);
  assert.match(admin,/href="#members-heading"/);
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
  assert.match(rules,/function validAdminNicknameOnlyUpdate\(uid\)\s*\{/);
  assert.match(rules,/allow update:\s*if\s+validAdminMessagingUpdate\(uid\)\s*\|\|\s*validSelfNicknameUpdate\(uid\)\s*\|\|\s*validAdminNicknameOnlyUpdate\(uid\)\s*\|\|\s*validAdminMemberUpdate\(uid\)\s*;/);
  assert.match(rules,/changed\.hasOnly\(\['dmMode','dmUpdatedBy','dmUpdatedAt'\]\)/);
});
