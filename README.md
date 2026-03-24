# HonTo Memo

Cloudflare Workers + TiDB Cloud Starter 기반 원격 메모장입니다.

같은 Worker 주소로 접속하면 다른 IP, 다른 컴퓨터에서도 같은 메모를 보고 수정할 수 있습니다. 프론트는 정적 파일로 배포되고, 메모 데이터는 TiDB(MySQL 호환)에 저장됩니다.

## 현재 배포 구조

- 정적 사이트: Cloudflare Workers assets
- API: `src/worker.js`
- DB: TiDB Cloud Starter
- 프론트: `public/index.html`, `public/script.js`

## Cloudflare Secrets

Worker `Settings -> Variables and Secrets`에 아래 값을 넣으면 됩니다.

- `TIDB_HOST`
- `TIDB_PORT`
- `TIDB_USER`
- `TIDB_PASSWORD`
- `TIDB_DATABASE`

예시:

- `TIDB_HOST`: `gateway01.ap-northeast-1.prod.aws.tidbcloud.com`
- `TIDB_PORT`: `4000`
- `TIDB_USER`: `27FJXp28cnpuvq7.root`
- `TIDB_DATABASE`: `test`
- `TIDB_PASSWORD`: TiDB에서 새로 만든 비밀번호

선택 사항:

- `DATABASE_URL`
  값이 있으면 Worker가 이 값을 우선 사용합니다.
  형식: `mysql://USER:PASSWORD@HOST:PORT/DATABASE?sslaccept=strict`

## Worker가 하는 일

- `/api/health`: 연결 상태 확인
- `/api/notes`: 메모 목록 조회
- `/api/notes/:id`: 메모 저장, 삭제
- 첫 실행 시 `notes` 테이블 자동 생성
- 테이블이 비어 있으면 `SYSTEM_READY.log` 기본 메모 자동 생성

## 프론트 동작

`public/script.js`는 서버 전송 실패 시 브라우저 `localStorage`에 변경 내용을 붙잡아 두고, 다시 온라인이 되면 자동 재전송합니다.

즉 학교 와이파이가 잠깐 끊기거나 요청이 시간 초과되어도 브라우저 안에서는 메모가 바로 사라지지 않게 되어 있습니다.

## 중요한 제한

Cloudflare Workers는 서버 파일시스템에 `.txt`를 쓰는 방식의 백업을 지원하지 않습니다. 그래서 배포 버전은 예전 Rust 서버처럼 `failed_notes` 폴더에 서버 측 `.txt` 파일을 남길 수 없습니다.

대신 현재 배포 버전의 실패 대비 방식은 이렇습니다.

- 1차 보호: 브라우저 `localStorage` 임시 저장
- 2차 보호: 네트워크 복구 시 자동 재전송

로컬에서 Rust 서버를 직접 돌릴 때만 기존 `src/main.rs` 경로의 `failed_notes` 백업 흐름을 사용할 수 있습니다.

## 파일 구성

- `src/worker.js`: Cloudflare Worker API + TiDB 연결
- `wrangler.jsonc`: Worker 이름과 정적 assets 설정
- `package.json`: `@tidbcloud/serverless`, `wrangler`
- `public/index.html`: 메모 앱 화면
- `public/script.js`: 자동 저장, 재전송, 메모 편집 로직

## 다음 배포 방법

1. GitHub 저장소에 현재 코드 반영
2. Cloudflare에서 이 저장소를 Worker 프로젝트로 연결하거나 `Edit code`로 코드 반영
3. Secrets 유지
4. 배포 후 `https://<worker-name>.<subdomain>.workers.dev/api/health` 확인
5. 메인 주소에서 메모 생성 후 MySQL Workbench에서 `test.notes` 확인