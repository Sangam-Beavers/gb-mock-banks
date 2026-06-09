'use strict';

const { getDb } = require('./db');
const money = require('./money');
const { uuid, nowIso, ok, BankError, requireFields } = require('./util');

const SUPPORTED_CURRENCIES = ['KRW', 'USD', 'PHP', 'VND'];

/**
 * 계좌번호 정규화: 하이픈/공백 제거 후 대소문자 정규화.
 * 앱은 숫자만 전송하지만 seed.json은 하이픈 포함 형식을 쓸 수 있어 양쪽 normalize.
 */
function normalizeAccNum(s) {
  return String(s).replace(/[-\s]/g, '');
}

function findAccountByNumber(db, bankCode, accountNumber) {
  const norm = normalizeAccNum(accountNumber);
  // SQLite REPLACE()로 저장된 계좌번호의 하이픈도 무시하고 비교
  return db
    .prepare(
      "SELECT * FROM bank_accounts" +
      " WHERE bank_code = ? AND REPLACE(account_number, '-', '') = ?"
    )
    .get(bankCode, norm);
}

function findAccountByToken(db, token) {
  const row = db
    .prepare(
      'SELECT a.* FROM account_tokens t' +
      ' JOIN bank_accounts a ON a.id = t.account_id' +
      ' WHERE t.account_token = ?'
    )
    .get(token);
  return row || null;
}

// 예금주 실명 조회
function inquiry(body) {
  requireFields(body, ['bank_code', 'account_number']);
  const db = getDb();
  const acc = findAccountByNumber(db, body.bank_code, body.account_number);
  if (!acc) throw new BankError('BANK4040');

  return ok(
    {
      account_holder_name: acc.holder_name,
      currency_code: acc.currency_code,
      account_status: acc.account_status,
    },
    '예금주 조회가 완료되었습니다.'
  );
}

// 계좌 인증 요청 - 1원 소액이체 방식
function verify(body) {
  requireFields(body, ['bank_code', 'account_number', 'holder_name']);
  const db = getDb();
  const acc = findAccountByNumber(db, body.bank_code, body.account_number);
  if (!acc) throw new BankError('BANK4040');

  const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');
  if (norm(acc.holder_name) !== norm(body.holder_name)) {
    throw new BankError('BANK4003');
  }

  const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const ts = nowIso();
  const expiresAt = new Date(new Date(ts).getTime() + 10 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const memo = '[GlobalBridge] Auth code: ' + code;
  const depositAmount = '1.0000';

  db.transaction(() => {
    const balanceAfter = money.add(acc.balance, depositAmount);
    db.prepare('UPDATE bank_accounts SET balance = ?, updated_at = ? WHERE id = ?')
      .run(balanceAfter, ts, acc.id);

    db.prepare(
      'INSERT INTO bank_transactions' +
      ' (bank_tx_id, idempotency_key, kind, account_id, amount, currency_code,' +
      '  balance_after, status, memo, response_json, created_at)' +
      " VALUES (?, NULL, 'VERIFY_DEPOSIT', ?, ?, ?, ?, 'COMPLETED', ?, '{}', ?)"
    ).run(uuid(), acc.id, depositAmount, acc.currency_code, balanceAfter, memo, ts);

    db.prepare(
      'INSERT INTO pending_verifications (account_id, code, expires_at, used_at, created_at)' +
      ' VALUES (?, ?, ?, NULL, ?)'
    ).run(acc.id, code, expiresAt, ts);
  })();

  return ok(
    {
      bank_code: acc.bank_code,
      currency_code: acc.currency_code,
      pending: true,
      expires_at: expiresAt,
    },
    '1원이 입금되었습니다. 입금 적요의 인증번호 4자리를 입력해주세요.'
  );
}

// 계좌 인증 확인 - 4자리 코드 검증 후 account_token 발급
function confirm(body) {
  requireFields(body, ['bank_code', 'account_number', 'code']);

  if (!/^\d{4}$/.test(body.code)) throw new BankError('BANK4005');

  const db = getDb();
  const acc = findAccountByNumber(db, body.bank_code, body.account_number);
  if (!acc) throw new BankError('BANK4040');

  const now = nowIso();

  const pv = db.prepare(
    'SELECT * FROM pending_verifications' +
    ' WHERE account_id = ? AND used_at IS NULL AND expires_at > ?' +
    ' ORDER BY created_at DESC LIMIT 1'
  ).get(acc.id, now);

  if (!pv) throw new BankError('BANK4006');
  if (pv.code !== body.code) throw new BankError('BANK4005');

  const token = uuid();
  db.transaction(() => {
    db.prepare('UPDATE pending_verifications SET used_at = ? WHERE id = ?')
      .run(now, pv.id);
    db.prepare(
      'INSERT INTO account_tokens (account_token, account_id, created_at) VALUES (?, ?, ?)'
    ).run(token, acc.id, now);
  })();

  return ok(
    {
      account_token: token,
      bank_code: acc.bank_code,
      currency_code: acc.currency_code,
      verified: true,
      verified_at: now,
    },
    '계좌 인증이 완료되었습니다.'
  );
}

function checkIdempotent(db, idempotencyKey) {
  if (!idempotencyKey) return null;
  const row = db
    .prepare('SELECT response_json FROM bank_transactions WHERE idempotency_key = ?')
    .get(idempotencyKey);
  return row ? JSON.parse(row.response_json) : null;
}

// 출금 (withdrawal)
function withdrawal(body, headers) {
  requireFields(body, ['account_token', 'amount', 'currency_code']);
  const db = getDb();
  const idemKey = headers['idempotency-key'] || null;

  const cached = checkIdempotent(db, idemKey);
  if (cached) return cached;

  const acc = findAccountByToken(db, body.account_token);
  if (!acc) throw new BankError('BANK4010');
  if (acc.currency_code !== body.currency_code) throw new BankError('BANK4004');

  const amount = safeNormalize(body.amount);

  const result = db.transaction(() => {
    if (!money.gte(acc.balance, amount)) throw new BankError('BANK4002');
    const balanceAfter = money.sub(acc.balance, amount);
    const ts = nowIso();

    db.prepare('UPDATE bank_accounts SET balance = ?, updated_at = ? WHERE id = ?')
      .run(balanceAfter, ts, acc.id);

    const bankTxId = uuid();
    const data = {
      bank_tx_id: bankTxId,
      account_token: body.account_token,
      amount,
      currency_code: acc.currency_code,
      balance_after: balanceAfter,
      status: 'COMPLETED',
      processed_at: ts,
    };
    const response = ok(data, '출금이 완료되었습니다.');

    db.prepare(
      'INSERT INTO bank_transactions' +
      ' (bank_tx_id, idempotency_key, kind, account_id, amount, currency_code,' +
      '  balance_after, status, memo, response_json, created_at)' +
      " VALUES (?, ?, 'WITHDRAWAL', ?, ?, ?, ?, 'COMPLETED', NULL, ?, ?)"
    ).run(bankTxId, idemKey, acc.id, amount, acc.currency_code, balanceAfter,
          JSON.stringify(response), ts);

    return response;
  })();

  return result;
}

// 지급 (payout)
function payout(body, headers) {
  requireFields(body, ['bank_code', 'account_number', 'amount', 'currency_code']);
  const db = getDb();
  const idemKey = headers['idempotency-key'] || null;

  const cached = checkIdempotent(db, idemKey);
  if (cached) return cached;

  const acc = findAccountByNumber(db, body.bank_code, body.account_number);
  if (!acc) throw new BankError('BANK4040');
  if (acc.currency_code !== body.currency_code) throw new BankError('BANK4004');

  const amount = safeNormalize(body.amount);

  const result = db.transaction(() => {
    const balanceAfter = money.add(acc.balance, amount);
    const ts = nowIso();

    db.prepare('UPDATE bank_accounts SET balance = ?, updated_at = ? WHERE id = ?')
      .run(balanceAfter, ts, acc.id);

    const bankTxId = uuid();
    const data = {
      bank_tx_id: bankTxId,
      bank_code: acc.bank_code,
      account_number: maskAccount(acc.account_number),
      amount,
      currency_code: acc.currency_code,
      status: 'COMPLETED',
      processed_at: ts,
    };
    const response = ok(data, '지급이 완료되었습니다.');

    db.prepare(
      'INSERT INTO bank_transactions' +
      ' (bank_tx_id, idempotency_key, kind, account_id, amount, currency_code,' +
      '  balance_after, status, memo, response_json, created_at)' +
      " VALUES (?, ?, 'PAYOUT', ?, ?, ?, ?, 'COMPLETED', NULL, ?, ?)"
    ).run(bankTxId, idemKey, acc.id, amount, acc.currency_code, balanceAfter,
          JSON.stringify(response), ts);

    return response;
  })();

  return result;
}

function safeNormalize(amountStr) {
  let normalized;
  try {
    normalized = money.normalize(amountStr);
  } catch (_) {
    throw new BankError('BANK4001');
  }
  if (!money.isPositive(normalized)) throw new BankError('BANK4001');
  return normalized;
}

function maskAccount(num) {
  if (num.length <= 4) return num;
  return num.slice(0, -4).replace(/[\d]/g, '*') + num.slice(-4);
}

// (UI 전용) 잔액 포함 전체 계좌 목록
function listAccounts() {
  const db = getDb();
  const rows = db.prepare(
    'SELECT bank_code, account_number, holder_name, currency_code,' +
    ' balance, account_status, updated_at' +
    ' FROM bank_accounts ORDER BY bank_code, account_number'
  ).all();
  return ok({ accounts: rows }, 'OK');
}

// (UI 전용) 미사용 + 미만료 인증 대기 목록
function listPendingVerifications() {
  const db = getDb();
  const now = nowIso();
  const rows = db.prepare(
    'SELECT pv.id, pv.code, pv.expires_at, pv.created_at,' +
    ' a.bank_code, a.account_number, a.holder_name, a.currency_code' +
    ' FROM pending_verifications pv' +
    ' JOIN bank_accounts a ON a.id = pv.account_id' +
    ' WHERE pv.used_at IS NULL AND pv.expires_at > ?' +
    ' ORDER BY pv.created_at DESC'
  ).all(now);
  return ok({ pending: rows }, 'OK');
}

// (UI 전용) 특정 계좌의 최근 거래 내역 (memo 포함)
function listAccountTransactions(bankCode, accountNumber) {
  const db = getDb();
  const acc = findAccountByNumber(db, bankCode, accountNumber);
  if (!acc) throw new BankError('BANK4040');

  const rows = db.prepare(
    'SELECT bank_tx_id, kind, amount, currency_code, balance_after, memo, status, created_at' +
    ' FROM bank_transactions WHERE account_id = ?' +
    ' ORDER BY created_at DESC LIMIT 20'
  ).all(acc.id);

  return ok({ transactions: rows }, 'OK');
}

module.exports = {
  inquiry, verify, confirm, withdrawal, payout,
  listAccounts, listPendingVerifications, listAccountTransactions,
  SUPPORTED_CURRENCIES,
};
