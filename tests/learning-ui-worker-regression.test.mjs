import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
const dashboard=read('src/pages/[lang]/membres/index.astro');
const learning=read('src/pages/[lang]/membres/[area].astro');
const worker=read('worker/asicc-media-worker-extended.js');

test('recent learning title follows actual published preview count, not constant 5', () => {
  assert.doesNotMatch(dashboard, /최근 등록 자료 5개/);
  assert.match(dashboard, /id="recent-learning-count"/);
  assert.match(dashboard, /최근 등록 자료 \${docs\.length}개/);
  assert.match(dashboard, /getDocsFromServer\(feedQuery\)/);
  assert.match(dashboard, /data\.status==='published'/);
});
test('newly selected file names are rendered separately and safely', () => {
  assert.match(learning, /id="resource-selected-file-names"/);
  assert.match(learning, /for\(const file of selected\)/);
  assert.match(learning, /row\.textContent=`\${file\.name}/);
  assert.match(learning, /chosenNames\.replaceChildren\(\)/);
});
test('Worker permits preflight for DELETE and retains per-file and full deletion', async () => {
  assert.match(worker, /'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS'/);
  assert.match(worker, /const deleteAll=resource&&request\.method==='DELETE'&&!fileId/);
  assert.match(worker, /deleteAll\?files\.map\(f=>f\.id\):\[fileId\]/);
  const url='data:text/javascript;base64,'+Buffer.from(worker).toString('base64');
  const {default:entry}=await import(url);
  const request=new Request('https://worker.example/api/resource?postId=test001',{
    method:'OPTIONS',headers:{Origin:'https://test.asicc-parents.fr',
    'Access-Control-Request-Method':'DELETE',
    'Access-Control-Request-Headers':'authorization'}
  });
  const response=await entry.fetch(request,{ALLOWED_ORIGINS:'https://test.asicc-parents.fr'});
  assert.equal(response.status,204);
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /DELETE/);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://test.asicc-parents.fr');
});
