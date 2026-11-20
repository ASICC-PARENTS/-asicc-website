import {test,before,after} from 'node:test';
import fs from 'node:fs';
import {initializeTestEnvironment,assertSucceeds,assertFails} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,deleteDoc,updateDoc,serverTimestamp} from 'firebase/firestore';
let env;
const mkProfile=(uid,role,status='approved')=>({uid,role,status,name:uid,email:`${uid}@example.test`,nickname:uid,createdAt:new Date()});
const ctx=(uid,verified=true)=>env.authenticatedContext(uid,{email:`${uid}@example.test`,email_verified:verified}).firestore();
const attachment=(id,size)=>({id,name:`file${id}.pdf`,mime:'application/pdf',size});
const learning=(uid,total=20000000)=>({
  title:'한글 학습자료',body:'학습 안내',authorUid:uid,status:'draft',
  files:[attachment('file_00000001',2000000),attachment('file_00000002',18000000)],
  bytesTotal:total,createdAt:serverTimestamp()
});
const gallery=(uid)=>({title:'학교 행사',description:'공개 동의 확인',authorUid:uid,status:'draft',
  image:{id:'image_00000001',mime:'image/webp',size:1000000},createdAt:serverTimestamp()});

before(async()=>{
  env=await initializeTestEnvironment({projectId:'demo-asicc-media-rules',firestore:{
    rules:fs.readFileSync(new URL('../firestore.rules.PROPOSED_ONLY',import.meta.url),'utf8')
  }});
  await env.withSecurityRulesDisabled(async ({firestore})=>{
    await Promise.all(['general','member','special','admin','suspended'].map(role=>setDoc(doc(firestore(),'members',role),mkProfile(role,role,role==='suspended'?'suspended':'approved'))));
  });
});
after(async()=>{if(env)await env.cleanup();});

test('general may read learning, not gallery; verified association roles see both',async()=>{
  await env.withSecurityRulesDisabled(async ({firestore})=>{
    await setDoc(doc(firestore(),'learningResources','legacyLearn'),{title:'기존 파일',filename:'old.pdf',mime:'application/pdf',storagePath:'learning/legacyLearn/old.pdf',createdBy:'admin',createdAt:new Date()});
    await setDoc(doc(firestore(),'galleryItems','legacyPhoto'),{title:'기존 사진',filename:'old.webp',mime:'image/webp',storagePath:'gallery/legacyPhoto/old.webp',createdBy:'admin',createdAt:new Date()});
  });
  await assertSucceeds(getDoc(doc(ctx('general'),'learningResources','legacyLearn')));
  await assertFails(getDoc(doc(ctx('general'),'galleryItems','legacyPhoto')));
  await assertSucceeds(getDoc(doc(ctx('special'),'galleryItems','legacyPhoto')));
  await assertFails(getDoc(doc(ctx('suspended'),'learningResources','legacyLearn')));
});

test('general cannot publish learning resources, but association/special/admin can',async()=>{
  await assertFails(setDoc(doc(ctx('general'),'learningResources','learn-general'),learning('general')));
  await assertSucceeds(setDoc(doc(ctx('member'),'learningResources','learn-member'),learning('member')));
  await assertSucceeds(setDoc(doc(ctx('special'),'learningResources','learn-special'),learning('special')));
  await assertSucceeds(setDoc(doc(ctx('admin'),'learningResources','learn-admin'),learning('admin')));
});

test('Firestore rejects post declared over 20MB and invalid attachments',async()=>{
  await assertFails(setDoc(doc(ctx('member'),'learningResources','too-big'),learning('member',20000001)));
  const bad=learning('member');bad.files[1].mime='application/x-msdownload';
  await assertFails(setDoc(doc(ctx('member'),'learningResources','exe-file'),bad));
});

test('only the author can publish a draft; cannot rewrite its file manifest',async()=>{
  const member=ctx('member');
  await assertSucceeds(updateDoc(doc(member,'learningResources','learn-member'),{status:'published',updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(doc(ctx('special'),'learningResources','learn-member'),{status:'published',updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(doc(member,'learningResources','learn-member'),{bytesTotal:1}));
});

test('gallery publishing is admin-only; member/special can view but not create',async()=>{
  await assertFails(setDoc(doc(ctx('member'),'galleryItems','new-by-member'),gallery('member')));
  await assertFails(setDoc(doc(ctx('special'),'galleryItems','new-by-special'),gallery('special')));
  await assertSucceeds(setDoc(doc(ctx('admin'),'galleryItems','new-by-admin'),gallery('admin')));
  await assertSucceeds(updateDoc(doc(ctx('admin'),'galleryItems','new-by-admin'),{status:'published',updatedAt:serverTimestamp()}));
  await assertSucceeds(getDoc(doc(ctx('member'),'galleryItems','new-by-admin')));
  await assertFails(getDoc(doc(ctx('general'),'galleryItems','new-by-admin')));
});

test('authors can delete their learning posts; other members cannot',async()=>{
  await assertFails(deleteDoc(doc(ctx('special'),'learningResources','learn-member')));
  await assertSucceeds(deleteDoc(doc(ctx('member'),'learningResources','learn-member')));
});
