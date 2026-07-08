# 다시장 
## 시큐어 코딩 과제 - Tiny Second-hand Shopping Platform

> 쓰던 물건이 다시 장터로 — 우리 동네 중고거래 플랫폼
>
> 소프트웨어 개발 실습 / 시큐어코딩 과제 제출물

회원가입·로그인, 상품 등록/조회/검색, 1대1 및 전체 채팅, 지갑 충전·송금·에스크로 거래,
신고 및 자동 제재, 관리자 콘솔을 제공하는 중고거래 웹 애플리케이션입니다.
Node.js(Express) + SQLite(기본) / PostgreSQL(선택) 기반이며, 토스페이먼츠 결제를 연동합니다.

---

## 1. 요구 환경

| 항목 | 버전 / 비고 |
|---|---|
| Node.js | **22.13 이상** (`node --version`으로 확인) |
| npm | Node.js에 포함 |
| DB | SQLite(기본, 별도 설치 불필요) 또는 PostgreSQL(선택) |
| OS | Windows / macOS / Linux |

> SQLite는 Node.js 내장 모듈(`node:sqlite`)을 사용하므로 별도 설치가 필요 없습니다.

---

## 2. 설치 및 실행

```bash
# 1) 소스 내려받기
git clone https://github.com/<본인아이디>/dasijang.git
cd dasijang

# 2) 의존성 설치
npm install

# 3) 환경 변수 파일 생성 (예시 파일 복사)
cp .env.example .env
#   → .env 를 열어 JWT_SECRET, ADMIN_PASSWORD 등을 반드시 변경하세요.

# 4) 서버 실행
npm start
```

실행에 성공하면 다음과 같이 출력됩니다.

```
다시장 서버 실행 중 → http://localhost:3000
DB: sqlite · 결제 모드: 모의 결제(mock)
```

브라우저에서 **http://localhost:3000** 으로 접속합니다.
관리자 계정(`.env`의 `ADMIN_NAME` / `ADMIN_PASSWORD`)은 최초 실행 시 자동 생성됩니다.

---

## 3. 환경 변수 (.env)

`.env.example`을 복사해 `.env`로 만든 뒤 값을 채웁니다. 주요 항목은 다음과 같습니다.

| 변수 | 설명 | 기본값 |
|---|---|---|
| `PORT` | 서버 포트 | `3000` |
| `JWT_SECRET` | 토큰 서명 비밀키 — **운영 시 반드시 변경** | (예시값) |
| `ADMIN_NAME` / `ADMIN_PASSWORD` | 최초 생성 관리자 계정 | `admin` / `admin1234` |
| `DB_DRIVER` | `sqlite`(기본) 또는 `postgres` | `sqlite` |
| `DATABASE_URL` | PostgreSQL 사용 시 접속 문자열 | (예시값) |
| `PAYMENT_MODE` | `mock`(모의 결제) 또는 `toss`(실연동) | `mock` |
| `TOSS_CLIENT_KEY` / `TOSS_SECRET_KEY` | 토스페이먼츠 키 (toss 모드) | (비어 있음) |
| `REPORT_AUTO_LIMIT` | 자동 제재 임계 신고자 수 | `3` |
| `LOGIN_ATTEMPT_LIMIT` | 로그인 실패 허용 횟수(IP 기준) | `10` |
| `DAILY_POST_LIMIT` | 1일 상품 등록 한도 | `30` |
| `API_RATE_LIMIT_PER_MIN` | IP당 분당 API 요청 상한 | `300` |
| `COOKIE_SECURE` | HTTPS 배포 시 `1` | `0` |


### 결제(토스페이먼츠) 실연동을 쓰려면

1. https://developers.tosspayments.com 에서 무료 **테스트 키**를 발급받습니다.
2. `.env`에 `PAYMENT_MODE=toss`, `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`를 설정합니다.
3. 테스트 키 환경에서는 실제 카드 정보를 입력해도 출금되지 않습니다(가상 결제).

---

## 4. 테스트

기능·보안 자동 테스트 스크립트(총 49개 케이스)가 포함되어 있습니다.

```bash
# 1) 깨끗한 DB로 시작 (기존 데이터가 있으면 백업 후)
rm -f data/dasijang.db*

# 2) 레이트 리밋에 걸리지 않도록 크게 설정하여 서버 실행
API_RATE_LIMIT_PER_MIN=100000 npm start

# 3) 다른 터미널에서 테스트 실행
bash tests/e2e.sh          # → "결과: 통과 49 / 실패 0"
```

> 테스트는 한 IP에서 수백 건을 보내므로 전역 레이트 리밋을 크게 설정한 상태에서 실행합니다.

---

## 5. 프로젝트 구조

```
dasijang/
├─ src/
│  ├─ server.js          # 진입점, 보안 헤더·레이트리밋·에러 핸들러
│  ├─ db.js              # SQLite/PostgreSQL 어댑터, 스키마
│  ├─ middleware.js      # 인증, CSRF, 공통 핸들러
│  └─ routes/            # auth, market, wallet, payments, admin
├─ public/               # 프론트엔드 (index.html, app.js, style.css)
├─ tests/e2e.sh          # 자동 테스트 (49개)
├─ docs/
│  ├─ SECURITY.md         # 보안 패치 내역
│  ├─ TESTING.md          # 테스트 체크리스트·유지보수 가이드
│  ├─ API.md              # REST API 명세
│  └─ ARCHITECTURE.md     # 구조 설명
├─ .env.example          # 환경 변수 예시
└─ README.md
```

---

## 6. 주요 기능

- **회원/인증** — 회원가입·로그인(bcrypt 해싱, httpOnly 쿠키 JWT), 마이페이지(소개글·비밀번호 변경), 사용자 프로필 조회
- **상품** — 등록(이미지 업로드)·조회·검색·상세, 내 상품 관리
- **채팅** — 상품별 1대1 채팅, 전체 유저 공용 채팅(폴링)
- **지갑** — 충전(토스페이먼츠/모의), 송금, 에스크로(안전거래) 주문·확정
- **신고/제재** — 상품·유저 신고, 서로 다른 신고자 임계 도달 시 자동 차단/휴면, 관리자 콘솔
