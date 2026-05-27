#!/usr/bin/env bash
# ============================================================
# GlobalBridge Mock 은행 — mTLS 인증서 생성 스크립트
# ============================================================
# 셀프사인 CA를 만들고, 그 CA로 서버 인증서와 클라이언트(본체) 인증서를 발급한다.
# - 서버: 은행 서버가 자신을 증명 (server-cert.pem / server-key.pem)
# - 클라이언트: 본체(com.gb)가 자신을 증명 (client-cert.pem / client-key.pem)
# - CA: 양쪽이 상대를 검증할 때 사용 (ca-cert.pem)
#
# Windows: Git Bash에서 실행하세요. (openssl 포함됨)
# Mac/Linux: 그대로 실행.
#
# 사용법:
#   bash certs/generate-certs.sh            # 기본 (서버 CN=localhost)
#   bash certs/generate-certs.sh 192.168.0.50   # 홈서버 IP를 SAN에 추가
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

DAYS=825
SERVER_HOST="${1:-localhost}"   # 첫 인자로 서버 호스트/IP 지정 가능

echo "==> 서버 호스트(SAN): ${SERVER_HOST}"

# ---------- 1. CA (인증 기관) ----------
echo "==> [1/4] CA 생성"
openssl genrsa -out ca-key.pem 4096
openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days "${DAYS}" \
  -subj "/C=KR/O=GlobalBridge/CN=GlobalBridge-Mock-Bank-CA" \
  -out ca-cert.pem

# ---------- 2. 서버 인증서 ----------
echo "==> [2/4] 서버 인증서 생성"
openssl genrsa -out server-key.pem 4096
openssl req -new -key server-key.pem \
  -subj "/C=KR/O=GlobalBridge/CN=${SERVER_HOST}" \
  -out server.csr

cat > server-ext.cnf <<EOF
subjectAltName = DNS:localhost,DNS:${SERVER_HOST},IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF

openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out server-cert.pem -days "${DAYS}" -sha256 \
  -extfile server-ext.cnf

# ---------- 3. 클라이언트(본체) 인증서 ----------
echo "==> [3/4] 클라이언트(본체) 인증서 생성"
openssl genrsa -out client-key.pem 4096
openssl req -new -key client-key.pem \
  -subj "/C=KR/O=GlobalBridge/CN=globalbridge-backend" \
  -out client.csr

cat > client-ext.cnf <<EOF
extendedKeyUsage = clientAuth
EOF

openssl x509 -req -in client.csr -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out client-cert.pem -days "${DAYS}" -sha256 \
  -extfile client-ext.cnf

# ---------- 4. Spring용 변환 (PKCS12 keystore + truststore) ----------
echo "==> [4/4] Spring용 PKCS12 변환"
# 본체가 제시할 클라이언트 키스토어 (keystore.p12, 비번: changeit)
openssl pkcs12 -export \
  -in client-cert.pem -inkey client-key.pem \
  -name globalbridge-backend \
  -out client-keystore.p12 -passout pass:changeit

# 본체가 은행 서버를 검증할 트러스트스토어 (CA 포함)
keytool -importcert -noprompt \
  -alias mock-bank-ca \
  -file ca-cert.pem \
  -keystore truststore.p12 -storetype PKCS12 \
  -storepass changeit 2>/dev/null || \
  echo "   (keytool 없으면 ca-cert.pem 을 직접 트러스트스토어에 임포트하세요)"

# 정리
rm -f server.csr client.csr server-ext.cnf client-ext.cnf

echo ""
echo "==> 완료. 생성된 파일:"
echo "  [은행 서버용]  server-cert.pem  server-key.pem  ca-cert.pem"
echo "  [본체(Spring)] client-keystore.p12 (비번 changeit)  truststore.p12"
echo "  [본체(기타)]   client-cert.pem  client-key.pem  ca-cert.pem"
echo ""
echo "다음: .env 에서 TLS_ENABLED=true 로 바꾸고 'npm start'"
