// src/routes/market.js — 요구사항 2,3,4,6: 상품 등록/조회/검색, 채팅, 신고
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { q } = require("../db");
const { auth, h } = require("../middleware");

const CATEGORIES = ["디지털", "가구", "생활", "패션", "기타"];

/* ── 이미지 업로드 (5MB) — 보안 진단서 §1 대응 ──
   · 저장 시 클라이언트 파일명/확장자를 신뢰하지 않음 (확장자 없이 임시 저장)
   · 업로드 후 파일 "내용"의 시그니처(매직 바이트)를 검사해 진짜 이미지인지 확인
   · 확장자는 검증된 포맷에 따라 서버가 부여 → .html 등 위장 파일 저장 원천 차단 */
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9)), // 확장자 없음
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// 파일 첫 바이트로 실제 포맷 판별 (jpg/png/gif/webp만 허용)
function detectImageExt(filePath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
const dropFile = (f) => { if (f) { try { fs.unlinkSync(f.path); } catch { /* 이미 없음 */ } } };

/* ═══ 상품 ═══ */

// 목록 + 검색 (?q=&category=) — 차단된 상품/유저의 상품은 제외
router.get("/products", auth, h(async (req, res) => {
  const kw = String(req.query.q || "").trim();
  const category = String(req.query.category || "").trim();
  let sql = `
    SELECT p.*, u.name AS seller_name
    FROM products p JOIN users u ON u.id = p.seller_id
    WHERE p.status IN ('active','sold') AND u.blocked = 0 AND u.dormant = 0`;
  const params = [];
  if (category && category !== "전체") { sql += " AND p.category = ?"; params.push(category); }
  if (kw) { sql += " AND (p.title LIKE ? OR p.description LIKE ?)"; params.push(`%${kw}%`, `%${kw}%`); }
  sql += " ORDER BY p.id DESC LIMIT 100";
  res.json({ products: await q.all(sql, ...params), categories: CATEGORIES });
}));

// 상세
router.get("/products/:id", auth, h(async (req, res) => {
  const p = await q.get(
    `SELECT p.*, u.name AS seller_name, (u.blocked + u.dormant) AS seller_blocked
     FROM products p JOIN users u ON u.id = p.seller_id WHERE p.id = ?`, req.params.id);
  if (!p || p.status === "deleted" || (!req.user.is_admin && (p.status === "blocked" || p.seller_blocked)))
    return res.status(404).json({ error: "상품을 찾을 수 없습니다." });
  res.json({ product: p });
}));

// 등록 (multipart, image 선택) — 매직 바이트 검증 + 1일 등록 한도 (진단서 §1, §4)
router.post("/products", auth, upload.single("image"), h(async (req, res) => {
  const title = String(req.body.title || "").trim();
  const price = parseInt(req.body.price, 10);
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : "기타";
  const description = String(req.body.description || "").trim();
  if (!title || title.length > 60) { dropFile(req.file); return res.status(400).json({ error: "상품명을 1~60자로 입력해 주세요." }); }
  if (!Number.isInteger(price) || price <= 0 || price > 100_000_000) {
    dropFile(req.file); return res.status(400).json({ error: "가격은 1원 이상 1억원 이하로 입력해 주세요." });
  }

  // 1일 게시글 한도: 삭제분 포함 오늘 등록 수 집계 (지웠다 다시 올리는 우회 방지)
  const DAILY = parseInt(process.env.DAILY_POST_LIMIT || "30", 10);
  const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
  const { n } = await q.get("SELECT COUNT(*) AS n FROM products WHERE seller_id = ? AND created_at LIKE ?", req.user.id, today + "%");
  if (Number(n) >= DAILY) {
    dropFile(req.file);
    return res.status(429).json({ error: `하루 등록 한도(${DAILY}개)를 모두 사용했습니다. 내일 다시 등록해 주세요.` });
  }

  // 이미지 검증: 헤더가 아닌 파일 내용으로 판별하고, 확장자는 서버가 부여
  let image = null;
  if (req.file) {
    const ext = detectImageExt(req.file.path);
    if (!ext) { dropFile(req.file); return res.status(400).json({ error: "jpg, png, gif, webp 이미지 파일만 업로드할 수 있습니다." }); }
    const finalName = req.file.filename + "." + ext;
    fs.renameSync(req.file.path, path.join(UPLOAD_DIR, finalName));
    image = "/uploads/" + finalName;
  }

  const id = await q.insert(
    "INSERT INTO products (seller_id, title, price, category, description, image) VALUES (?,?,?,?,?,?)",
    req.user.id, title, price, category, description, image);
  res.status(201).json({ id });
}));

// 내 상품 삭제
router.delete("/products/:id", auth, h(async (req, res) => {
  const p = await q.get("SELECT * FROM products WHERE id = ?", req.params.id);
  if (!p) return res.status(404).json({ error: "상품을 찾을 수 없습니다." });
  if (p.seller_id !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: "본인 상품만 삭제할 수 있습니다." });
  if (p.status === "sold") return res.status(400).json({ error: "판매 완료된 상품은 삭제할 수 없습니다." });
  await q.run("UPDATE products SET status = 'deleted' WHERE id = ?", p.id);
  res.json({ ok: true });
}));

/* ═══ 채팅 ═══ */

// 대화 시작(기존 방 있으면 반환)
router.post("/chats", auth, h(async (req, res) => {
  const productId = parseInt(req.body.product_id, 10);
  const p = await q.get("SELECT * FROM products WHERE id = ? AND status != 'deleted'", productId);
  if (!p) return res.status(404).json({ error: "상품을 찾을 수 없습니다." });
  if (p.seller_id === req.user.id) return res.status(400).json({ error: "본인 상품에는 채팅을 시작할 수 없습니다." });
  let chat = await q.get("SELECT * FROM chats WHERE product_id = ? AND buyer_id = ?", productId, req.user.id);
  if (!chat) chat = { id: await q.insert("INSERT INTO chats (product_id, buyer_id) VALUES (?, ?)", productId, req.user.id) };
  res.json({ chat_id: chat.id });
}));

// 내 채팅 목록
router.get("/chats", auth, h(async (req, res) => {
  const chats = await q.all(`
    SELECT c.id, c.product_id, p.title AS product_title, p.price, p.image,
           b.id AS buyer_id, b.name AS buyer_name, s.id AS seller_id, s.name AS seller_name,
           (SELECT text FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_text,
           (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_at
    FROM chats c
    JOIN products p ON p.id = c.product_id
    JOIN users b ON b.id = c.buyer_id
    JOIN users s ON s.id = p.seller_id
    WHERE c.buyer_id = ? OR p.seller_id = ?
    ORDER BY COALESCE(last_at, c.created_at) DESC LIMIT 100`, req.user.id, req.user.id);
  res.json({ chats });
}));

// 메시지 조회 (?after=마지막ID → 증분 폴링)
router.get("/chats/:id/messages", auth, h(async (req, res) => {
  const chat = await q.get(`
    SELECT c.*, p.seller_id, p.title AS product_title, p.price,
           b.name AS buyer_name, s.name AS seller_name
    FROM chats c JOIN products p ON p.id = c.product_id
    JOIN users b ON b.id = c.buyer_id JOIN users s ON s.id = p.seller_id
    WHERE c.id = ?`, req.params.id);
  if (!chat) return res.status(404).json({ error: "대화방을 찾을 수 없습니다." });
  if (chat.buyer_id !== req.user.id && chat.seller_id !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: "참여 중인 대화방이 아닙니다." });
  const after = parseInt(req.query.after || "0", 10);
  const messages = await q.all(
    "SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE chat_id = ? AND m.id > ? ORDER BY m.id LIMIT 500",
    chat.id, after);
  res.json({ chat, messages });
}));

// 메시지 전송
router.post("/chats/:id/messages", auth, h(async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text || text.length > 1000) return res.status(400).json({ error: "메시지는 1~1000자로 입력해 주세요." });
  const chat = await q.get(
    "SELECT c.*, p.seller_id FROM chats c JOIN products p ON p.id = c.product_id WHERE c.id = ?", req.params.id);
  if (!chat) return res.status(404).json({ error: "대화방을 찾을 수 없습니다." });
  if (chat.buyer_id !== req.user.id && chat.seller_id !== req.user.id)
    return res.status(403).json({ error: "참여 중인 대화방이 아닙니다." });
  const id = await q.insert("INSERT INTO messages (chat_id, sender_id, text) VALUES (?,?,?)", chat.id, req.user.id, text);
  res.status(201).json({ id });
}));

/* ═══ 사용자 조회: 다른 유저의 프로필 + 판매 상품 ═══ */
router.get("/users/:id", auth, h(async (req, res) => {
  const u = await q.get(
    "SELECT id, name, bio, blocked, dormant, created_at FROM users WHERE id = ? AND is_admin = 0", req.params.id);
  if (!u || ((u.blocked || u.dormant) && !req.user.is_admin))
    return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
  const products = await q.all(
    "SELECT id, title, price, image, status, created_at FROM products WHERE seller_id = ? AND status IN ('active','sold') ORDER BY id DESC LIMIT 100",
    u.id);
  res.json({ user: { id: u.id, name: u.name, bio: u.bio || "", created_at: u.created_at }, products });
}));

/* ═══ 전체 채팅: 모든 유저가 참여하는 공용 채팅방 ═══ */
// 도배 방지: 유저당 최소 전송 간격 (기본 1.5초) + 10초당 최대 8건
const gchatHits = new Map(); // userId → [timestamps]
setInterval(() => {
  const cut = Date.now() - 10000;
  for (const [k, arr] of gchatHits) {
    const kept = arr.filter((t) => t > cut);
    if (kept.length) gchatHits.set(k, kept); else gchatHits.delete(k);
  }
}, 60000).unref();
function gchatAllowed(userId) {
  const now = Date.now();
  const arr = (gchatHits.get(userId) || []).filter((t) => now - t < 10000);
  if (arr.length >= 8) return false;               // 10초당 8건 초과 차단
  if (arr.length && now - arr[arr.length - 1] < 1500) return false; // 최소 1.5초 간격
  arr.push(now);
  gchatHits.set(userId, arr);
  return true;
}

router.get("/global-chat", auth, h(async (req, res) => {
  const after = parseInt(req.query.after || "0", 10);
  const messages = await q.all(
    `SELECT g.*, u.name AS sender_name FROM global_messages g JOIN users u ON u.id = g.sender_id
     WHERE g.id > ? ORDER BY g.id DESC LIMIT 100`, after);
  res.json({ messages: messages.reverse() }); // 최신 100개를 시간순으로
}));

router.post("/global-chat", auth, h(async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text || text.length > 500) return res.status(400).json({ error: "메시지는 1~500자로 입력해 주세요." });
  if (!gchatAllowed(req.user.id))
    return res.status(429).json({ error: "메시지를 너무 빠르게 보내고 있어요. 잠시 후 다시 시도해 주세요." });
  const id = await q.insert("INSERT INTO global_messages (sender_id, text) VALUES (?, ?)", req.user.id, text);
  res.status(201).json({ id });
}));

/* ═══ 신고 (요구사항 4 — 임계 횟수 도달 시 자동 제재, 그 외 관리자 판단) ═══ */
router.post("/reports", auth, h(async (req, res) => {
  const kind = req.body.kind === "user" ? "user" : req.body.kind === "product" ? "product" : null;
  const targetId = parseInt(req.body.target_id, 10);
  const reason = String(req.body.reason || "").trim();
  if (!kind || !targetId || !reason) return res.status(400).json({ error: "신고 대상과 사유를 입력해 주세요." });
  // 자기 자신/본인 상품 신고 차단 (자동 제재 카운트 조작 방지)
  if (kind === "user") {
    if (targetId === req.user.id) return res.status(400).json({ error: "자기 자신은 신고할 수 없습니다." });
  } else {
    const own = await q.get("SELECT seller_id FROM products WHERE id = ?", targetId);
    if (own && own.seller_id === req.user.id) return res.status(400).json({ error: "본인 상품은 신고할 수 없습니다." });
  }
  const exists = kind === "user"
    ? await q.get("SELECT id FROM users WHERE id = ? AND is_admin = 0", targetId) // 관리자는 신고 대상 아님
    : await q.get("SELECT id FROM products WHERE id = ?", targetId);
  if (!exists) return res.status(404).json({ error: "신고 대상을 찾을 수 없습니다." });
  // 같은 신고자의 중복 신고 차단 (DISTINCT 카운트 우회 및 도배 방지)
  const dup = await q.get("SELECT id FROM reports WHERE kind = ? AND target_id = ? AND reporter_id = ?", kind, targetId, req.user.id);
  if (dup) return res.status(409).json({ error: "이미 신고한 대상입니다." });
  await q.run("INSERT INTO reports (kind, target_id, reporter_id, reason) VALUES (?,?,?,?)", kind, targetId, req.user.id, reason);

  // 자동 제재: 서로 다른 신고자 수가 임계값(기본 3명) 이상이면
  //  · 상품 → 자동 차단  · 유저 → 휴면계정 전환   (관리자가 콘솔에서 해제 가능)
  const LIMIT = parseInt(process.env.REPORT_AUTO_LIMIT || "3", 10);
  const { n } = await q.get(
    "SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE kind = ? AND target_id = ?", kind, targetId);
  let auto = false;
  if (Number(n) >= LIMIT) {
    if (kind === "product") {
      const { changes } = await q.run("UPDATE products SET status = 'blocked' WHERE id = ? AND status = 'active'", targetId);
      auto = changes === 1;
    } else {
      const { changes } = await q.run("UPDATE users SET dormant = 1 WHERE id = ? AND is_admin = 0 AND dormant = 0", targetId);
      auto = changes === 1;
    }
  }
  res.status(201).json({ ok: true, auto_sanctioned: auto });
}));

module.exports = router;
