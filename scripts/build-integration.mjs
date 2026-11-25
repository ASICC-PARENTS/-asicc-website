import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const design=process.env.ASICC_DESIGN_PREVIEW==='true';
const site=design?'https://design-asicc-ui.asicc-integration-test.pages.dev':'https://asicc-integration-test.pages.dev';
const worker='https://asicc-bazaar-test-api.falling-hall-f390.workers.dev';
const key=process.env.PUBLIC_ASICC_BAZAAR_TEST_API_KEY?.trim();
const appId=process.env.PUBLIC_ASICC_BAZAAR_TEST_APP_ID?.trim();
if(!key || !appId || key==='test-project-api-key-required'){
 console.error('Set PUBLIC_ASICC_BAZAAR_TEST_API_KEY and PUBLIC_ASICC_BAZAAR_TEST_APP_ID from the existing asicc-bazaar-test Firebase web app in the Pages environment.');
 process.exit(1);
}
const expectedBranch=design?'design/asicc-ui':'feat/online-bazaar';
if(process.env.CF_PAGES_BRANCH && process.env.CF_PAGES_BRANCH!==expectedBranch){
 console.error('Unexpected ASICC test build branch.');
 process.exit(1);
}
const env={...process.env,SITE_URL:site,BASE_PATH:'/',PUBLIC_ASICC_INTEGRATION_TEST:'true',PUBLIC_ASICC_BAZAAR_TEST:'true',PUBLIC_ASICC_BAZAAR_EMULATOR:'false',PUBLIC_ASICC_MEMBERS_ENABLED:'true',PUBLIC_ASICC_CLOUDFLARE_TOKEN:'',PUBLIC_ASICC_BAZAAR_WORKER_URL:worker,PUBLIC_ASICC_BAZAAR_TEST_API_KEY:key,PUBLIC_ASICC_BAZAAR_TEST_APP_ID:appId};
const result=spawnSync(process.execPath,[resolve('node_modules/astro/astro.js'),'build'],{env,stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
writeFileSync('dist/_headers','/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n  Referrer-Policy: no-referrer\n');
writeFileSync('dist/robots.txt','User-agent: *\nDisallow: /\n');
for(const lang of ['ko','fr']){
 const home=readFileSync('dist/'+lang+'/index.html','utf8');
 if(!home.includes('/'+lang+'/bazaar/')||!home.includes('noindex')||!home.includes('/'+lang+'/bazaar/admin/'))throw new Error('Integration home validation failed: '+lang);
 for(const route of ['bazaar','bazaar/admin','bazaar/admin/products','bazaar/admin/orders','bazaar/admin/settlement','membres/login','membres/admin'])readFileSync('dist/'+lang+'/'+route+'/index.html');
}
console.log('ASICC full-site integration build ready; no production deploy performed.');
