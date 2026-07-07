// src/routes/payments.js — 외부 결제(PG)로 지갑 충전
// PAYMENT_MODE=toss : 토스페이먼츠 실연동 / PAYMENT_MODE=mock : 즉시 승인 (개발용, 기본)
const router = require("express").Router();
const crypto = require("crypto");
const { q, tx, httpError } = require("../db");
const { auth, h } = require("../middleware");

const MODE = process.env.PAYMENT_MODE === "toss" ? "toss" : "mock";
const CLIENT_KEY = process.env.TOSS_CLIENT_KEY || "";
const SECRET_KEY = process.env.TOSS_SECRET_KEY || "";
const ALLOWED_AMOUNTS = [5000, 10000, 30000, 50000, 100000];

// 충전 확정 — 멱등 처리 (같은 주문번호로 중복 승인해도 한 번만 입금)
async function completeCharge(orderNo, paymentKey) {
  return tx(async (t) => {
    const c = await t.get("SELECT * FROM charges WHERE order_no = ?", orderNo);
    if (!c) throw httpError(404, "충전 요청을 찾을 수 없습니다.");
    const { changes } = await t.run(
      "UPDATE charges SET status = 'done', payment_key = ? WHERE id = ? AND status = 'ready'", paymentKey || null, c.id);
    if (changes !== 1) return c; // 이미 처리됨
    await t.run("UPDATE users SET balance = balance + ? WHERE id = ?", c.amount, c.user_id);
    await t.run("INSERT INTO transactions (from_id, to_id, amount, memo) VALUES (NULL, ?, ?, ?)",
      c.user_id, c.amount, `지갑 충전 (${MODE === "toss" ? "토스페이먼츠" : "모의 결제"})`);
    return c;
  });
}

// 1) 충전 요청 생성
router.post("/charges", auth, h(async (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  if (!ALLOWED_AMOUNTS.includes(amount))
    return res.status(400).json({ error: "지원하는 충전 금액이 아닙니다.", allowed: ALLOWED_AMOUNTS });
  const orderNo = "charge_" + crypto.randomUUID();
  await q.run("INSERT INTO charges (user_id, order_no, amount) VALUES (?,?,?)", req.user.id, orderNo, amount);
  res.status(201).json({
    order_no: orderNo,
    amount,
    mode: MODE,
    client_key: MODE === "toss" ? CLIENT_KEY : null,
    order_name: `다시장 지갑 ${amount.toLocaleString()}원 충전`,
  });
}));

// 2-a) 모의 결제 승인 (개발용) — mock 모드에서만 라우트를 등록한다.
//   toss(운영) 모드에서는 이 엔드포인트 자체가 존재하지 않아, 환경변수 실수나
//   엔드포인트 노출로 인한 '공짜 무한 충전'이 원천 차단된다.
if (MODE === "mock") {
  router.post("/charges/mock-confirm", auth, h(async (req, res) => {
    const c = await completeCharge(String(req.body.order_no || ""), "mock");
    if (c.user_id !== req.user.id) return res.status(403).json({ error: "본인 충전 건이 아닙니다." });
    res.json({ ok: true, amount: c.amount });
  }));
}

// 2-b) 토스페이먼츠 결제 승인 (successUrl에서 호출 — 시크릿 키는 서버에서만 사용)
router.post("/charges/toss-confirm", auth, h(async (req, res) => {
  if (MODE !== "toss") return res.status(400).json({ error: "토스 결제 모드가 아닙니다." });
  const { paymentKey, orderId, amount } = req.body;
  const c = await q.get("SELECT * FROM charges WHERE order_no = ?", String(orderId || ""));
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: "충전 요청을 찾을 수 없습니다." });
  if (parseInt(amount, 10) !== c.amount)
    return res.status(400).json({ error: "결제 금액이 일치하지 않습니다." }); // 금액 변조 방지

  let r, data;
  try {
    r = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(SECRET_KEY + ":").toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ paymentKey, orderId, amount: c.amount }),
    });
    data = await r.json();
  } catch {
    return res.status(502).json({ error: "결제 서버와 통신에 실패했습니다. 잠시 후 다시 시도해 주세요." });
  }
  if (!r.ok) {
    await q.run("UPDATE charges SET status = 'failed' WHERE id = ? AND status = 'ready'", c.id);
    return res.status(400).json({ error: data.message || "결제 승인에 실패했습니다." });
  }
  await completeCharge(c.order_no, paymentKey);
  res.json({ ok: true, amount: c.amount });
}));

module.exports = router;
