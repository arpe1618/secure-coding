// src/server.js — 다시장 API 서버
require("dotenv").config();
const path = require("path");
const express = require("express");
const { ready, seedAdmin, DRIVER } = require("./db");

const app = express();
app.set("trust proxy", 1); // Nginx 등 리버스 프록시 뒤에서 실행
app.use(express.json());

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

// 공통 에러 핸들러 (도메인 에러는 status 포함)
app.use((err, _req, res, _next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "서버 오류가 발생했습니다." });
});

const PORT = process.env.PORT || 3000;
(async () => {
  await ready; // 스키마 준비 대기 (PG)
  await seedAdmin(process.env.ADMIN_NAME || "admin", process.env.ADMIN_PASSWORD || "admin1234");
  app.listen(PORT, () => {
    console.log(`다시장 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`DB: ${DRIVER} · 결제 모드: ${process.env.PAYMENT_MODE === "toss" ? "토스페이먼츠 실연동" : "모의 결제(mock)"}`);
  });
})().catch((e) => { console.error("서버 시작 실패:", e); process.exit(1); });
