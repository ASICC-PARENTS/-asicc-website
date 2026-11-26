# ASICC 14차 관리자 보안 검사 수정 안내

## 대상
- `test-cms-fr` 브랜치에서 14차 배너 수정 적용 후 `admin-security` 테스트 11개 중 2개가 실패하는 문제
- 이번 ZIP은 **14차 수정본 위에 추가로 덮어쓰는 작은 보완 패치**입니다. 14차의 배너 화면, 관리자/CMS 편집 기능, HelloAsso 링크는 변경하지 않습니다.

## 수정된 파일 (2개)

1. `firestore.rules.PROPOSED_ONLY`
   - 운영진이 **닉네임만** 변경할 때 다른 회원정보 편집 조건까지 검사하지 않는 좁은 허용 조건을 추가했습니다.
   - 닉네임 예약(`nicknames`)과 공개 별명(`publicNames`)을 같은 트랜잭션에서 일치시켜야만 변경됩니다.
   - 바꾸는 항목은 오직 `nickname`과 `nicknameKey`여야 합니다. 이메일, 등급, 상태, 권한 변경은 이 경로로 허용되지 않습니다.
   - 기존 회원관리/쪽지/배너/자료실/갤러리 권한 조건은 보존했습니다.
2. `tests/admin-member-rules.test.mjs`
   - 테스트의 공개 별명 필드를 최신 형식(`role`, `canReceiveDM`)에 맞췄습니다.
   - 배너 격리 테스트가 다른 테스트에서 생성한 공식 배너를 잘못 '없다'고 가정하던 문제를 수정했습니다. 변경 전후 공식 배너의 존재 여부와 데이터가 동일한지 검사합니다.

## 적용 방법
1. ZIP을 해제합니다.
2. 현재 작업 중인 `test-cms-fr` 브랜치에서 두 파일을 **동일한 경로에 덮어씁니다**.
3. GitHub Desktop에서 Commit → Push origin 합니다.
4. **`admin-security`를 포함한 모든 Actions 검사가 녹색인지** 확인합니다.
5. 실패가 계속된다면 새 `admin-security` 로그를 보내주세요.

## Firebase 주의
이 ZIP의 규칙은 `firestore.rules.PROPOSED_ONLY`입니다. GitHub Actions 전체 검사와 테스트 홈페이지의 동작 확인 전에는 Firebase Console에 적용하지 마세요. 코드를 수정하지 않은 공식 홈페이지에는 아직 아무 변화가 없어야 합니다.

## 검증 범위 및 한계
- Node.js `node --check` 구문 검사: 통과
- 14차 배포본 대비 정확히 위의 2개 파일만 변경: 확인
- 트랜잭션의 필드 동기화/닉네임만 변경 제한: 정적 확인
- ZIP 무결성: 확인
- **Firestore Emulator 테스트: 미실행** (실행에 필요한 npm 의존성이 작업 환경 캐시에 없으며 오프라인 설치 실패). 실제 통과 여부는 GitHub Actions 결과로 확인해야 합니다.

## 로그의 기타 경고
`npm warn deprecated`는 설치 의존성 경고로 이 오류의 직접 원인이 아닙니다. 실제 실패 원인은 테스트 8번(닉네임 변경)과 11번(테스트/운영 배너 분리)입니다.
