# GlobalBridge — Mock 외부 은행 서버

실제 PG사·오픈뱅킹·해외 파트너 은행을 대체하는 **Mock 은행 서버**입니다. (Beaver Bank = 한국 / Quokka Bank = 해외)
GlobalBridge 본체(`com.gb.wallet`)가 이 서버를 HTTP로 호출해 **충전(출금)** 과 **현금화(지급)** 를 처리합니다.

> 📄 API 계약 전체는 [`API-SPEC.md`](./API-SPEC.md) 참고.
> 핵심 원칙: **두 장부 분리** (앱 포인트는 본체 MySQL, 외부 현금은 이 서버 SQLite). 서로의 DB를 절대 변경하지 않습니다.

---

## 1. 준비물

- **Node.js 18 이상** (`node -v` 로 확인)
- **openssl** (mTLS 인증서 생성용)
  - Windows: **Git Bash** 에서 실행 (Git 설치 시 포함)
  - Mac/Linux: 기본 내장

---

## 2. 셋업 (VS Code 터미널에서)

```bash
# 1) 의존성 설치
npm install

# 2) 환경 설정 파일 생성
cp .env.example .env      # Windows(cmd): copy .env.example .env

# 3) 시드 계좌 투입 (SQLite bank.db 생성됨)
npm run seed

# 4) 서버 실행
npm start
```

기본은 **평문 HTTP**(`TLS_ENABLED=false`)로 뜹니다. → `http://localhost:4000`

개발 중 자동 재시작이 필요하면 `npm run dev` (Node `--watch`).
시드를 초기화하고 다시 넣으려면 `npm run reset`.

---

## 3. mTLS 켜기 (데모/발표용)

```bash
# 1) 인증서 생성 (CA + 서버 + 클라이언트)
bash certs/generate-certs.sh
#   홈서버 IP를 쓸 경우:  bash certs/generate-certs.sh 192.168.0.50

# 2) .env 에서 토글 변경
#    TLS_ENABLED=true

# 3) 재실행
npm start          # → https://localhost:4000 (클라이언트 인증서 필수)
```

생성되는 인증서:
- **은행 서버용**: `server-cert.pem`, `server-key.pem`, `ca-cert.pem`
- **본체(Spring)용**: `client-keystore.p12`, `truststore.p12` (비밀번호 `changeit`)

> mTLS가 켜지면 클라이언트 인증서 없는 요청은 TLS 핸드셰이크 단계에서 거절됩니다.
> 개발 초기엔 `TLS_ENABLED=false` 로 흐름부터 검증하고, 데모 직전에 켜세요.

---

## 4. 동작 확인 (curl, 평문 HTTP 기준)

```bash
# 헬스 체크
curl http://localhost:4000/health

# ① 예금주 조회
curl -X POST http://localhost:4000/api/v1/bank/accounts/inquiry \
  -H 'Content-Type: application/json' \
  -d '{"bank_code":"SHINHAN","account_number":"110-234-567890"}'

# ② 계좌 인증 → account_token 받기
curl -X POST http://localhost:4000/api/v1/bank/accounts/verify \
  -H 'Content-Type: application/json' \
  -d '{"bank_code":"SHINHAN","account_number":"110-234-567890","holder_name":"WIN MAUNG"}'

# ③ 출금 (위에서 받은 account_token 사용) — 충전 재원
curl -X POST http://localhost:4000/api/v1/bank/transfers/withdrawal \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 11111111-1111-1111-1111-111111111111' \
  -d '{"account_token":"<위에서_받은_토큰>","amount":"100000","currency_code":"KRW"}'

# ④ 지급 — 현금화 (베트남 수취 계좌)
curl -X POST http://localhost:4000/api/v1/bank/transfers/payout \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 22222222-2222-2222-2222-222222222222' \
  -d '{"bank_code":"QUOKKA","account_number":"VN-9001-4455","amount":"18250000","currency_code":"VND"}'
```

mTLS 켠 경우 curl 에 인증서 옵션 추가:
```bash
curl --cacert certs/ca-cert.pem \
     --cert certs/client-cert.pem --key certs/client-key.pem \
     https://localhost:4000/health
```

---

## 5. 시드 계좌

| 은행 | 계좌번호 | 예금주 | 통화 | 잔액 | 용도 |
| --- | --- | --- | --- | --- | --- |
| SHINHAN | 110-234-567890 | WIN MAUNG | KRW | 5,000,000 | 한국→해외 충전 재원 |
| WOORI | 1002-345-678901 | NGUYEN VAN A | KRW | 3,200,000 | 한국→해외 충전 재원 |
| KB | 404-21-987654 | JUAN DELA CRUZ | KRW | 150,000 | 잔액부족 시연용 |
| QUOKKA | VN-9001-4455 | TRAN THI GIA DINH | VND | 0 | 베트남 수취 (현금화 대상) |
| QUOKKA | PH-7700-1234 | MARIA SANTOS | PHP | 0 | 필리핀 수취 |
| QUOKKA | US-3300-8899 | DAVID KIM | USD | 0 | 미국 수취 |
| QUOKKA | VN-2200-0011 | LE VAN B | VND | 50,000,000 | 해외→한국 충전 재원(역방향) |
| BEAVER | BV-1000-7788 | KIM CHEOL SU | KRW | 0 | 해외→한국 수취(역방향) |

---

## 6. 데모 시나리오 (한국 → 베트남)

발표 때 **물리적으로 다른 서버(홈서버)의 은행 잔액이 실시간으로 움직이는 것**을 보여주는 게 핵심입니다.

```
① 한국 사용자가 신한계좌에서 10만원 충전
   → 은행 서버: 신한계좌 500만 → 490만  (③ 출금)  ★ 잔액 줄어듦
   → 본체: 주머니 +10만 P

② 본체에서 KRW → VND 환전 (환율은 본체가 계산, 은행 호출 없음)

③ 베트남 가족(앱 고객2)에게 앱 내 송금 → 본체 내부 포인트 이동 (은행 호출 없음)

④ 고객2가 본국 Quokka 계좌로 현금화
   → 본체: 주머니 VND 소멸
   → 은행 서버: VN-9001 계좌 0 → 1825만 VND  (④ 지급)  ★ 잔액 늘어남

"역방향(베트남→한국)도 동일한 출금/지급 구조로 동작합니다."
```

---

## 7. 폴더 구조

```
mock-bank/
├── API-SPEC.md          ← API 계약 (정본)
├── README.md            ← 이 문서
├── package.json
├── .env.example
├── certs/
│   └── generate-certs.sh   ← mTLS 인증서 생성
├── src/
│   ├── server.js        ← TLS 토글 서버 + 라우팅
│   ├── routes.js        ← inquiry/verify/withdrawal/payout
│   ├── db.js            ← SQLite 스키마
│   ├── money.js         ← string 십진수 금액 연산
│   ├── util.js          ← UUID/시각/응답래퍼/에러
│   └── seed.js          ← 시드 투입
└── data/
    ├── seed.json        ← 시드 계좌 정의
    └── bank.db          ← (자동 생성) 은행 장부
```

---

## 8. 본체(Spring) 연동 요약

본체는 `BankClient` 인터페이스에만 의존하고, 구현체(`MockBankClient` / 실서비스 `RealBankClient`)를 Profile로 교체합니다. 호출 base URL은 환경변수 `BANK_API_BASE_URL` 로 분리하세요. 자세한 계약·필드는 [`API-SPEC.md`](./API-SPEC.md) §6 참고.
