// src/server.js — 다시장 API 서버
require("dotenv").config();
const path = require("path");
const express = require("express");
const { ready, seedAdmin, DRIVER } = require("./db");

const app = express();
app.set("trust proxy", 1); // Nginx 등 리버스 프록시 뒤에서 실행
app.disable("x-powered-by"); // Express 노출 헤더 제거 (기술 스택 은닉)
app.use(express.json({ limit: "1mb" })); // 거대 JSON 바디로 인한 메모리 남용 차단

// 보안 HTTP 헤더 — 표준 방어 헤더를 모든 응답에 부착
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");          // MIME 스니핑 차단 (Stored XSS 방어, 진단서 §1)
  res.setHeader("X-Frame-Options", "DENY");                     // 클릭재킹 차단 (iframe 삽입 금지)
  res.setHeader("Referrer-Policy", "no-referrer");              // 외부로 URL·경로 정보 유출 최소화
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");   // 크로스 오리진 창 격리
  res.setHeader("Content-Security-Policy",                      // 리소스 출처 제한 (XSS 완화)
    "default-src 'self'; img-src 'self' data: https:; " +
    "script-src 'self' https://*.tosspayments.com; " +          // 스크립트는 자체+토스 하위도메인만 (인라인 JS 금지 유지 → XSS 방어)
    "style-src 'self' 'unsafe-inline'; " +                       // UI가 인라인 style 속성을 사용하므로 허용
    "connect-src 'self' https://*.tosspayments.com; " +          // 토스 결제창이 log/event/apigw 등 여러 하위도메인과 통신
    "frame-src https://*.tosspayments.com; " +                   // 결제창 iframe
    "object-src 'none'");
  if (process.env.COOKIE_SECURE === "1")                         // HTTPS 배포 시 HSTS
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});

// CSRF 방어: 쿠키 인증을 쓰는 상태변경 요청은 X-CSRF-Token 헤더 검증 (double-submit 패턴)
const { csrfProtect } = require("./middleware");

/* ── 전역 API 레이트 리밋 (IP 기준) ──
   로그인·전체채팅뿐 아니라 "모든 API"에 IP당 요청 상한을 둔다. 검색(LIKE 쿼리) 등을
   초당 수천 번 때려 DB·서버를 마비시키는 애플리케이션 계층 DoS를 완화한다.
   기본: IP당 1분에 300건 초과 시 429. (환경변수 API_RATE_LIMIT_PER_MIN로 조정)
   [한계] 메모리 기반이라 서버 재시작 시 리셋되고, 서버를 여러 대로 늘리면 카운터가
   서버마다 따로 논다. 다중화 시에는 Redis 등 공유 저장소로 옮겨야 정확히 동작한다.
   (docs/TESTING.md "확장 시 보안 고려사항" 참고) */
const RATE_MAX = parseInt(process.env.API_RATE_LIMIT_PER_MIN || "300", 10);
const rateHits = new Map(); // ip → { count, resetAt }
setInterval(() => { const now = Date.now(); for (const [ip, r] of rateHits) if (now >= r.resetAt) rateHits.delete(ip); }, 5 * 60 * 1000).unref();
app.use("/api", (req, res, next) => {
  const now = Date.now();
  let r = rateHits.get(req.ip);
  if (!r || now >= r.resetAt) { r = { count: 0, resetAt: now + 60000 }; rateHits.set(req.ip, r); }
  r.count++;
  if (r.count > RATE_MAX)
    return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
  next();
});

app.use("/api", csrfProtect);

// 정적 파일: 프론트엔드 + 업로드 이미지
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

// API 라우트
app.use("/api/auth", require("./routes/auth"));
app.use("/api", require("./routes/market"));
app.use("/api/wallet", require("./routes/wallet"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/admin", require("./routes/admin"));

// 헬스체크 (로드밸런서/도커용)
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// 토스 결제 리다이렉트도 SPA로
app.get("/payment/success", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.get("/payment/fail", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

// 공통 에러 핸들러 — 내부 오류 상세(스택·SQL·경로)를 클라이언트에 절대 노출하지 않음
app.use((err, _req, res, _next) => {
  // 업로드 용량 초과 등 multer 에러를 깔끔한 4xx로 변환 (진단서 §1 관련, 500 크래시 방지)
  if (err && err.code === "LIMIT_FILE_SIZE")
    return res.status(413).json({ error: "이미지는 5MB 이하만 업로드할 수 있습니다." });
  if (err && typeof err.code === "string" && err.code.startsWith("LIMIT_"))
    return res.status(400).json({ error: "파일 업로드 형식이 올바르지 않습니다." });
  // JSON 파싱 실패·본문 초과 등 잘못된 요청
  if (err && err.type === "entity.parse.failed")
    return res.status(400).json({ error: "요청 형식이 올바르지 않습니다." });
  if (err && err.type === "entity.too.large")
    return res.status(413).json({ error: "요청 본문이 너무 큽니다." });
  // 의도된 도메인 에러(status 4xx)만 그 메시지를 노출. 그 외(500)는 서버 로그에만 남기고
  // 클라이언트에는 일반 문구만 반환 → 스택 트레이스·SQL·파일 경로 유출 차단.
  const status = err && err.status && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status < 500 ? err.message : "서버 오류가 발생했습니다." });
});

const PORT = process.env.PORT || 3000;
(async () => {
  // 운영(NODE_ENV=production)에서 기본 JWT_SECRET로 기동 방지 — 토큰 위조 위험 차단
  if (process.env.NODE_ENV === "production" &&
      (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-me-in-production")) {
    console.error("[보안] 운영 환경에서 JWT_SECRET이 설정되지 않았습니다. .env에 강력한 비밀키를 설정하세요.");
    process.exit(1);
  }
  await ready; // 스키마 준비 대기 (PG)
  await seedAdmin(process.env.ADMIN_NAME || "admin", process.env.ADMIN_PASSWORD || "admin1234");
  app.listen(PORT, () => {
    console.log(`다시장 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`DB: ${DRIVER} · 결제 모드: ${process.env.PAYMENT_MODE === "toss" ? "토스페이먼츠 실연동" : "모의 결제(mock)"}`);
  });
})().catch((e) => { console.error("서버 시작 실패:", e); process.exit(1); });
