'use strict';

const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); // 2026-05-27T12:00:00Z
}

// SSOT 응답 래퍼와 동일 구조
function ok(data, message = '요청이 성공적으로 처리되었습니다.') {
  return { success: true, data, message };
}

function fail(code, message) {
  return { success: false, code, message };
}

// 은행 도메인 에러 코드 (BANK####). 본체 코드와 별개.
const BANK_ERROR = {
  BANK4001: { http: 400, message: '요청 값이 올바르지 않습니다.' },
  BANK4002: { http: 400, message: '계좌 잔액이 부족합니다.' },
  BANK4003: { http: 400, message: '예금주 정보가 일치하지 않습니다.' },
  BANK4004: { http: 400, message: '통화가 일치하지 않습니다.' },
  BANK4010: { http: 401, message: '유효하지 않은 계좌 토큰입니다.' },
  BANK4040: { http: 404, message: '존재하지 않는 계좌입니다.' },
  BANK5000: { http: 500, message: '은행 서버 내부 오류입니다.' },
};

// 라우트에서 throw 해서 일괄 처리되게 하는 에러
class BankError extends Error {
  constructor(code) {
    const def = BANK_ERROR[code] || BANK_ERROR.BANK5000;
    super(def.message);
    this.code = code;
    this.http = def.http;
  }
}

// 요청 본문(JSON) 읽기
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new BankError('BANK4001')); // 1MB 제한
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new BankError('BANK4001'));
      }
    });
    req.on('error', () => reject(new BankError('BANK5000')));
  });
}

// 필수 필드 검증
function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      throw new BankError('BANK4001');
    }
  }
}

module.exports = {
  uuid, nowIso, ok, fail, BANK_ERROR, BankError, readJsonBody, requireFields,
};
