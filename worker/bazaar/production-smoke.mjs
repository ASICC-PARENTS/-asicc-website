import assert from 'node:assert/strict';
import worker from './index.mjs';
import {createMail} from './mail.mjs';
import {serverToken} from './auth.mjs';
import {createBazaar} from '../../firebase-functions-bazaar/bazaar/service.mjs';

const env={BAZAAR_MODE:'production',FIREBASE_PROJECT_ID:'asicc-member-space',
  BAZAAR_SITE_URL:'https://asicc-parents.fr',BAZAAR_PUBLIC_OPEN:'false',BAZAAR_PRELAUNCH_READ_ONLY:'true',
  MAIL_MODE:'capture',MAIL_PROVIDER:'brevo'};
const host='https://asicc-bazaar-api.falling-hall-f390.workers.dev';
const request=(path,origin=env.BAZAAR_SITE_URL,target=host)=>
  new Request(target+'/api/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"data":{}}'});
const realFetch=globalThis.fetch;
globalThis.fetch=()=>assert.fail('The release smoke test must not contact external systems');
try {
  for(const route of ['bazaarPublic','bazaarCreateOrder','bazaarBuyerAction']){
    assert.equal((await worker.fetch(request(route),env,{})).status,404);
  }
  assert.equal((await worker.fetch(request('bazaarAdmin','https://asicc-integration-test.pages.dev'),env,{})).status,403);
  assert.equal((await worker.fetch(request('bazaarAdmin'),env,{})).status,401);
  const probe = new Request(host+'/_ops/firestore-readiness',{method:'HEAD'});
  assert.equal((await worker.fetch(probe,env,{})).status,404);
  const token='a'.repeat(64);
  const expiredProbe = new Request(probe,{headers:{Authorization:'Bearer '+token}});
  assert.equal((await worker.fetch(expiredProbe,{...env,BAZAAR_READ_PROBE_TOKEN:token,
    BAZAAR_READ_PROBE_EXPIRES:String(Date.now()-1)},{})).status,404);
  await worker.scheduled({},env,{});
  const unsigned=new Request(host+'/photo/bazaar-photos/production-001/custom-001/'+'a'.repeat(64));
  assert.equal((await worker.fetch(unsigned,env,{})).status,404);
  for (const invalid of [{FIREBASE_PROJECT_ID:'asicc-bazaar-test'},{MAIL_MODE:'api'},{BAZAAR_PUBLIC_OPEN:''},{TEST_MAIL_TO:'invalid@example.test'}]){
    assert.equal((await worker.fetch(request('bazaarAdmin'),{...env,...invalid},{})).status,503);
  }
  assert.equal((await worker.fetch(request('bazaarAdmin',env.BAZAAR_SITE_URL,'https://asicc-bazaar-test-api.falling-hall-f390.workers.dev'),env,{})).status,503);
  const mail=createMail(env,{collection:()=>({doc:()=>({})})});
  assert.equal(mail.canSend(),true);
  await assert.rejects(serverToken({...env,FIRESTORE_CLIENT_EMAIL:'another@asicc-member-space.iam.gserviceaccount.com'}),
    /Unexpected production Firestore service account/);
  let allowed;
  const db={doc:()=>({}),collection:()=>({doc:()=>({})}),
    getAll:async()=>[{data:()=>({role:'admin',status:'approved'})},{exists:allowed!==undefined,data:()=>({adminUids:allowed})}]};
  const svc=createBazaar({db,requireExplicitAdmin:true});
  const admin={auth:{uid:'fixture',token:{email_verified:true}},data:{op:'noSuchOperation'}};
  await assert.rejects(svc.bazaarAdmin(admin),{code:'permission-denied'});
  allowed=['another-fixture'];
  await assert.rejects(svc.bazaarAdmin(admin),{code:'permission-denied'});
  allowed=['fixture'];
  await assert.rejects(svc.bazaarAdmin(admin),{code:'invalid-argument'});
  console.log('Production gate, approved-host boundary, explicit administrator list and capture configuration passed');
} finally{globalThis.fetch=realFetch;}
