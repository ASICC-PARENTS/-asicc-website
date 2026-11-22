# ASICC 5차 — Firebase 보안 검사 오류 수정 패치 (배포 전 검토본)

## 적용 대상

- **기준:** 4차 B2 유지 통합본 + GitHub에서 이미 성공한 갤러리/쪽지 Astro 빌드 핫픽스.
- ZIP에는 **아래 네 파일만** 포함. 같은 경로에 덮어쓴 뒤 `test-cms-fr`에 Commit / Push origin.
- `firestore.rules` (기존 운영 규칙) **포함하지 않음**. 이 ZIP을 Firebase Console에 붙여넣거나 Firebase에 배포하지 마세요.
- Backblaze B2 / Cloudflare Worker / Google Drive / 홈페이지 화면 코드는 전혀 변경하지 않음.

## 수정·점검 내역

1. `firestore.rules.PROPOSED_ONLY`
   - 정회원 승급 신청에서 선택적 `startYear`, `schoolYear`가 누락되었을 때 발생하던 rules evaluation error 방지(`.get(..., null)`).
   - 부모/졸업·전학자/해당 학부모의 승급 신청에는 학생 정보를 최소 한 명 필수로 하는 검증 추가. 프런트엔드 신청서와 일치함.
   - **미성년자 쪽지 차단, 갤러리 기본 비공개 및 등급별 권한 완화 없음.**
2. `tests/firestore-rules.test.mjs`
   - 회원가입/닉네임 테스트가 현재 필수 필드 `accountType`, `canReceiveDM`, 역할 등을 사용하게 수정.
   - 닉네임 변경 시 이전 예약 해제와 새 공개 닉네임 갱신을 하나의 Batch로 수행하도록 현실적인 시나리오로 정리.
   - 갤러리 비공개 상태(운영진만)와 운영진 공개 후 정회원·특별회원 열람 권한을 분리해서 검사.
   - 학생 계정의 쪽지 발신·수신 금지, 일반회원→운영진만 발신, 졸업·전학 신청 정보 필수 검사를 추가.
   - 승급 승인 트랜잭션이 공개 닉네임의 역할도 함께 갱신하도록 수정.
3. `tests/media-rules.test.mjs`
   - 더 이상 맞지 않는 “갤러리 업로드는 운영진만 허용” 테스트를 현재 정책에 맞춰 교체.
   - 비공개 시 일반회원·정회원·특별회원 접근 제한, 운영진 테스트 가능, 공개 시 정회원·특별회원 업로드 허용 검증.
   - 초상권 불확실 사진을 `pending`으로 올리면 다른 회원에게 비공개, 운영진 승인 후 공개되는 흐름 검증.
4. `tests/admin-member-rules.test.mjs`
   - 관리자 닉네임 갱신 테스트에 새 공개 닉네임 필드 및 성인 계정 필드를 반영.

## 실제로 진행한 검증

- Node.js 구문 검사 (`node --check`) : 보안 테스트 JavaScript 3파일 모두 통과.
- 기존 정적 회귀 검사: 21/21 통과 (`tests/asicc-round2-regressions.test.mjs`, `asicc-round3-regressions.test.mjs`, `asicc-b2-first.test.mjs`, `patch-regressions.test.mjs`).
- 새 에뮬레이터 테스트 개수: Firestore 39건, Private Resources 8건, Member Admin 9건.
- **Firebase 에뮬레이터 실행은 이 환경의 npm 외부 접근 제한으로 완료하지 못함.** 테스트가 모두 통과한다고 아직 보장하지 않음.

## GitHub 적용 후 확인

1. GitHub Desktop에서 `test-cms-fr` 브랜치를 확인.
2. ZIP의 네 파일을 프로젝트의 동일한 경로에 덮어쓴 뒤 Commit / Push origin.
3. `.github/workflows`를 바꿀 필요 없이, `firestore.rules.PROPOSED_ONLY` 변경으로 아래 세 Actions가 자동 실행되어야 함:
   - ASICC Firestore Rules Security Test
   - ASICC Private Resources Security Test
   - ASICC Member Admin Rules Security Test
4. 세 항목이 모두 녹색인지 확인. 하나라도 실패하면 **새 실행의 첫 번째 `not ok` 부분과 `evaluation error` 라인**을 공유.
5. 세 테스트가 모두 통과하기 전까지 Firebase Console에는 아무 규칙도 배포하지 말 것. 통과 후에도 현재 운영 Firebase 규칙과 비교·통합 검토가 필요함.

## 여전히 별개로 남은 작업

- 정식 Google Drive 원본 자동 보관은 Goodstack 승인 후. 지금은 B2 사용.
- 갤러리 정식 공개는 초상권 운영진 회의 후. 현재 기본 비공개 유지.
- 원본 사진 삭제·보관 정책, 실메일 발송 서비스 연결, 일부 고급 관리자/CMS 기능은 별도 작업임.
- 공유 앨범에 다른 회원이 한 번 참여한 후에는 소유자가 단독으로 잠금을 해제하지 못하는 현행 설계가 남아 있음. 운영진이 공유 잠금을 확인·해제하는 기능은 별도이며, 해당 사항은 이번 보안 오류 패치에 포함하지 않음.
