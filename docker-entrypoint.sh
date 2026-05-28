#!/bin/sh
# 매 기동마다 시드 보장. seed.js 는 INSERT OR IGNORE 라 안전 —
# 기존 계좌 잔액·거래 원장은 건드리지 않고, 누락된 계좌만 채워 넣는다.
# (파일 존재 여부만 보는 방식은 "빈 스키마 DB"에 취약해서 폐기)

set -e

DB_FILE="${DB_PATH:-./data/bank.db}"
DB_DIR="$(dirname "$DB_FILE")"
mkdir -p "$DB_DIR"

echo "[entrypoint] 시드 보장: $DB_FILE"
node src/seed.js

exec node src/server.js
