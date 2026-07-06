// src/db.js — DB 어댑터 (SQLite ↔ PostgreSQL 전환형)
// DB_DRIVER=sqlite   : Node 22+ 내장 SQLite (개발/소규모 운영, 기본값)
// DB_DRIVER=postgres : PostgreSQL (운영 배포, DATABASE_URL 필요)
//
// 두 드라이버 모두 동일한 비동기 인터페이스를 제공합니다:
//   q.get(sql, ...params)  → 첫 행 또는 undefined
//   q.all(sql, ...params)  → 행 배열
//   q.run(sql, ...params)  → { changes }
//   q.insert(sql, ...params) → 새 행의 id
//   tx(async (t) => {...}) → 트랜잭션 (t는 위와 같은 인터페이스)
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");

const DRIVER = process.env.DB_DRIVER === "postgres" ? "postgres" : "sqlite";

/* ─────────── 스키마 ─────────── */
// 방언 차이: id 자동증가, 시간 기본값. 나머지는 공통.
const dialect = DRIVER === "postgres"
  ? { pk: "id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY", now: "to_char(now(), 'YYYY-MM-DD HH24:MI:SS')" }
  : { pk: "id INTEGER PRIMARY KEY AUTOINCREMENT", now: "datetime('now','localtime')" };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  ${dialect.pk},
  name TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,          -- 원 단위 정수 (부동소수점 금지)
  bio TEXT NOT NULL DEFAULT '',                -- 마이페이지 소개글
  blocked INTEGER NOT NULL DEFAULT 0,          -- 관리자 차단
  dormant INTEGER NOT NULL DEFAULT 0,          -- 신고 누적 자동 휴면
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${dialect.now})
);
CREATE TABLE IF NOT EXISTS products (
  ${dialect.pk},
  seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active | sold | blocked | deleted
  created_at TEXT NOT NULL DEFAULT (${dialect.now})
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE TABLE IF NOT EXISTS chats (
  ${dialect.pk},
  product_id INTEGER NOT NULL REFERENCES products(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (${dialect.now}),
  UNIQUE(product_id, buyer_id)
);
CREATE TABLE IF NOT EXISTS messages (
  ${dialect.pk},
  chat_id INTEGER NOT NULL REFERENCES chats(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${dialect.now})
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS reports (
  ${dialect.pk},
  kind TEXT NOT NULL CHECK (kind IN ('user','product')),
  target_id INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${dialect.now})
);
CREATE TABLE IF NOT EXISTS transactions (      -- 지갑 원장: 모든 돈의 이동 기록 (NULL = 외부/에스크로)
  ${dialect.pk},
  from_id INTEGER REFERENCES users(id),
  to_id INTEGER REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${dialect.now})
);
CREATE TABLE IF NOT EXISTS orders (            -- 안전거래(에스크로) 주문
  ${dialect.pk},
  product_id INTEGER NOT NULL REFERENCES products(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',          -- paid | completed | refunded
  created_at TEXT NOT NULL DEFAULT (${dialect.now})
);
CREATE TABLE IF NOT EXISTS global_messages (   -- 전체 채팅 (모든 유저 공용)
  ${dialect.pk},
  sender_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${dialect.now})
);
CREATE TABLE IF NOT EXISTS charges (           -- 외부 결제(토스페이먼츠) 충전
  ${dialect.pk},
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_no TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'ready',         -- ready | done | failed
  payment_key TEXT,
  created_at TEXT NOT NULL DEFAULT (${dialect.now})
);
`;

let q, tx, ready;

/* ─────────── SQLite 드라이버 ───────────
   내장 드라이버는 동기라서 어댑터 호출이 즉시 resolve됩니다.
   → 트랜잭션 콜백이 한 매크로태스크 안에서 끝나므로 다른 요청과 섞이지 않습니다.
   (주의: 트랜잭션 콜백 안에서 DB 이외의 진짜 비동기 작업(fetch 등)을 하지 마세요) */
if (DRIVER === "sqlite") {
  const { DatabaseSync } = require("node:sqlite");
  const DATA_DIR = path.join(__dirname, "..", "data");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, "dasijang.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // 기존 DB 업그레이드 (이미 컬럼이 있으면 조용히 넘어감)
  for (const alter of [
    "ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN dormant INTEGER NOT NULL DEFAULT 0",
  ]) { try { db.exec(alter); } catch { /* already applied */ } }

  q = {
    async get(sql, ...p) { return db.prepare(sql).get(...p); },
    async all(sql, ...p) { return db.prepare(sql).all(...p); },
    async run(sql, ...p) { const i = db.prepare(sql).run(...p); return { changes: i.changes }; },
    async insert(sql, ...p) { return Number(db.prepare(sql).run(...p).lastInsertRowid); },
  };
  tx = async (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try { const r = await fn(q); db.exec("COMMIT"); return r; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  ready = Promise.resolve();
}

/* ─────────── PostgreSQL 드라이버 ─────────── */
if (DRIVER === "postgres") {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // '?' 플레이스홀더 → $1, $2 ... 변환 (쿼리 문자열 리터럴에는 ?를 쓰지 않는 것이 규칙)
  const $ = (sql) => { let i = 0; return sql.replace(/\?/g, () => "$" + ++i); };

  const iface = (runner) => ({
    async get(sql, ...p) { return (await runner.query($(sql), p)).rows[0]; },
    async all(sql, ...p) { return (await runner.query($(sql), p)).rows; },
    async run(sql, ...p) { const r = await runner.query($(sql), p); return { changes: r.rowCount }; },
    async insert(sql, ...p) {
      const withReturning = /returning/i.test(sql) ? sql : sql + " RETURNING id";
      return (await runner.query($(withReturning), p)).rows[0].id;
    },
  });

  q = iface(pool);
  tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await fn(iface(client));
      await client.query("COMMIT");
      return r;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  };
  ready = (async () => {
    for (const stmt of SCHEMA.split(";")) if (stmt.trim()) await pool.query(stmt);
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS dormant INTEGER NOT NULL DEFAULT 0");
  })();
}

/* ─────────── 관리자 시드 ─────────── */
async function seedAdmin(name, password) {
  await ready;
  const exists = await q.get("SELECT id FROM users WHERE is_admin = 1 LIMIT 1");
  if (!exists) {
    await q.run("INSERT INTO users (name, pw_hash, is_admin) VALUES (?, ?, 1)", name, bcrypt.hashSync(password, 10));
    console.log(`[seed] 관리자 계정 생성: ${name}`);
  }
}

// 라우트에서 던지는 도메인 에러
const httpError = (status, message) => Object.assign(new Error(message), { status });

module.exports = { q, tx, ready, seedAdmin, httpError, DRIVER };
