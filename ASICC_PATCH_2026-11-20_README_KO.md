# ASICC 테스트 홈페이지 누락 기능 통합 패치 (2026-11-20)

## 기준
사용자가 제공한 `-asicc-website-test-cms-fr (2).zip`을 기준으로 변경했습니다.
GitHub의 `test-cms-fr` 테스트 브랜치용이며, `main`을 변경하지 않았습니다.
기존 회원관리(수정창/승급/알림), 게시판 사진·서식·숨김/복원, 헤더 자물쇠, 메인 배너는 보존했습니다.

## 반영 사항
1. 게시판 댓글과 답글은 원댓글을 1단계로 최대 5단계까지 렌더링. 5단계에는 '답글' 버튼이 없습니다.
   기존 댓글의 본문 내 `[ASICC_REPLY_V1:부모ID]` 형식을 유지해 데이터 마이그레이션이 필요 없습니다.
   댓글/답글 표기, 수정·삭제 확인 문구를 구분합니다. 삭제된 상위 댓글의 고아 답글도 표시합니다.
2. 회원공간 운영진 전용 '회원관리'·'온라인 협회 사무실' 링크를 왼쪽으로 분리,
   오른쪽에 회원 이름·운영진 배지·개인 메뉴를 배치했습니다.
   '학습자료실 가기 / 회원게시판 가기 / 갤러리 가기' 버튼으로 문구를 수정했습니다.
3. 관리자 회원관리 목록에 '최종 접속일 (파리)' 추가, 정렬 지원.
   '오늘 접속 회원'은 파리 날짜 기준, 로그인한 서로 다른 회원 수입니다.
   **전체 홈페이지 방문자 수가 아니며 비로그인 방문자는 포함되지 않습니다.**
4. '가입 종료일' 검색 필터 제거. 탈퇴 요청 시에는 '탈퇴 요청일'만 표시하고,
   실제로 `withdrawnAt` 값이 있는 탈퇴 완료 회원에게만 '탈퇴일'을 표시합니다.
   기존 코드에는 탈퇴 승인/계정 완전삭제 완료 자동화가 없어 그 날짜를 새로 생성하지 않습니다.
5. '기존 게시글 실명 비공개 처리' 실행 메뉴 제거(정식 오픈 전이라 불필요).
   '게시판 삭제 이력'은 접힌 상태로 두고, 클릭했을 때만 가져와 세부 내역을 확인할 수 있습니다.
6. 기존 운영진 정보 수정, 승인·탈퇴 알림 문구, 저장 완료 알림을 그대로 유지했습니다.

## GitHub 적용 방법
### 수정 파일만 패치 ZIP (권장)
1. GitHub Desktop에서 ASICC 저장소를 열고 **Current branch = test-cms-fr**인지 확인.
2. 기존 변경사항을 커밋/보관한 다음, `ASICC_test_cms_fr_patch_changed.zip`을 압축 해제.
3. 압축을 푼 **파일과 폴더의 상대경로 그대로** 저장소 로컬 폴더에 복사해 덮어쓰기.
   ZIP 자체를 GitHub에 올리면 패치가 적용되지 않습니다.
4. GitHub Desktop의 Changes에서 변경 내역 확인 후 Commit, Push origin.
5. GitHub Actions에서 Test Build 및 관련 보안 테스트를 확인하고 테스트 사이트 검증.

### 전체 저장소 ZIP
`ASICC_test_cms_fr_integrated_full.zip`은 통합 복원본입니다. 기존 저장소를 교체해야 할 때만 사용하세요.

## Firebase 보안 규칙: **자동 적용되지 않음**
- 원본 `firestore.rules` (실제 배포용 파일)은 **일부러 건드리지 않았습니다**.
- `firestore.rules.PROPOSED_ONLY`에 추가한 `validSelfActivityUpdate(uid)` 함수와
  `/members/{uid}`의 `allow update` 조건은 실제 Firestore 규칙에 **별도 병합/테스트/게시**해야 합니다.
- 특히 Firebase 콘솔에 이미 수정된 규칙을 붙인 상태라면, 제안 파일 전체로 현재 규칙을 덮어쓰지 마세요.
- 접속 기록은 인증·활성 회원만 `lastSeenAt: serverTimestamp()`를 갱신합니다.
  서버 시각이며 방문자별 중복 계산을 방지합니다. 최근 10분 내 재방문은 비용을 줄이려고 기록을 재사용하되,
  **파리 날짜가 바뀌면 반드시 새로 기록**합니다.
- 실제 규칙을 반영하기 전에는 관리자 화면에 최종 접속일/오늘 접속 수가 집계되지 않을 수 있습니다.
- 기존 Firebase 규칙 중 다른 API·게시판·갤러리·회원관리 권한을 잃지 않도록 병합해야 합니다.

## 검사 결과
- 5개 Node 기반 정적 회귀검사 통과 (`node --test tests/patch-regressions.test.mjs`)
- 수정 `.astro` `<script>`와 새 TypeScript 파일의 TypeScript 구문 파싱 통과
- 업로드 원본과 SHA-256 비교 결과: 지정된 파일만 변경, 공개 메인 배너/사진 설정/회원가입/기존 firestore.rules 변경 없음
- **전체 Astro 빌드 및 Firebase 에뮬레이터 테스트는 이 환경에서 완료하지 못했습니다.**
  `npm ci` 설치가 네트워크에서 지연되어 완료되지 않았고 `npm ci --offline`은
  `ENOTCACHED (zwitch-2.0.4.tgz)` 오류가 발생했습니다.
  따라서 실제 사이트 동작과 배포 전 보안 규칙 검사는 GitHub Actions에서 꼭 확인하세요.

## 수정/추가 파일
- `firestore.rules.PROPOSED_ONLY`
- `src/layouts/Base.astro`
- `src/pages/[lang]/membres/admin.astro`
- `src/pages/[lang]/membres/board.astro`
- `src/pages/[lang]/membres/index.astro`
- `src/scripts/members/activity.ts`
- `src/styles/global.css`
- `tests/admin-member-rules.test.mjs`
- `tests/patch-regressions.test.mjs`
