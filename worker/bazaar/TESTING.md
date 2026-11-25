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
- 실제 B2 연결 전 계정의 무료 저장량 여유를 확인합니다. 기존 비공개 버킷과 `bazaar/test/photos/` 접두사로 제한된 Application Key에 `readFiles` 및 `writeFiles` 권한을 부여합니다. Worker 변수는 `B2_S3_ENDPOINT=https://s3.<region>.backblazeb2.com`과 `B2_BUCKET=<기존 버킷 이름>`입니다. `B2_KEY_ID`와 `B2_APPLICATION_KEY`는 Secrets입니다. 사진 미리보기에는 기존 Worker Secret `BAZAAR_PHOTO_SIGNING_KEY`가 필요합니다. 상품에서 사진을 교체하거나 제거해도 이전 행사 참조는 유지됩니다. 동일한 사진 파일은 해시로 재사용합니다.
- `MAIL_MODE = "capture"`에서는 외부 발송 없이 테스트 Firestore에 처리 상태를 기록합니다. `MAIL_MODE = "api"`로 실제 전송을 검증할 때는 테스트 수신함인 `TEST_MAIL_TO`가 모든 수신자를 대체합니다. 바자회 전용 `BAZAAR_MAIL_API_KEY`, `BAZAAR_MAIL_FROM`, `MAIL_PROVIDER=brevo` 또는 `resend`를 설정합니다. 발신자 등록과 발신 도메인 인증에는 해당 메일 공급자가 제공한 DNS 레코드를 사용합니다.

## 테스트 후 운영 검토 항목

- Cloudflare 대시보드의 실행 통계에서 CPU 초과·요청 오류를, Firebase 사용량 화면에서는 주문과 사진 요청을 포함한 읽기·쓰기 수를 확인합니다.
- Brevo의 리셋 시각을 확인하기 전에는 Worker가 최근 25시간 발송 시도를 기준으로 일반 250통, 주문 접수·일반 취소 예비 50통을 제한합니다. 관리자 화면의 공급자 잔여량은 Brevo에서 확인한 계정 전체 수치이며, Worker의 접수 및 예약 수치와 별개입니다. 초과분은 대기합니다.
- HTTP 429처럼 요청이 확실히 거절된 경우 설정된 시각 이후 재시도합니다. 연결 종료나 타임아웃 등 결과가 불확실한 경우에는 공급자 이력 확인 후에만 재발송을 선택합니다. 예약 독촉은 송금 신고, 실제 입금, 취소, 대조 시작 및 마감 여부를 전송 전에 다시 확인합니다.
- 기존 관리자 주문 화면에서 행사별 마감 알림과 최종 미입금 취소의 자동 발송을 선택할 수 있습니다. OVH 수동 메일은 대상 준비, Bcc 복사 또는 Excel 저장, 실제 전송 완료 기록 순서로 처리합니다. 전송하지 않으면 준비를 해제합니다.
- Brevo 계정의 승인 IP 차단이 켜져 있으면 동적 IP를 사용하는 Worker에서 `unauthorized` 응답이 발생할 수 있습니다. 계정 보안 설정 검토 및 실제 발송 승인 전에는 `MAIL_MODE=capture`를 유지합니다.
- 기존 Firefox 및 Edge 등 브라우저에서 한국어·프랑스어 고객 화면, 관리자 화면, PDF와 Excel 발주서 내보내기를 확인합니다. Worker 주소의 클라우드 연결과 운영 브랜치 병합은 각각 별도로 진행합니다.
