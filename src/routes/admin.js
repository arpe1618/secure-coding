// src/routes/admin.js — 요구사항 4,7: 악성 유저/상품 차단 + 전체 요소 관리
const router = require("express").Router();
const { q, tx, httpError } = require("../db");
const { auth, adminOnly, h } = require("../middleware");

router.use(auth, adminOnly);

// 페이징 (진단서 §3: 무제한 반환으로 인한 메모리 고갈/DoS 방지)
const PAGE_SIZE = 100;
const MAX_PAGE = 100000; // OFFSET 정수 오버플로우로 인한 500 크래시 방지
const pageOf = (req) => {
  let p = parseInt(req.query.page, 10);
  if (!Number.isFinite(p) || p < 1) p = 1;
  if (p > MAX_PAGE) p = MAX_PAGE;
  return (p - 1) * PAGE_SIZE;
};

// 대시보드 요약 (PG는 COUNT/SUM을 문자열로 반환하므로 Number 처리)
router.get("/summary", h(async (_req, res) => {
  const n = async (sql) => Number((await q.get(sql)).n);
  res.json({
    users: await n("SELECT COUNT(*) n FROM users WHERE is_admin = 0"),
    blocked_users: await n("SELECT COUNT(*) n FROM users WHERE blocked = 1"),
    products: await n("SELECT COUNT(*) n FROM products WHERE status != 'deleted'"),
    blocked_products: await n("SELECT COUNT(*) n FROM products WHERE status = 'blocked'"),
    open_reports: await n("SELECT COUNT(*) n FROM reports WHERE resolved = 0"),
    orders: await n("SELECT COUNT(*) n FROM orders"),
    escrow_held: await n("SELECT COALESCE(SUM(amount),0) n FROM orders WHERE status = 'paid'"),
  });
}));

// 유저 관리
router.get("/users", h(async (req, res) => {
  res.json({
    users: await q.all(`
      SELECT u.id, u.name, u.balance, u.bio, u.blocked, u.dormant, u.created_at,
        (SELECT COUNT(*) FROM products WHERE seller_id = u.id AND status != 'deleted') AS product_count,
        (SELECT COUNT(*) FROM reports WHERE kind = 'user' AND target_id = u.id) AS report_count
      FROM users u WHERE is_admin = 0 ORDER BY u.id DESC LIMIT ${PAGE_SIZE} OFFSET ?`, pageOf(req)),
  });
}));

// 유저 차단/해제 (요구사항 4)
router.post("/users/:id/block", h(async (req, res) => {
  const blocked = req.body.blocked ? 1 : 0;
  const { changes } = await q.run("UPDATE users SET blocked = ? WHERE id = ? AND is_admin = 0", blocked, req.params.id);
  if (!changes) return res.status(404).json({ error: "유저를 찾을 수 없습니다." });
  res.json({ ok: true });
}));

// 유저 휴면 전환/해제 (자동 제재된 계정 복구)
router.post("/users/:id/dormant", h(async (req, res) => {
  const dormant = req.body.dormant ? 1 : 0;
  const { changes } = await q.run("UPDATE users SET dormant = ? WHERE id = ? AND is_admin = 0", dormant, req.params.id);
  if (!changes) return res.status(404).json({ error: "유저를 찾을 수 없습니다." });
  res.json({ ok: true });
}));

// 상품 관리
router.get("/products", h(async (req, res) => {
  res.json({
    products: await q.all(`
      SELECT p.*, u.name AS seller_name FROM products p JOIN users u ON u.id = p.seller_id
      WHERE p.status != 'deleted' ORDER BY p.id DESC LIMIT ${PAGE_SIZE} OFFSET ?`, pageOf(req)),
  });
}));

// 상품 차단/복구 (요구사항 4)
router.post("/products/:id/block", h(async (req, res) => {
  const p = await q.get("SELECT * FROM products WHERE id = ?", req.params.id);
  if (!p) return res.status(404).json({ error: "상품을 찾을 수 없습니다." });
  if (p.status === "sold") return res.status(400).json({ error: "판매 완료된 상품입니다." });
  await q.run("UPDATE products SET status = ? WHERE id = ?", req.body.blocked ? "blocked" : "active", p.id);
  res.json({ ok: true });
}));

// 신고 관리
router.get("/reports", h(async (req, res) => {
  res.json({
    reports: await q.all(`
      SELECT r.*, rep.name AS reporter_name,
        CASE r.kind WHEN 'user' THEN (SELECT name FROM users WHERE id = r.target_id)
                    ELSE (SELECT title FROM products WHERE id = r.target_id) END AS target_label
      FROM reports r JOIN users rep ON rep.id = r.reporter_id
      ORDER BY r.resolved, r.id DESC LIMIT ${PAGE_SIZE} OFFSET ?`, pageOf(req)),
  });
}));

// 신고 처리: action = block | dismiss
router.post("/reports/:id/resolve", h(async (req, res) => {
  const r = await q.get("SELECT * FROM reports WHERE id = ?", req.params.id);
  if (!r) return res.status(404).json({ error: "신고를 찾을 수 없습니다." });
  if (req.body.action === "block") {
    if (r.kind === "user") await q.run("UPDATE users SET blocked = 1 WHERE id = ? AND is_admin = 0", r.target_id);
    else await q.run("UPDATE products SET status = 'blocked' WHERE id = ? AND status = 'active'", r.target_id);
  }
  await q.run("UPDATE reports SET resolved = 1 WHERE id = ?", r.id);
  res.json({ ok: true });
}));

// 주문 관리
router.get("/orders", h(async (req, res) => {
  res.json({
    orders: await q.all(`
      SELECT o.*, p.title AS product_title, b.name AS buyer_name, s.name AS seller_name
      FROM orders o JOIN products p ON p.id = o.product_id
      JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id
      ORDER BY o.id DESC LIMIT ${PAGE_SIZE} OFFSET ?`, pageOf(req)),
  });
}));

// 에스크로 주문 환불 (구매자에게 반환, 상품 재판매)
router.post("/orders/:id/refund", h(async (req, res) => {
  await tx(async (t) => {
    const o = await t.get("SELECT o.*, p.title FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?", req.params.id);
    if (!o) throw httpError(404, "주문을 찾을 수 없습니다.");
    const { changes } = await t.run("UPDATE orders SET status = 'refunded' WHERE id = ? AND status = 'paid'", o.id);
    if (changes !== 1) throw httpError(400, "에스크로 보관 중인 주문만 환불할 수 있습니다.");
    await t.run("UPDATE users SET balance = balance + ? WHERE id = ?", o.amount, o.buyer_id);
    await t.run("UPDATE products SET status = 'active' WHERE id = ? AND status = 'sold'", o.product_id);
    await t.run("INSERT INTO transactions (from_id, to_id, amount, memo) VALUES (NULL, ?, ?, ?)",
      o.buyer_id, o.amount, `「${o.title}」 관리자 환불`);
  });
  res.json({ ok: true });
}));

// 전체 거래 원장
router.get("/transactions", h(async (req, res) => {
  res.json({
    transactions: await q.all(`
      SELECT t.*, f.name AS from_name, u.name AS to_name
      FROM transactions t LEFT JOIN users f ON f.id = t.from_id LEFT JOIN users u ON u.id = t.to_id
      ORDER BY t.id DESC LIMIT ${PAGE_SIZE} OFFSET ?`, pageOf(req)),
  });
}));

module.exports = router;
