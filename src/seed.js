'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { getDb, closeDb } = require('./db');
const { nowIso } = require('./util');
const money = require('./money');

const SEED_FILE = path.resolve(__dirname, '../data/seed.json');
const isReset = process.argv.includes('--reset');

function loadSeed() {
  const raw = fs.readFileSync(SEED_FILE, 'utf-8');
  return JSON.parse(raw);
}

function run() {
  const db = getDb();
  const seed = loadSeed();
  const ts = nowIso();

  if (isReset) {
    db.exec('DELETE FROM bank_transactions; DELETE FROM account_tokens; DELETE FROM bank_accounts;');
    console.log('🧹 기존 데이터 초기화 완료.');
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO bank_accounts
       (bank_code, account_number, holder_name, currency_code, balance, account_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
  );

  let count = 0;
  const tx = db.transaction(() => {
    for (const a of seed.accounts) {
      const balance = money.normalize(a.balance); // string 십진수 표준화
      const info = insert.run(
        a.bank_code, a.account_number, a.holder_name, a.currency_code, balance, ts, ts
      );
      if (info.changes > 0) count++;
    }
  });
  tx();

  console.log(`🏦 시드 계좌 ${count}건 투입 완료. (총 ${seed.accounts.length}건 중)`);
  console.log('계좌 목록:');
  const rows = db.prepare('SELECT bank_code, account_number, holder_name, currency_code, balance FROM bank_accounts').all();
  for (const r of rows) {
    console.log(`  - [${r.bank_code}] ${r.account_number} / ${r.holder_name} / ${r.currency_code} ${r.balance}`);
  }

  closeDb();
}

run();
