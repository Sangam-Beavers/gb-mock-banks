'use strict';

/**
 * 금액 유틸. SSOT 규칙: 금액은 string 십진수, float 금지.
 * 내부 계산은 소수 4자리(scale=4) 기준 정수(BigInt)로 처리해 부동소수점 오차를 없앤다.
 */

const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE); // 10000

// "1200000.0000" | "150000" | "12.5"  → BigInt(scaled)
function toScaled(str) {
  if (typeof str === 'number') {
    throw new Error('금액은 number가 아니라 string으로 전달해야 합니다.');
  }
  if (typeof str !== 'string' || str.trim() === '') {
    throw new Error('유효하지 않은 금액 문자열입니다.');
  }
  const neg = str.trim().startsWith('-');
  const clean = str.trim().replace(/^-/, '');
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    throw new Error(`유효하지 않은 금액 형식: ${str}`);
  }
  const [intPart, fracPartRaw = ''] = clean.split('.');
  const fracPart = (fracPartRaw + '0'.repeat(SCALE)).slice(0, SCALE);
  const scaled = BigInt(intPart) * FACTOR + BigInt(fracPart || '0');
  return neg ? -scaled : scaled;
}

// BigInt(scaled) → "1200000.0000"
function fromScaled(scaled) {
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const intPart = abs / FACTOR;
  const fracPart = (abs % FACTOR).toString().padStart(SCALE, '0');
  return `${neg ? '-' : ''}${intPart.toString()}.${fracPart}`;
}

// 정규화: 입력 string을 표준 표기("####.####")로
function normalize(str) {
  return fromScaled(toScaled(str));
}

function add(a, b) { return fromScaled(toScaled(a) + toScaled(b)); }
function sub(a, b) { return fromScaled(toScaled(a) - toScaled(b)); }

// a >= b ?
function gte(a, b) { return toScaled(a) >= toScaled(b); }
// a > 0 ?
function isPositive(a) { return toScaled(a) > 0n; }

module.exports = { SCALE, toScaled, fromScaled, normalize, add, sub, gte, isPositive };
