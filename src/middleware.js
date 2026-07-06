// src/middleware.js — JWT 인증/권한 + 비동기 핸들러 래퍼
const jwt = require("jsonwebtoken");
const { q } = require("./db");

const SECRET = process.env.JWT_SECRET || "change-me-in-production";

const sign = (user) => jwt.sign({ id: user.id }, SECRET, { expiresIn: "7d" });

// async 라우트의 예외를 Express 에러 핸들러로 전달
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 로그인 필수
const auth = h(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });
  let id;
  try { ({ id } = jwt.verify(token, SECRET)); }
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

module.exports = { sign, auth, adminOnly, h };
