import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync,existsSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const rules=read('firestore.rules.PROPOSED_ONLY');
const worker=read('worker/asicc-media-worker-extended.js');
const gallery=read('src/scripts/members/gallery.ts');
const admin=read('src/pages/[lang]/membres/admin.astro');
const adminOps=read('src/scripts/members/admin-ops.ts');
const resources=read('src/pages/[lang]/membres/[area].astro');
const messages=read('src/scripts/members/messages.ts');
test('the gallery is closed by default, including server-side file routes',()=>{
  assert.match(gallery,/opened=snapshot\.exists\(\)&&snapshot\.data\(\)\?\.isOpen===true/);
  assert.match(gallery,/if\(!opened&&!admin\(\)\)\{locked\(\);return false;/);
  assert.match(worker,/await galleryIsOpen\(request,env\)/);
  assert.match(rules,/function galleryReady\(\) \{ return galleryOpen\(\) \|\| isAdmin\(\); \}/);
});
test('learning resources editing, comments and zero-attachment posts are preserved',()=>{
  assert.match(rules,/function validLearningEdit\(\)/);
  assert.match(rules,/\|\| validLearningEdit\(\)/);
  assert.match(rules,/match \/learningResources\/\{id\}[\s\S]*?match \/comments\/\{commentId\}/);
  assert.match(rules,/a\.size\(\) == 0 \|\| validAttachment\(a\[0\]\)/);
  assert.match(worker,/if\(sum>MAX_RESOURCE_POST\|\|sum!==record\.bytesTotal\)/);
  assert.match(resources,/loadResourceCategories\(\)/);
});
test('gallery upload requires moderated state; album rights protect shared media',()=>{
  assert.match(gallery,/review\?'pending':'published'/);
  assert.match(rules,/resource\.data\.isShared == false/);
  assert.match(rules,/resource\.data\.ownerUid == request\.auth\.uid && resource\.data\.isShared == false/);
  assert.match(gallery,/async function bulkUpdate/);
  assert.match(gallery,/gallery-target-album/);
});
test('private messages block student or unknown accounts server side',()=>{
  assert.match(rules,/function isAdultAccount\(uid\)/);
  assert.match(rules,/isAdultAccount\(request\.resource\.data\.recipientUid\)/);
  assert.match(messages,/!dmAllowed\(me\.data\(\)\)/);
  assert.match(admin,/admin-edit-account-type/);
});
test('admin categories, review inbox and email notification must use explicit configuration',()=>{
  assert.match(adminOps,/\['resourceCategories','ops-resource-categories'/);
  assert.match(adminOps,/keys:items\.map\(x=>x\.id\)/);
  assert.match(rules,/function resourceCategoryAllowed\(category\)/);
  assert.match(worker,/RESEND_API_KEY/);
  assert.match(worker,/NOTIFICATION_KV/);
  assert.match(worker,/ASICC_NOTIFY_TO/);
  assert.match(admin,/ops-inbox/);
});
