import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initializeTestEnvironment,assertSucceeds,assertFails} from '@firebase/rules-unit-testing';
import {doc,getDoc,getDocs,collection,setDoc,updateDoc,deleteDoc,runTransaction,serverTimestamp} from 'firebase/firestore';

let env;
const email=uid=>`${uid}@example.test`;
const context=uid=>env.authenticatedContext(uid,{email:email(uid),email_verified:true}).firestore();
const profile=(uid,role='general')=>({name:uid,nickname:uid,nicknameKey:uid,
  email:email(uid),role,status:'approved',createdAt:new Date(),consent:true});

before(async()=>{
  env=await initializeTestEnvironment({projectId:'demo-asicc-admin-rules',firestore:{
    rules:fs.readFileSync(new URL('../firestore.rules.PROPOSED_ONLY',import.meta.url),'utf8')
  }});
  await env.withSecurityRulesDisabled(async ctx=>{
    for(const [uid,role] of [['admin','admin'],['general','general'],['member','member'],
      ['special','special'],['editme','member'],['statusme','member'],['nickold','member']]) {
      await setDoc(doc(ctx.firestore(),'members',uid),profile(uid,role));
    }
    await setDoc(doc(ctx.firestore(),'nicknames','nickold'),{uid:'nickold',nickname:'nickold',createdAt:new Date()});
    await setDoc(doc(ctx.firestore(),'publicNames','nickold'),{nickname:'nickold',updatedAt:new Date()});
  });
});
after(async()=>{if(env)await env.cleanup();});

test('admin can view member profiles; ordinary members cannot list or inspect others',async()=>{
  await assertSucceeds(getDoc(doc(context('admin'),'members','member')));
  await assertSucceeds(getDoc(doc(context('member'),'members','member')));
  await assertFails(getDoc(doc(context('general'),'members','member')));
  await assertFails(getDocs(collection(context('general'),'members')));
});

test('admin can edit name, contact information, school levels and student details',async()=>{
  await assertSucceeds(updateDoc(doc(context('admin'),'members','editme'),{
    name:'Edited Name',phone:'+33 00 00 00 00 00',levels:['elem'],
    memberKind:'parent',memberRelation:'mother',
    children:[{studentName:'Child One',school:'Public school',grade:'CM1'}]
  }));
});

test('admin can change another member role and account status',async()=>{
  await assertSucceeds(updateDoc(doc(context('admin'),'members','statusme'),{role:'special',status:'suspended'}));
});

test('admin may not alter auth identity, timestamps, or grant invalid roles',async()=>{
  await assertFails(updateDoc(doc(context('admin'),'members','editme'),{email:'attacker@example.test'}));
  await assertFails(updateDoc(doc(context('admin'),'members','editme'),{createdAt:new Date()}));
  await assertFails(updateDoc(doc(context('admin'),'members','editme'),{role:'superadmin'}));
});

test('members cannot edit others or elevate their own role; admin cannot change their own role',async()=>{
  await assertFails(updateDoc(doc(context('member'),'members','editme'),{phone:'12345'}));
  await assertFails(updateDoc(doc(context('general'),'members','general'),{role:'admin'}));
  await assertFails(updateDoc(doc(context('admin'),'members','admin'),{role:'general'}));
});

test('new member and withdrawal acknowledgement belongs to each admin only',async()=>{
  await assertSucceeds(setDoc(doc(context('admin'),'adminNotificationAcks','admin'),{
    acknowledgedAt:serverTimestamp()
  }));
  await assertSucceeds(getDoc(doc(context('admin'),'adminNotificationAcks','admin')));
  await assertFails(setDoc(doc(context('member'),'adminNotificationAcks','member'),{
    acknowledgedAt:serverTimestamp()
  }));
  await assertFails(setDoc(doc(context('admin'),'adminNotificationAcks','general'),{
    acknowledgedAt:serverTimestamp()
  }));
});

test('members can request their own withdrawal; admin can review but others cannot list',async()=>{
  await assertSucceeds(setDoc(doc(context('general'),'memberWithdrawalRequests','general'),{
    uid:'general',name:'general',email:email('general'),status:'pending',
    requestedAt:serverTimestamp()
  }));
  await assertSucceeds(getDoc(doc(context('admin'),'memberWithdrawalRequests','general')));
  await assertSucceeds(getDocs(collection(context('admin'),'memberWithdrawalRequests')));
  await assertFails(getDocs(collection(context('member'),'memberWithdrawalRequests')));
  await assertFails(setDoc(doc(context('member'),'memberWithdrawalRequests','special'),{
    uid:'special',name:'special',email:email('special'),status:'pending',
    requestedAt:serverTimestamp()
  }));
});

test('nickname cannot change without coordinated reservation and public alias updates',async()=>{
  await assertFails(updateDoc(doc(context('admin'),'members','nickold'),{
    nickname:'nicknew',nicknameKey:'nicknew'
  }));
  const db=context('admin');
  await assertSucceeds(runTransaction(db,async tx=>{
    const memberRef=doc(db,'members','nickold');
    const newRef=doc(db,'nicknames','nicknew');
    const previousRef=doc(db,'nicknames','nickold');
    const aliasRef=doc(db,'publicNames','nickold');
    await tx.get(memberRef);
    await tx.get(newRef);
    tx.set(newRef,{uid:'nickold',nickname:'nicknew',createdAt:serverTimestamp()});
    tx.update(memberRef,{nickname:'nicknew',nicknameKey:'nicknew'});
    tx.set(aliasRef,{nickname:'nicknew',role:'member',canReceiveDM:false,updatedAt:serverTimestamp()});
    tx.delete(previousRef);
  }));
});


test('homepage banner is publicly readable but cannot be listed or edited by ordinary users',async()=>{
  const data={
    enabled:true,link:'news/2026-10-08-admissions/',
    eyebrow_ko:'모집 안내',eyebrow_fr:'Admissions',
    title_ko:'유치원 모집',title_fr:'Inscriptions ouvertes',
    body_ko:'모집 공고를 확인하세요',body_fr:'Consultez l’annonce',
    status_ko:'모집 중',status_fr:'Ouvert',
    button_ko:'모집 공지 보기',button_fr:'Lire l’annonce',
    updatedBy:'admin',updatedAt:serverTimestamp()
  };
  const adminDb=context('admin');
  await assertSucceeds(setDoc(doc(adminDb,'publicHomeBanners','admissions'),data));
  const guest=env.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(guest,'publicHomeBanners','admissions')));
  await assertFails(getDocs(collection(guest,'publicHomeBanners')));
  await assertFails(getDoc(doc(guest,'publicHomeBanners','unknown')));
  await assertFails(setDoc(doc(context('general'),'publicHomeBanners','bazaar'),{...data,updatedBy:'general'}));
  await assertFails(setDoc(doc(context('member'),'publicHomeBanners','bazaar'),{...data,updatedBy:'member'}));
  await assertFails(deleteDoc(doc(context('special'),'publicHomeBanners','admissions')));
  await assertSucceeds(deleteDoc(doc(adminDb,'publicHomeBanners','admissions')));
});

test('homepage banner validation rejects extra fields and unsafe links',async()=>{
  const db=context('admin');
  const data={enabled:true,link:'news/test-notice/',eyebrow_ko:'',eyebrow_fr:'',
    title_ko:'제목',title_fr:'Titre',body_ko:'설명',body_fr:'Description',
    status_ko:'',status_fr:'',button_ko:'보기',button_fr:'Voir',
    updatedBy:'admin',updatedAt:serverTimestamp()};
  const path=doc(db,'publicHomeBanners','bazaar');
  await assertFails(setDoc(path,{...data,link:'javascript:alert(1)'}));
  await assertFails(setDoc(path,{...data,memberEmail:'private@example.org'}));
  await assertFails(setDoc(path,{...data,title_ko:'X'.repeat(121)}));
  await assertFails(setDoc(path,{...data,updatedBy:'member'}));
  await assertFails(setDoc(doc(db,'publicHomeBanners','other'),data));
  await assertSucceeds(setDoc(path,data));
  await assertSucceeds(updateDoc(path,{title_ko:'수정됨',updatedAt:serverTimestamp()}));
  for(const slot of ['bazaar','admissions']){
    const ref=doc(db,'publicHomeBanners',slot);
    await assertSucceeds(setDoc(ref,{...data,link:'bazaar/?event=bazaar-test-original'}));
    await assertFails(setDoc(ref,{...data,link:'bazaar/?event=bazaar-test-original&other=value'}));
  }
});


test('staging banners are isolated from public production banner documents',async()=>{
  const data={enabled:true,link:'news/2026-11-22-bazaar/',eyebrow_ko:'',eyebrow_fr:'',
    title_ko:'바자회',title_fr:'Bazar',body_ko:'준비 중',body_fr:'Bientôt',
    status_ko:'',status_fr:'',button_ko:'보기',button_fr:'Voir',updatedBy:'admin',updatedAt:serverTimestamp()};
  const guest=env.unauthenticatedContext().firestore();
  const prodRef=doc(guest,'publicHomeBanners','bazaar');
  const prodBefore=await assertSucceeds(getDoc(prodRef));
  await assertSucceeds(setDoc(doc(context('admin'),'publicHomeBannersTest','bazaar'),data));
  const staging=await assertSucceeds(getDoc(doc(guest,'publicHomeBannersTest','bazaar')));
  const prodAfter=await assertSucceeds(getDoc(prodRef));
  assert.equal(staging.exists(),true,'the staging banner should exist');
  assert.equal(prodAfter.exists(),prodBefore.exists(),'staging must not create or delete production');
  if(prodBefore.exists())assert.deepEqual(prodAfter.data(),prodBefore.data(),'staging must not change production content');
  await assertFails(setDoc(doc(context('member'),'publicHomeBannersTest','bazaar'),{...data,updatedBy:'member'}));
});
