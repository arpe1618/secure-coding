# 다시장 — 보안 위협 및 패치 내역

본 문서는 「다시장」 중고거래 플랫폼의 개발 과정에서 발견한 보안 위협과 그 조치를
**문제점 → 해결방안** 형식으로 코드 단위로 정리한 것이다. 개발 보고서에 개시된 순서를 따른다.

발견 경로:
1. 수동 테스트 중 발견한 취약 시나리오
2. 외부 AI 진단 (파일 업로드 우회, JWT 저장 방식)
3. AI가 자주 간과하는 유형의 교차검증
4. 유형별 심층 점검 (라이브러리 CVE)
5. 결제 연동 관련 취약점 (모의결제, CSRF, CSP)
6. 시큐어코딩 관점의 전역 방어 보강
7. 확장 시 한계

> 모든 조치는 자동 테스트 스위트(`tests/e2e.sh`, 총 49개 케이스)로 회귀 검증되었다.

---

## 1. 수동 테스트 중 발견한 취약 시나리오

### 1-1. 로그인 브루트 포스

**문제점**

로그인 실패 횟수에 제한이 없어 비밀번호 무차별 대입이 가능했다. bcrypt 해싱이 연산을
늦추긴 하지만 시도 횟수 자체를 막는 장치가 없었다.

**해결방안**

"계정 잠금"이 아니라 "요청 IP의 로그인 시도를 일시 제한"하는 방식으로 조치했다.
계정을 잠그면 공격자가 남의 계정을 일부러 틀려 그 사람을 못 들어오게 만드는
**계정 잠금 DoS**가 가능하므로, 계정이 아닌 IP를 제한하도록 설계했다.

```javascript
// src/routes/auth.js
const MAX_FAILS = parseInt(process.env.LOGIN_ATTEMPT_LIMIT || "10", 10); // IP당 허용 실패 수
const WINDOW_MS = 10 * 60 * 1000;   // 실패를 세는 시간 창(10분)
const COOLDOWN_MS = 10 * 60 * 1000; // 초과 시 그 IP 제한 시간(10분)
const ipFails = new Map();          // ip → { fails:[timestamps], until }

function recordIpFail(ip) {          // 실패는 "요청한 IP"에 누적 (피해자 계정이 아니라)
  const now = Date.now();
  const a = ipFails.get(ip) || { fails: [] };
  a.fails = a.fails.filter((t) => now - t < WINDOW_MS);
  a.fails.push(now);
  if (a.fails.length >= MAX_FAILS) a.until = now + COOLDOWN_MS; // 임계 초과 → 그 IP 쿨다운
  ipFails.set(ip, a);
}
function clearIpFails(ip) { ipFails.delete(ip); } // 로그인 성공 시 초기화
```

로그인 처리부에서 IP 쿨다운을 먼저 확인하고, 실패는 요청 IP에 누적한다.

```javascript
// src/routes/auth.js — 로그인 핸들러
const wait = ipCooldownMinutes(ip);
if (wait > 0)
  return res.status(429).json({ error: `이 위치에서 로그인 시도가 너무 많습니다. 약 ${wait}분 후 다시 시도해 주세요.` });
const user = await q.get("SELECT * FROM users WHERE name = ?", name);
if (!user || !bcrypt.compareSync(password, user.pw_hash)) {
  recordIpFail(ip);
  return res.status(401).json({ error: "닉네임 또는 비밀번호가 맞지 않습니다." });
}
clearIpFails(ip); // 성공 → 해당 IP 카운터 초기화
```

> **한계(문서화)**: 봇넷(수천 IP 분산 공격)까지 완전히 막으려면 실제 서비스에서는
> 추가로 CAPTCHA를 적용해야 한다. 본 프로젝트는 IP 기준 제한까지 구현하고,
> CAPTCHA는 실서비스 필수 사항으로 명시한다.

---

### 1-2. 관리자 보드의 무제한 데이터 로드 (DoS)

**문제점**

관리자 목록 API(회원·상품·주문 등)가 조건 없이 전체 행을 반환했다. 데이터가 누적되면
관리자가 목록을 여는 순간 대량의 행이 메모리에 적재되어 서버가 다운, 전체 서비스가
서비스 거부(DoS) 상태에 빠질 수 있었다.

**해결방안**

전 목록 API에 페이지당 100건 제한과 `page` 파라미터를 도입했다. page 값은 안전한
범위로 제한하여 정수 오버플로우로 인한 크래시도 방지한다.

```javascript
// src/routes/admin.js
const PAGE_SIZE = 100;
const MAX_PAGE = 100000; // OFFSET 정수 오버플로우로 인한 500 크래시 방지
const pageOf = (req) => {
  let p = parseInt(req.query.page, 10);
  if (!Number.isFinite(p) || p < 1) p = 1;
  if (p > MAX_PAGE) p = MAX_PAGE;
  return (p - 1) * PAGE_SIZE;
};

// 사용 예
// ... ORDER BY u.id DESC LIMIT ${PAGE_SIZE} OFFSET ?   // pageOf(req)
```

---

### 1-3. 채팅 도배

**문제점**

전체 채팅에 전송 간격·횟수 제한이 없어, 봇으로 초당 수백 건을 보내 채팅을 마비시키고
DB를 부풀릴 수 있었다. (50회 연속 전송이 전부 성공함을 확인)

**해결방안**

유저당 "10초에 8건, 최소 1.5초 간격" 제한을 두었다.

```javascript
// src/routes/market.js
function gchatAllowed(userId) {
  const now = Date.now();
  const arr = (gchatHits.get(userId) || []).filter((t) => now - t < 10000);
  if (arr.length >= 8) return false;                           // 10초당 8건 초과 차단
  if (arr.length && now - arr[arr.length - 1] < 1500) return false; // 최소 1.5초 간격
  arr.push(now);
  gchatHits.set(userId, arr);
  return true;
}

// 전송 핸들러
if (!gchatAllowed(req.user.id))
  return res.status(429).json({ error: "메시지를 너무 빠르게 보내고 있어요. 잠시 후 다시 시도해 주세요." });
```

---

### 1-4. 게시글 무제한 등록

**문제점**

한 사용자가 상품을 무제한 등록할 수 있어 피드 도배가 가능했다. 상품 등록에 이미지
업로드가 동반되므로, 용량이 큰 이미지 게시글을 대량 등록하면 디스크(DB) 도배로
이어질 수 있었다.

**해결방안**

당일 등록 수를 세어 30개 초과 시 거절한다. **삭제한 글도 집계에 포함**시켜
"지우고 다시 올리기" 우회를 막았다.

```javascript
// src/routes/market.js
const LIMIT = parseInt(process.env.DAILY_POST_LIMIT || "30", 10);
const today = new Date().toISOString().slice(0, 10);
const { n } = await q.get(
  "SELECT COUNT(*) AS n FROM products WHERE seller_id = ? AND created_at LIKE ?",
  req.user.id, today + "%");        // 삭제분(status='deleted')도 집계됨
if (Number(n) >= LIMIT)
  return res.status(429).json({ error: `하루 상품 등록은 ${LIMIT}개까지 가능합니다.` });
```

---

### 1-5. 회원가입 진입장벽 부재 (신고 오남용 / 사기)

**문제점**

회원가입에 본인 확인 절차가 없어, 가짜 계정을 여러 개 만들면 자동 제재(서로 다른
신고자 3명 도달 시 차단·휴면)를 악용해 정상 판매자를 부당하게 제재할 수 있었다.
또한 신고 대상(`target_id`)을 요청 바디로 임의 지정할 수 있었고, 자기 신고·중복 신고를
막지 않았다.

```javascript
// (수정 전) src/routes/market.js
const exists = kind === "user"
  ? await q.get("SELECT id FROM users WHERE id = ?", targetId)   // 관리자·본인 체크 없음
  : await q.get("SELECT id FROM products WHERE id = ?", targetId);
await q.run("INSERT INTO reports ...");                          // 중복 신고 체크 없음
```

**해결방안**

자기 자신·본인 상품·동일인 중복·관리자 신고를 모두 차단해 카운트 조작 경로를 좁혔다.

```javascript
// (수정 후) src/routes/market.js
if (kind === "user") {
  if (targetId === req.user.id)
    return res.status(400).json({ error: "자기 자신은 신고할 수 없습니다." });
} else {
  const own = await q.get("SELECT seller_id FROM products WHERE id = ?", targetId);
  if (own && own.seller_id === req.user.id)
    return res.status(400).json({ error: "본인 상품은 신고할 수 없습니다." });
}
const exists = kind === "user"
  ? await q.get("SELECT id FROM users WHERE id = ? AND is_admin = 0", targetId) // 관리자 제외
  : await q.get("SELECT id FROM products WHERE id = ?", targetId);
const dup = await q.get(
  "SELECT id FROM reports WHERE kind = ? AND target_id = ? AND reporter_id = ?",
  kind, targetId, req.user.id);
if (dup) return res.status(409).json({ error: "이미 신고한 대상입니다." }); // 중복 차단
```

> **근본 대책(문서화)**: 다중 계정 생성 자체를 막으려면 회원가입 시 휴대폰(SMS) 인증으로
> 번호당 1계정을 강제해야 한다. 이는 실서비스 필수 사항으로 명시한다.

---

## 2. 외부 AI 진단으로 발견한 취약점

### 2-1. 파일 업로드 검증 우회 + 저장형 XSS (심각)

**문제점**

상품 이미지 업로드가 클라이언트가 보낸 확장자와 MIME 타입을 신뢰했다. 둘 다 조작
가능하므로, 스크립트가 든 파일을 이미지로 위장해 업로드하면 서버에 저장되어 이후
접근 시 저장형 XSS로 이어질 수 있었다.

```javascript
// (수정 전) src/routes/market.js
filename: (_req, file, cb) =>
  cb(null, Date.now() + "-" + ... + path.extname(file.originalname).toLowerCase()), // 원본 확장자 신뢰
fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),           // MIME 위조 가능
```

**해결방안**

① 확장자 없이 임시 저장 → ② 파일 내용의 시그니처(매직 바이트)로 실제 이미지인지 검증
→ ③ 검증된 포맷으로 서버가 확장자 부여. 위장 파일은 즉시 삭제한다.

```javascript
// (수정 후) src/routes/market.js
function sniffImageType(filePath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "png";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null; // 이미지로 위장한 HTML/JS 등은 여기서 걸러짐
}
function validateUpload(req) {
  if (!req.file) return null;
  const type = sniffImageType(req.file.path);
  if (!type) {
    fs.unlinkSync(req.file.path); // 위장 파일은 디스크에 남기지 않는다
    const e = new Error("이미지 파일이 아닙니다."); e.status = 400; throw e;
  }
  const finalName = req.file.filename.replace(/^tmp-/, "") + "." + type;
  fs.renameSync(req.file.path, path.join(UPLOAD_DIR, finalName));
  return "/uploads/" + finalName;
}
```

추가로 모든 응답에 `X-Content-Type-Options: nosniff`를 붙여 브라우저의 MIME 추측
실행을 차단했다.

---

### 2-2. JWT를 localStorage에 저장 (토큰 탈취, 높음)

**문제점**

인증 토큰(JWT)을 `localStorage`에 저장했다. localStorage는 자바스크립트로 접근
가능하므로, XSS가 한 번이라도 성공하면 `localStorage.getItem('token')`으로 토큰을
통째로 탈취당할 수 있었다.

**해결방안**

토큰을 **httpOnly + SameSite=Strict 쿠키**로 옮겼다. httpOnly 쿠키는 자바스크립트로
읽는 것 자체가 불가능하여 XSS로도 탈취할 수 없다.

```javascript
// (수정 후) src/middleware.js
const COOKIE_OPTS = {
  httpOnly: true,          // JS 접근 불가 → XSS 탈취 차단
  sameSite: "strict",      // 타 사이트발 요청에 쿠키 미전송 → CSRF 완화
  secure: process.env.COOKIE_SECURE === "1", // HTTPS 배포 시 1
  maxAge: 7 * 24 * 3600 * 1000,
};
const setAuthCookie = (res, token) => res.cookie("token", token, COOKIE_OPTS);
```

---

## 3. AI가 자주 간과하는 유형의 교차검증

외부 진단에서 드러난 것과 같은 유형(접근 통제, 신뢰 경계)의 취약점을 능동적으로
교차검증했다. 실제 공격 요청을 서버에 보내 검증하였다.

| 점검 항목 | 결과 |
|---|---|
| IDOR (채팅·주문·프로필) — 매 요청 소유자 검사 | 안전 |
| 차단·휴면의 즉시 반영 — 미들웨어가 매 요청 DB 재조회 | 안전 |
| 구매 가격 신뢰 주체 — 서버가 DB에서 조회 | 안전 (클라이언트 값 미사용) |
| 이중지급 — 조건부 UPDATE로 1회만 처리 | 안전 |
| Mass Assignment — 요청 바디 통째 반영 코드 전수조사 | 안전 (해당 없음) |
| 금액 지수표기 검증 / 페이징 크래시 / 업로드 500 | 조치 완료 (아래) |

### 3-1. 금액 검증 강화

**문제점**

송금 금액 검증이 `parseInt`에만 의존하여, 지수표기(`1e300`)·문자열·과대값이 예상과
다르게 처리될 수 있었다. 예컨대 `parseInt(1e300, 10)`은 `1`로 뭉개진다.

```javascript
// (수정 전) src/routes/wallet.js
const amount = parseInt(req.body.amount, 10);
if (!Number.isInteger(amount) || amount <= 0) return res.status(400)...;
```

**해결방안**

숫자 1~9자리 정수만 허용하고 1억원 상한을 두는 전용 검증 함수로 교체했다.

```javascript
// (수정 후) src/routes/wallet.js
const MAX_AMOUNT = 100_000_000;
function safeAmount(raw) {
  if (typeof raw === "number" && !Number.isInteger(raw)) return null; // 0.1 등 소수 거부
  const s = String(raw).trim();
  if (!/^[0-9]{1,9}$/.test(s)) return null;    // 지수·기호·공백 차단
  const n = parseInt(s, 10);
  if (n <= 0 || n > MAX_AMOUNT) return null;
  return n;
}
```

### 3-2. 페이징 파라미터로 서버 크래시 / 업로드 용량 초과 크래시

**문제점**

`page`에 초거대 숫자를 넣으면 OFFSET 오버플로우로 500이 발생했고, 5MB 초과 업로드 시
multer 에러가 처리되지 않아 500이 발생했다.

**해결방안**

page 값은 clamp로 제한(1-2절 참고)하고, 공통 에러 핸들러에서 multer 에러를 깔끔한
413/400으로 변환했다.

```javascript
// (수정 후) src/server.js — 공통 에러 핸들러
if (err && err.code === "LIMIT_FILE_SIZE")
  return res.status(413).json({ error: "이미지는 5MB 이하만 업로드할 수 있습니다." });
if (err && err.type === "entity.parse.failed")
  return res.status(400).json({ error: "요청 형식이 올바르지 않습니다." });
```

---

## 4. 유형별 심층 점검 — 외부 라이브러리 CVE

한 분야당 하나의 프롬프트로 나누어 심층 점검했다. `npm audit`과 NVD/GitHub Advisory
교차 검증 결과, 조치가 필요한 치명적 CVE는 없었다. 특히 파일 업로드 라이브러리
multer는 CVE가 잦은데, 사용 중인 `2.2.0`이 최신 CVE(CVE-2026-5038 등)의 패치 버전에
정확히 해당하여 안전했다.

| 라이브러리 | 버전 | 판정 |
|---|---|---|
| multer | 2.2.0 | 안전 (2025~2026 CVE 패치 반영) |
| jsonwebtoken | 9.0.3 | 안전 (CVE-2022-23529는 9.0.0에서 패치) |
| express | 5.2.1 | 안전 (알려진 CVE는 4.x 대상) |
| pg | 8.22.0 | 안전 |
| bcryptjs / dotenv | 3.0.3 / 17.4.2 | 안전 |

> 라이브러리와 별개로 Node.js 런타임 자체의 최신 보안 패치 적용은 배포 시 확인이 필요하다.

---

## 5. 결제(토스페이먼츠) 연동 관련 취약점

결제 승인은 브라우저의 주장을 믿지 않고, 서버가 시크릿 키로 토스에 직접 재확인하여
확정하는 구조로 설계했다. 결제 금액은 클라이언트가 보낸 값이 아니라 충전 요청 시 DB에
기록한 금액을 사용하므로, 요청 바디의 금액을 조작해도 부풀리기가 불가능하다.

### 5-1. 모의 결제 무한 충전 차단

**문제점**

모의 결제 승인 엔드포인트(`mock-confirm`)가 항상 등록되어 있어, 운영 모드에서 노출되면
`/charges` → `/charges/mock-confirm` 반복으로 공짜 무한 충전이 가능했다. 결제 안전이
런타임 환경변수 하나에 의존하는 구조였다.

**해결방안**

mock 라우트를 **mock 모드에서만 등록**하여, 운영(toss) 모드에서는 라우트 자체가
존재하지 않게(404) 했다.

```javascript
// (수정 후) src/routes/payments.js
if (MODE === "mock") {   // 라우트 조건부 등록 → toss 모드에선 404
  router.post("/charges/mock-confirm", auth, h(async (req, res) => {
    const c = await completeCharge(String(req.body.order_no || ""), "mock");
    if (c.user_id !== req.user.id) return res.status(403).json({ error: "본인 충전 건이 아닙니다." });
    res.json({ ok: true, amount: c.amount });
  }));
}
```

### 5-2. CSRF 방어 및 관련 버그

**문제점**

httpOnly 쿠키 인증은 요청 시 브라우저가 쿠키를 자동 전송하므로, 타 사이트가 사용자를
속여 송금·구매확정 같은 상태변경 요청을 보내게 하는 CSRF에 노출될 수 있었다.

**해결방안**

double-submit 쿠키 패턴을 도입했다. JS가 읽을 수 있는 `csrf` 쿠키를 발급하고, 상태변경
요청에 그 값을 `X-CSRF-Token` 헤더로도 보내게 하여 서버가 일치를 검증한다. 타 사이트
스크립트는 쿠키값을 읽을 수 없어 헤더를 채울 수 없다.

```javascript
// src/middleware.js
const cookieTok = readCookie(req, "csrf");
const headerTok = req.headers["x-csrf-token"];
if (!cookieTok || !headerTok || cookieTok !== headerTok)
  return res.status(403).json({ error: "보안 토큰이 유효하지 않습니다. 페이지를 새로고침해 주세요." });
```

도입 과정에서 발생한 버그 2건을 함께 조치했다.

**버그 (a): 로그인·회원가입 자체가 막힘.** CSRF 검증을 `/api` 전체에 걸었는데, 로그인/
회원가입은 CSRF 토큰을 발급해주는 곳이라 아직 토큰이 없어 요청이 막혔다.

```javascript
// (수정) src/middleware.js — 인증 시작 엔드포인트는 검증에서 제외
const CSRF_EXEMPT = ["/auth/login", "/auth/signup"];
if (CSRF_EXEMPT.includes(req.path)) return next();
```

**버그 (b): 낡은 세션에서 "알 수 없는 에러".** CSRF 이전 버전에서 로그인된 세션은
`csrf` 쿠키가 없어 상태변경 요청 시 403이 났고, 새로고침으로도 해결되지 않았다.

```javascript
// (수정) src/routes/auth.js — /me 응답 시 csrf 쿠키가 없으면 재발급 (자가 치유)
router.get("/me", auth, (req, res) => {
  const existing = (req.headers.cookie || "").includes("csrf=");
  const csrf = existing ? undefined : issueCsrf(res);
  res.json({ user: publicUser(req.user), ...(csrf ? { csrf } : {}) });
});
```

### 5-3. CSP 차단으로 결제창이 뜨지 않는 버그

**문제점**

보안 헤더로 추가한 CSP가 `connect-src`에 `api.tosspayments.com`만 허용하여, 실제
결제창이 통신하는 `log.`·`event.`·`apigw-sandbox.tosspayments.com` 등 하위 도메인을
차단했다. 그 결과 결제창이 뜨지 않았다.

```
Content-Security-Policy: The page's settings blocked the loading of a resource
(connect-src) at https://apigw-sandbox.tosspayments.com/... because it violates
the following directive: "connect-src 'self' https://api.tosspayments.com"
```

**해결방안**

토스의 모든 하위 도메인(`*.tosspayments.com`)을 script·connect·frame에 허용하되,
`script-src`는 여전히 "자체 + 토스"로만 제한하여 외부 스크립트 주입(XSS) 방어를
유지했다.

```javascript
// (수정 후) src/server.js
"script-src 'self' https://*.tosspayments.com; " +
"connect-src 'self' https://*.tosspayments.com; " +  // log/event/apigw 등 허용
"frame-src https://*.tosspayments.com; " +           // 결제창 iframe
"object-src 'none'"
```

---

## 6. 시큐어코딩 관점의 전역 방어 보강

개별 취약점 조치에 더해, 애플리케이션 계층의 전역 방어를 보강했다.

### 6-1. 전역 API 레이트 리밋

**문제점**

레이트 리밋이 로그인·전체채팅에만 있었다. 나머지 API(검색 등)는 초당 수천 번 호출해도
막는 게 없어, `LIKE '%검색어%'` 쿼리를 대량으로 날리면 DB 부하로 서비스가 마비될 수
있었다.

**해결방안**

모든 `/api`에 IP당 분당 300건 상한을 두었다.

```javascript
// src/server.js
const RATE_MAX = parseInt(process.env.API_RATE_LIMIT_PER_MIN || "300", 10);
app.use("/api", (req, res, next) => {
  const now = Date.now();
  let r = rateHits.get(req.ip);
  if (!r || now >= r.resetAt) { r = { count: 0, resetAt: now + 60000 }; rateHits.set(req.ip, r); }
  r.count++;
  if (r.count > RATE_MAX)
    return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
  next();
});
```

### 6-2. 보안 HTTP 헤더

**문제점**

`nosniff` 외의 표준 보안 헤더(클릭재킹 방어, CSP, HSTS 등)가 없었고, `x-powered-by`로
기술 스택이 노출되었다.

**해결방안**

표준 보안 헤더 세트를 모든 응답에 부착하고 `x-powered-by`를 제거했다.

```javascript
// src/server.js
app.disable("x-powered-by");
res.setHeader("X-Content-Type-Options", "nosniff"); // MIME 스니핑 차단
res.setHeader("X-Frame-Options", "DENY");            // 클릭재킹 차단
res.setHeader("Referrer-Policy", "no-referrer");
res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
res.setHeader("Content-Security-Policy", "default-src 'self'; ..."); // 리소스 출처 제한
if (process.env.COOKIE_SECURE === "1")               // HTTPS 배포 시 HSTS
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
```

### 6-3. 에러 정보 노출 차단 및 대용량 요청 제한

**문제점**

500 오류 시 내부 오류 상세(스택·SQL·경로)가 노출될 여지가 있었고, JSON 바디 크기
제한이 없어 대용량 페이로드로 메모리를 남용할 수 있었다.

**해결방안**

500 오류는 일반 문구만 반환하고(상세는 서버 로그에만), 요청 본문을 1MB로 제한했다.

```javascript
// src/server.js
app.use(express.json({ limit: "1mb" }));   // 대용량 페이로드 차단
...
const status = err && err.status && err.status < 500 ? err.status : 500;
if (status >= 500) console.error(err);      // 상세는 서버 로그에만
res.status(status).json({ error: status < 500 ? err.message : "서버 오류가 발생했습니다." });
```

### 6-4. JWT 알고리즘 고정 및 운영 시크릿 강제

**문제점**

JWT 검증 시 허용 알고리즘을 지정하지 않아 `alg:none`·알고리즘 혼동 공격의 여지가
있었고, `JWT_SECRET` 미설정 시 기본값으로 동작하여 토큰 위조 위험이 있었다.

**해결방안**

서명·검증을 HS256으로 고정하고, 운영 환경에서 기본 시크릿이면 서버 기동을 거부한다.

```javascript
// src/middleware.js
const sign = (user) => jwt.sign({ id: user.id }, SECRET, { expiresIn: "7d", algorithm: "HS256" });
jwt.verify(token, SECRET, { algorithms: ["HS256"] });

// src/server.js
if (process.env.NODE_ENV === "production" &&
    (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-me-in-production")) {
  console.error("[보안] 운영 환경에서 JWT_SECRET이 설정되지 않았습니다.");
  process.exit(1);
}
```

---

## 7. 확장 시 한계

메모리 기반 방어(브루트포스 카운터, 도배 제한, 전역 레이트 리밋)는 단일 서버에서는
충분하나, ① 서버 재시작 시 카운터가 초기화되고, ② 서버를 여러 대로 늘리면(다중화)
카운터가 서버마다 분산되어, 공격자가 요청을 나눠 보내면 우회될 수 있다.

실서비스 다중화 단계에서는 카운터를 **Redis** 같은 공유 저장소로 옮겨, 모든 서버가
동일한 카운터를 참조하도록 해야 정확히 동작한다. 애플리케이션 로직은 그대로 두고 저장
위치만 메모리에서 Redis로 교체하면 된다. 본 프로젝트(단일 서버)에서는 이 한계와 대안을
명시하는 것으로 갈음한다.

---

## 검증

위 모든 조치는 자동 테스트 스위트(`tests/e2e.sh`, 총 49개 케이스)로 검증되었으며,
회귀 방지를 위해 각 조치에 대응하는 테스트 케이스가 포함되어 있다.

```
결과: 통과 49 / 실패 0
```
