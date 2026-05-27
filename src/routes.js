'use strict';

const { getDb } = require('./db');
const money = require('./money');
const { uuid, nowIso, ok, BankError, requireFields } = require('./util');

const SUPPORTED_CURRENCIES = ['KRW', 'USD', 'PHP', 'VND'];

function findAccountByNumber(db, bankCode, accountNumber) {
  return db
    .prepare('SELECT * FROM bank_accounts WHERE bank_code = ? AND account_number = ?')
    .get(bankCode, accountNumber);
}

function findAccountByToken(db, token) {
  const row = db
    .prepare(
      `SELECT a.* FROM account_tokens t
       JOIN bank_accounts a ON a.id = t.account_id
       WHERE t.account_token = ?`
    )
    .get(token);
  return row || null;
}

// ① 예금주 실명 조회
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

// ② 계좌 인증 (자동이체 등록) → account_token 발급
function verify(body) {
  requireFields(body, ['bank_code', 'account_number', 'holder_name']);
  const db = getDb();
  const acc = findAccountByNumber(db, body.bank_code, body.account_number);
  if (!acc) throw new BankError('BANK4040');

  // 예금주명 일치 검증 (공백/대소문자 무시)
  const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');
  if (norm(acc.holder_name) !== norm(body.holder_name)) {
    throw new BankError('BANK4003');
  }

  const token = uuid();
  const ts = nowIso();
  db.prepare(
    'INSERT INTO account_tokens (account_token, account_id, created_at) VALUES (?, ?, ?)'
  ).run(token, acc.id, ts);

  return ok(
    {
      account_token: token,
      bank_code: acc.bank_code,
      currency_code: acc.currency_code,
      verified: true,
      verified_at: ts,
    },
    '계좌 인증이 완료되었습니다.'
  );
}

// 멱등성: 같은 키로 이미 처리된 거래가 있으면 그 응답을 그대로 반환
function checkIdempotent(db, idempotencyKey) {
  if (!idempotencyKey) return null;
  const row = db
    .prepare('SELECT response_json FROM bank_transactions WHERE idempotency_key = ?')
    .get(idempotencyKey);
  return row ? JSON.parse(row.response_json) : null;
}

// ③ 출금 (withdrawal) — 외부 계좌 차감. 충전 재원.
function withdrawal(body, headers) {
  requireFields(body, ['account_token', 'amount', 'currency_code']);
  const db = getDb();
  const idemKey = headers['idempotency-key'] || null;

  // 멱등 재반환
  const cached = checkIdempotent(db, idemKey);
  if (cached) return cached;

  const acc = findAccountByToken(db, body.account_token);
  if (!acc) throw new BankError('BANK4010');
  if (acc.currency_code !== body.currency_code) throw new BankError('BANK4004');

  const amount = safeNormalize(body.amount);

  // 트랜잭션: 잔액 검증 → 차감 → 거래 기록 (원자적)
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
      `INSERT INTO bank_transactions
        (bank_tx_id, idempotency_key, kind, account_id, amount, currency_code,
         balance_after, status, response_json, created_at)
       VALUES (?, ?, 'WITHDRAWAL', ?, ?, ?, ?, 'COMPLETED', ?, ?)`
    ).run(bankTxId, idemKey, acc.id, amount, acc.currency_code, balanceAfter,
          JSON.stringify(response), ts);

    return response;
  })();

  return result;
}

// ④ 지급 (payout) — 외부 계좌 증액. 현금화. (환율은 본체가 이미 적용, 외화 그대로 지급)
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
      `INSERT INTO bank_transactions
        (bank_tx_id, idempotency_key, kind, account_id, amount, currency_code,
         balance_after, status, response_json, created_at)
       VALUES (?, ?, 'PAYOUT', ?, ?, ?, ?, 'COMPLETED', ?, ?)`
    ).run(bankTxId, idemKey, acc.id, amount, acc.currency_code, balanceAfter,
          JSON.stringify(response), ts);

    return response;
  })();

  return result;
}

// amount 정규화 + 양수/통화 검증
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

// (UI 전용) 잔액 포함 전체 계좌 목록. 실제 은행 API에는 없는 어드민 조회.
function listAccounts() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT bank_code, account_number, holder_name, currency_code,
            balance, account_status, updated_at
     FROM bank_accounts
     ORDER BY bank_code, account_number`
  ).all();
  return ok({ accounts: rows }, 'OK');
}

module.exports = { inquiry, verify, withdrawal, payout, listAccounts, SUPPORTED_CURRENCIES };
