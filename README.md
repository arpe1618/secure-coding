# ♻️ 다시장 — 중고거래 플랫폼

Express + SQLite + JWT 인증 + 토스페이먼츠 결제 연동으로 구현한 중고거래 서비스입니다.

## 요구사항 구현 현황

| # | 요구사항 | 구현 |
|---|---|---|
| 1 | 사용자 가입 | 회원가입/로그인, bcrypt 비밀번호 해싱, JWT 세션 |
| 2 | 상품 등록·조회 | 이미지 업로드 포함 등록, 목록/상세 조회 |
| 3 | 사용자 간 소통 | 상품별 1:1 채팅 (증분 폴링으로 실시간 갱신) |
| 4 | 악성 유저/상품 차단 | 유저 신고 접수 → 관리자 검토 후 차단 집행, 차단 시 피드·로그인에서 제외 |
| 5 | 유저 간 송금 | 지갑 잔액 기반 송금 + 안전거래(에스크로) 구매·정산·환불, 전 과정 원장 기록 |
| 6 | 상품 검색 | 제목/설명 키워드 + 카테고리 필터 |
| + | 마이페이지 | 소개글·비밀번호 업데이트, 다른 유저 프로필 조회 |
| + | 전체 채팅 | 모든 유저 공용 실시간 채팅방 |
| + | 자동 제재 | 서로 다른 N명(기본 3) 신고 시 상품 자동 차단·유저 휴면 전환 |
| 7 | 관리자 전체 관리 | 유저·상품·신고·주문·거래 원장 관리 콘솔 (차단/복구/환불) |
| + | 결제(PG) | 토스페이먼츠 연동으로 지갑 충전 (개발용 모의 결제 모드 내장) |

## 실행 방법

### A. 로컬 개발 (SQLite — DB 설치 불필요)

요구 사항: **Node.js 22.13 이상**

```bash
npm install
cp .env.example .env      # JWT_SECRET, 관리자 비밀번호를 꼭 변경하세요
npm start                 # → http://localhost:3000
```

### B. 운영 배포 (Docker + PostgreSQL)

```bash
cp .env.example .env      # JWT_SECRET, ADMIN_PASSWORD, DB_PASSWORD 설정
docker compose up -d --build   # 앱 + PostgreSQL 컨테이너 실행
```

- DB는 `DB_DRIVER` 환경변수로 전환됩니다 (`sqlite` ↔ `postgres`). 라우트 코드는 동일합니다.
- HTTPS는 `deploy/nginx.conf`를 참고해 Nginx + Let's Encrypt로 구성하세요.

- 일반 유저: 첫 화면에서 회원가입
- 관리자: `.env`의 `ADMIN_NAME` / `ADMIN_PASSWORD`로 로그인 (기본 admin / admin1234)
- 데이터: `data/dasijang.db` (SQLite), 업로드 이미지: `uploads/`

## 결제(토스페이먼츠) 연동

기본값은 `PAYMENT_MODE=mock`(모의 결제)이라 PG 없이 전체 흐름을 테스트할 수 있습니다.

실제 결제창을 띄우려면:

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com)에서 무료 테스트 키(클라이언트/시크릿)를 발급
2. `.env` 수정:
   ```
   PAYMENT_MODE=toss
   TOSS_CLIENT_KEY=test_ck_...
   TOSS_SECRET_KEY=test_sk_...
   ```
3. 서버 재시작 → 지갑 탭 "충전하기"에서 토스 결제창이 열립니다.
   결제 승인은 서버가 시크릿 키로 토스 API(`/v1/payments/confirm`)를 호출해 처리하며,
   금액 변조 검증과 중복 승인 방지(멱등 처리)가 들어 있습니다.

라이브 전환 시 라이브 키로 교체하고 사업자 심사(전자금융업 관련 요건 포함)를 완료해야 합니다.

## 돈이 오가는 구조 (안전거래)

```
[구매자 지갑] --결제--> [에스크로 보관 (orders.status=paid)]
                             │
              구매 확정 ──────┼──────> [판매자 지갑]  (status=completed)
              관리자 환불 ────┴──────> [구매자 지갑]  (status=refunded, 상품 재판매)
```

- 모든 이동은 `transactions` 원장에 기록됩니다.
- 잔액 차감은 `UPDATE ... WHERE balance >= ?` 조건부 갱신 + `BEGIN IMMEDIATE` 트랜잭션으로
  동시 요청에도 마이너스 잔액이 생기지 않습니다.
- 금액은 원 단위 정수만 사용합니다 (부동소수점 금지).

## 프로젝트 구조

```
dasijang/
├─ src/
│  ├─ server.js          # 서버 진입점
│  ├─ db.js              # SQLite 스키마 + 트랜잭션 헬퍼 + 관리자 시드
│  ├─ middleware.js      # JWT 인증 / 관리자 권한
│  └─ routes/
│     ├─ auth.js         # 회원가입, 로그인
│     ├─ market.js       # 상품 CRUD·검색, 채팅, 신고
│     ├─ wallet.js       # 송금, 에스크로 주문, 거래 내역
│     ├─ payments.js     # 지갑 충전 (토스 / mock)
│     └─ admin.js        # 관리자: 유저·상품·신고·주문·원장
├─ public/               # 프론트엔드 SPA (빌드 불필요)
├─ uploads/              # 상품 이미지
├─ data/                 # SQLite DB (sqlite 모드에서 자동 생성)
├─ docs/                 # 설계 문서: ARCHITECTURE.md(ERD·시퀀스), API.md(명세)
├─ deploy/nginx.conf     # HTTPS 리버스 프록시 예시
├─ Dockerfile / docker-compose.yml
```

## 설계 문서

- **docs/ARCHITECTURE.md** — 시스템 구성도, ERD, 결제·에스크로 시퀀스 다이어그램, 돈 처리 원칙, 보안 설계, 확장 로드맵
- **docs/API.md** — 전체 REST API 명세 (요청/응답/오류 코드)
- **docs/TESTING.md** — 요구사항 추적표, 기능/보안 체크리스트, 유지보수 가이드
- **tests/e2e.sh** — 25개 자동 테스트 (`bash tests/e2e.sh`로 실행)

## API 요약

```
POST /api/auth/signup, /api/auth/login          GET /api/auth/me
GET  /api/products?q=&category=                 GET/POST/DELETE /api/products/:id
POST /api/chats                                 GET /api/chats
GET/POST /api/chats/:id/messages (?after=id 폴링)
POST /api/reports
POST /api/wallet/transfer                       GET /api/wallet/transactions
POST /api/wallet/orders                         POST /api/wallet/orders/:id/confirm
POST /api/payments/charges                      POST /api/payments/charges/{mock,toss}-confirm
GET  /api/admin/{summary,users,products,reports,orders,transactions}
POST /api/admin/users/:id/block  /products/:id/block  /reports/:id/resolve  /orders/:id/refund
```

## 운영 배포 전 체크리스트

- [ ] `JWT_SECRET`을 길고 무작위한 값으로 교체
- [ ] 관리자 비밀번호 변경
- [ ] HTTPS 리버스 프록시(Nginx/Caddy) 뒤에서 실행
- [ ] 운영은 PostgreSQL 사용 (`docker compose up`이면 자동 구성)
- [ ] 레이트 리밋(express-rate-limit), 로그 수집 추가
- [ ] 토스페이먼츠 라이브 키 + 사업자 심사
