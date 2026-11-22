# ASICC 9차 수정 — 쪽지 권한 단순화 및 운영 화면 개선

## 적용 순서 (8차 적용 완료 기준)

1. 9차 ZIP을 풀고 `test-cms-fr` 프로젝트의 동일 경로에 덮어씁니다. 변경 파일만 포함합니다. 기존 Firebase 규칙은 별도로 백업합니다.
2. GitHub Desktop에서 Commit → Push origin. GitHub Actions의 기존 4개 검사 결과를 확인합니다. 쪽지 정책 테스트도 기존 Firestore Security Test 워크플로에 포함됩니다.
3. 모든 검사 통과 후 Firebase Console → Firestore Database → Rules에서 **`firestore.rules.PROPOSED_ONLY` 전체**를 붙여넣고 Publish합니다. 기존 `firestore.rules`는 이 패치에서 변경하지 않습니다. Cloudflare Worker, Storage 규칙, B2는 변경하지 않습니다.
4. 홈페이지가 배포된 뒤 운영진 계정으로 관리자 화면을 새로고침합니다. **홈페이지 운영 설정 → 기존 회원 쪽지 일괄 활성화 (최초 1회)** 버튼을 한 번 누릅니다. 이 작업은 활성 상태인 기존 정회원·특별회원·운영진의 개인 설정을 ON으로 바꾸고 쪽지 전체 설정을 ON으로 저장합니다. 일반회원과 이용 정지 계정은 제외합니다. 완료 표시는 서버에 저장되어 있으며 이후에는 다시 실행되지 않습니다. 기존 명시적 OFF도 이 최초 초기화에서만 ON으로 바뀌고 이후 개인별 OFF는 유지됩니다. (최대 400명; 그 이상이면 일괄 처리하지 않고 실패 안내합니다.)
5. 회원공간을 새로고침해 쪽지함, 닉네임 옆 편지 표시, 수신자 검색, 발송·수신·읽음 N을 실제로 확인합니다. 운영진이 서로 다른 계정으로 시험합니다.

## 정책

- 일반회원: 자동·수동 여부와 관계없이 개인 쪽지 발송·수신 불가, 쪽지함 숨김. 공식 문의 기능은 유지합니다.
- 정회원·특별회원: 성인/학부모는 자동 ON. 학생·졸업/전학생 본인은 등록된 생년월일 기준 18세 도달 후 자동 ON. 계정 정보 미확인 시 자동 OFF.
- 운영진: 자동 ON. 운영진 본인도 회원관리 목록에서 직접 ON/OFF 저장 가능.
- 정회원·특별회원·운영진에 대한 명시적 ON/OFF는 나이·생년월일·프로젝트 코드·성인 확인에 우선합니다. 수동 ON 시 추가 팝업이 없습니다. 운영진 권한, 정상 계정 상태, 전체 쪽지 설정은 유지합니다. 회원 본인의 임의 권한 변경은 차단합니다. 변경 이력(운영진 UID, 시간) 저장.
- 신규 등록은 일반회원이므로 공개 별칭의 쪽지 활성화 값이 false입니다. 승급 후 위 정책이 적용됩니다. 나이는 UTC 생일 경계에서 계산합니다.
- 기존 계정 초기화는 실제 서버 데이터에 운영진이 버튼을 누를 때만 실행됩니다. 신규 회원에게 계속 일괄 ON을 적용하지 않습니다. 공개 별칭의 과거 쪽지 상태가 최신 상태가 아니어도 상대방의 실제 연락 권한을 서버에 검사합니다.
- 미성년 회원을 ON으로 설정하면 다른 쪽지 가능 회원과의 개인 연락이 허용됩니다. 기존 계정 중 미성년자가 있다면 실제 활성화가 필요한 회원인지 운영진이 관리할 것을 권장합니다. 시스템에 추가 검증 팝업은 넣지 않았습니다.

## 화면 변경

- 관리자 첫 업무 카드: 통합 처리 대기 요약.
- 갤러리: 반려 버튼 삭제 → 공개 또는 비공개. 기존 반려 사진은 비공개로 표시. 검토 대기 목록에는 pending만 유지. 상태별 확인 문구 및 완료 메시지를 구분합니다. 비공개는 삭제가 아닙니다. 전체 갤러리 공개 여부는 변경하지 않습니다.
- 관리자 설정, 회원관리, 갤러리, 게시판, 학습자료실, 프로필, 승급, 건의, 쪽지에서 기존 상태 메시지 및 주요 작업 완료/오류를 화면 상단 알림으로 보강합니다. 주요 저장 버튼 처리 중 비활성화합니다. 자료 첨부·저장소 로직은 유지합니다.
- 닉네임 옆 편지와 화살표: 실제 연락 허용 여부를 `messageAccess`에서 확인할 때만 표시. 수신자 검색 및 발송도 서버 권한 검사. 쪽지 기능을 사용할 수 없으면 운영진 문의 안내.

## 검증 결과

- 기존 정적 회귀 검사 26건 통과 (의도적으로 변경한 쪽지 정책 관련 기존 기대값 갱신, 다른 기능 검사 유지).
- 신규 검사 26건 통과 (정책 함수 실제 실행 21건, 소스 연결 정적 검사 5건).
- TypeScript 및 Astro 스크립트/프런트매터 구문 검사 73개 통과. 이는 전체 Astro 컴파일 또는 타입 검사와 동일하지 않습니다.
- 전체 Astro 빌드는 실행 시 `astro: not found`로 중단됐습니다. 현재 환경에 프로젝트 의존성이 설치되지 않았습니다. Firebase 에뮬레이터도 실행하지 못했습니다. **GitHub Actions에서 해당 검사 및 실제 Firestore 규칙 검증이 통과하기 전에는 Firebase Publish 하지 마세요.** 운영 사이트에서 발송 및 수신 테스트까지는 수행하지 않았습니다.
- Firebase 에뮬레이터용 테스트에는 일반회원 양방향 차단, 기본 미성년 OFF, 운영진 수동 ON, 권한 철회, 타인의 쪽지 읽기 차단, 운영진 자기 권한 변경, 전체 OFF, 최초 초기화 마커 권한 등을 포함했습니다.

## 변경 파일 목록

- `.github/workflows/security-test.yml`
- `firestore.rules.PROPOSED_ONLY`
- `src/pages/[lang]/membres/[area].astro`
- `src/pages/[lang]/membres/admin.astro`
- `src/pages/[lang]/membres/board.astro`
- `src/pages/[lang]/membres/index.astro`
- `src/pages/[lang]/membres/messages.astro`
- `src/pages/[lang]/membres/profile.astro`
- `src/pages/[lang]/membres/signup.astro`
- `src/pages/[lang]/membres/suggestions.astro`
- `src/pages/[lang]/membres/upgrade.astro`
- `src/scripts/members/admin-ops.ts`
- `src/scripts/members/dm-policy.ts`
- `src/scripts/members/gallery.ts`
- `src/scripts/members/member-access.ts`
- `src/scripts/members/messages.ts`
- `src/scripts/members/toast.ts`
- `src/styles/global.css`
- `tests/asicc-round2-regressions.test.mjs`
- `tests/asicc-round8-regressions.test.mjs`
- `tests/asicc-round9-policy.test.mjs`
- `tests/firestore-rules.test.mjs`
- `tests/patch-regressions.test.mjs`
