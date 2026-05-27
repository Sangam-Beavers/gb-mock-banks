'use strict';

require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const { getDb } = require('./db');
const routes = require('./routes');
const { ok, fail, BankError, readJsonBody, nowIso } = require('./util');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TLS_ENABLED = String(process.env.TLS_ENABLED || 'false').toLowerCase() === 'true';

// 라우트 테이블: "METHOD path" → handler(body, headers)
const ROUTES = {
  'POST /api/v1/bank/accounts/inquiry':       (b)    => routes.inquiry(b),
  'POST /api/v1/bank/accounts/verify':        (b)    => routes.verify(b),
  'POST /api/v1/bank/transfers/withdrawal':   (b, h) => routes.withdrawal(b, h),
  'POST /api/v1/bank/transfers/payout':       (b, h) => routes.payout(b, h),
};

function sendJson(res, http_status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(http_status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handler(req, res) {
  const url = (req.url || '').split('?')[0];
  const method = req.method || 'GET';

  // 헬스 체크
  if (method === 'GET' && url === '/health') {
    return sendJson(res, 200, ok({ status: 'UP', tls: TLS_ENABLED, time: nowIso() }, 'OK'));
  }

  // (UI 전용) 전체 계좌 목록 — 잔액 포함
  if (method === 'GET' && url === '/admin/accounts') {
    try {
      return sendJson(res, 200, routes.listAccounts());
    } catch (err) {
      console.error('[UNHANDLED]', err);
      return sendJson(res, 500, fail('BANK5000', '은행 서버 내부 오류입니다.'));
    }
  }

  // 정적 파일 (UI). GET만 처리.
  if (method === 'GET' && tryServeStatic(url, res)) return;

  const key = `${method} ${url}`;
  const route = ROUTES[key];

  if (!route) {
    return sendJson(res, 404, fail('BANK4040', '존재하지 않는 엔드포인트입니다.'));
  }

  try {
    const body = await readJsonBody(req);
    // 헤더 키는 Node가 소문자로 정규화함 → 'idempotency-key'
    const result = route(body, req.headers);
    return sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof BankError) {
      return sendJson(res, err.http, fail(err.code, err.message));
    }
    console.error('[UNHANDLED]', err);
    return sendJson(res, 500, fail('BANK5000', '은행 서버 내부 오류입니다.'));
  }
}

// path traversal 방지하면서 public/ 안의 파일을 반환. 매칭 안 되면 false.
function tryServeStatic(urlPath, res) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!resolved.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;

  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const data = fs.readFileSync(resolved);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(data);
  return true;
}

function start() {
  // DB 초기화 (스키마 생성)
  getDb();

  let server;
  if (TLS_ENABLED) {
    const opts = {
      key: fs.readFileSync(process.env.TLS_SERVER_KEY),
      cert: fs.readFileSync(process.env.TLS_SERVER_CERT),
      ca: fs.readFileSync(process.env.TLS_CA_CERT),
      // mTLS: 클라이언트(본체) 인증서 요구 + CA 검증
      requestCert: String(process.env.TLS_REQUEST_CLIENT_CERT || 'true').toLowerCase() === 'true',
      rejectUnauthorized: true,
    };
    server = https.createServer(opts, handler);
    server.listen(PORT, HOST, () => {
      console.log(`🔐 Mock 은행 서버 (mTLS) → https://${HOST}:${PORT}`);
      console.log(`   클라이언트 인증서 요구: ${opts.requestCert}`);
    });
  } else {
    server = http.createServer(handler);
    server.listen(PORT, HOST, () => {
      console.log(`🏦 Mock 은행 서버 (평문 HTTP) → http://${HOST}:${PORT}`);
      console.log('   ⚠️  TLS 꺼짐 — 개발용. 데모/발표 시 .env에서 TLS_ENABLED=true 로 변경하세요.');
    });
  }

  process.on('SIGINT', () => { console.log('\n종료합니다.'); process.exit(0); });
  return server;
}

if (require.main === module) start();
module.exports = { start, handler };
