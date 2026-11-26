import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = p => readFileSync(new URL('../'+p, import.meta.url), 'utf8');
const worker = read('worker/asicc-media-worker-extended.js');
const gallery = read('src/scripts/members/gallery.ts');
const galleryPage = read('src/pages/[lang]/membres/gallery.astro');
const adminPage = read('src/pages/[lang]/membres/admin.astro');
const rules = read('firestore.rules');
test('resource and gallery media remain on B2; no Drive upload integration', () => {
  assert.match(worker, /async function b2Request\(/);
  assert.match(worker, /resource\?'learningResources':'galleryItems'/);
  assert.match(worker, /await b2Request\(env,'PUT',key,bytes,mime\)/);
  assert.match(gallery, /BOARD_PHOTO_API/);
  assert.match(gallery, /\/api\/gallery-upload\?itemId=/);
  assert.doesNotMatch(worker, /drive\.googleapis\.com|www\.googleapis\.com\/upload\/drive\/v3|GOOGLE_DRIVE_TOKEN|DRIVE_FOLDER_ID/);
  assert.doesNotMatch(gallery, /drive\.googleapis\.com|DRIVE_FOLDER_ID|googleDrive\.files\.create/);
});
test('gallery starts closed, server denies non-admin requests while closed', () => {
  assert.match(gallery, /opened=snapshot\.exists\(\)&&snapshot\.data\(\)\?\.isOpen===true/);
  assert.match(worker, /!await galleryIsOpen\(request,env\)/);
  assert.match(rules, /function galleryReady\(\) \{ return galleryOpen\(\) \|\| isAdmin\(\); \}/);
});
test('UI accurately says B2 is active and unarchived originals are not retained', () => {
  assert.doesNotMatch(galleryPage, /Backblaze B2|Google Drive|Goodstack/);
  assert.match(galleryPage, /사진은 웹용으로 축소되며 원본은 별도 보관되지 않습니다/);
  assert.match(adminPage, /현재 파일은 Backblaze B2에만 저장되고 Google Drive 원본 자동 보관은 실행되지 않습니다/);
});
