'use strict';

/**
 * 외부 은행 장부 DB (SQLite).
 *
 * 이 DB는 "외부 은행"의 것이다. GlobalBridge 본체의 MySQL(wallet_balances)과
 * 완전히 분리되어 있으며, 본체는 이 DB를 직접 만지지 않는다.
 *
 * 테이블:
 *   bank_accounts      외부 계좌와 잔액 (충전 재원 / 송금 수취 대상)
 *   account_tokens     계좌 인증(②) 시 발급한 토큰 → 출금(③)에서 계좌 지칭
 *   bank_transactions  출금/지급 거래 원장 + 멱등성 키(UNIQUE)
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

function getDb(dbPath) {
  if (db) return db;

  const resolved = path.resolve(dbPath || process.env.DB_PATH || './data/bank.db');
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(resolved);
  db.pragma('journal_mode = WAL');   // 동시 읽기 안정성
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_code       TEXT    NOT NULL,
      account_number  TEXT    NOT NULL,
      holder_name     TEXT    NOT NULL,
      currency_code   TEXT    NOT NULL,         -- KRW/USD/PHP/VND
      balance         TEXT    NOT NULL DEFAULT '0.0000',  -- string 십진수 (DECIMAL 의미)
      account_status  TEXT    NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE/INACTIVE
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL,
      UNIQUE (bank_code, account_number)
    );

    CREATE TABLE IF NOT EXISTS account_tokens (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      account_token   TEXT    NOT NULL UNIQUE,  -- UUID
      account_id      INTEGER NOT NULL,
      created_at      TEXT    NOT NULL,
      FOREIGN KEY (account_id) REFERENCES bank_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS bank_transactions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_tx_id       TEXT    NOT NULL UNIQUE, -- UUID (대외 식별자)
      idempotency_key  TEXT    UNIQUE,          -- 멱등성. 같은 키면 첫 결과 재반환
      kind             TEXT    NOT NULL,        -- WITHDRAWAL / PAYOUT
      account_id       INTEGER NOT NULL,
      amount           TEXT    NOT NULL,        -- string 십진수
      currency_code    TEXT    NOT NULL,
      balance_after    TEXT    NOT NULL,        -- 거래 후 외부 계좌 잔액
      status           TEXT    NOT NULL,        -- COMPLETED
      response_json    TEXT    NOT NULL,        -- 멱등 재반환용 응답 캐시
      created_at       TEXT    NOT NULL,
      FOREIGN KEY (account_id) REFERENCES bank_accounts(id)
    );
  `);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
