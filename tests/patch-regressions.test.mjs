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

test('administrator display has visit count, last login, collapsed audit and no obsolete filters',()=>{
  for(const value of ['admin-today-visitors','lastSeenAt','최종 접속일','admin-deletions-panel','탈퇴 요청일'])assert.ok(admin.includes(value),value);
  assert.ok(!admin.includes('admin-filter-to'));
  assert.ok(!admin.includes('admin-redact-legacy'));
  assert.match(admin, /addEventListener\('toggle'/);
});

test('member tracking updates only the logged-in member time with reviewed rules',()=>{
  assert.match(base,/members-icon-open/);
  assert.match(base,/recordMemberActivity/);
  assert.match(activity,/updateDoc\(member\.ref,\{lastSeenAt:serverTimestamp\(\)\}\)/);
  assert.match(activity,/parisDay\(last\)===parisDay\(now\)/);
  assert.match(rules,/function validSelfActivityUpdate\(uid\)/);
  assert.match(rules,/affectedKeys\(\)\.hasOnly\(\['lastSeenAt'\]\)/);
  assert.match(rules,/request\.resource\.data\.lastSeenAt == request\.time/);
  assert.match(rules,/validSelfNicknameUpdate\(uid\) \|\| validSelfActivityUpdate\(uid\) \|\| validAdminMemberUpdate\(uid\)/);
});
