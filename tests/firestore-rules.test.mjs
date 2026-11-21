
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} from '@firebase/rules-unit-testing';
import {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  runTransaction
} from 'firebase/firestore';

import { deleteDoc, writeBatch } from 'firebase/firestore';

let env;

const EMAIL = uid => `${uid}@example.test`;

const profile = (uid, role, status = 'approved') => ({
  name: uid,
  nickname: uid,
  nicknameKey: uid,
  accountType: 'adult',
  email: EMAIL(uid),
  role,
  status,
  consent: true,
  createdAt: new Date()
});

const uid = {
  general: 'general',
  member: 'member',
  special: 'special',
  admin: 'admin',
  suspended: 'suspended',
  unverified: 'unverified'
};

const seedMember = async (db, key, role, status = 'approved') =>
  setDoc(doc(db, 'members', key), profile(key, role, status));

const context = (key, verified = true) =>
  env.authenticatedContext(key, {
    email: EMAIL(key),
    email_verified: verified
  }).firestore();

const item = (id, folder) => ({
  title: 'test',
  filename: 'test.pdf',
  mime: 'application/pdf',
  storagePath: `${folder}/${id}/test.pdf`,
  createdBy: 'admin',
  createdAt: new Date()
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-asicc-security',
    firestore: {
      rules: fs.readFileSync(
        new URL('../firestore.rules.PROPOSED_ONLY', import.meta.url),
        'utf8'
      )
    }
  });

  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();

    await Promise.all([
      seedMember(db, uid.general, 'general'),
      seedMember(db, uid.member, 'member'),
      seedMember(db, uid.special, 'special'),
      seedMember(db, uid.admin, 'admin'),
      seedMember(db, uid.suspended, 'member', 'suspended'),
      seedMember(db, uid.unverified, 'member'),

      setDoc(
        doc(db, 'learningResources', 'learn1'),
        item('learn1', 'learning')
      ),

      setDoc(doc(db, 'nicknames', 'member'), {
        uid: 'member', nickname: 'member', createdAt: new Date()
      }),
      setDoc(doc(db, 'publicNames', 'member'), {
        nickname: 'member', role: 'member', canReceiveDM: true, updatedAt: new Date()
      }),
      setDoc(
        doc(db, 'galleryItems', 'pic1'),
        {...item('pic1', 'gallery'), status:'published', mediaType:'photo', albumId:'album-seed'}
      ),

      setDoc(
        doc(db, 'officeDocs', 'minutes1'),
        item('minutes1', 'office')
      ),

      setDoc(doc(db, 'boardPosts', 'post1'), {
        title: 'test',
        body: 'test',
        authorUid: uid.member,
        authorName: '기존회원',
        createdAt: new Date(),
        updatedAt: new Date(),
        deleted: false
      })
    ]);
  });
});

after(async () => {
  if (env) await env.cleanup();
});

// =====================================================
// ORIGINAL TESTS 1-17
// =====================================================

test('anonymous cannot access member profile', async () => {
  await assertFails(
    getDoc(
      doc(
        env.unauthenticatedContext().firestore(),
        'members',
        uid.admin
      )
    )
  );
});

test('own profile readable; others not', async () => {
  const db = context(uid.general);

  await assertSucceeds(
    getDoc(doc(db, 'members', uid.general))
  );

  await assertFails(
    getDoc(doc(db, 'members', uid.admin))
  );
});

test('general can see learning but not gallery or office', async () => {
  const db = context(uid.general);

  await assertSucceeds(
    getDoc(doc(db, 'learningResources', 'learn1'))
  );

  await assertFails(
    getDoc(doc(db, 'galleryItems', 'pic1'))
  );

  await assertFails(
    getDoc(doc(db, 'officeDocs', 'minutes1'))
  );
});

test('closed gallery: only admin can inspect photos; both member and special are blocked', async () => {
  await assertSucceeds(getDoc(doc(context(uid.admin), 'galleryItems', 'pic1')));
  for (const user of [uid.member, uid.special]) {
    await assertFails(getDoc(doc(context(user), 'galleryItems', 'pic1')));
    await assertFails(getDoc(doc(context(user), 'officeDocs', 'minutes1')));
  }
});

test('opened gallery: member and special can view equally, general remains blocked', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(),'siteSettings','gallery'), {isOpen:true});
  });
  try {
    for (const user of [uid.member, uid.special]) {
      await assertSucceeds(getDoc(doc(context(user), 'galleryItems', 'pic1')));
    }
    await assertFails(getDoc(doc(context(uid.general), 'galleryItems', 'pic1')));
  } finally {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(),'siteSettings','gallery'), {isOpen:false});
    });
  }
});

test('admin can open office; suspended and unverified cannot open resources', async () => {
  await assertSucceeds(
    getDoc(
      doc(context(uid.admin), 'officeDocs', 'minutes1')
    )
  );

  await assertFails(
    getDoc(
      doc(context(uid.suspended), 'learningResources', 'learn1')
    )
  );

  await assertFails(
    getDoc(
      doc(context(uid.unverified, false), 'learningResources', 'learn1')
    )
  );
});

test('general can read board but not write', async () => {
  const db = context(uid.general);

  await assertSucceeds(
    getDoc(doc(db, 'boardPosts', 'post1'))
  );

  await assertFails(
    setDoc(doc(db, 'boardPosts', 'blocked1'), {
      title: 'x',
      body: 'hello',
      authorUid: uid.general,
      authorName: uid.general,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      deleted: false
    })
  );
});

test('member and special can write board posts', async () => {
  for (const user of [uid.member, uid.special]) {
    const db = context(user);

    await assertSucceeds(
      setDoc(doc(db, 'boardPosts', `post-${user}`), {
        title: 'example',
        body: 'hello',
        authorUid: user,
        authorName: '기존회원',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        deleted: false
      })
    );
  }
});

test('self-promotion to admin forbidden', async () => {
  await assertFails(
    updateDoc(
      doc(context(uid.general), 'members', uid.general),
      { role: 'admin' }
    )
  );
});

test('general cannot read all member profiles; admin can', async () => {
  await assertFails(
    getDocs(collection(context(uid.general), 'members'))
  );

  await assertSucceeds(
    getDocs(collection(context(uid.admin), 'members'))
  );
});

test('new user may create only approved general member profile', async () => {
  const newuid = 'new-signup';
  const db = context(newuid);
  const batch = writeBatch(db);
  batch.set(doc(db,'members',newuid),{
    name:'New user',nickname:'NewTester',nicknameKey:'newtester',email:EMAIL(newuid),
    role:'general',status:'approved',accountType:'adult',consent:true,termsVersion:'2026-11',
    termsAcceptedAt:serverTimestamp(),createdAt:serverTimestamp()
  });
  batch.set(doc(db,'nicknames','newtester'),{
    uid:newuid,nickname:'NewTester',createdAt:serverTimestamp()
  });
  batch.set(doc(db,'publicNames',newuid),{
    nickname:'NewTester',role:'general',canReceiveDM:true,updatedAt:serverTimestamp()
  });
  await assertSucceeds(batch.commit());
  const evil='evil-signup';
  await assertFails(setDoc(doc(context(evil),'members',evil),{
    name:'Evil',email:EMAIL(evil),role:'admin',status:'approved',
    consent:true,createdAt:serverTimestamp()
  }));
});

test('student registration can only publish a non-messageable public alias', async () => {
  const studentId='student-test', db=context(studentId);
  const b=writeBatch(db);
  b.set(doc(db,'members',studentId),{
    name:'Student Test',nickname:'YoungGuest',nicknameKey:'youngguest',
    email:EMAIL(studentId),role:'general',status:'approved',accountType:'student',
    consent:true,termsVersion:'2026-11',termsAcceptedAt:serverTimestamp(),createdAt:serverTimestamp()
  });
  b.set(doc(db,'nicknames','youngguest'),{uid:studentId,nickname:'YoungGuest',createdAt:serverTimestamp()});
  b.set(doc(db,'publicNames',studentId),{
    nickname:'YoungGuest',role:'general',canReceiveDM:false,updatedAt:serverTimestamp()
  });
  await assertSucceeds(b.commit());
  await assertFails(updateDoc(doc(db,'publicNames',studentId),{canReceiveDM:true,updatedAt:serverTimestamp()}));
});

test('student information and both years are mandatory for alumni upgrade requests', async () => {
  const applicant='alumni-applicant', db=context(applicant);
  await env.withSecurityRulesDisabled(async ctx=>{
    await setDoc(doc(ctx.firestore(),'members',applicant),profile(applicant,'general'));
  });
  const ref=doc(db,'upgradeRequests',applicant);
  const base={uid:applicant,applicantName:applicant,applicantEmail:EMAIL(applicant),
    requestedRole:'special',kind:'alumni-parent',status:'pending',note:'Old school records',
    relation:'mother',createdAt:serverTimestamp()};
  await assertFails(setDoc(ref,{...base,startYear:null,schoolYear:2022,children:[
    {studentName:'Child',school:'Primary',grade:'CM2'}]}));
  await assertFails(setDoc(ref,{...base,startYear:2020,schoolYear:2022,children:[]}));
  await assertSucceeds(setDoc(ref,{...base,startYear:2020,schoolYear:2022,children:[
    {studentName:'Child',school:'Primary',grade:'CM2'}]}));
});

test('minor/student cannot send or receive private messages; general may message admin only', async () => {
  const adminDb=context(uid.admin);
  await assertSucceeds(setDoc(doc(adminDb,'siteSettings','messaging'),{
    enabled:true,updatedBy:uid.admin,updatedAt:serverTimestamp()
  }));
  const message=(sender,recipient)=>({senderUid:sender,recipientUid:recipient,
    body:'Hello',readAt:null,createdAt:serverTimestamp()});
  await assertFails(setDoc(doc(context('student-test'),'privateMessages','student-out'),
    message('student-test',uid.admin)));
  await assertFails(setDoc(doc(context(uid.member),'privateMessages','student-in'),
    message(uid.member,'student-test')));
  await assertSucceeds(setDoc(doc(context(uid.general),'privateMessages','general-to-admin'),
    message(uid.general,uid.admin)));
  await assertFails(setDoc(doc(context(uid.general),'privateMessages','general-to-member'),
    message(uid.general,uid.member)));
});

test('general member can file request to become association member', async () => {
  const db = context(uid.general);

  await assertSucceeds(
    setDoc(doc(db, 'upgradeRequests', uid.general), {
      uid: uid.general,
      applicantName: uid.general,
      applicantEmail: EMAIL(uid.general),
      requestedRole: 'member',
      kind: 'parent',
      schoolYear: null,
      startYear: null,
      relation: 'mother',
      children: [{studentName:'Student One',school:'Primary',grade:'CM1'}],
      note: 'test',
      status: 'pending',
      createdAt: serverTimestamp()
    })
  );
});

test('non-admin cannot approve request or change another member role', async () => {
  const db = context(uid.member);

  await assertFails(
    updateDoc(
      doc(db, 'upgradeRequests', uid.general),
      { status: 'approved' }
    )
  );

  await assertFails(
    updateDoc(
      doc(db, 'members', uid.general),
      { role: 'special' }
    )
  );
});

test('admin may approve member upgrade using transaction', async () => {
  const db = context(uid.admin);

  await assertSucceeds(
    runTransaction(db, async tx => {
      const reqRef = doc(db, 'upgradeRequests', uid.general);
      const memRef = doc(db, 'members', uid.general);

      const req = await tx.get(reqRef);
      const mem = await tx.get(memRef);

      assert.equal(req.data().status, 'pending');
      assert.equal(mem.data().role, 'general');

      tx.update(memRef, {
        role: 'member'
      });
      tx.set(doc(db,'publicNames',uid.general), {
        nickname: uid.general, role: 'member', canReceiveDM: true,
        updatedAt: serverTimestamp()
      });

      tx.update(reqRef, {
        status: 'approved',
        reviewedBy: uid.admin,
        reviewedAt: serverTimestamp()
      });
    })
  );
});

test('all unspecified collections are denied', async () => {
  await assertFails(
    getDoc(
      doc(context(uid.admin), 'studentDirectory', 'student1')
    )
  );
});

test('anonymous newsletter subscription is disabled in staging', async () => {
  const db = env.unauthenticatedContext().firestore();

  await assertFails(
    setDoc(doc(db, 'subscribers', 'untrusted1'), {
      email: 'test@example.test',
      lang: 'ko',
      pageLang: 'ko',
      consent: true,
      date: '2026-11-18',
      createdAt: serverTimestamp()
    })
  );
});

test('anonymous contact messages are disabled in staging', async () => {
  const db = env.unauthenticatedContext().firestore();

  await assertFails(
    setDoc(doc(db, 'messages', 'untrusted1'), {
      name: 'Test',
      email: 'test@example.test',
      message: 'Test',
      consent: true,
      createdAt: serverTimestamp()
    })
  );
});

test('anonymous registrations are disabled in staging', async () => {
  const db = env.unauthenticatedContext().firestore();

  await assertFails(
    setDoc(doc(db, 'registrations', 'untrusted1'), {
      name: 'Test',
      email: 'test@example.test',
      message: 'Test',
      consent: true,
      createdAt: serverTimestamp()
    })
  );
});

// =====================================================
// NEW TEST 18
// Post owners may edit.
// Admins may NOT rewrite posts by other members.
// =====================================================

test('post owner may edit; admin and other members may not rewrite it', async () => {
  const postId = 'post1';

  // Original author can edit the post.
  await assertSucceeds(
    updateDoc(
      doc(context(uid.member), 'boardPosts', postId),
      {
        title: 'Edited by original author',
        body: 'Updated by original author',
        updatedAt: serverTimestamp()
      }
    )
  );

  // Admin cannot change another person's title or body.
  await assertFails(
    updateDoc(
      doc(context(uid.admin), 'boardPosts', postId),
      {
        title: 'Admin tried to rewrite the title',
        updatedAt: serverTimestamp()
      }
    )
  );

  // Another association member cannot edit this post.
  await assertFails(
    updateDoc(
      doc(context(uid.special), 'boardPosts', postId),
      {
        body: 'Another member tried to rewrite it',
        updatedAt: serverTimestamp()
      }
    )
  );
});

// =====================================================
// NEW TEST 19
// Admin may hide another member's post.
// =====================================================

test('admin may hide another member post', async () => {
  const postId = 'post-for-admin-hide';

  // Create a separate post to avoid affecting other tests.
  await assertSucceeds(
    setDoc(
      doc(context(uid.member), 'boardPosts', postId),
      {
        title: 'Post to be hidden',
        body: 'Original content',
        authorUid: uid.member,
        authorName: '기존회원',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        deleted: false
      }
    )
  );

  // Hide with a private archive so an administrator can restore the original.
  const db=context(uid.admin),batch=writeBatch(db);
  batch.set(doc(db,'hiddenPosts',postId),{
    title:'Post to be hidden',body:'Original content',authorUid:uid.member,
    hiddenBy:uid.admin,hiddenAt:serverTimestamp()
  });
  batch.update(doc(db,'boardPosts',postId),{
    deleted:true,title:'[숨김 처리된 게시글]',body:'[숨김 처리된 게시글]',
    updatedAt:serverTimestamp()
  });
  await assertSucceeds(batch.commit());
  await assertFails(getDoc(doc(context(uid.member),'hiddenPosts',postId)));
  const redacted=await assertSucceeds(getDoc(doc(context(uid.member),'boardPosts',postId)));
  assert.equal(redacted.data().body,'[숨김 처리된 게시글]');
});

// =====================================================
// NEW TEST 20
// Comment owner may edit.
// Admin cannot rewrite another member's comment.
// Admin may hide that comment.
// =====================================================

test('comment owner may edit; admin cannot rewrite but may hide', async () => {
  const postId = 'post1';
  const commentId = 'comment-permission-test';

  // Member creates a comment.
  await assertSucceeds(
    setDoc(
      doc(
        context(uid.member),
        'boardPosts',
        postId,
        'comments',
        commentId
      ),
      {
        body: 'Original member comment',
        authorUid: uid.member,
        authorName: '기존회원',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        deleted: false
      }
    )
  );

  // Original commenter can edit their own comment.
  await assertSucceeds(
    updateDoc(
      doc(
        context(uid.member),
        'boardPosts',
        postId,
        'comments',
        commentId
      ),
      {
        body: 'Edited by the original commenter',
        updatedAt: serverTimestamp()
      }
    )
  );

  // Admin cannot rewrite someone else's comment.
  await assertFails(
    updateDoc(
      doc(
        context(uid.admin),
        'boardPosts',
        postId,
        'comments',
        commentId
      ),
      {
        body: 'Admin tried to rewrite the comment',
        updatedAt: serverTimestamp()
      }
    )
  );

  // Another member cannot rewrite the comment either.
  await assertFails(
    updateDoc(
      doc(
        context(uid.special),
        'boardPosts',
        postId,
        'comments',
        commentId
      ),
      {
        body: 'Different member tried to rewrite it',
        updatedAt: serverTimestamp()
      }
    )
  );

  // Admin hides the comment, retaining the original in a private archive.
  const db=context(uid.admin),batch=writeBatch(db);
  batch.set(doc(db,'hiddenComments',`${postId}_${commentId}`),{
    postId,commentId,body:'Edited by the original commenter',authorUid:uid.member,
    hiddenBy:uid.admin,hiddenAt:serverTimestamp()
  });
  batch.update(doc(db,'boardPosts',postId,'comments',commentId),{
    body:'[숨김 처리된 댓글]',deleted:true,updatedAt:serverTimestamp()
  });
  await assertSucceeds(batch.commit());
  await assertFails(getDoc(doc(context(uid.member),'hiddenComments',`${postId}_${commentId}`)));
});


// Additional tests 21–24: permanent deletion and audit logs

const seedPostForDeletion = async (postId, owner = uid.member, withComment = true) => {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();

    await setDoc(doc(db, 'boardPosts', postId), {
      title: 'to delete',
      body: 'to delete',
      authorUid: owner,
      authorName: owner,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false
    });

    if (withComment) {
      await setDoc(doc(db, 'boardPosts', postId, 'comments', 'comment-a'), {
        body: 'reply',
        authorUid: uid.special,
        authorName: uid.special,
        createdAt: new Date(),
        updatedAt: new Date(),
        deleted: false
      });
    }
  });
};

const audit = (postId, authorUid, actorUid, reason, type = 'post', commentId = '') => ({
  targetType: type,
  postId,
  commentId,
  authorUid,
  actorUid,
  reason,
  deletedAt: serverTimestamp()
});

test('author may permanently delete own post with comments and audit log', async () => {
  const postId = 'delete-own-post';
  await seedPostForDeletion(postId);

  const db = context(uid.member);
  const b = writeBatch(db);

  b.delete(doc(db, 'boardPosts', postId, 'comments', 'comment-a'));
  b.delete(doc(db, 'boardPosts', postId));
  b.set(doc(db, 'boardDeletionLogs', `post_${postId}`),
    audit(postId, uid.member, uid.member, 'author_request'));

  await assertSucceeds(b.commit());

  const found = await assertSucceeds(getDoc(doc(db, 'boardPosts', postId)));
  assert.equal(found.exists(), false);

  await assertFails(getDoc(doc(db, 'boardDeletionLogs', `post_${postId}`)));
  await assertSucceeds(getDoc(doc(context(uid.admin), 'boardDeletionLogs', `post_${postId}`)));
});

test('delete without audit record denied; unrelated member denied', async () => {
  const postId = 'delete-no-log';
  await seedPostForDeletion(postId, uid.member, false);

  await assertFails(deleteDoc(doc(context(uid.member), 'boardPosts', postId)));

  const db = context(uid.special);
  const b = writeBatch(db);

  b.delete(doc(db, 'boardPosts', postId));
  b.set(doc(db, 'boardDeletionLogs', `post_${postId}`),
    audit(postId, uid.member, uid.special, 'author_request'));

  await assertFails(b.commit());
});

test('admin may delete other author post with logged spam reason', async () => {
  const postId = 'delete-admin-post';
  await seedPostForDeletion(postId);

  const db = context(uid.admin);
  const b = writeBatch(db);

  b.delete(doc(db, 'boardPosts', postId, 'comments', 'comment-a'));
  b.delete(doc(db, 'boardPosts', postId));
  b.set(doc(db, 'boardDeletionLogs', `post_${postId}`),
    audit(postId, uid.member, uid.admin, 'spam'));

  await assertSucceeds(b.commit());
});

test('author may delete own comment with log; other member cannot', async () => {
  const postId = 'delete-comment-only';
  await seedPostForDeletion(postId);

  const wrong = context(uid.member);
  const b1 = writeBatch(wrong);

  b1.delete(doc(wrong, 'boardPosts', postId, 'comments', 'comment-a'));
  b1.set(doc(wrong, 'boardDeletionLogs', `comment_${postId}_comment-a`),
    audit(postId, uid.special, uid.member, 'author_request', 'comment', 'comment-a'));

  await assertFails(b1.commit());

  const db = context(uid.special);
  const b = writeBatch(db);

  b.delete(doc(db, 'boardPosts', postId, 'comments', 'comment-a'));
  b.set(doc(db, 'boardDeletionLogs', `comment_${postId}_comment-a`),
    audit(postId, uid.special, uid.special, 'author_request', 'comment', 'comment-a'));

  await assertSucceeds(b.commit());
});


test('duplicate nickname registration is denied', async () => {
  const newuid = 'duplicate-nickname-user';
  const db = context(newuid);
  const batch = writeBatch(db);

  batch.set(doc(db, 'members', newuid), {
    name: 'Second user',
    nickname: 'NewTester',
    nicknameKey: 'newtester',
    email: EMAIL(newuid),
    role: 'general',
    status: 'approved',
    accountType: 'adult',
    consent: true,
    termsVersion: '2026-11',
    termsAcceptedAt: serverTimestamp(),
    createdAt: serverTimestamp()
  });

  batch.set(doc(db, 'nicknames', 'newtester'), {
    uid: newuid,
    nickname: 'NewTester',
    createdAt: serverTimestamp()
  });

  batch.set(doc(db, 'publicNames', newuid), {nickname:'NewTester',role:'general',canReceiveDM:true,updatedAt:serverTimestamp()});
  await assertFails(batch.commit());
});

// ASICC 2026-11: nickname uniqueness, atomic renaming, privacy and requests.
test('a different member cannot read nickname reservations', async () => {
  await assertFails(getDoc(doc(context(uid.member),'nicknames','newtester')));
  await assertSucceeds(getDoc(doc(context(uid.admin),'nicknames','newtester')));
});

test('reserved administrator nickname cannot be registered', async () => {
  const other='impersonator';const db=context(other);const batch=writeBatch(db);
  batch.set(doc(db,'members',other),{
    name:'Bad',nickname:'ASICCAdmin',nicknameKey:'asiccadmin',email:EMAIL(other),
    role:'general',status:'approved',accountType:'adult',consent:true,termsVersion:'2026-11',
    termsAcceptedAt:serverTimestamp(),createdAt:serverTimestamp()
  });
  batch.set(doc(db,'nicknames','asiccadmin'),{uid:other,nickname:'ASICCAdmin',createdAt:serverTimestamp()});
  batch.set(doc(db,'publicNames',other),{nickname:'ASICCAdmin',role:'general',canReceiveDM:true,updatedAt:serverTimestamp()});
  await assertFails(batch.commit());
});

test('member can reserve an alias atomically but cannot seize an existing one', async () => {
  const db=context(uid.member);const member=doc(db,'members',uid.member);
  const good=writeBatch(db);
  good.update(member,{nickname:'Bonjour77',nicknameKey:'bonjour77'});
  good.delete(doc(db,'nicknames','member'));
  good.set(doc(db,'nicknames','bonjour77'),{uid:uid.member,nickname:'Bonjour77',createdAt:serverTimestamp()});
  good.set(doc(db,'publicNames',uid.member),{nickname:'Bonjour77',role:'member',canReceiveDM:true,updatedAt:serverTimestamp()});
  await assertSucceeds(good.commit());
  const bad=writeBatch(db);
  bad.update(member,{nickname:'NewTester',nicknameKey:'newtester'});
  bad.set(doc(db,'nicknames','newtester'),{uid:uid.member,nickname:'NewTester',createdAt:serverTimestamp()});
  bad.set(doc(db,'publicNames',uid.member),{nickname:'NewTester',role:'member',canReceiveDM:true,updatedAt:serverTimestamp()});
  bad.delete(doc(db,'nicknames','bonjour77'));
  await assertFails(bad.commit());
});

test('nickname can change with reservation release and public display update', async () => {
  const db=context(uid.member);const batch=writeBatch(db);
  batch.update(doc(db,'members',uid.member),{nickname:'Bonjour78',nicknameKey:'bonjour78'});
  batch.set(doc(db,'nicknames','bonjour78'),{uid:uid.member,nickname:'Bonjour78',createdAt:serverTimestamp()});
  batch.set(doc(db,'publicNames',uid.member),{nickname:'Bonjour78',role:'member',canReceiveDM:true,updatedAt:serverTimestamp()});
  batch.delete(doc(db,'nicknames','bonjour77'));
  await assertSucceeds(batch.commit());
  const snap=await assertSucceeds(getDoc(doc(context(uid.special),'publicNames',uid.member)));
  assert.equal(snap.data().nickname,'Bonjour78');
});

test('a general member can request a real-name correction but not change real name', async () => {
  const db=context(uid.general);
  await assertFails(updateDoc(doc(db,'members',uid.general),{name:'Forgery'}));
  await assertSucceeds(setDoc(doc(db,'nameChangeRequests',uid.general),{
    uid:uid.general,currentName:uid.general,requestedName:'Corrected Name',
    status:'pending',createdAt:serverTimestamp()
  }));
  await assertFails(getDoc(doc(context(uid.member),'nameChangeRequests',uid.general)));
});

test('admin can approve a real-name correction', async () => {
  const db=context(uid.admin);
  await assertSucceeds(runTransaction(db,async tx=>{
    const r=doc(db,'nameChangeRequests',uid.general),m=doc(db,'members',uid.general);
    const request=await tx.get(r);assert.equal(request.data().status,'pending');
    tx.update(m,{name:request.data().requestedName});
    tx.update(r,{status:'approved',reviewedBy:uid.admin,reviewedAt:serverTimestamp()});
  }));
});

test('member suggestion is private, admin may respond', async()=>{
  const member=context(uid.general),ref=doc(member,'suggestions','item1');
  await assertSucceeds(setDoc(ref,{
    uid:uid.general,category:'operations',subject:'Question',body:'Message',
    status:'received',createdAt:serverTimestamp()
  }));
  await assertFails(getDoc(doc(context(uid.special),'suggestions','item1')));
  await assertSucceeds(getDoc(doc(context(uid.admin),'suggestions','item1')));
  await assertFails(updateDoc(ref,{status:'answered',response:'By member'}));
  await assertSucceeds(updateDoc(doc(context(uid.admin),'suggestions','item1'),{
    status:'answered',response:'Merci',respondedBy:uid.admin,respondedAt:serverTimestamp()
  }));
});

test('admin can restore a previously hidden post, but a member cannot access its archive', async()=>{
  const postId='post-for-admin-hide';const db=context(uid.admin);
  const archive=await assertSucceeds(getDoc(doc(db,'hiddenPosts',postId)));
  assert.equal(archive.data().body,'Original content');
  const batch=writeBatch(db);
  batch.update(doc(db,'boardPosts',postId),{
    title:archive.data().title,body:archive.data().body,deleted:false,updatedAt:serverTimestamp()
  });
  batch.delete(doc(db,'hiddenPosts',postId));
  await assertSucceeds(batch.commit());
  const result=await assertSucceeds(getDoc(doc(context(uid.member),'boardPosts',postId)));
  assert.equal(result.data().body,'Original content');
});

test('admin can restore a previously hidden comment, but others cannot access its archive', async()=>{
  const postId='post1',commentId='comment-permission-test';const db=context(uid.admin);
  const hidden=doc(db,'hiddenComments',`${postId}_${commentId}`);
  const archive=await assertSucceeds(getDoc(hidden));
  const batch=writeBatch(db);
  batch.update(doc(db,'boardPosts',postId,'comments',commentId),{
    body:archive.data().body,deleted:false,updatedAt:serverTimestamp()
  });
  batch.delete(hidden);
  await assertSucceeds(batch.commit());
  const result=await assertSucceeds(getDoc(doc(context(uid.member),'boardPosts',postId,'comments',commentId)));
  assert.equal(result.data().body,'Edited by the original commenter');
});

test('admin may anonymize historical authorName without rewriting the body', async()=>{
  const db=context(uid.admin);
  await assertSucceeds(updateDoc(doc(db,'boardPosts','post1'),{authorName:'기존회원',updatedAt:serverTimestamp()}));
  await assertSucceeds(updateDoc(doc(db,'boardPosts','post1','comments','comment-permission-test'),{authorName:'기존회원',updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(doc(context(uid.special),'boardPosts','post1'),{authorName:'other',updatedAt:serverTimestamp()}));
});
