'use strict';

/**
 * 외부 은행 장부 DB (SQLite).
 *
 * 테이블:
 *   bank_accounts          외부 계좌와 잔액
 *   account_tokens         계좌 인증 confirm 시 발급한 토큰
 *   bank_transactions      출금/지급/인증입금 거래 원장
 *   pending_verifications  1원 소액이체 인증 세션
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
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(d) {
  const sql = [
    'CREATE TABLE IF NOT EXISTS bank_accounts (',
    '  id              INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  bank_code       TEXT    NOT NULL,',
    '  account_number  TEXT    NOT NULL,',
    '  holder_name     TEXT    NOT NULL,',
    '  currency_code   TEXT    NOT NULL,',
    "  balance         TEXT    NOT NULL DEFAULT '0.0000',",
    "  account_status  TEXT    NOT NULL DEFAULT 'ACTIVE',",
    '  created_at      TEXT    NOT NULL,',
    '  updated_at      TEXT    NOT NULL,',
    '  UNIQUE (bank_code, account_number)',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS account_tokens (',
    '  id              INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  account_token   TEXT    NOT NULL UNIQUE,',
    '  account_id      INTEGER NOT NULL,',
    '  created_at      TEXT    NOT NULL,',
    '  FOREIGN KEY (account_id) REFERENCES bank_accounts(id)',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS bank_transactions (',
    '  id               INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  bank_tx_id       TEXT    NOT NULL UNIQUE,',
    '  idempotency_key  TEXT    UNIQUE,',
    "  kind             TEXT    NOT NULL,",
    '  account_id       INTEGER NOT NULL,',
    '  amount           TEXT    NOT NULL,',
    '  currency_code    TEXT    NOT NULL,',
    '  balance_after    TEXT    NOT NULL,',
    '  status           TEXT    NOT NULL,',
    '  memo             TEXT,',
    '  response_json    TEXT    NOT NULL,',
    '  created_at       TEXT    NOT NULL,',
    '  FOREIGN KEY (account_id) REFERENCES bank_accounts(id)',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS pending_verifications (',
    '  id          INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  account_id  INTEGER NOT NULL,',
    '  code        TEXT    NOT NULL,',
    '  expires_at  TEXT    NOT NULL,',
    '  used_at     TEXT,',
    '  created_at  TEXT    NOT NULL,',
    '  FOREIGN KEY (account_id) REFERENCES bank_accounts(id)',
    ');',
  ].join('\n');

  d.exec(sql);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
