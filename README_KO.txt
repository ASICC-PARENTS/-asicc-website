ASICC Firestore 보안검사 보강 — 2026-11-18

이 패키지는 test-cms-fr 브랜치 전용 업데이트입니다.

포함:
- firestore.rules.PROPOSED_ONLY: 기존의 4등급 회원/게시판 권한 규칙은 유지하지만, 공개 양식 3개(messages, registrations, subscribers)의 익명 쓰기를 임시로 차단합니다.
- tests/firestore-rules.test.mjs: 기존 14개에 익명 공개 양식 차단 검사 3개를 추가합니다(총 17개).

GitHub 저장소의 test-cms-fr 루트에 두 파일을 같은 경로로 업로드해 덮어쓰고 커밋하세요. 설치된 GitHub Actions가 자동 실행됩니다. 검사 결과 17 pass, 0 fail을 확인하기 전까지 Firebase 콘솔에 게시하지 마세요.

주의:
1) firestore.rules(기존 루트 파일)은 이 패키지에서 변경하지 않습니다.
2) 아직 공개 문의·행사 신청·소식지 구독은 Firestore에서 저장되지 않습니다. 연락처 페이지의 외부 Formspree 양식은 별도 서비스입니다.
3) 17개 테스트가 통과해도 실제 Firebase에 적용하기 전에 게시할 규칙 텍스트가 해당 테스트 파일과 일치하는지 검증해야 합니다.
4) 본 프로젝트의 Firebase는 실제 홈페이지와 테스트 홈페이지가 같은 프로젝트를 사용합니다. 규칙 게시 시 두 사이트에 동시에 영향을 줄 수 있습니다.
5) Storage 보안 규칙은 별도 검증이 필요합니다. 사진/아동 명부/운영진 비밀문서는 업로드하지 마세요.
