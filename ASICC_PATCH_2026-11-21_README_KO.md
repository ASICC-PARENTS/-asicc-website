# ASICC 보안 오류 및 방문 통계 단순화 패치 (2026-11-21)

## 이번 패치 범위
- 기존 11월 20일 통합 패치(5단계 대댓글, 회원관리 수정, 운영진 메뉴 등) **위에 덮어쓰는 추가 수정**입니다.
- Firestore 회원 문서의 브라우저 `lastSeenAt` 기록을 **완전히 비활성화**하고, 제안 보안 규칙에서도 쓰기 허용을 삭제했습니다.
- 회원/운영진 모두 `lastSeenAt` 필드의 임의 갱신을 할 수 없도록 `admin-member-rules.test.mjs`의 6번 테스트를 **거부 확인**으로 변경했습니다.
- 관리자 화면에서 그 필드로 계산하던 정확하지 않은 '오늘 접속 회원' 숫자와 마지막 접속일 열을 제거했습니다.
- Firebase Authentication에 있는 개별 로그인 기록은 **Firebase Console의 Authentication 사용자 목록**에서 확인합니다.
  GitHub Pages의 정적 웹페이지는 다른 모든 회원의 Auth 메타데이터를 관리자 권한 없이 바로 조회할 수 없습니다.
  별도 서버 기능은 만들지 않았습니다.
- 비회원 포함 방문 횟수는 **Cloudflare Web Analytics**에서 확인하게 했습니다.
  관리자 화면에서 Cloudflare 대시보드로 이동하는 링크를 제공합니다. 별도 API 연동/자동 새로고침은 하지 않습니다.
- Cloudflare 설정을 완료할 때까지 추적 스크립트는 삽입되지 않습니다. 수집되는 통계는 **활성화 이후**부터 시작합니다.
- 실제 배포 규칙인 `firestore.rules`는 수정하지 않고 `firestore.rules.PROPOSED_ONLY`만 수정했습니다.

## GitHub 적용법
1. GitHub Desktop에서 `test-cms-fr` 브랜치를 확인합니다.
2. ZIP 속 폴더와 파일들을 저장소 최상위 경로를 기준으로 그대로 덮어씁니다. ZIP 파일 자체를 저장소에 올리는 것이 아닙니다.
3. Commit / Push origin 뒤 GitHub Actions > `ASICC Member Admin Rules Security Test`에서 9개 검사 결과를 확인합니다.
4. **실제 Firestore 규칙을 이 파일 전체로 덮어쓰지 마세요.** 실서버 규칙과 필요한 변경만 별도 검토해야 합니다.
5. 테스트가 통과한 뒤에만 공식 `main` 반영을 검토하세요.

## Cloudflare 통계 활성화 (선택 / 추후)
1. Cloudflare Web Analytics에서 도메인 `asicc-parents.fr` 사이트를 추가하고 제공되는 **beacon token**을 확인합니다.
2. GitHub 저장소 Settings > Secrets and variables > Actions > **Variables**에서 이름 `ASICC_CLOUDFLARE_TOKEN`으로 token 값을 추가합니다.
3. `main` 브랜치가 배포되면 GitHub Actions의 `PUBLIC_ASICC_CLOUDFLARE_TOKEN` 빌드 환경변수로 전달되어
   `src/layouts/Base.astro`가 공식 사이트 HTML에 Cloudflare beacon 스크립트 하나만 넣습니다.
   테스트 브랜치 빌드에는 자동 적용하지 않아 테스트 방문은 집계에 포함되지 않습니다.
4. 결과는 Cloudflare 대시보드에서 직접 확인합니다(관리자 페이지의 외부 링크 사용).
5. 정식 활성화 전 개인정보 처리 고지 및 프랑스 CNIL 기준을 확인하세요.

## 주의 및 검증
- `Firebase Auth lastSignInTime`은 **마지막 인증(로그인)** 기록이지, 로그인 상태에서 매번 사이트를 방문한 날짜가 아닙니다.
- 실서버 배포 규칙의 `lastSeenAt` 허용 여부는 별도 확인이 필요합니다. 제안 규칙만 수정하면 실서버 규칙은 바뀌지 않습니다.
- 이미 `lastSeenAt`로 저장된 기존 값은 지우거나 옮기지 않았으며, 관리자 화면에서 사용하지 않습니다.
- 오프라인 파일 정적검사와 `node --test tests/patch-regressions.test.mjs`를 수행합니다.
  Firestore Emulator CI 9개 검사와 실제 Astro 빌드는 GitHub Actions 결과로 최종 확인하세요.
