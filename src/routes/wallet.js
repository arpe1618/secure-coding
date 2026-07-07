// src/routes/wallet.js — 요구사항 5: 유저 간 송금 + 안전거래(에스크로)
const router = require("express").Router();
const { q, tx, httpError } = require("../db");
const { auth, h } = require("../middleware");

// 금액 검증: 문자열/지수표기/소수/음수/과대값을 모두 차단하고 안전한 정수만 통과
// (예: "1e300" → parseInt이 1로 뭉개는 문제, 오버플로우 방지)
const MAX_AMOUNT = 100_000_000; // 1억원
function safeAmount(raw) {
  if (typeof raw === "number" && !Number.isInteger(raw)) return null; // 0.1 등
  const s = String(raw).trim();
  if (!/^[0-9]{1,9}$/.test(s)) return null;                            // 숫자 1~9자리만 (지수·기호·공백 차단)
  const n = parseInt(s, 10);
  if (n <= 0 || n > MAX_AMOUNT) return null;
  return n;
}

// 잔액이 충분할 때만 차감 (동시성 안전: 조건부 UPDATE — 두 드라이버 공통)
async function debit(t, userId, amount) {
  const { changes } = await t.run(
    "UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ? AND blocked = 0",
    amount, userId, amount);
  if (changes !== 1) throw httpError(400, "잔액이 부족합니다.");
}
const credit = (t, userId, amount) => t.run("UPDATE users SET balance = balance + ? WHERE id = ?", amount, userId);
const ledger = (t, fromId, toId, amount, memo) =>
  t.run("INSERT INTO transactions (from_id, to_id, amount, memo) VALUES (?,?,?,?)", fromId, toId, amount, memo);

/* ── 직접 송금 ── */
router.post("/transfer", auth, h(async (req, res) => {
  const toName = String(req.body.to_name || "").trim();
  const amount = safeAmount(req.body.amount);
  const memo = String(req.body.memo || "직접 송금").slice(0, 100);
  if (!amount) return res.status(400).json({ error: "금액은 1원 이상 1억원 이하의 정수로 입력해 주세요." });
  const to = await q.get("SELECT id, (blocked + dormant) AS blocked FROM users WHERE name = ?", toName);
  if (!to) return res.status(404).json({ error: "받는 사람을 찾을 수 없습니다." });
  if (to.id === req.user.id) return res.status(400).json({ error: "본인에게는 송금할 수 없습니다." });
  if (to.blocked) return res.status(400).json({ error: "차단된 계정에는 송금할 수 없습니다." });

  await tx(async (t) => {
    await debit(t, req.user.id, amount);
    await credit(t, to.id, amount);
    await ledger(t, req.user.id, to.id, amount, memo);
  });
  res.json({ ok: true });
}));

/* ── 안전거래 구매: 지갑 → 에스크로 보관 ── */
router.post("/orders", auth, h(async (req, res) => {
  const productId = parseInt(req.body.product_id, 10);
  const order = await tx(async (t) => {
    const p = await t.get(
      "SELECT p.*, (u.blocked + u.dormant) AS seller_blocked FROM products p JOIN users u ON u.id = p.seller_id WHERE p.id = ?",
      productId);
    if (!p || p.status !== "active" || p.seller_blocked) throw httpError(400, "구매할 수 없는 상품입니다.");
    if (p.seller_id === req.user.id) throw httpError(400, "본인 상품은 구매할 수 없습니다.");
    await debit(t, req.user.id, p.price);
    const { changes } = await t.run("UPDATE products SET status = 'sold' WHERE id = ? AND status = 'active'", p.id);
    if (changes !== 1) throw httpError(409, "방금 다른 구매자가 결제했습니다."); // 동시 구매 방지
    const id = await t.insert(
      "INSERT INTO orders (product_id, buyer_id, seller_id, amount) VALUES (?,?,?,?)",
      p.id, req.user.id, p.seller_id, p.price);
    await ledger(t, req.user.id, null, p.price, `「${p.title}」 결제 (에스크로 보관)`);
    return { id };
  });
  res.status(201).json({ order });
}));

/* ── 구매 확정: 에스크로 → 판매자 정산 ── */
router.post("/orders/:id/confirm", auth, h(async (req, res) => {
  await tx(async (t) => {
    const o = await t.get("SELECT o.*, p.title FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?", req.params.id);
    if (!o) throw httpError(404, "주문을 찾을 수 없습니다.");
    if (o.buyer_id !== req.user.id) throw httpError(403, "본인 주문만 확정할 수 있습니다.");
    const { changes } = await t.run("UPDATE orders SET status = 'completed' WHERE id = ? AND status = 'paid'", o.id);
    if (changes !== 1) throw httpError(400, "이미 처리된 주문입니다.");
    await credit(t, o.seller_id, o.amount);
    await ledger(t, null, o.seller_id, o.amount, `「${o.title}」 판매 정산 (구매 확정)`);
  });
  res.json({ ok: true });
}));

/* ── 내 주문 목록 ── */
router.get("/orders", auth, h(async (req, res) => {
  const orders = await q.all(`
    SELECT o.*, p.title AS product_title, p.image, b.name AS buyer_name, s.name AS seller_name
    FROM orders o JOIN products p ON p.id = o.product_id
    JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id
    WHERE o.buyer_id = ? OR o.seller_id = ? ORDER BY o.id DESC`, req.user.id, req.user.id);
  res.json({ orders });
}));

/* ── 내 거래 내역 ── */
router.get("/transactions", auth, h(async (req, res) => {
  const transactions = await q.all(`
    SELECT t.*, f.name AS from_name, u.name AS to_name
    FROM transactions t LEFT JOIN users f ON f.id = t.from_id LEFT JOIN users u ON u.id = t.to_id
    WHERE t.from_id = ? OR t.to_id = ? ORDER BY t.id DESC LIMIT 100`, req.user.id, req.user.id);
  res.json({ transactions });
}));

module.exports = router;
