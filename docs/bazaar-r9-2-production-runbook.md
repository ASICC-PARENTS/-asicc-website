# ASICC 바자회 R9.2 운영 적용 절차

이 문서는 운영 승인 이후의 절차다. 현재 검수 범위는 `feat/online-bazaar`, `asicc-integration-test`, `asicc-bazaar-test-api`, `asicc-bazaar-test`다. 테스트 Worker와 스케줄러는 `MAIL_MODE=capture`로 동작한다.

## 1. 통합과 배포 전제

2026-11-25에 조회한 원격 `main`은 `00a01ea58fc30cae38399d596ecc89e98a24ac05`다. 기준 개발 커밋과의 `git merge-tree`는 충돌 없이 트리를 생성했다. 개발 브랜치에는 Firebase 규칙, 회원 관련 코드, 배너와 별도 CI 변경도 있으므로 운영 통합 시 최신 `main` 기준으로 실제 적용할 변경 목록을 별도 PR에서 확인한다.

현재 코드에는 운영 공개를 막는 설정이 있다.

- 공식 도메인에서는 `src/lib/bazaar/api.ts`의 테스트 모드가 꺼진다. 테스트 환경변수를 복사해도 공식 사이트에서 바자회 API가 연결되지는 않는다.
- `worker/bazaar/index.mjs`는 로컬 에뮬레이터 또는 `asicc-bazaar-test`만 허용하고, 공식 도메인을 거부하며, 메일을 강제로 `capture`로 지정한다.
- 테스트 사이트는 GitHub Actions에서 별도의 Direct Upload 프로젝트에 배포한다. 운영 사이트의 `main` 기반 GitHub Pages 작업은 별도로 유지한다. 운영 빌드에서 테스트용 robots 차단, Firebase 초기화 및 Worker URL이 유입되지 않는지 생성물까지 확인한다. [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)

운영 사용에는 별도로 승인된 운영 Worker·사이트 설정과 목표 Origin·프로젝트 검증이 필요하다. 최신 `main` 위에 범위가 제한된 변경을 올리고 운영 서비스에 실제 연결하기 전에 동일한 빌드를 격리 환경에서 검사한다.

## 2. 필요한 설정과 권한

| 서비스 | 승인 후 점검할 설정 |
| --- | --- |
| Firebase 웹앱 | 기존 운영 회원 인증을 유지한다. 운영 바자회의 목표 프로젝트와 웹앱을 운영진이 확정한다. Auth에 허용할 도메인과 Worker가 받는 ID 토큰의 발급자·대상 프로젝트가 일치해야 한다. 승인된 이메일 인증 계정의 `members/{uid}`에서 `role: admin` 및 `status: approved`를 확인한다. `bazaarMeta/access`가 있다면 운영진 UID만 반영한다. |
| Firestore | Worker 서버 계정에 해당 프로젝트의 읽기·쓰기 권한만 부여한다. 역할은 필요한 Datastore 권한으로 한정한다. 브라우저의 주문·증빙 컬렉션 직접 접근은 차단한다. 테스트 규칙을 운영 규칙 위에 일괄 배포하기 전에 운영 회원·갤러리·학습자료·운영센터 규칙 차이를 검토한다. |
| Cloudflare Worker | 운영 사이트 CORS Origin, 운영 Firebase 프로젝트, 배포 대상 이름, `FIRESTORE_CLIENT_EMAIL`, `FIRESTORE_PRIVATE_KEY`, `BAZAAR_PHOTO_SIGNING_KEY`, B2 및 메일 Secret을 대상별로 설정한다. 테스트 Secret과 혼용하지 않는다. 사진·증빙 키는 암호화 복구에 필요하므로 키 원문은 소스·로그에 두지 않고 운영진의 암호화 저장소에 버전 이력을 유지한다. 무중단 키 교체는 기존 증빙 복호화 검증을 전제로 한다. 배포 토큰은 지정 Cloudflare 계정의 Workers Scripts Edit로 제한한다. |
| GitHub Pages 및 테스트 Pages | 운영은 기존 GitHub Pages 환경 권한을 쓰고, 테스트 Pages 토큰은 기존 ASICC 계정 Pages Edit만 사용한다. 운영·테스트 워크플로 이름, 배포 환경, 계정 변수, 승인 조건을 분리한다. |
| Backblaze B2 | 기존 버킷에서 운영용 접두사 `bazaar/production/photos/` 또는 승인한 전용 접두사를 사용한다. 테스트는 `bazaar/test/photos/`에 격리한다. `B2_BUCKET`, `B2_S3_ENDPOINT`, `B2_KEY_ID`, `B2_APPLICATION_KEY`를 대상별로 분리한다. 대상 버킷·접두사에 대응하는 객체 읽기·쓰기만 부여한다. 영구 삭제는 정상 운영 권한에 포함하지 않는다. 증빙은 전용 하위 경로에 암호화하고 직접 접근 차단·관리자 다운로드를 확인한다. [B2 키와 접두사 권한](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys) |
| Brevo | 검증된 ASICC 발신 도메인과 발신자를 유지하고 거래 이메일용 최소 권한 키를 Worker Secret에 등록한다. `MAIL_PROVIDER`, `BAZAAR_MAIL_API_KEY`, `BAZAAR_MAIL_FROM`을 확인한다. 테스트는 `capture`와 별도 수신자 제한을 유지한다. 운영 발송 활성화는 별도 승인과 계정 전체 한도 확인, 중복 방지·수신 시험 후 진행한다. 기존 OVH/DNS/Resend 설정을 이 절차에서 변경하지 않는다. [Brevo 거래 이메일 설정](https://developers.brevo.com/docs/send-a-transactional-email) |

## 3. 백업과 테스트 데이터 분리

1. 승인한 작업 시간에 주문·관리자 쓰기를 중지하고, 대기 중인 입금·환불·메일 상태를 기록한다. 운영 Git SHA, 실제 Pages 배포 URL, Worker 버전 ID와 변수 **이름**, Firebase 규칙·색인 버전을 변경 기록에 남긴다.
2. Firebase Spark에서는 관리형 Firestore export/import에 Blaze가 필요하다. 현재 요금제를 유지한다면 읽기 전용 서비스 계정으로 승인된 컬렉션과 하위 컬렉션을 Firestore API로 내보내는 경로를 별도로 검증한다. 페이지네이션, 문서형 데이터와 ID, 결제 하위 원장, 정정·결산 이력, 메일 대기열을 포함한다. 개수 및 해시 확인 후 암호화 보관한다. CSV 명부는 원장 복구본과 별도로 보관한다. [Firestore export/import 요금제 조건](https://firebase.google.com/docs/firestore/manage-data/export-import)
3. B2는 운영 접두사에 한정해 객체 경로·버전·크기·해시를 목록화한다. 암호화 증빙의 사본, 복호화에 필요한 승인된 키, Firestore 증빙 인덱스를 함께 보관한다. 실제 고객정보나 계좌정보를 테스트 환경에 복제하지 않는다.
4. 데이터 복구는 먼저 로컬 에뮬레이터나 별도 격리 환경에서 시험한다. 하위 컬렉션과 객체 연결, 재고·입금·환불 합계, 관리자 권한을 확인한다. 백업이나 복원 실습의 성공 기록이 없으면 운영 적용을 승인받기 전에 이를 해결한다.

## 4. 배포 순서와 장애 복구

1. 운영 전용 Worker를 지정된 프로젝트로 배포한다. 인증 없는 관리자 API 거절, 승인된 운영진 인증, 공개 응답의 개인정보 차단, 비공개 증빙 접근 차단, 합계와 재고를 먼저 점검한다. 메일은 이 단계에서 capture를 유지한다.
2. 승인된 운영 빌드만 공식 사이트에 적용한다. 한국어·프랑스어 홈페이지, 회원 로그인과 운영센터, 상품·주문 화면, 공식 연락처와 약관, 모바일에서 주요 버튼을 확인한다. 기존 사이트 파일·기존 주문을 쓰기 검수에 사용하지 않는다.
3. 장애 시 신규 주문과 메일 처리부터 중지하고, 문제가 시작된 시각과 버전을 기록한다. 기존 Worker를 기록한 버전 ID로 롤백한다. GitHub Pages는 이전 승인 SHA의 정적 빌드를 기존 운영 워크플로로 다시 게시한다. Cloudflare 테스트 Pages는 이전에 성공한 기본 배포를 선택해 롤백할 수 있다. [Worker 롤백](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) · [Pages 롤백](https://developers.cloudflare.com/pages/configuration/rollbacks/)
4. 코드 롤백은 Firestore와 B2를 복원하지 않는다. 장애 이후 접수된 주문·입금·환불 기록을 보존하고 재고와 원장을 먼저 대조한다. 메일 결과가 불확실한 항목은 제공사 이력을 확인한 뒤 재발송 여부를 판단한다. 데이터 복원이나 실제 금융 정정은 검증된 복구본과 별도 운영 승인으로 진행한다.
