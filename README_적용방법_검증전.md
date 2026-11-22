# Astro 정적 언어 페이지 빌드 오류 수정 후보 (GitHub Actions 검증 필요)

대상 커밋: 5dfe14d
실패 로그: `Cannot read properties of undefined (reading 'lang')` at `gallery.astro.mjs:10:27`.

## 변경 범위
- `src/pages/[lang]/membres/gallery.astro`
- `src/pages/[lang]/membres/messages.astro`

두 신규 페이지에서 언어를 `Astro.params.lang`로 직접 읽던 부분을 변경했습니다.
이제 `getStaticPaths()`에서 한국어/프랑스어 페이지 생성 시 `pageLang` prop을 명시적으로 전달하고,
렌더링 시 `Astro.props.pageLang`에서 언어를 읽습니다.

기존 정상 동작하는 `board.astro`, 자료실, Firebase, Cloudflare, Google Drive는 수정하지 않았습니다.
이 패치는 원인 가설에 따라 작성한 **사전 검증용 코드**로, 로컬에서 `astro build`를 실행할 수 없어 GitHub Actions 확인이 필요합니다.

## 적용
1. `test-cms-fr` 브랜치에서 ZIP의 **두 Astro 파일만** 덮어쓰세요.
2. Commit → Push origin.
3. `ASICC Test Build`를 확인하세요.
4. 같은 빌드 오류가 지속되면 `dist/pages/_lang_/membres/gallery.astro.mjs` 10번째 줄의 생성코드를 출력해 정확한 평가 위치를 확인해야 합니다.
5. 빌드 성공 후 다른 Firestore 보안 테스트 3개는 개별 오류 로그 확인이 필요합니다.

**중요**: Firebase 규칙이나 Cloudflare Worker를 지금 배포하지 마세요.
