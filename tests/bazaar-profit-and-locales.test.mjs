import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('event expenses use an admin-only, revisioned record separate from event closure and purchase orders',async()=>{
  const service=await read('../firebase-functions-bazaar/bazaar/service.mjs');
  assert.match(service,/const eventFinancials=db\.collection\('bazaarEventFinancials'\)/);
  assert.match(service,/op==='saveEventExpenses'/);
  assert.match(service,/op==='finalizeEventFinancials'/);
  assert.match(service,/if\(old\.finalizedAt\)throw new HttpsError\('failed-precondition'/);
  assert.match(service,/eventArchives\.doc\(eventId\)/);
  assert.match(service,/eventFinancials\.doc\(planned\?'planned-'\+eventId:eventId\)/);
});

test('settlement UI keeps vendor purchase orders and adds independent event profit and expense controls',async()=>{
  const app=await read('../src/lib/bazaar/admin/app.js');
  assert.match(app,/전체 바자회 수익 결산/);
  assert.match(app,/예상 매출총이익/);
  assert.match(app,/상품 매입비용 TTC/);
  assert.match(app,/data-action="expense-add"/);
  assert.match(app,/data-action="profit-excel"/);
  assert.match(app,/data-action="profit-pdf"/);
  assert.match(app,/data-action="settlement-finalize"/);
  assert.match(app,/data-action="settlement-reopen"/);
  assert.match(app,/구매발주서 미리보기/);
});

test('French bazaar administrator route has translated shell and dynamic administration labels',async()=>{
  const screen=await read('../src/lib/bazaar/admin/Screen.astro');
  const locale=await read('../src/lib/bazaar/admin/i18n.js');
  assert.match(screen,/fr:'Gestion du bazar en ligne'/);
  assert.match(screen,/data-lang=\{lang\}/);
  assert.match(locale,/observeAdminLocale/);
  assert.match(locale,/Commandes par produit/);
  assert.match(locale,/Résultat global du bazar/);
});

test('product editor uses TTC-only costs, bidirectional selling prices and checks every row before saving',async()=>{
  const app=await read('../src/lib/bazaar/admin/app.js');
  const service=await read('../firebase-functions-bazaar/bazaar/service.mjs');
  assert.match(app,/모든 가격은 TTC 기준입니다/);
  assert.match(app,/매입가\/박스 TTC/);
  assert.match(app,/data-key="sale"/);
  assert.match(app,/if\(k!==\x27roi\x27\)margin\.value/);
  assert.match(app,/updateCalculatedPrice\(p,val\)/);
  assert.match(app,/필수입력 항목이 누락되었거나 유효하지 않은 상품/);
  assert.match(app,/현재 숨겨진 열입니다/);
  assert.match(app,/data-action="product-validation-focus"/);
  assert.match(service,/TTC 판매가격이 없거나 0 이하입니다/);
  assert.doesNotMatch(service,/out\.boxPriceTtcCents=Math\.round\(out\.boxPriceHtCents/);
});

test('product table exposes direct column gestures and buyer-row preview without a real order action',async()=>{
  const app=await read('../src/lib/bazaar/admin/app.js');
  assert.match(app,/h\.oncontextmenu=/);
  assert.match(app,/h\.ondrop=/);
  assert.match(app,/fitColumn\(table,names\[i\],key\)/);
  assert.match(app,/data-col-menu="hide"/);
  assert.match(app,/data-col-menu="pin"/);
  assert.match(app,/renderShopProducts\(products\.map/);
  assert.match(await read('../src/pages/[lang]/bazaar/index.astro'),/renderShopProducts\(products,lang/);
  assert.doesNotMatch(app,/data-action="preview-add"/);
  assert.match(app,/changeCartQuantity\(previewCart/);
  assert.match(app,/class="bz-btn" disabled/);
});


test('CMS bilingual text pairs have a French value and no untranslated Korean UI copy',async()=>{
  const {readdir}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const root=new URL('../src/data/',import.meta.url);
  const {fileURLToPath}=await import('node:url');
  const findings=[];let checked=0;
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);if(entry.isDirectory()){await walk(path);continue;}
    if(!entry.name.endsWith('.json'))continue;
    const content=JSON.parse(await readFile(path,'utf8'));
    function check(value,key){if(!value||typeof value!=='object')return;
      if(typeof value.ko==='string'&&value.ko.trim()){
        checked++;
        if(typeof value.fr!=='string'||!value.fr.trim())findings.push(path+': '+key+' missing French');
        else if(/[가-힣]{2,}/.test(value.fr)&&!(entry.name==='navigation.json'&&key==='lang_switch'))findings.push(path+': '+key+' Korean in French');
      }
      for(const [k,v] of Object.entries(value))check(v,key?key+'.'+k:k);
    }check(content,'');
  }}await walk(fileURLToPath(root));
  assert.ok(checked>100,'Expected the CMS bilingual dictionary to be checked');
  assert.deepEqual(findings,[]);
});

test('administrator French labels distinguish cancellation action and status',async()=>{
  const {translateAdminText}=await import('../src/lib/bazaar/admin/i18n.js');
  for(const key of ["지난 바자회 상품 복사","복사하지 않음","송금 신고 접수","주문번호","정정 사유","관리 탭","상품명 · 프랑스어","공급업체명","집계 기준","IBAN (FR · 27자리)","이름 · 주문번호 · 연락처 · 비고 검색","신고 완료","미신고","구매발주서","총 발주금액 TTC","운영진 계정으로 로그인해 주세요."]){
    assert.notEqual(translateAdminText(key),key,key);
    assert.doesNotMatch(translateAdminText(key),/[가-힣]/);
  }
  assert.equal(translateAdminText('취소'),'Annuler');
  assert.equal(translateAdminText('Utilisateur'),'Utilisateur');
  const app=await read('../src/lib/bazaar/admin/app.js');
  assert.ok(app.includes("canceled:[fr?'Annulée':'취소'"));
});

test('French native admin dialogs and test sign-in have explicit translations',async()=>{
  const app=await read('../src/lib/bazaar/admin/app.js');
  assert.doesNotMatch(app,/(?:alert|confirm|prompt)\(['"][^'"]*[가-힣]/);
  assert.ok(app.includes("language('최종 확인','CONFIRMER')"));
  const api=await read('../src/lib/bazaar/api.ts');
  assert.ok(api.includes("t('테스트 로그인','Connexion de test')"));
});
