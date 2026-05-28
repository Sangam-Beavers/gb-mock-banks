# syntax=docker/dockerfile:1.7

# ---- Builder: better-sqlite3 네이티브 모듈 컴파일 ----
FROM --platform=linux/amd64 node:20-slim AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime: 가벼운 실행 이미지 ----
FROM --platform=linux/amd64 node:20-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# 시드 데이터(seed.json 등)는 이미지에 굽는다. 실제 DB는 entrypoint가 첫 기동 시 생성.
COPY data ./data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4000

# /health 엔드포인트 헬스체크 (Node 20 내장 fetch 사용 — 추가 패키지 불필요)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
