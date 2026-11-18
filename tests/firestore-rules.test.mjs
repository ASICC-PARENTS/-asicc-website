
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

      setDoc(
        doc(db, 'galleryItems', 'pic1'),
        item('pic1', 'gallery')
      ),

      setDoc(
        doc(db, 'officeDocs', 'minutes1'),
        item('minutes1', 'office')
      ),

      setDoc(doc(db, 'boardPosts', 'post1'), {
        title: 'test',
        body: 'test',
        authorUid: uid.member,
        authorName: uid.member,
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

test('special has identical gallery permission to member, not office', async () => {
  for (const user of [uid.member, uid.special]) {
    const db = context(user);

    await assertSucceeds(
      getDoc(doc(db, 'galleryItems', 'pic1'))
    );

    await assertFails(
      getDoc(doc(db, 'officeDocs', 'minutes1'))
    );
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
        authorName: user,
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

batch.set(doc(db, 'members', newuid), {
  name: 'New user',
  nickname: 'NewTester',
  nicknameKey: 'newtester',
  email: EMAIL(newuid),
  role: 'general',
  status: 'approved',
  consent: true,
  createdAt: serverTimestamp()
});

batch.set(doc(db, 'nicknames', 'newtester'), {
  uid: newuid,
  nickname: 'NewTester',
  createdAt: serverTimestamp()
});

await assertSucceeds(batch.commit());

  const evil = 'evil-signup';

  await assertFails(
    setDoc(doc(context(evil), 'members', evil), {
      name: 'Evil',
      email: EMAIL(evil),
      role: 'admin',
      status: 'approved',
      consent: true,
      createdAt: serverTimestamp()
    })
  );
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
        authorName: uid.member,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        deleted: false
      }
    )
  );

  // Hide using the current soft-delete data format.
  await assertSucceeds(
    updateDoc(
      doc(context(uid.admin), 'boardPosts', postId),
      {
        deleted: true,
        title: '[숨김 처리된 게시글]',
        body: '[숨김 처리된 게시글]',
        updatedAt: serverTimestamp()
      }
    )
  );
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
        authorName: uid.member,
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

  // Admin may hide the comment.
  await assertSucceeds(
    updateDoc(
      doc(
        context(uid.admin),
        'boardPosts',
        postId,
        'comments',
        commentId
      ),
      {
        body: '[숨김 처리된 댓글]',
        deleted: true,
        updatedAt: serverTimestamp()
      }
    )
  );
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

