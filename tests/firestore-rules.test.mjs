import { test, before, after } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, serverTimestamp, runTransaction } from 'firebase/firestore';

let env;
const EMAIL = uid => `${uid}@example.test`;
const profile = (uid, role, status='approved') => ({name: uid, email: EMAIL(uid), role, status, consent:true, createdAt: new Date()});
const uid = {general:'general', member:'member', special:'special', admin:'admin', suspended:'suspended', unverified:'unverified'};
const seedMember = async (db, key, role, status='approved') => setDoc(doc(db,'members',key), profile(key,role,status));
const context = (key, verified=true) => env.authenticatedContext(key,{email:EMAIL(key),email_verified:verified}).firestore();
const item = (id,folder) => ({title:'test',filename:'test.pdf',mime:'application/pdf',storagePath:`${folder}/${id}/test.pdf`,createdBy:'admin',createdAt:new Date()});

before(async () => {
  env = await initializeTestEnvironment({
    projectId:'demo-asicc-security',
    firestore:{ rules:fs.readFileSync(new URL('../firestore.rules.PROPOSED_ONLY', import.meta.url),'utf8') }
  });
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await Promise.all([
      seedMember(db,uid.general,'general'),
      seedMember(db,uid.member,'member'),
      seedMember(db,uid.special,'special'),
      seedMember(db,uid.admin,'admin'),
      seedMember(db,uid.suspended,'member','suspended'),
      seedMember(db,uid.unverified,'member'),
      setDoc(doc(db,'learningResources','learn1'),item('learn1','learning')),
      setDoc(doc(db,'galleryItems','pic1'),item('pic1','gallery')),
      setDoc(doc(db,'officeDocs','minutes1'),item('minutes1','office')),
      setDoc(doc(db,'boardPosts','post1'),{ title:'test',body:'test',authorUid:uid.member,authorName:uid.member,createdAt:new Date(),updatedAt:new Date(),deleted:false })
    ]);
  });
});
after(async () => { if(env) await env.cleanup(); });

test('anonymous cannot access member profile', async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),'members',uid.admin)));
});
test('own profile readable; others not', async () => {
  const db=context(uid.general);
  await assertSucceeds(getDoc(doc(db,'members',uid.general)));
  await assertFails(getDoc(doc(db,'members',uid.admin)));
});
test('general can see learning but not gallery or office', async () => {
  const db=context(uid.general);
  await assertSucceeds(getDoc(doc(db,'learningResources','learn1')));
  await assertFails(getDoc(doc(db,'galleryItems','pic1')));
  await assertFails(getDoc(doc(db,'officeDocs','minutes1')));
});
test('special has identical gallery permission to member, not office', async () => {
  for (const user of [uid.member,uid.special]) {
    const db=context(user);
    await assertSucceeds(getDoc(doc(db,'galleryItems','pic1')));
    await assertFails(getDoc(doc(db,'officeDocs','minutes1')));
  }
});
test('admin can open office; suspended and unverified cannot open resources', async () => {
  await assertSucceeds(getDoc(doc(context(uid.admin),'officeDocs','minutes1')));
  await assertFails(getDoc(doc(context(uid.suspended),'learningResources','learn1')));
  await assertFails(getDoc(doc(context(uid.unverified,false),'learningResources','learn1')));
});
test('general can read board but not write', async () => {
  const db=context(uid.general);
  await assertSucceeds(getDoc(doc(db,'boardPosts','post1')));
  await assertFails(setDoc(doc(db,'boardPosts','blocked1'),{
    title:'x',body:'hello',authorUid:uid.general,authorName:uid.general,createdAt:serverTimestamp(),updatedAt:serverTimestamp(),deleted:false
  }));
});
test('member and special can write board posts', async () => {
  for (const user of [uid.member,uid.special]) {
    const db=context(user);
    await assertSucceeds(setDoc(doc(db,'boardPosts',`post-${user}`),{
      title:'example',body:'hello',authorUid:user,authorName:user,createdAt:serverTimestamp(),updatedAt:serverTimestamp(),deleted:false
    }));
  }
});
test('self-promotion to admin forbidden', async () => {
  await assertFails(updateDoc(doc(context(uid.general),'members',uid.general),{role:'admin'}));
});
test('general cannot read all member profiles; admin can', async () => {
  await assertFails(getDocs(collection(context(uid.general),'members')));
  await assertSucceeds(getDocs(collection(context(uid.admin),'members')));
});
test('new user may create only approved general member profile', async () => {
  const newuid='new-signup'; const db=context(newuid);
  await assertSucceeds(setDoc(doc(db,'members',newuid),{
    name:'New user',email:EMAIL(newuid),role:'general',status:'approved',consent:true,createdAt:serverTimestamp()
  }));
  const evil='evil-signup';
  await assertFails(setDoc(doc(context(evil),'members',evil),{
    name:'Evil',email:EMAIL(evil),role:'admin',status:'approved',consent:true,createdAt:serverTimestamp()
  }));
});
test('general member can file request to become association member', async () => {
  const db=context(uid.general);
  await assertSucceeds(setDoc(doc(db,'upgradeRequests',uid.general),{
    uid:uid.general,applicantName:uid.general,applicantEmail:EMAIL(uid.general),
    requestedRole:'member',kind:'parent',schoolYear:null,note:'test',status:'pending',createdAt:serverTimestamp()
  }));
});
test('non-admin cannot approve request or change another member role', async () => {
  const db=context(uid.member);
  await assertFails(updateDoc(doc(db,'upgradeRequests',uid.general),{status:'approved'}));
  await assertFails(updateDoc(doc(db,'members',uid.general),{role:'special'}));
});
test('admin may approve member upgrade using transaction', async () => {
  const db=context(uid.admin);
  await assertSucceeds(runTransaction(db,async tx => {
    const reqRef=doc(db,'upgradeRequests',uid.general);
    const memRef=doc(db,'members',uid.general);
    const req=await tx.get(reqRef);
    const mem=await tx.get(memRef);
    assert.equal(req.data().status,'pending');
    assert.equal(mem.data().role,'general');
    tx.update(memRef,{role:'member'});
    tx.update(reqRef,{status:'approved',reviewedBy:uid.admin,reviewedAt:serverTimestamp()});
  }));
});
test('all unspecified collections are denied', async () => {
  await assertFails(getDoc(doc(context(uid.admin),'studentDirectory','student1')));
});

// Staging safety: public intake is not launched yet. These requests must fail.
test('anonymous newsletter subscription is disabled in staging', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(db,'subscribers','untrusted1'), {
    email:'test@example.test', lang:'ko', pageLang:'ko', consent:true,
    date:'2026-11-18', createdAt:serverTimestamp()
  }));
});
test('anonymous contact messages are disabled in staging', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(db,'messages','untrusted1'), {
    name:'Test', email:'test@example.test', message:'Test', consent:true,
    createdAt:serverTimestamp()
  }));
});
test('anonymous registrations are disabled in staging', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(db,'registrations','untrusted1'), {
    name:'Test', email:'test@example.test', message:'Test', consent:true,
    createdAt:serverTimestamp()
  }));
});
