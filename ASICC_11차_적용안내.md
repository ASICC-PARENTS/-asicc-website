# ASICC 홈페이지 11차 — 회원공간 디자인 마무리

## 적용 전
- 10차 패치가 적용된 `test-cms-fr` 브랜치를 기준으로 변경 파일만 포함합니다.
- 기존 파일을 백업하고 ZIP 내부 디렉터리 구조를 그대로 유지하여 덮어쓰세요.
- **상단 메뉴는 수정 대상에서 제외**했습니다. Base.astro 및 기존 헤더 CSS는 변경하지 않았습니다.
- Firebase 보안 규칙, 쪽지 권한 판정, 회원별 ON/OFF, 기존 회원 일괄 활성화, B2 및 Cloudflare Worker는 10차 상태 그대로입니다. Firebase 규칙이 아직 10차 버전이 아니라면 기존 10차 적용 절차를 먼저 완료하세요. 11차에서 별도로 적용할 규칙은 없습니다.

## 수정 사항
1. 쪽지함: 받은/보낸 탭 분리, 기본 받은 탭, 최신순 목록, 한 쪽지 한 행, 긴 내용 말줄임, 20개 단위 페이지, 클릭 상세 및 닫기, 받은 쪽지 답장/개인 삭제, 보낸 쪽지 읽음 상태. 기존 보안 규칙을 유지하므로 삭제는 이전과 동일하게 받은 쪽지함의 본인 쪽지에만 적용됩니다. 상대방의 보낸 쪽지는 삭제되지 않습니다.
2. 자동 읽음: 서버 스냅샷에서 읽음 기록, 삭제된 쪽지는 제외. 기존 N 표시 갱신 방식 및 허용된 게시글·댓글 작성자/받은 쪽지 발신자에 대한 발송 제한 유지. 수신자 검색 없음.
3. 회원게시판/학습자료실/갤러리/쪽지함/회원공간: 공통 버튼·검색창·입력창·분류 색상, 크기와 모서리, 명칭 통일. 게시글·자료실·쪽지·갤러리·관리자 표시 날짜는 파리 시간 YYYY.MM.DD HH:mm. 정회원/특별회원/운영진 등급 배지 및 기존 공지/카테고리 유지.
4. 갤러리: 전체/앨범 보기/검토 대기, 연도→학교 순서(필터와 앨범 생성), 등록·다운로드·대표 사진 지정 등 명칭 간소화. 일반 갤러리 화면에서 기술적 저장소 안내 제외, 원본 미보관과 파일 제한은 유지. 관리자 운영 설정의 B2/Drive 안내와 비공개 테스트 안내는 유지.
5. 모바일/프랑스어: 회원공간에만 범위를 제한한 CSS, 줄바꿈·너비 조정, 각 화면의 프랑스어 문구. 사이트 상단 메뉴와 공개 홈페이지 디자인은 유지.

## 실제 수행한 검증
- Node 테스트: 기존/신규 회귀 테스트 및 권한 판정 테스트 **66/66 통과**. 기존 화면 형태를 기대하던 3개 테스트는 승인된 디자인에 맞춰 갱신하되 보안 관련 단언은 유지.
- TypeScript 및 변경 Astro 파일 스크립트/프런트매터 구문 변환 **17/17 통과** (TypeScript의 transpileModule, 전체 타입검사나 Astro 컴파일과는 다름).
- Chromium 모의 데이터 브라우저 테스트: 쪽지함 한국어/프랑스어 × 1280/375px **4/4 통과**. 43개 받은 쪽지, 20개 페이지, 최신순, 삭제 항목 제외, 본문 안전 표시, 탭, 답장 전달 데이터, 삭제 데이터, 자동 읽음 호출, 가로 넘침 확인.
- Chromium 화면 조각 검사: 게시판/자료실/갤러리 검색·등록 도구 한국어/프랑스어 × 1280/375px **12/12 통과**. 위 브라우저 검사는 실제 Astro 빌드가 아닌 소스 기반 HTML/CSS와 모의 Firebase를 사용했습니다.
- 보안 규칙 및 Worker, 권한 판정 스크립트, 헤더 파일, 기존 Firebase 에뮬레이터 테스트 파일 내용이 10차와 동일함을 확인했습니다.
- npm 의존성 캐시 부족으로 전체 Astro 빌드 및 실제 Firestore 에뮬레이터는 로컬에서 실행하지 못했습니다. GitHub Actions 결과를 확인해야 합니다. 실제 운영 사이트에서의 발송/수신을 검증한 것은 아닙니다.

## 적용 순서
1. ZIP 해제 후 `test-cms-fr` 작업 폴더에 덮어쓰기 → Commit → Push origin.
2. GitHub Actions의 이번 커밋에 대한 **ASICC Test Build**, **ASICC Firestore Rules Security Test** 통과 확인. 나머지 두 보안 워크플로는 경로 필터에 따라 자동 실행되지 않을 수 있으며 필요한 경우 수동으로 실행. 이전 CI의 초록색과 이번 커밋 결과는 구분.
3. 테스트 홈페이지 최신 배포 확인 후 Ctrl+F5.
4. 쪽지 탭, 최신순/상세, 답장·삭제, 보낸 쪽지 읽음 표시, N 알림, 갤러리 연도→학교, 회원공간 모바일/프랑스어 확인.
5. **Firebase / Cloudflare Worker / Backblaze B2 변경 불필요.** 기존 일괄 활성화도 재실행 불필요. 공식 사이트 `main` 배포는 테스트 완료 후 별도로 진행.

## 변경 파일 목록
- `src/pages/[lang]/membres/[area].astro`
- `src/pages/[lang]/membres/admin.astro`
- `src/pages/[lang]/membres/board.astro`
- `src/pages/[lang]/membres/gallery.astro`
- `src/pages/[lang]/membres/index.astro`
- `src/pages/[lang]/membres/messages.astro`
- `src/scripts/members/display-date.ts`
- `src/scripts/members/gallery.ts`
- `src/scripts/members/mailbox-view.ts`
- `src/scripts/members/messages.ts`
- `src/styles/global.css`
- `tests/asicc-b2-first.test.mjs`
- `tests/asicc-round10-regressions.test.mjs`
- `tests/asicc-round11-regressions.test.mjs`
- `tests/patch-regressions.test.mjs`
- `.github/workflows/security-test.yml`
