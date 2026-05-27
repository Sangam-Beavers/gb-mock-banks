# Mock 외부 은행 서버 — API 명세 (정본)

> **무엇인가:** 실제 PG사(토스페이먼츠)·오픈뱅킹·해외 파트너 은행을 대체하는 **Mock 은행 서버**의 API 계약이다. GlobalBridge 본체(`com.gb.wallet`)가 이 서버를 **HTTP 클라이언트로서 호출**한다.
> **구현 수준:** 수준 2 (Mock API). 실서비스 전환 시 이 서버를 끄고 **호출 URL만 실제 PG/은행 API로 교체**하면 본체 비즈니스 로직은 그대로 동작하도록 설계한다.
> **전역 규칙 정합:** 금액은 `string` 십진수, 실행 계열은 `Idempotency-Key` 헤더(동일 키 재요청 시 첫 응답 재반환), 응답은 `{ success, data, message }` 래퍼. (본체 [`conventions.md`](../conventions.md) §0/§8과 일치)
> **통신 보안:** 모든 엔드포인트는 **mTLS**(상호 TLS) 필수. 본체가 클라이언트 인증서를 제시하지 못하면 TLS 핸드셰이크 단계에서 거절된다.

---

## 0. 시스템 경계 — 가장 먼저 이해할 것

이 서버는 **외부 은행**이다. 본체와 **장부(DB)가 완전히 분리**되어 있다.

```
┌──────────────────────────────┐       mTLS HTTPS       ┌──────────────────────────────┐
│  GlobalBridge 본체 (com.gb)  │  ───────────────────>  │  Mock 외부 은행 서버          │
│  MySQL                       │   (본체가 클라이언트)   │  SQLite (은행 자체 장부)      │
│  └ wallet_balances           │                        │  └ bank_accounts (외부 계좌)  │
│    = 앱 포인트의 진실         │  <───────────────────  │    = 외부 현금의 진실         │
└──────────────────────────────┘     성공/실패 응답      └──────────────────────────────┘
```

- 본체의 `wallet_balances`(앱 포인트)는 **본체 MySQL**에만 있다. 은행 서버는 이를 모른다.
- 은행 서버의 `bank_accounts`(외부 계좌 잔액)는 **은행 SQLite**에만 있다. 본체는 이를 직접 못 만진다.
- 두 장부는 **서로의 DB를 절대 변경하지 않는다.** 은행의 "성공 응답"이 트리거가 되어, 본체가 자기 MySQL을 갱신할 뿐이다.

| 본체 동작 | 은행 호출 | 은행이 자기 DB에 하는 일 | 본체가 자기 DB에 하는 일 |
| --- | --- | --- | --- |
| 충전 (외부계좌 → 앱) | **출금** (③) | 외부 계좌 잔액 **차감** | `wallet_balances` 증액 + `transactions(CHARGE)` |
| 환전 (KRW↔외화) | 없음 | — | 통화 전환 (앱 내부) |
| 앱 내 송금 (고객→고객) | 없음 | — | 포인트 이동 (앱 내부) |
| 현금화 (앱 → 외부계좌) | **지급** (④) | 외부 계좌 잔액 **증액** | `wallet_balances` 소멸 + `transactions(REMITTANCE)` |

> **돈의 방향 주의:** 충전 시 외부계좌는 **줄고**(출금), 현금화 시 외부계좌는 **는다**(지급). 방향이 정반대라 엔드포인트를 분리했다.

---

## 1. 은행 배역 (시드 기준)

| 은행 코드 | 이름 | 역할 | 취급 통화 |
| --- | --- | --- | --- |
| `BEAVER` | Beaver Bank | 한국 PG + 한국 계좌 출금/지급 | KRW |
| `QUOKKA` | Quokka Bank | 해외 파트너 은행 통합 (베트남/필리핀/미국) | USD / PHP / VND |
| `SHINHAN` / `WOORI` / `KB` | 신한·우리·국민 | 한국 타행 (충전 재원 계좌가 위치) | KRW |

> 지원 통화는 본체 정책과 동일하게 **KRW / USD / PHP / VND** 4개로 고정. (본체 [`project-overview.md`](../project-overview.md) §2)
> 돈의 흐름은 **양방향** 지원(한국→해외 / 해외→한국). 단, 본체에서 어느 방향을 노출하는지는 본체 기획 소관이며, 은행 서버는 양방향 호출을 모두 받는다.

---

## 2. 공통 규약

### 2-1. 인증 — mTLS
- 본체와 은행 서버는 **상호 TLS 인증서**로 서로를 검증한다.
- 셀프사인 CA로 서버 인증서 / 클라이언트(본체) 인증서를 발급한다. 서버는 CA가 서명한 클라이언트 인증서만 수락한다.
- 애플리케이션 레벨 API Key는 두지 않는다(전송 계층에서 이미 신뢰가 성립).

### 2-2. 멱등성 — `Idempotency-Key`
- 실행 계열(출금 ③, 지급 ④)은 `Idempotency-Key` 헤더(UUID)를 **필수**로 받는다.
- **동일 키 재요청은 에러가 아니다.** 은행 서버는 첫 실행 결과(2xx)를 그대로 재반환한다. (네트워크 재시도로 인한 이중 출금/지급 방지)
- 구현: 은행 SQLite의 `bank_transactions.idempotency_key` UNIQUE + 결과 캐시.

### 2-3. 금액 표기
- 모든 금액은 **`string` 십진수**. 소수 4자리 권장(`"1200000.0000"`). `number`(float) 금지.
- 통화 필드는 `_code` 접미사 (`currency_code`).

### 2-4. 응답 래퍼
성공:
```json
{ "success": true, "data": { }, "message": "..." }
```
실패:
```json
{ "success": false, "code": "BANK4002", "message": "계좌 잔액이 부족합니다." }
```

### 2-5. 식별자·시각
- 거래 식별자는 `bank_tx_id`(UUID). 계좌 토큰은 `account_token`(UUID).
- 시각은 ISO 8601 UTC `Z` (`"2026-05-27T12:00:00Z"`).

---

## 3. 엔드포인트 목록

| # | 동작 | Method | Endpoint | 멱등성 | 부르는 본체 시점 |
| --- | --- | --- | --- | --- | --- |
| ① | 예금주 실명 조회 | POST | `/api/v1/bank/accounts/inquiry` | — | 계좌 등록 시 실명 확인 |
| ② | 계좌 인증 (자동이체 등록) | POST | `/api/v1/bank/accounts/verify` | — | 충전용 계좌 연결 |
| ③ | 출금 (withdrawal) | POST | `/api/v1/bank/transfers/withdrawal` | ✅ | 충전 실행 (외부계좌 차감) |
| ④ | 지급 (payout) | POST | `/api/v1/bank/transfers/payout` | ✅ | 현금화 실행 (외부계좌 증액) |
| — | 헬스 체크 | GET | `/health` | — | 운영 |

> **계좌 지칭 방식:** 충전(출금 ③)은 ②에서 발급받은 `account_token`으로 계좌를 지칭한다(실제 PG의 빌링키 구조 모사). 지급(④)은 등록 없이 `bank_code + account_number`로 직접 지칭한다.
> **인증 위치:** 본인 계좌에서 빼가는 출금만 계좌 인증(②)이 선행된다. 외부계좌로 넣어주는 지급(④)은 인증 불필요.

---

## ① 예금주 실명 조회

`POST /api/v1/bank/accounts/inquiry`

본체가 계좌 등록 화면에서 "예금주 실명 조회"를 할 때 호출한다.

**Request Body**
| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `bank_code` | string | O | 은행 코드 (SHINHAN/WOORI/KB/BEAVER/QUOKKA) |
| `account_number` | string | O | 계좌번호 |

**Response 200** — `data`
| 필드 | 타입 | nullable | 설명 |
| --- | --- | --- | --- |
| `account_holder_name` | string | N | 예금주 실명 |
| `currency_code` | string | N | 계좌 통화 (KRW/USD/PHP/VND) |
| `account_status` | string | N | ACTIVE / INACTIVE |

**Error**
| HTTP | code | message |
| --- | --- | --- |
| 400 | BANK4001 | 요청 값이 올바르지 않습니다. |
| 404 | BANK4040 | 존재하지 않는 계좌입니다. |

> 시드에 등록된 계좌만 조회 성공. 없는 계좌는 `BANK4040`.

---

## ② 계좌 인증 (자동이체 등록)

`POST /api/v1/bank/accounts/verify`

충전에 쓸 계좌를 본체에 연결한다. 예금주 일치를 확인하고 **`account_token`을 발급**한다. 이후 출금(③)은 이 토큰으로만 가능하다.

**Request Body**
| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `bank_code` | string | O | 은행 코드 |
| `account_number` | string | O | 계좌번호 |
| `holder_name` | string | O | 본체가 입력받은 예금주명 (일치 검증용) |

**Response 200** — `data`
| 필드 | 타입 | nullable | 설명 |
| --- | --- | --- | --- |
| `account_token` | string | N | 계좌 토큰(UUID). 출금 시 계좌 지칭에 사용 |
| `bank_code` | string | N | 은행 코드 |
| `currency_code` | string | N | 계좌 통화 |
| `verified` | boolean | N | 항상 true (실패 시 에러 응답) |
| `verified_at` | string | N | 인증 시각 (ISO 8601 UTC Z) |

**Error**
| HTTP | code | message |
| --- | --- | --- |
| 400 | BANK4001 | 요청 값이 올바르지 않습니다. |
| 400 | BANK4003 | 예금주 정보가 일치하지 않습니다. |
| 404 | BANK4040 | 존재하지 않는 계좌입니다. |

> ⚠️ 실제 자동이체 인증(PASS/ARS 등)은 구현 불가 영역이다. 본 Mock은 예금주명 일치 검증 + 토큰 발급으로 시뮬레이션한다.

---

## ③ 출금 (withdrawal) ★ 충전 재원

`POST /api/v1/bank/transfers/withdrawal` · Header `Idempotency-Key`

본체의 충전 실행(`POST /api/v1/accounts/{id}/charge`) 내부에서 호출된다. **외부 계좌에서 돈을 빼서** 본체 앱으로 보낼 재원을 마련한다. → 은행 SQLite의 해당 계좌 잔액을 **차감**한다.

**Request Header**
| 헤더 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `Idempotency-Key` | string | O | 멱등성 키(UUID) |

**Request Body**
| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `account_token` | string | O | ②에서 발급받은 계좌 토큰 |
| `amount` | string | O | 출금 금액 (string 십진수) |
| `currency_code` | string | O | 출금 통화. 계좌 통화와 일치해야 함 |

**Response 200** — `data`
| 필드 | 타입 | nullable | 설명 |
| --- | --- | --- | --- |
| `bank_tx_id` | string | N | 은행 거래 식별자(UUID) |
| `account_token` | string | N | 출금 계좌 토큰 |
| `amount` | string | N | 출금 금액 |
| `currency_code` | string | N | 통화 |
| `balance_after` | string | N | 출금 후 외부 계좌 잔액 |
| `status` | string | N | COMPLETED |
| `processed_at` | string | N | 처리 시각 (ISO 8601 UTC Z) |

**Error**
| HTTP | code | message |
| --- | --- | --- |
| 400 | BANK4001 | 요청 값이 올바르지 않습니다. |
| 400 | BANK4002 | 계좌 잔액이 부족합니다. |
| 400 | BANK4004 | 통화가 일치하지 않습니다. |
| 401 | BANK4010 | 유효하지 않은 계좌 토큰입니다. |

> 멱등성: 동일 `Idempotency-Key` 재요청 시 첫 결과 그대로 재반환(잔액 재차감 없음).
> 본체는 이 응답이 `COMPLETED`일 때만 자기 MySQL `wallet_balances`를 증액한다.

---

## ④ 지급 (payout) ★ 현금화

`POST /api/v1/bank/transfers/payout` · Header `Idempotency-Key`

본체에서 사용자가 포인트를 실제 외부 계좌의 현금으로 받을 때 호출된다. **외부 계좌로 돈을 넣어준다.** → 은행 SQLite의 수취 계좌 잔액을 **증액**한다. 환율은 본체가 이미 적용했으므로, 은행은 **받은 외화 금액 그대로** 지급한다(환율을 모름).

**Request Header**
| 헤더 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `Idempotency-Key` | string | O | 멱등성 키(UUID) |

**Request Body**
| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `bank_code` | string | O | 수취 은행 코드 (BEAVER=한국 / QUOKKA=해외) |
| `account_number` | string | O | 수취 계좌번호 |
| `amount` | string | O | 지급 금액 (이미 환전된 최종 외화 금액) |
| `currency_code` | string | O | 지급 통화. 수취 계좌 통화와 일치해야 함 |

**Response 200** — `data`
| 필드 | 타입 | nullable | 설명 |
| --- | --- | --- | --- |
| `bank_tx_id` | string | N | 은행 거래 식별자(UUID) |
| `bank_code` | string | N | 수취 은행 코드 |
| `account_number` | string | N | 수취 계좌번호(마스킹 권장) |
| `amount` | string | N | 지급 금액 |
| `currency_code` | string | N | 통화 |
| `status` | string | N | COMPLETED |
| `processed_at` | string | N | 처리 시각 (ISO 8601 UTC Z) |

**Error**
| HTTP | code | message |
| --- | --- | --- |
| 400 | BANK4001 | 요청 값이 올바르지 않습니다. |
| 400 | BANK4004 | 통화가 일치하지 않습니다. |
| 404 | BANK4040 | 존재하지 않는 계좌입니다. |

> 멱등성: 동일 `Idempotency-Key` 재요청 시 첫 결과 재반환(잔액 재증액 없음).
> 본체는 이 호출 **이전에** 자기 MySQL에서 포인트를 차감(또는 차감 예약)하고, 응답이 `COMPLETED`일 때 확정한다.

---

## 5. 에러 코드 표 (은행 도메인 — BANK)

> 본체의 에러 코드(COMMON/WALLET 등)와 **별개**다. 이 서버는 외부 시스템이므로 자체 코드 체계(`BANK####`)를 쓴다. 본체는 은행 에러를 받아 자기 도메인 코드(`ACCOUNT4003` 등)로 매핑한다.

| code | HTTP | 의미 |
| --- | --- | --- |
| `BANK4001` | 400 | 요청 값이 올바르지 않습니다. |
| `BANK4002` | 400 | 계좌 잔액이 부족합니다. (출금 시) |
| `BANK4003` | 400 | 예금주 정보가 일치하지 않습니다. |
| `BANK4004` | 400 | 통화가 일치하지 않습니다. |
| `BANK4010` | 401 | 유효하지 않은 계좌 토큰입니다. |
| `BANK4040` | 404 | 존재하지 않는 계좌입니다. |
| `BANK5000` | 500 | 은행 서버 내부 오류입니다. |

### 본체 ↔ 은행 에러 매핑(참고)
| 은행 코드 | 본체 처리 |
| --- | --- |
| `BANK4002` (출금 잔액부족) | `ACCOUNT4003` (연동 계좌의 잔액이 부족합니다) |
| `BANK4040` (계좌 없음) | `ACCOUNT4001` (존재하지 않는 계좌입니다) |
| `BANK4003` (예금주 불일치) | `ACCOUNT4002` (계좌 인증에 실패했습니다) |
| `BANK5000` / 타임아웃 | `COMMON5031` (일시적으로 처리할 수 없습니다) |

---

## 6. 본체(`com.gb.wallet`) 연동 가이드 — `BankClient` 인터페이스

본체는 이 은행 서버를 직접 호출하지 않고 **인터페이스에 의존**한다. 실서비스 전환 시 구현체만 교체한다.

```java
public interface BankClient {
    AccountHolder   inquiry(String bankCode, String accountNumber);                 // ①
    AccountToken    verify(String bankCode, String accountNumber, String holder);   // ②
    WithdrawalResult withdraw(String accountToken, BigDecimal amount,
                              String currencyCode, String idempotencyKey);          // ③
    PayoutResult    payout(String bankCode, String accountNumber, BigDecimal amount,
                           String currencyCode, String idempotencyKey);             // ④
}

@Profile({"dev","stage"}) @Component
class MockBankClient implements BankClient { /* 이 Mock 서버 호출 */ }

@Profile("prod") @Component
class RealBankClient implements BankClient { /* 토스페이먼츠/Vietcombank 등 */ }
```

- 비즈니스 로직(`WalletService`)은 `BankClient`만 의존 → 구현체 교체 시 로직 무변경.
- 호출 base URL은 환경변수(`BANK_API_BASE_URL`)로 분리 → 학원/홈서버/실서비스 간 URL만 교체.
- mTLS 키스토어/트러스트스토어 경로도 환경변수로 분리.

---

## 7. 확정된 설계 결정

- **수수료는 은행이 떼지 않는다.** 환전 수수료·타행 이체 수수료는 모두 **본체(우리 앱)** 가 환전/송금 시점에 처리한다(`transactions.fee`). 은행 서버는 수수료 개념을 모르며, 요청받은 금액을 그대로 출금/지급한다.
- **강제 실패 시뮬레이션 엔드포인트는 두지 않는다.** 성공 경로 위주. (단, 잔액부족·계좌없음 등 자연 발생하는 실패는 정상적으로 에러 응답한다.)
- **mTLS는 토글 가능.** 환경변수 `TLS_ENABLED=true/false`로 켜고 끈다. 개발 초기에는 평문 HTTP로 흐름을 검증하고, 데모/발표 시 mTLS를 켠다. 코드는 양쪽 모두 지원한다.

---

*GlobalBridge 팀 내부 문서 | Mock 외부 은행 서버 API 명세 v1*
