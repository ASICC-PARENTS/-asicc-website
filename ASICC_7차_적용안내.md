# ASICC 7차 홈페이지 개선 — 적용 안내

## 적용 범위
- 회원게시판 명칭 통일, 정회원·특별회원·일반회원·운영진 배지를 닉네임 위에 표시. 게시판/자료실/갤러리의 공개 닉네임 사용. 회원 등급이 확인되지 않으면 미확인으로 표시.
- 학습자료실 공통·일반 분류 제외, 기타 유지. 기존 글은 삭제하지 않음. 글 목록에서 댓글이 있는 상세 화면으로 가는 링크 추가. 기존 댓글/대댓글 권한 및 5단계 구조 유지.
- 허용된 성인 회원의 닉네임 메뉴에 쪽지 보내기, 회원공간 쪽지함, 받은/보낸 쪽지, 열람 시 읽음 기록, 상단 및 회원공간 N+미확인 개수 표시.
- 학생 본인(재학/졸업/전학) 생년월일 입력; 승급해도 회원정보에 보존. 운영진이 생년월일을 확인하면 만 18세 기준일 저장. 개별 회원 쪽지 설정 자동/활성화/비활성화. 미성년 및 미확인 학생 계정에는 활성화 금지. 일반 성인 가입자는 만 18세 이상임을 스스로 선택하는 구조이며, 신분증을 통한 나이 인증 시스템은 아님.
- 학생 생년월일은 비공개 members 문서에만 보존. 만 18세 기준일에 서버에서 이용 가능하되, 수신 목록/닉네임 메뉴에 반영되려면 본인 로그인 시 공개 닉네임 정보를 갱신해야 함. 기준일은 프랑스 날짜 기준보다 일찍 열리지 않도록 UTC 자정을 사용(시차로 몇 시간 뒤 활성화 가능). 운영진은 개별 계정의 나이 확인, 쪽지 제한을 관리. 관리자 자신의 권한 변경 제한은 유지.
- 갤러리 파일별 업로드 전 미리보기, 선택적 설명, 선택적 운영진 검토, 게시 후 이미지/영상 미리보기, 파일명 미표시, 등록자 등급, 독립적인 학교/연도 선택 저장, 회원 화면 구성 미리보기. 기존 비공개 상태 유지. 운영진 미리보기는 관리자 계정의 화면 모의 표시이며 실제 회원 접근 권한 테스트를 대신하지 않음.
- 사진 등록 안내는 간단한 문구만 사용. 일반 등록은 정식 공개 이후 자유롭게 게시, 선택적으로 검토 요청한 자료만 승인 대기. 별도의 초상권 책임 동의 체크박스 없음.
- 기존 Backblaze B2/Cloudflare 파일 API 사용. Google Drive 미연결. 기존 자료실 첨부파일 처리 유지. 이번 변경은 기존 동작 중이던 Worker가 최신 검토본이라는 전제이며, 실제 B2나 승인 자료 미리보기 조회에 실패할 경우 화면에 오류를 표시함.

## 적용 순서
1. 현재 GitHub 프로젝트/실제 Firebase 규칙을 백업한다. `test-cms-fr` 브랜치에서 ZIP 내 `src`, `tests`와 `firestore.rules.PROPOSED_ONLY`를 같은 경로에 덮어쓴다. `firestore.rules`는 변경하지 않는다. README는 웹사이트 경로에 복사할 필요 없다.
2. Commit → Push origin. 최신 커밋 기준 Astro 빌드, Firestore Rules Security Test, Private Resources Security Test, Member Admin Rules Security Test 등 기존 4개 검사가 모두 통과하는지 확인한다. 실패하면 운영 규칙은 업데이트하지 말고 로그를 확인한다.
3. 4개 검사 통과 후 Firebase Console → Firestore Database → Rules에서 **이번 ZIP의 firestore.rules.PROPOSED_ONLY 내용**을 복사하여 기존 운영 규칙을 교체하고 Publish 한다. 승인된 실제 운영 규칙과 비교/백업 후 적용한다. 새 화면과 새 규칙이 잠시 호환되지 않을 수 있으므로 가급적 테스트 시간에 시행한다.
4. Cloudflare Worker, B2, Google Drive, 메일 서비스는 이번에 변경하지 않는다.
5. 운영진 관리 설정에서 쪽지 전체 활성화 여부를 확인한다. 갤러리 전체 공개와는 별개다. 갤러리는 회의 전까지 비공개 유지. 현재 관리자 계정에 계정 유형이 비어 있으면 개별 회원 편집이 가능한 다른 운영진이 성인 여부를 확인하여 정정한다. 관리자 자신의 권한 수정 제한은 기존대로 유지하므로, 다른 운영진이 없다면 별도로 안전한 설정 방법을 확인한다.

## 실제 기능 테스트
- 운영진/정회원/특별회원/일반회원 각 작성자의 정확한 배지와 댓글 표시.
- 자료실 목록 분류, 댓글 링크, 댓글/대댓글 등록·수정·삭제, 기존 첨부파일의 업로드·다운로드·추가·삭제.
- 성인 정회원과 특별회원 쪽지 교환, 일반회원→운영진, 학생/미확인 계정의 발신·수신 차단, 관리자 개별 비활성화, 확인된 성인 졸업생 활성화, N 및 읽음 상태 갱신.
- 운영진 비공개 시험 모드: 테스트용 사진/동영상 여러 장 미리보기, 설명, 개별 검토 요청, 승인 전후 상태, 학교·연도 개별 변경, 회원 화면 미리보기, 실제 회원 비공개 차단. 실 아동 사진 사용 금지.

## 준비 단계 검증 결과
- 기존 정적 회귀 검사 21/21 통과.
- TypeScript/Astro 스크립트 73개 구간 구문 검사 통과 (Astro 템플릿 전체 빌드/타입 검사 아님).
- 생년월일 및 쪽지 자격 함수 11개 단위 확인 통과.
- 테스트 JS 문법 검사 통과.
- Astro 전체 빌드 및 Firebase 에뮬레이터 새 규칙 실행은 의존성 캐시 부족으로 이 환경에서 미실행. GitHub Actions 확인 필수. 실제 Cloudflare/B2 연결 및 브라우저 동작 미검증.

## 변경 파일 목록
- `src/layouts/Base.astro`
- `src/pages/[lang]/membres/[area].astro`
- `src/pages/[lang]/membres/admin.astro`
- `src/pages/[lang]/membres/board.astro`
- `src/pages/[lang]/membres/gallery.astro`
- `src/pages/[lang]/membres/index.astro`
- `src/pages/[lang]/membres/messages.astro`
- `src/pages/[lang]/membres/profile.astro`
- `src/pages/[lang]/membres/signup.astro`
- `src/pages/[lang]/membres/upgrade.astro`
- `src/scripts/members/admin-ops.ts`
- `src/scripts/members/gallery.ts`
- `src/scripts/members/member-access.ts`
- `src/scripts/members/messages.ts`
- `src/styles/global.css`
- `tests/asicc-round2-regressions.test.mjs`
- `tests/asicc-round3-regressions.test.mjs`
- `tests/firestore-rules.test.mjs`
- `tests/media-rules.test.mjs`
- `firestore.rules.PROPOSED_ONLY`
