  async function requireAdmin(req){
    if(!req.auth?.uid) throw new HttpsError('unauthenticated','관리자 로그인이 필요합니다.');
    const [member] = await db.getAll(db.collection('members').doc(req.auth.uid));
    const profile = member.data();
    if(req.auth.token?.email_verified!==true||profile?.status!=='approved'||profile.role!=='admin') throw new HttpsError('permission-denied','바자회 관리자 권한이 없습니다.');
  }
