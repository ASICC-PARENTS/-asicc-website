# ASICC 6차 Firestore CI 테스트 수정 패치 (운영 규칙 변경 없음)

대상: `test-cms-fr` 브랜치, 최신 검토안/테스트 코드 5차 패치 적용 후.

## 진단

GitHub Actions `ASICC Firestore Rules Security Test #23` (커밋 `8852392`)는 39개 테스트 중 33개 통과, 6개 실패.
- 실패 #8 `member and special can write board posts`: 작성자 닉네임 검증 규칙과 테스트 데이터 불일치.
- 실패 #23 `admin may hide another member post`: 선행 게시글 생성에서 동일 불일치.
- 실패 #24 `comment owner may edit; admin cannot rewrite but may hide`: 선행 댓글 생성에서 동일 불일치.
- 실패 #37 / #38 게시글·댓글 복구: 선행 숨김 테스트가 실패하여 비공개 보관 원본 미생성. 후속 실패.
- 실패 #39 작성자명 비식별화: 선행 댓글 테스트 실패로 댓글 미생성. 후속 실패.

### 원인 및 수정

`firestore.rules.PROPOSED_ONLY`는 게시글과 댓글의 `authorName`이 해당 계정의 `members/{uid}.nickname`과 일치해야 쓰기 허용하도록 설계됨. 5차 테스트 일부는 `authorName: '기존회원'`으로 신규 작성 요청을 보내 정상 보안 거부를 초래함.

수정 파일은 오직 `tests/firestore-rules.test.mjs`이며, 테스트가 새 글·댓글을 쓸 때 실제 인증된 테스트 계정의 닉네임(`user` 또는 `uid.member`)을 전송하도록 아래 **세 지점만** 변경:
1. 정회원/특별회원 게시글 작성 테스트
2. 관리자 게시글 숨김 테스트의 선행 게시글 작성
3. 댓글 수정·숨김 테스트의 선행 댓글 작성

보안 규칙 완화/변경 없음. 다른 테스트와 실제 홈페이지 코드, Firebase/Cloudflare 운영 설정 변경 없음.

## 적용 절차

1. GitHub Desktop에서 `test-cms-fr` 선택.
2. ZIP의 `tests/firestore-rules.test.mjs` 파일을 프로젝트의 **동일한 상대경로**에 덮어쓰기.
3. Commit → Push origin.
4. GitHub Actions의 `ASICC Firestore Rules Security Test` 최신 커밋 결과 확인.
5. 다른 세 검사가 이전에 녹색이었더라도 최신 커밋에서 재실행 여부를 함께 확인.

## 확인한 결과와 제한

- `node --check tests/firestore-rules.test.mjs`: 통과.
- 5차 파일과 비교한 변경점은 테스트에 사용한 `authorName` 세 곳뿐.
- Firebase 에뮬레이터를 이 작업 환경에서 실행하지 못함. **39개 테스트의 실제 통과 여부는 GitHub Actions에서 확인 필요.**
- 여전히 테스트 실패가 발생하면 새 로그를 바탕으로 개별 원인을 확인해야 하며, 보안 규칙을 일괄 완화해서는 안 됨.

**지금 Firebase Console에 `firestore.rules.PROPOSED_ONLY`를 배포하지 마세요.** Goodstack/Google Drive, B2, Cloudflare도 이번 작업과 무관합니다.
