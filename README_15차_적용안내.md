# ASICC 15차 수정 — 가로 3열 메인 배너 / 관리자 화면 정리 / Firebase 배너 오류 안내

## 반영 내용

1. **메인 배너**: 현재 세로 위치·위쪽 간격은 그대로 유지. 바자회·신규 모집·후원 배너를 가로 3열, 같은 높이의 한 행으로 배치. 최소 높이는 278px이되 프랑스어 등 내용이 길어지면 세 개가 함께 늘어납니다. 모바일(740px 이하)에서는 1열로 전환됩니다.
2. **후원 배너**: 기존 연회비·자유 후원 버튼(진한 남색/녹색)과 HelloAsso 두 주소 유지. 계좌명 및 IBAN을 버튼 아래에 **항상 노출**. 접이식/팝업으로 숨기지 않음. 불필요한 빈 공간은 삭제.
3. **CMS 버튼**: 회원공간 맨 위 관리자 전용 바로가기의 '회원관리'와 '온라인 협회 사무실' 사이에 '홈페이지 CMS 열기'를 추가. 관리자 화면 맨 아래 중복 버튼/안내 상자는 제거. 계정이 관리자일 때만 표시.
4. **관리자 페이지 순서**: 관리자 이름·인증 표시 → 새 가입/탈퇴 알림(없으면 알림 없음) → 통합 처리 대기 요약 → 회원 등급 및 계정 관리 → 게시판 관리(분류·숨김·삭제이력) → 나머지 관리자 기능. 독립 '승급 승인 대기' 영역을 제거하고 **통합 처리 대기 요약 안의 접기/펼치기에서 승급 승인·거절은 그대로 사용**. 처리 대기 건이 있으면 자동으로 펼쳐집니다.
5. **Firebase 배너 오류**: `getDocFromServer`로 실제 서버를 조회하고, 권한 거부와 네트워크 장애를 구별하여 한국어/프랑스어 오류 안내를 제공합니다. Firebase 배너의 **CMS 기본값 복원**에 필요하지만 빠졌던 `deleteDoc` import도 추가했습니다.

## 적용 파일 (3개만 소스 덮어쓰기)

- `src/components/HomeCampaigns.astro`
- `src/pages/[lang]/membres/index.astro`
- `src/pages/[lang]/membres/admin.astro`

압축 내 `FIRESTORE_배너규칙_확인용_추가블록.txt`는 기존 14차 제안 규칙에서 추출한 **참고용**입니다. 자동 배포되는 파일이 아니며 그대로 전체 Firestore 규칙을 대체하면 안 됩니다.

## 주의 — 실제 Firebase 접근 오류는 코드만 덮어써서 해결되지 않을 수 있음

`배너 저장소를 읽지 못했습니다`는 실제 Firebase 프로젝트의 **게시된 Firestore 규칙에** 두 컬렉션 권한이 없는 경우 발생합니다. GitHub Actions 녹색은 Firebase Console에 규칙이 게시되었다는 뜻이 아닙니다.

1. Firebase Console → Firestore Database → **규칙(Rules)** 으로 이동.
2. 현재 게시된 규칙을 따로 백업하고, **이 프로젝트에서 사용하는 Firebase 프로젝트인지 먼저 확인**.
3. 현재 규칙 안에 `publicHomeBanners` 및 `publicHomeBannersTest`의 `get`/`create`/`update`/`delete` 블록과 `validEditorialBanner`, `validBannerText` 함수가 있는지 확인.
4. 빠졌다면 14차에서 보안 테스트를 통과한 `firestore.rules.PROPOSED_ONLY`를 기준으로 **현재 규칙과 비교·병합 후 게시**. 참고용 `FIRESTORE_배너규칙_확인용_추가블록.txt`는 같은 내용을 확인할 때 사용. **기존 회원/자료실/갤러리 규칙을 삭제하거나 제안 규칙을 통째로 덮지 마세요.**
5. `asicc-test.pages.dev`는 `publicHomeBannersTest/{bazaar|admissions}`에 접근하고, 공식 도메인은 `publicHomeBanners/{bazaar|admissions}`에 접근해야 합니다. CMS 기본값은 Firestore 권한이 없어도 공개 페이지에 정적으로 표시됩니다.
6. 규칙 게시 후 테스트 사이트에서 관리자 로그인 → 메인 배너 관리 → 읽기/저장/새로고침/기본값 복원 확인.

**중요:** 이 패치는 Firebase 규칙의 실제 게시를 대신하지 않습니다. 권한 거부가 지속된다면 현재 Firebase Console 규칙을 확인해야 합니다.

## 적용 순서

1. GitHub Desktop의 `test-cms-fr` 브랜치에서 프로젝트를 백업합니다.
2. ZIP을 압축 해제해 **세 소스 파일만** 동일한 상대 경로에 덮어씁니다. 나머지 파일은 건드리지 않습니다.
3. Commit → Push origin 후 GitHub Actions의 `ASICC Test Build` 확인.
4. 테스트 홈페이지에서 PC 3열 높이·상단 위치, 후원 계좌·버튼, 모바일/프랑스어, 관리자 순서·CMS 링크를 확인.
5. Firebase 실제 규칙이 미반영이라면 위 절차에 따라 백업·병합·게시하여 배너 읽기·저장·복원이 되는지 확인.
6. 정상 확인 후 `test-cms-fr`을 `main`에 병합합니다.

## 검증 범위

- Node 회귀 검사 **66개 모두 통과** (`node --experimental-strip-types --test ...`)
- 세 Astro 컴포넌트의 클라이언트 TypeScript 구문 검사 통과 (Node 22 `--experimental-strip-types --check`)
- 배너 CSS 파싱 및 기존 Firestore 제안 규칙과 신규 오류 안내의 참조 확인
- **Astro 전체 빌드는 실행하지 못함**: 오프라인 환경에 npm 의존성 일부가 없어 `npm ci --offline` 설치 실패. GitHub Actions 확인 필요
- 실제 Firebase Console의 게시된 규칙 및 로그인 계정 확인은 수행하지 못함

## 제외

- Firebase·Cloudflare Worker·B2 설정은 직접 변경하지 않았음
- 기존 회원정보, 쪽지함, 게시판 글, 사진과 CMS 데이터 값은 변경하지 않았음
- 기존 후원 계좌/IBAN과 HelloAsso 링크는 변경하지 않았음
