import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const gallery=read('src/scripts/members/gallery.ts'),page=read('src/pages/[lang]/membres/gallery.astro'),ops=read('src/scripts/members/admin-ops.ts'),admin=read('src/pages/[lang]/membres/admin.astro'),rules=read('firestore.rules.PROPOSED_ONLY'),messages=read('src/scripts/members/messages.ts'),access=read('src/scripts/members/member-access.ts');
test('review queue has a dedicated link, query and refreshed status after approval',()=>{
  assert.match(ops,/href:'\.\.\/gallery\/\?view=review'/);
  assert.match(gallery,/if\(view==='review'\)return admin\(\)\?\(await getDocs\(query\(collection\(db,'galleryItems'\),where\('status','==','pending'\)\)\)\)\.docs/);
  assert.match(gallery,/view==='review'\?admin\(\)&&p\.status==='pending'/);
  assert.match(gallery,/async function changePhotoStatus[\s\S]*?await refreshPhotos\(\)/);
  assert.match(gallery,/get\('view'\)==='review'&&admin\(\)/);
});
test('all reset, albums and photos have clear independent controls, lazy media and incremental display',()=>{
  for(const id of ['gallery-all-view','gallery-folder-view','gallery-photo-view','gallery-more','album-new-toggle'])assert.match(page,new RegExp(`id="${id}"`));
  assert.match(page,/#album-new-toggle\{margin-inline-start:auto/);
  assert.match(gallery,/el\.value='all'/);assert.match(gallery,/search\.value=''/);
  assert.match(gallery,/PHOTO_BATCH=24/);assert.match(gallery,/visible\.slice\(renderedCount,renderedCount\+PHOTO_BATCH\)/);
  assert.match(gallery,/new IntersectionObserver/);assert.match(gallery,/loadWhenVisible\(media/);
});
test('uploads remain ordinary draft-to-published, no per-photo review checkbox is generated',()=>{
  assert.doesNotMatch(gallery,/gallery-review-\$\{i\}|notifyReview\(record\.id\)/);
  assert.match(gallery,/reviewReason:'',sortOrder/);assert.match(gallery,/await updateDoc\(record,\{status:'published'/);
  assert.match(gallery,/description=by<HTMLTextAreaElement>/);
  assert.match(page,/책임감 있게 사진과 동영상을 등록/);
});
test('row-level messaging has independently saved settings, admin override and audit',()=>{
  assert.match(admin,/renderMemberMessaging\(row,m\)/);assert.match(admin,/saveMessagingMode\(m,select,save\)/);
  assert.match(admin,/href='\.\.\/messages\/\?to='/);
  assert.match(admin,/dmUpdatedBy:meUid,dmUpdatedAt:serverTimestamp\(\)/);
  assert.doesNotMatch(admin,/admin-edit-dm-project|admin-edit-birth-verified/);assert.match(rules,/function validAdminMessagingUpdate/);
  assert.match(rules,/changed\.hasOnly\(\['dmMode','dmUpdatedBy','dmUpdatedAt'\]\)/);
});
test('compose rechecks actual recipient permissions; admin does not depend on stale aliases',()=>{
  assert.match(access,/canContact\(db,authorUid\)/);
  assert.match(messages,/role==='admin'\)\{\s*const active=await getDocs\(collection\(db,'members'\)\)/);
  assert.match(access,/getDocFromServer\(doc\(db,'messageAccess',uid\)\)/);
  assert.match(rules,/match \/messageAccess\/\{uid\}[\s\S]*?allow get: if canSendTo\(uid\)/);
  assert.match(rules,/sender\.role in \['member','special','admin'\] && recipient\.role in \['member','special','admin'\]/);
  assert.match(messages,/if\(sending\|\|!selectedAllowed\)/);
});
