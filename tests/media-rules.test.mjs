import {test,before,after} from 'node:test';
import fs from 'node:fs';
import {initializeTestEnvironment,assertSucceeds,assertFails} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,deleteDoc,updateDoc,serverTimestamp} from 'firebase/firestore';
let env;
const mkProfile=(uid,role,status='approved')=>({uid,role,status,name:uid,email:`${uid}@example.test`,nickname:uid,nicknameKey:uid,accountType:'adult',createdAt:new Date()});
const ctx=(uid,verified=true)=>env.authenticatedContext(uid,{email:`${uid}@example.test`,email_verified:verified}).firestore();
const attachment=(id,size)=>({id,name:`file${id}.pdf`,mime:'application/pdf',size});
const learning=(uid,total=20000000)=>({
  title:'한글 학습자료',body:'학습 안내',category:'elementary',authorUid:uid,status:'draft',
  files:[attachment('file_00000001',2000000),attachment('file_00000002',18000000)],
  bytesTotal:total,createdAt:serverTimestamp()
});
const gallery=(uid,albumId,reviewReason='')=>({
  albumId,title:'학교 행사',description:'공개 동의 확인',authorUid:uid,status:'draft',
  mediaType:'photo',originalName:'test.webp',reviewReason,sortOrder:1,
  image:{id:'image_00000001',mime:'image/webp',size:1000000},createdAt:serverTimestamp()
});
const album=uid=>({title:'2026 School Day',school:'elementary',year:2026,
  ownerUid:uid,isShared:false,coverItemId:'',createdAt:serverTimestamp(),updatedAt:serverTimestamp()});

before(async()=>{
  env=await initializeTestEnvironment({projectId:'demo-asicc-media-rules',firestore:{
    rules:fs.readFileSync(new URL('../firestore.rules.PROPOSED_ONLY',import.meta.url),'utf8')
  }});
  await env.withSecurityRulesDisabled(async (context)=>{
    await Promise.all(['general','member','special','admin','suspended'].map(role=>setDoc(doc(context.firestore(),'members',role),mkProfile(role,role,role==='suspended'?'suspended':'approved'))));
  });
});
after(async()=>{if(env)await env.cleanup();});

test('general may read learning, not gallery; verified association roles see both',async()=>{
  await env.withSecurityRulesDisabled(async (context)=>{
    await setDoc(doc(context.firestore(),'learningResources','legacyLearn'),{title:'기존 파일',filename:'old.pdf',mime:'application/pdf',storagePath:'learning/legacyLearn/old.pdf',createdBy:'admin',createdAt:new Date()});
    await setDoc(doc(context.firestore(),'galleryItems','legacyPhoto'),{title:'기존 사진',status:'published',albumId:'legacy',createdAt:new Date()});
  });
  await assertSucceeds(getDoc(doc(ctx('general'),'learningResources','legacyLearn')));
  await assertFails(getDoc(doc(ctx('general'),'galleryItems','legacyPhoto')));
  await assertFails(getDoc(doc(ctx('special'),'galleryItems','legacyPhoto')));
  await assertSucceeds(getDoc(doc(ctx('admin'),'galleryItems','legacyPhoto')));
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

test('school category is required and unverified oversized file lists are rejected',async()=>{
  const missing=learning('member');delete missing.category;
  await assertFails(setDoc(doc(ctx('member'),'learningResources','no-category'),missing));
  const many=learning('member',9);
  many.files=Array.from({length:9},(_,i)=>attachment(`file_${String(i).padStart(8,'0')}`,1));
  await assertFails(setDoc(doc(ctx('member'),'learningResources','too-many-attachments'),many));
});

test('only the author can publish a draft; cannot rewrite its file manifest',async()=>{
  const member=ctx('member');
  await assertSucceeds(updateDoc(doc(member,'learningResources','learn-member'),{status:'published',updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(doc(ctx('special'),'learningResources','learn-member'),{status:'published',updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(doc(member,'learningResources','learn-member'),{bytesTotal:1}));
});

test('gallery stays closed for members; admins may stage and review photos',async()=>{
  await assertFails(setDoc(doc(ctx('member'),'galleryAlbums','closed-member'),album('member')));
  await assertSucceeds(setDoc(doc(ctx('admin'),'galleryAlbums','admin-album'),album('admin')));
  await assertSucceeds(setDoc(doc(ctx('admin'),'galleryItems','new-by-admin'),gallery('admin','admin-album')));
  await assertSucceeds(updateDoc(doc(ctx('admin'),'galleryItems','new-by-admin'),{status:'published',updatedAt:serverTimestamp()}));
  await assertFails(getDoc(doc(ctx('special'),'galleryItems','new-by-admin')));
  await assertSucceeds(getDoc(doc(ctx('admin'),'galleryItems','new-by-admin')));
});

test('when opened, verified member and special may create albums and upload photos',async()=>{
  await assertSucceeds(setDoc(doc(ctx('admin'),'siteSettings','gallery'),{
    isOpen:true,updatedBy:'admin',updatedAt:serverTimestamp()
  }));
  try {
    await assertFails(setDoc(doc(ctx('general'),'galleryAlbums','general-album'),album('general')));
    for(const role of ['member','special']){
      const db=ctx(role),albumId=`album-${role}`;
      await assertSucceeds(setDoc(doc(db,'galleryAlbums',albumId),album(role)));
      await assertSucceeds(setDoc(doc(db,'galleryItems',`photo-${role}`),gallery(role,albumId)));
      await assertSucceeds(updateDoc(doc(db,'galleryItems',`photo-${role}`),{status:'published',updatedAt:serverTimestamp()}));
      await assertSucceeds(getDoc(doc(ctx('special'),'galleryItems',`photo-${role}`)));
    }
    await assertFails(getDoc(doc(ctx('general'),'galleryItems','photo-member')));
    // Opt-in review stays private until an administrator explicitly publishes it.
    const owner=ctx('member');
    await assertSucceeds(setDoc(doc(owner,'galleryItems','review-photo'),
      gallery('member','album-member','consent_uncertain')));
    await assertSucceeds(updateDoc(doc(owner,'galleryItems','review-photo'),{
      status:'pending',updatedAt:serverTimestamp()
    }));
    await assertFails(getDoc(doc(ctx('special'),'galleryItems','review-photo')));
    await assertSucceeds(getDoc(doc(ctx('admin'),'galleryItems','review-photo')));
    await assertSucceeds(updateDoc(doc(ctx('admin'),'galleryItems','review-photo'),{
      status:'published',updatedAt:serverTimestamp()
    }));
    await assertSucceeds(getDoc(doc(ctx('special'),'galleryItems','review-photo')));
  } finally {
    await assertSucceeds(setDoc(doc(ctx('admin'),'siteSettings','gallery'),{
      isOpen:false,updatedBy:'admin',updatedAt:serverTimestamp()
    }));
  }
  await assertFails(getDoc(doc(ctx('member'),'galleryItems','photo-special')));
});

test('authors can delete their learning posts; other members cannot',async()=>{
  await assertFails(deleteDoc(doc(ctx('special'),'learningResources','learn-member')));
  await assertSucceeds(deleteDoc(doc(ctx('member'),'learningResources','learn-member')));
});
