# ASICC 14차 CI 회귀 검사 오류 보완

## 원인
GitHub Actions의 회귀 검사 66개 중 65개 성공, 1개 실패.
`tests/patch-regressions.test.mjs` 47행에 남아 있던 이전 Firestore `allow update` 조건의 정규식이 14차 보안 패치의 `validAdminNicknameOnlyUpdate(uid)` 추가를 반영하지 못했음.

## 수정
테스트 파일 **1개만** 수정.
- 기존 회원정보 수정 함수 세 개와 새 `validAdminNicknameOnlyUpdate(uid)`가 모두 올바른 순서로 들어 있는지 확인
- 별도 함수 선언 존재 검사 추가
- 나머지 회귀 검사 조건은 유지

## 적용
1. `test-cms-fr` 브랜치를 선택한다.
2. ZIP 속 `tests/patch-regressions.test.mjs`를 같은 경로에 덮어쓴다.
3. Commit → Push origin 한다.
4. GitHub Actions 검사 전부 초록색인지 확인한다.
5. 테스트 홈페이지 확인 후 main에 병합한다.

Firebase 규칙, 웹페이지, CMS, Cloudflare/B2 변경 없음. Firebase에 새로운 규칙을 붙여넣을 필요도 없음.

## 검증
로컬에서 현재 제공된 패치 및 필요한 이전 파일을 조합해 아래 회귀 검사 명령을 실행했을 때 66/66 통과:
`node --experimental-strip-types --test tests/asicc-*-regressions.test.mjs tests/asicc-round9-policy.test.mjs tests/asicc-b2-first.test.mjs tests/patch-regressions.test.mjs`
단, 실제 GitHub 저장소에서의 자동 검사 결과는 Push 이후 별도로 확인 필요.
