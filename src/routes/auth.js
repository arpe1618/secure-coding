// src/routes/auth.js — 요구사항 1: 회원가입 / 로그인
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { q } = require("../db");
const { sign, auth, h } = require("../middleware");

const publicUser = (u) => ({ id: u.id, name: u.name, balance: u.balance, bio: u.bio || "", is_admin: !!u.is_admin });

/* ── 로그인 브루트 포스 방어 ──
   같은 IP + 같은 계정 조합으로 LIMIT회 연속 실패하면 LOCK_MS 동안 잠금.
   성공하면 카운터 초기화. (메모리 기반 — 서버 재시작 시 리셋.
   다중 서버로 확장하면 Redis 같은 공유 저장소로 옮겨야 함) */
const LOGIN_LIMIT = parseInt(process.env.LOGIN_ATTEMPT_LIMIT || "5", 10);
const LOCK_MS = 10 * 60 * 1000;
const attempts = new Map(); // "ip|name" → { count, until }

function lockedMinutes(key) {
  const a = attempts.get(key);
  if (!a || !a.until) return 0;
  if (Date.now() >= a.until) { attempts.delete(key); return 0; }
  return Math.ceil((a.until - Date.now()) / 60000);
}
function recordFail(key) {
  const a = attempts.get(key) || { count: 0 };
  a.count++;
  if (a.count >= LOGIN_LIMIT) a.until = Date.now() + LOCK_MS;
  attempts.set(key, a);
}
// 오래된 기록 정리 (메모리 누수 방지)
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until && now >= a.until) attempts.delete(k);
}, 30 * 60 * 1000).unref();

router.post("/signup", h(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const password = String(req.body.password || "");
  if (name.length < 2 || name.length > 20) return res.status(400).json({ error: "닉네임은 2~20자로 입력해 주세요." });
  if (password.length < 4) return res.status(400).json({ error: "비밀번호는 4자 이상이어야 합니다." });
  if (await q.get("SELECT id FROM users WHERE name = ?", name))
    return res.status(409).json({ error: "이미 사용 중인 닉네임입니다." });

  const id = await q.insert("INSERT INTO users (name, pw_hash) VALUES (?, ?)", name, bcrypt.hashSync(password, 10));
  const user = await q.get("SELECT * FROM users WHERE id = ?", id);
  res.status(201).json({ token: sign(user), user: publicUser(user) });
}));

router.post("/login", h(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const password = String(req.body.password || "");
  const key = `${req.ip}|${name}`;

  const wait = lockedMinutes(key);
  if (wait > 0)
    return res.status(429).json({ error: `로그인 시도가 너무 많습니다. 약 ${wait}분 후 다시 시도해 주세요.` });

  const user = await q.get("SELECT * FROM users WHERE name = ?", name);
  if (!user || !bcrypt.compareSync(password, user.pw_hash)) {
    recordFail(key);
    return res.status(401).json({ error: "닉네임 또는 비밀번호가 맞지 않습니다." });
  }
  attempts.delete(key); // 성공 → 카운터 초기화
  if (user.blocked) return res.status(403).json({ error: "차단된 계정입니다. 관리자에게 문의하세요." });
  if (user.dormant) return res.status(403).json({ error: "신고 누적으로 휴면계정 전환되었습니다. 관리자에게 문의하세요." });
  res.json({ token: sign(user), user: publicUser(user) });
}));

router.get("/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

// 마이페이지: 소개글 수정
router.put("/me", auth, h(async (req, res) => {
  const bio = String(req.body.bio ?? "").trim().slice(0, 200);
  await q.run("UPDATE users SET bio = ? WHERE id = ?", bio, req.user.id);
  res.json({ ok: true, bio });
}));

// 마이페이지: 비밀번호 변경 (현재 비밀번호 확인 후)
router.put("/password", auth, h(async (req, res) => {
  const oldPw = String(req.body.old_password || "");
  const newPw = String(req.body.new_password || "");
  if (newPw.length < 4) return res.status(400).json({ error: "새 비밀번호는 4자 이상이어야 합니다." });
  const me = await q.get("SELECT pw_hash FROM users WHERE id = ?", req.user.id);
  if (!bcrypt.compareSync(oldPw, me.pw_hash))
    return res.status(400).json({ error: "현재 비밀번호가 맞지 않습니다." });
  await q.run("UPDATE users SET pw_hash = ? WHERE id = ?", bcrypt.hashSync(newPw, 10), req.user.id);
  res.json({ ok: true });
}));

module.exports = router;
