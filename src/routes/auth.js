// src/routes/auth.js — 요구사항 1: 회원가입 / 로그인
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { q } = require("../db");
const { sign, auth, h, setAuthCookie, clearAuthCookie, issueCsrf } = require("../middleware");

const publicUser = (u) => ({ id: u.id, name: u.name, balance: u.balance, bio: u.bio || "", is_admin: !!u.is_admin });

/* ── 로그인 브루트 포스 방어 (IP 기준) ──
   "계정 잠금"이 아니라 "요청 IP의 로그인 시도를 일시 제한"하는 방식.
   · 계정을 잠그지 않으므로, 공격자가 남의 계정을 틀려서 그 사람을 못 들어오게 만드는
     '계정 잠금 DoS'가 원천적으로 불가능하다.
   · 무차별 대입은 공격자의 IP에서 쏟아지므로, 그 IP를 늦추면 공격 속도가 꺾인다.
   · 성공/실패와 무관하게, 한 IP에서 WINDOW 시간 동안 MAX_FAILS회 "실패"하면
     그 IP의 로그인만 COOLDOWN 동안 429로 제한한다. (성공은 카운터를 초기화)
   (메모리 기반 — 서버 재시작 시 리셋. 다중 서버 확장 시 Redis 등 공유 저장소 필요.
    실제 봇넷(수천 IP 분산 공격) 대비까지 하려면 계정별 지연·CAPTCHA를 추가로 둔다.) */
const MAX_FAILS = parseInt(process.env.LOGIN_ATTEMPT_LIMIT || "10", 10); // IP당 허용 실패 수
const WINDOW_MS = 10 * 60 * 1000;   // 실패를 세는 시간 창(10분)
const COOLDOWN_MS = 10 * 60 * 1000; // 초과 시 그 IP 제한 시간(10분)
const ipFails = new Map(); // ip → { fails:[timestamps], until }

function ipCooldownMinutes(ip) {
  const a = ipFails.get(ip);
  if (!a || !a.until) return 0;
  if (Date.now() >= a.until) { ipFails.delete(ip); return 0; }
  return Math.ceil((a.until - Date.now()) / 60000);
}
function recordIpFail(ip) {
  const now = Date.now();
  const a = ipFails.get(ip) || { fails: [] };
  a.fails = a.fails.filter((t) => now - t < WINDOW_MS); // 창 밖 기록은 버림
  a.fails.push(now);
  if (a.fails.length >= MAX_FAILS) a.until = now + COOLDOWN_MS; // 임계 초과 → 그 IP 쿨다운
  ipFails.set(ip, a);
}
function clearIpFails(ip) { ipFails.delete(ip); } // 로그인 성공 시 해당 IP 카운터 초기화
// 오래된 기록 정리 (메모리 누수 방지)
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of ipFails) {
    const recent = a.fails.some((t) => now - t < WINDOW_MS);
    if (!recent && (!a.until || now >= a.until)) ipFails.delete(ip);
  }
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
  const token = sign(user);
  setAuthCookie(res, token); // 브라우저는 httpOnly 쿠키로 세션 유지
  const csrf = issueCsrf(res);
  res.status(201).json({ token, csrf, user: publicUser(user) });
}));

router.post("/login", h(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const password = String(req.body.password || "");
  const ip = req.ip;

  // 이 IP가 쿨다운 중이면, 어느 계정이든 로그인 시도 자체를 제한한다.
  const wait = ipCooldownMinutes(ip);
  if (wait > 0)
    return res.status(429).json({ error: `이 위치에서 로그인 시도가 너무 많습니다. 약 ${wait}분 후 다시 시도해 주세요.` });

  const user = await q.get("SELECT * FROM users WHERE name = ?", name);
  if (!user || !bcrypt.compareSync(password, user.pw_hash)) {
    recordIpFail(ip); // 실패는 "요청한 IP"에 누적 (피해자 계정이 아니라)
    return res.status(401).json({ error: "닉네임 또는 비밀번호가 맞지 않습니다." });
  }
  clearIpFails(ip); // 성공 → 해당 IP 카운터 초기화
  if (user.blocked) return res.status(403).json({ error: "차단된 계정입니다. 관리자에게 문의하세요." });
  if (user.dormant) return res.status(403).json({ error: "신고 누적으로 휴면계정 전환되었습니다. 관리자에게 문의하세요." });
  const token = sign(user);
  setAuthCookie(res, token);
  const csrf = issueCsrf(res);
  res.json({ token, csrf, user: publicUser(user) });
}));

// 로그아웃: httpOnly 쿠키 제거
router.post("/logout", h(async (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
}));

router.get("/me", auth, (req, res) => {
  // 낡은 세션(csrf 쿠키 없음)이 /me로 복귀하면 CSRF 토큰을 재발급해 자가 치유
  const existing = (req.headers.cookie || "").includes("csrf=");
  const csrf = existing ? undefined : issueCsrf(res);
  res.json({ user: publicUser(req.user), ...(csrf ? { csrf } : {}) });
});

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
