# 바자회 연결 검증

## 운영과 분리된 검증 환경

- Firebase CLI에서 프로젝트를 `demo-asicc-bazaar`로 지정합니다. Auth(9099), Functions(5001), Firestore, Storage Emulator를 구성합니다. 테스트 Firestore에는 `firestore.rules.PROPOSED_ONLY`를 사용해 별도로 검토합니다.
- Astro는 `PUBLIC_ASICC_BAZAAR_EMULATOR=true npm run dev -- --host 127.0.0.1 --port 4321`로 실행합니다. 바자회 웹 API는 로컬 주소에서 이 설정을 켰을 때만 해당 에뮬레이터 프로젝트를 사용합니다.
- 검증용 운영진 계정을 Auth Emulator에 생성하고 이메일 확인을 설정합니다. Firestore Emulator의 `members/{uid}`에 `role: 'admin'`과 `status: 'approved'`를 입력합니다. 일반 회원도 별도로 만들어 관리자 기능이 거부되는지 확인합니다. 바자회 관리 화면 테스트용 로그인은 바자회 테스트 Auth를 사용합니다. 홈페이지 회원 로그인은 기존 서비스에 연결되어 있으므로 브라우저에서 외부 요청을 차단한 채 테스트합니다.
- Functions Emulator에 `BAZAAR_SMTP_HOST`, `BAZAAR_SMTP_PORT`, `BAZAAR_SMTP_USER`를 설정합니다. 발신 비밀번호는 Functions 소스 디렉터리의 로컬 `.secret.local`에 `BAZAAR_SMTP_PASSWORD`로 설정합니다. 메일을 로컬에서만 수집하는 SMTP 서버와 `example.test` 주소를 사용합니다.
- [바자회 생명주기 테스트](test/lifecycle.test.mjs)는 `FIRESTORE_EMULATOR_HOST` 및 `FIREBASE_STORAGE_EMULATOR_HOST`를 로컬 주소로 설정한 후 홈페이지 저장소 루트에서 `node --test firebase-functions-bazaar/test/lifecycle.test.mjs`로 실행합니다. 깨끗한 에뮬레이터에서 실행합니다.

## 검증 순서

1. 관리 화면에서 새 임시저장을 만들고 복사된 상품 가격·사진을 수정합니다. 기본 상품 목록과 과거 행사에는 반영되지 않는지 확인합니다. 주문·송금 마감과 테스트용 수취인·IBAN, 양쪽 언어 수령 안내를 입력해 발행합니다.
2. 방문객 주문을 접수하고 로컬 SMTP에 접수 메일이 도착하는지 확인합니다. 메일 링크에서 주문 비고와 금액을 확인한 후 송금 신고를 합니다. 이때 주문은 은행 입금 확인 대기 상태입니다.
3. 관리자 주문 화면에서 가상의 은행 내역과 주문 금액을 대조해 입금을 확인합니다. 주문 확정 메일을 확인합니다.
4. 정산에서 입금 확인 주문 수량과 발주 박스 수를 대조합니다. 발주서 저장·재조회·확정 및 공급업체별·전체 PDF와 Excel을 확인합니다. 공급업체용 파일에 구매자 연락처나 고객 판매금액이 없는지 확인합니다.
5. 행사를 종료한 뒤 동일 공개 주소에 종료 안내가 나오고, 관리자에서 해당 주문과 발주서가 다시 열리는지 확인합니다.
6. 종료된 행사의 정산에서 수량을 바꾸고 품목·공급업체를 추가합니다. 저장 확인을 취소했을 때 반영되지 않는지 확인한 뒤 승인해 저장합니다. 새로고침 후 변경 내역을 확인하고, 고객 주문·입금 기록과 공개 종료 상태가 유지되는지 확인합니다.
7. 주문관리에서 전화 주문을 별도 등록합니다. 이메일을 비우면 발송하지 않는지 확인합니다. 해당 주문에서 추가 구매를 등록하고 별도 번호·원주문 연결·테스트 메일을 확인합니다. 관리자 정정은 사유와 변경 전후 값을 남기는지, 송금 신고 뒤 총액 변경이 거절되는지 확인합니다.
8. 은행 대조 완료 후의 미입금 취소는 현재 수동입니다. `finalizeNotBefore` 전후를 각각 검증하고 입금 확인 주문이 보존되는지 확인합니다. 예약 함수는 이메일 알림과 재시도를 수행합니다.

## 운영 설정을 변경하기 전에

별도 테스트 Firebase 프로젝트를 사용할 경우 Auth의 테스트 계정, 관리자 문서, Firestore·Storage 권한, Functions 리전(`europe-west1`)과 호출을 허용할 테스트 도메인부터 확인합니다. 운영 적용을 승인받은 뒤 Functions 서비스 계정의 Firestore·Storage 접근, 사진 버킷과 SMTP 호스트·포트·발신 계정, Secret Manager의 `BAZAAR_SMTP_PASSWORD`, 테스트 수신 주소에서의 발송 성공 여부를 확인합니다. 예약 이메일은 Cloud Scheduler의 유럽 파리 시간대와 재시도 기록도 확인합니다. 바자회 함수에 기능을 추가하더라도 운영 사이트와 배포 일정은 별도의 승인을 따릅니다.
