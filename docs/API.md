# 다시장 — API 명세서

- Base URL: `/api`
- 인증: 로그인/가입을 제외한 모든 엔드포인트는 `Authorization: Bearer {JWT}` 필수
- 응답: 성공은 2xx + JSON, 실패는 4xx/5xx + `{ "error": "사유" }`
- 관리자 API(`/admin/*`)는 `is_admin=1` 계정만 접근 가능 (아니면 403)

## 인증

### POST /auth/signup — 회원가입
| Body | 타입 | 제약 |
|---|---|---|
| name | string | 2~20자, 유니크 |
| password | string | 4자 이상 |

`201 → { token, user: { id, name, balance, is_admin } }`
오류: 400(형식), 409(닉네임 중복)

### POST /auth/login — 로그인
Body: `{ name, password }`
`200 → { token, user }` / 401(불일치), 403(차단·휴면 계정), 429(브루트 포스 잠금)
- **IP 기준** 제한: 한 IP가 10분 내 `LOGIN_ATTEMPT_LIMIT`(기본 10)회 실패 시 그 IP의 로그인을 10분간 429 제한 (계정을 잠그지 않아 계정 잠금 DoS 불가)

### GET /auth/me — 내 정보 (잔액 갱신용)
`200 → { user }`

### PUT /auth/me — 소개글 수정
Body: `{ bio }` (200자 이하) → `200 → { ok, bio }`

### PUT /auth/password — 비밀번호 변경
Body: `{ old_password, new_password }` → `200 → { ok }` / 400(현재 비밀번호 불일치·형식)

### GET /users/:id — 사용자 프로필 조회
`200 → { user: { id, name, bio, created_at }, products }` / 404(없음·차단·휴면)

## 상품

### GET /products?q={키워드}&category={카테고리} — 목록/검색
- 제목·설명 LIKE 검색 + 카테고리 필터, 최신순 100개
- 차단된 상품과 차단된 유저의 상품은 제외
`200 → { products: [{ id, seller_id, seller_name, title, price, category, description, image, status, created_at }], categories }`

### GET /products/:id — 상세
`200 → { product }` / 404(없음·삭제·차단)

### POST /products — 등록 (multipart/form-data)
| 필드 | 타입 | 제약 |
|---|---|---|
| title | text | 1~60자 |
| price | text | 정수 1~100,000,000 |
| category | text | 디지털·가구·생활·패션·기타 |
| description | text | 선택 |
| image | file | 선택, 이미지 MIME, 5MB 이하 |

`201 → { id }`

### DELETE /products/:id — 삭제 (본인 또는 관리자, 판매완료 제외)
`200 → { ok }` / 403, 400

## 채팅

### POST /chats — 대화 시작
Body: `{ product_id }` — 기존 방이 있으면 그 방 반환. 본인 상품이면 400.
`200 → { chat_id }`

### GET /chats — 내 대화 목록 (구매자·판매자 양쪽, 최근 메시지 포함)
`200 → { chats: [{ id, product_title, price, image, buyer_id, buyer_name, seller_id, seller_name, last_text, last_at }] }`

### GET /chats/:id/messages?after={msg_id} — 메시지 조회
- `after` 이후 메시지만 반환 (증분 폴링, 권장 주기 2~3초)
- 참여자와 관리자만 접근 가능
`200 → { chat, messages: [{ id, sender_id, sender_name, text, created_at }] }`

### POST /chats/:id/messages — 전송
Body: `{ text }` (1~1000자) → `201 → { id }`

## 전체 채팅

### GET /global-chat?after={msg_id} — 전체 채팅 조회 (증분 폴링)
`200 → { messages: [{ id, sender_id, sender_name, text, created_at }] }`

### POST /global-chat — 전체 채팅 전송
Body: `{ text }` (1~500자) → `201 → { id }`

## 신고

### POST /reports — 유저/상품 신고
Body: `{ kind: "user"|"product", target_id, reason }`
`201 → { ok, auto_sanctioned }` — 서로 다른 신고자 수가 `REPORT_AUTO_LIMIT`(기본 3) 이상이면
상품은 자동 차단, 유저는 휴면 전환(`auto_sanctioned: true`). 그 외는 관리자 검토

## 지갑

### POST /wallet/transfer — 송금
Body: `{ to_name, amount, memo? }`
`200 → { ok }` / 400(잔액 부족·본인·차단 계정), 404(수신자 없음)

### POST /wallet/orders — 안전거래 구매 (에스크로)
Body: `{ product_id }`
- 잔액 차감 → 에스크로 보관, 상품 sold 전환. 동시 구매 시 한 명만 성공(409).
`201 → { order: { id } }`

### POST /wallet/orders/:id/confirm — 구매 확정 (판매자 정산)
`200 → { ok }` / 403(본인 주문 아님), 400(이미 처리)

### GET /wallet/orders — 내 주문 (구매+판매)
`200 → { orders: [{ id, product_title, amount, status: paid|completed|refunded, buyer_name, seller_name, created_at }] }`

### GET /wallet/transactions — 내 거래 원장 (최근 100건)
`200 → { transactions: [{ from_id, from_name, to_id, to_name, amount, memo, created_at }] }`
- `from=NULL`: 외부 충전/환불 입금, `to=NULL`: 에스크로 출금

## 결제 (지갑 충전)

### POST /payments/charges — 충전 요청 생성
Body: `{ amount }` — 허용 금액: 5,000 / 10,000 / 30,000 / 50,000 / 100,000
`201 → { order_no, amount, mode: "mock"|"toss", client_key, order_name }`

### POST /payments/charges/mock-confirm — 모의 승인 (mock 모드)
Body: `{ order_no }` → `200 → { ok, amount }` (멱등)

### POST /payments/charges/toss-confirm — 토스 승인 (toss 모드)
Body: `{ paymentKey, orderId, amount }` — successUrl 쿼리 그대로 전달
- 서버가 금액 일치 검증 후 토스 승인 API 호출. 멱등 처리.
`200 → { ok, amount }` / 400(금액 불일치·승인 실패), 502(PG 통신 실패)

## 관리자

### GET /admin/summary — 대시보드
`200 → { users, blocked_users, products, blocked_products, open_reports, orders, escrow_held }`

### GET /admin/users · POST /admin/users/:id/block
Body: `{ blocked: 0|1 }` — 유저 목록(피신고 수·휴면 상태 포함) 조회 / 차단·해제

### POST /admin/users/:id/dormant — 휴면 전환/해제
Body: `{ dormant: 0|1 }` — 자동 휴면된 계정 복구에 사용

### GET /admin/products · POST /admin/products/:id/block
Body: `{ blocked: 0|1 }` — 상품 목록 조회 / 차단·복구 (판매완료 제외)

### GET /admin/reports · POST /admin/reports/:id/resolve
Body: `{ action: "block"|"dismiss" }` — block이면 대상 즉시 차단 후 처리 완료

### GET /admin/orders · POST /admin/orders/:id/refund
- 에스크로(paid) 상태 주문을 구매자에게 환불하고 상품을 재판매 전환

### GET /admin/transactions — 전체 원장 (최근 300건)

## 보안: CSRF 토큰

- 로그인/회원가입 응답의 `Set-Cookie`에 `csrf` 쿠키(httpOnly 아님)가 포함된다.
- 쿠키 인증(브라우저)으로 **상태변경 요청**(POST/PUT/DELETE)을 보낼 때는
  이 `csrf` 쿠키값을 `X-CSRF-Token` 헤더로도 함께 보내야 한다. 불일치 시 403.
- `Authorization: Bearer` 헤더로 인증하는 API 클라이언트/테스트는 CSRF 검증 대상이 아니다.

## 공통 오류 코드

| 코드 | 의미 |
|---|---|
| 400 | 입력 오류, 잔액 부족, 상태 전이 불가 |
| 401 | 미로그인, 토큰 만료 |
| 403 | 권한 없음, 차단 계정 (`blocked: true` 포함), CSRF 토큰 불일치 |
| 404 | 리소스 없음 |
| 409 | 중복 (닉네임, 동시 구매) |
| 502 | 외부 결제 서버 통신 실패 |
