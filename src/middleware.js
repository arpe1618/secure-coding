// src/middleware.js — JWT 인증/권한 + 비동기 핸들러 래퍼
const jwt = require("jsonwebtoken");
const { q } = require("./db");

const SECRET = process.env.JWT_SECRET || "change-me-in-production";

const sign = (user) => jwt.sign({ id: user.id }, SECRET, { expiresIn: "7d", algorithm: "HS256" });

// httpOnly 쿠키 설정 — 자바스크립트로 토큰 접근 불가(XSS로 탈취 차단),
// SameSite=Strict로 타 사이트발 요청에 쿠키 미전송(CSRF 완화)  [보안 진단서 §2]
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.COOKIE_SECURE === "1", // HTTPS 배포 시 .env에서 1로
  maxAge: 7 * 24 * 3600 * 1000,
};
const setAuthCookie = (res, token) => res.cookie("token", token, COOKIE_OPTS);
const clearAuthCookie = (res) => res.clearCookie("token", { httpOnly: true, sameSite: "strict", secure: COOKIE_OPTS.secure });

/* ── CSRF 방어 (double-submit 쿠키 패턴) ──
   httpOnly 쿠키 인증은 요청 시 브라우저가 쿠키를 자동 전송하므로, 타 사이트가
   사용자를 속여 상태변경 요청을 보내게 하는 CSRF에 노출될 수 있다. (SameSite=Strict가
   1차 방어지만 브라우저·서브도메인 조건에 따라 불완전.)
   대책: JS가 읽을 수 있는 csrf 쿠키(httpOnly 아님)를 발급하고, 상태변경 요청에는
   그 값을 헤더(X-CSRF-Token)로도 함께 보내게 한다. 서버는 쿠키값과 헤더값이
   일치할 때만 통과시킨다. 타 사이트 스크립트는 쿠키값을 읽을 수 없어 헤더를 못 채운다. */
const crypto = require("crypto");
const CSRF_COOKIE_OPTS = { httpOnly: false, sameSite: "strict", secure: COOKIE_OPTS.secure, maxAge: COOKIE_OPTS.maxAge };
function issueCsrf(res) {
  const token = crypto.randomBytes(24).toString("hex");
  res.cookie("csrf", token, CSRF_COOKIE_OPTS);
  return token;
}
// 상태변경(POST/PUT/DELETE) 요청에 적용: 쿠키의 csrf와 헤더의 X-CSRF-Token이 일치해야 함
// 인증 시작 엔드포인트(로그인/회원가입)는 세션·CSRF 토큰을 "발급"하는 곳이라 검증 대상에서 제외.
// (아직 토큰이 없는 상태에서 토큰을 요구하면 로그인 자체가 불가능해지는 모순 방지)
const CSRF_EXEMPT = ["/auth/login", "/auth/signup"];
const csrfProtect = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (CSRF_EXEMPT.includes(req.path)) return next();
  // Bearer 토큰 인증(쿠키 미사용, 예: API 클라이언트/테스트)은 CSRF 대상이 아님
  const usingCookie = !!readCookie(req, "token");
  if (!usingCookie) return next();
  const cookieTok = readCookie(req, "csrf");
  const headerTok = req.headers["x-csrf-token"];
  if (!cookieTok || !headerTok || cookieTok !== headerTok)
    return res.status(403).json({ error: "보안 토큰이 유효하지 않습니다. 페이지를 새로고침해 주세요." });
  next();
};

// 쿠키 헤더에서 특정 값 파싱 (외부 패키지 없이)
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}

// async 라우트의 예외를 Express 에러 핸들러로 전달
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 로그인 필수 — 1순위: httpOnly 쿠키(브라우저), 2순위: Bearer 헤더(API 클라이언트/테스트)
const auth = h(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = readCookie(req, "token") || (header.startsWith("Bearer ") ? header.slice(7) : null);
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });
  let id;
  try { ({ id } = jwt.verify(token, SECRET, { algorithms: ["HS256"] })); }
  catch { return res.status(401).json({ error: "세션이 만료되었습니다. 다시 로그인해 주세요." }); }
  const user = await q.get("SELECT id, name, balance, bio, blocked, dormant, is_admin FROM users WHERE id = ?", id);
  if (!user) return res.status(401).json({ error: "존재하지 않는 계정입니다." });
  if (user.blocked) return res.status(403).json({ error: "차단된 계정입니다. 관리자에게 문의하세요.", blocked: true });
  if (user.dormant) return res.status(403).json({ error: "신고 누적으로 휴면계정 전환되었습니다. 관리자에게 문의하세요.", blocked: true });
  req.user = user;
  next();
});

// 관리자 전용
const adminOnly = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: "관리자 권한이 필요합니다." });
  next();
};

module.exports = { sign, auth, adminOnly, h, setAuthCookie, clearAuthCookie, issueCsrf, csrfProtect };
