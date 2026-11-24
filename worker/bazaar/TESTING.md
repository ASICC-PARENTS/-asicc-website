# 바자회 테스트 Worker

이 폴더의 `wrangler.test.toml`은 `asicc-bazaar-test` 프로젝트와 테스트 메일 모드에 연결됩니다. 공식 홈페이지는 기존 GitHub Pages에서 제공됩니다. 테스트 웹앱의 공개 설정은 로컬 환경 변수에 입력하고, 서버 자격 증명은 Worker Secrets에 저장합니다.

## 로컬 실행

1. 저장소 루트에서 `npm ci`를 한 뒤 `firebase emulators:start --project demo-asicc-bazaar --config firebase.bazaar.local.json`으로 Auth와 Firestore를 실행합니다.
2. `npx wrangler dev --config worker/bazaar/wrangler.local.toml --ip 127.0.0.1 --port 8787 --test-scheduled`로 Worker를 실행합니다.
3. `node --test worker/bazaar/integration.test.mjs`로 공개 주문 및 관리자, 동시 재고, 발송, 정산 및 사진 경로 검사를 실행합니다. 이 테스트는 로컬 데모 Firestore만 초기화합니다.
4. Astro는 `PUBLIC_ASICC_BAZAAR_EMULATOR=true`와 `--host 127.0.0.1 --port 4321`로 실행합니다. Windows에서는 PowerShell로 환경 변수를 먼저 설정합니다. 테스트 관리자 화면에서 로컬 테스트 계정으로 로그인합니다.

## 실제 테스트 프로젝트 연결

- Astro는 `PUBLIC_ASICC_BAZAAR_TEST=true`, Firebase 테스트 웹앱의 `PUBLIC_ASICC_BAZAAR_TEST_API_KEY`, `PUBLIC_ASICC_BAZAAR_TEST_APP_ID`, 테스트 Worker 원본 주소인 `PUBLIC_ASICC_BAZAAR_WORKER_URL`을 사용합니다. 기본 테스트 브라우저 주소는 `http://127.0.0.1:4321`입니다.
- Worker Secrets에는 테스트 프로젝트 전용 `FIRESTORE_CLIENT_EMAIL`과 `FIRESTORE_PRIVATE_KEY`가 필요합니다. 서비스 계정의 Firestore 권한은 테스트 프로젝트에만 부여합니다. 주문, 원가, 발송 대기 데이터는 Worker를 통해 접근합니다.
- 사진을 실제 B2에서 검증하려면 계정의 무료 저장량 여유를 확인하고 기존 버킷의 `bazaar/test/photos/`로 제한된 B2 키를 사용합니다. `B2_S3_ENDPOINT`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APPLICATION_KEY`, `BAZAAR_PHOTO_SIGNING_KEY`를 이 Worker에 설정합니다. 상품에서 사진을 교체하거나 제거하면 이전 행사 기록의 참조는 유지됩니다. 동일한 사진 파일은 해시로 재사용합니다.
- `MAIL_MODE = "capture"`에서는 외부 발송 없이 테스트 Firestore에 처리 상태를 기록합니다. `MAIL_MODE = "api"`로 실제 전송을 검증할 때는 테스트 수신함인 `TEST_MAIL_TO`가 모든 수신자를 대체합니다. 바자회 전용 `BAZAAR_MAIL_API_KEY`, `BAZAAR_MAIL_FROM`, `MAIL_PROVIDER=brevo` 또는 `resend`를 설정합니다. 발신자 등록과 발신 도메인 인증에는 해당 메일 공급자가 제공한 DNS 레코드를 사용합니다.

## 테스트 후 운영 검토 항목

- Cloudflare 대시보드의 실행 통계에서 CPU 초과·요청 오류를, Firebase 사용량 화면에서는 주문과 사진 요청을 포함한 읽기·쓰기 수를 확인합니다.
- 일일 피크가 100통을 넘을 수 있는 경우 바자회 전용 Brevo Free의 300통 한도를 기준으로 검증합니다. 기존 홈페이지 Resend 알림은 그대로 사용합니다. Worker는 파리 날짜 기준으로 자체 발송량을 제한하며, 한도에 도달한 메일은 대기 상태로 남깁니다.
- 메일 공급자가 응답을 확정하지 못했을 때는 동일한 키로 재시도합니다. 공급자의 중복 제거 기간을 지나면 관리자 주문 상세에 검토가 필요한 실패로 표시됩니다.
- 기존 Firefox 및 Edge 등 브라우저에서 한국어·프랑스어 고객 화면, 관리자 화면, PDF와 Excel 발주서 내보내기를 확인합니다. Worker 주소의 클라우드 연결과 운영 브랜치 병합은 각각 별도로 진행합니다.
