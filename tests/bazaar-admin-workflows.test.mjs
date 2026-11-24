import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const screen=read('src/lib/bazaar/admin/Screen.astro');
const app=read('src/lib/bazaar/admin/app.js');
const mail=read('src/lib/bazaar/admin/mail.js');

test('bazaar dashboard returns to the homepage operations center and lists event states',()=>{
  assert.match(screen,/운영센터로 돌아가기/);
  assert.match(app,/작성 중인 바자회 '\+model\.drafts\.length/);
  for(const status of ["['draft','임시저장']","['published','발행']","['completed','완료']"])
    assert.ok(app.includes(status));
  assert.match(app,/data-action="new-event"/);
  assert.match(app,/data-action="event-filter"/);
});

test('draft creation supports prior event product copies and bulk catalog selection',()=>{
  assert.match(app,/지난 바자회 상품 복사/);
  assert.match(app,/request\('dashboard',\{eventId:\$\('#copy-products-from'\)\.value\}\)/);
  assert.match(app,/data-import-all/);
  assert.match(app,/data-action="import-apply"/);
});

test('product table supports direct ordering and operator-specific column preferences',()=>{
  assert.match(app,/\['순서','사진'/);
  assert.match(app,/data-action="product-up"/);
  assert.match(app,/data-sort-row/);
  assert.doesNotMatch(app,/data-action="reorder-products">진열 순서 변경/);
  assert.match(app,/data-column-pinned/);
  assert.match(app,/data-col-resize/);
  assert.match(app,/bazaar-cols-'.*currentUser\?\.uid/s);
});

test('past-event product import copies product fields into isolated product snapshots',()=>{
  assert.match(app,/지난 행사에서 가져오기/);
  assert.match(app,/request\('dashboard',\{eventId:selected\.id\}\)/);
  assert.match(app,/id:newId\(\),active:true/);
  assert.match(app,/주문, 고객, 입금 및 정산 기록은 복사하지 않습니다/);
  assert.match(app,/선택 상품 0개/);
});

test('product columns use stable IDs and allow individual hidden-column restore',()=>{
  assert.match(app,/data-column-id=/);
  assert.match(app,/dataset\.columnId\|\|`column-\$\{i\}`/);
  assert.match(app,/data-col-menu="restore"/);
  assert.match(app,/column-drop-before/);
  assert.match(app,/column-drop-after/);
  assert.match(app,/columns-desktop/);
  assert.match(app,/columns-mobile/);
});

test('buyer preview supports unsaved content, language and viewport controls without enabling orders',()=>{
  assert.match(app,/preview-draft-form/);
  assert.match(app,/data-action="preview-lang"/);
  assert.match(app,/data-action="preview-device"/);
  assert.match(app,/data-action="preview-publish"/);
  assert.match(app,/실제 주문은 비활성화되어 있습니다/);
});

test('OVH recipient preparation retains deduplication, Bcc output and send history controls',()=>{
  assert.match(mail,/data-manual-order/);
  assert.match(mail,/data-order-select-all/);
  assert.match(mail,/webmail\.ovh\.net/);
  assert.match(mail,/숨은참조\(Bcc\)/);
  assert.match(mail,/new Set\(prepared\.map/);
  assert.match(mail,/completeManual/);
});
