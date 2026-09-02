// 딸깍 버그리포팅 — 사내 OpenAI 프록시 (의존성 없는 순수 Node)
//
// 실제 OpenAI API 키는 이 서버(호스트 PC)에만 두고, 팀원의 확장에는
// 서버 주소(base URL)와 '팀 접속 토큰'만 배포한다. 팀원은 실제 키를 볼 수 없다.
//
// 실행:  node proxy/openai-proxy.mjs   (또는 proxy/start-proxy.bat 더블클릭)
// 설정:  proxy/config.local.json  (proxy/config.example.json 복사해서 채움. git에 안 올라감)
//
// 팀원 확장 옵션 입력값:
//   - base URL : http://<이 PC의 사내 IP>:<port>/v1   (예: http://192.168.0.10:8770/v1)
//   - API 키   : config의 accessToken 값 (실제 OpenAI 키 아님)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** config.local.json → 없으면 환경변수 → 기본값 순으로 설정을 읽는다. */
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(HERE, 'config.local.json'), 'utf8'));
  } catch {
    /* 파일 없으면 환경변수로 대체 */
  }
  return {
    openaiKey: file.openaiKey || process.env.OPENAI_API_KEY || '',
    accessToken: file.accessToken || process.env.PROXY_ACCESS_TOKEN || '',
    port: Number(file.port || process.env.PROXY_PORT || 8770),
    upstream: (file.upstream || process.env.OPENAI_UPSTREAM || 'https://api.openai.com').replace(/\/+$/, ''),
  };
}

const cfg = loadConfig();

if (!cfg.openaiKey) {
  console.error('❌ OpenAI API 키가 없습니다. proxy/config.local.json 의 "openaiKey"를 채워주세요.');
  process.exit(1);
}
if (!cfg.accessToken) {
  console.warn('⚠️  accessToken이 비어 있습니다 — 네트워크의 누구나 이 프록시로 키를 쓸 수 있습니다. config에 토큰을 설정하는 것을 강력히 권장합니다.');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

/** 요청 Authorization의 토큰만 추출 (Bearer 접두어 허용). */
function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // 헬스체크
  if (req.url === '/' || req.url === '/health') {
    send(res, 200, { ok: true, service: '딸깍 OpenAI proxy' });
    return;
  }

  // 접속 토큰 검증 (설정된 경우에만)
  if (cfg.accessToken && bearer(req) !== cfg.accessToken) {
    send(res, 401, { error: { message: '접속 토큰이 올바르지 않습니다. 확장 옵션의 API 키(팀 접속 토큰)를 확인하세요.' } });
    return;
  }

  // 허용 경로만 (chat/completions, models 등 /v1/* 통과)
  if (!req.url.startsWith('/v1/')) {
    send(res, 404, { error: { message: '지원하지 않는 경로입니다.' } });
    return;
  }

  // 요청 본문 수집
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  try {
    // 업스트림(OpenAI)으로 그대로 전달하되, Authorization을 실제 키로 교체
    const upstreamRes = await fetch(cfg.upstream + req.url, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Authorization: `Bearer ${cfg.openaiKey}`,
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });

    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
      ...CORS,
    });
    res.end(text);
    console.log(`${new Date().toISOString()}  ${req.method} ${req.url} → ${upstreamRes.status}`);
  } catch (err) {
    console.error('업스트림 요청 실패:', err.message);
    send(res, 502, { error: { message: 'OpenAI 업스트림 연결 실패: ' + err.message } });
  }
});

server.listen(cfg.port, '0.0.0.0', () => {
  console.log('✅ 딸깍 OpenAI 프록시 실행 중');
  console.log(`   포트   : ${cfg.port} (0.0.0.0 — 사내망에서 접속 가능)`);
  console.log(`   업스트림: ${cfg.upstream}`);
  console.log(`   접속토큰: ${cfg.accessToken ? '설정됨 ✔' : '없음(권장: 설정)'}`);
  console.log('');
  console.log('   팀원 확장 옵션에 입력:');
  console.log(`     base URL : http://<이 PC 사내 IP>:${cfg.port}/v1`);
  console.log('     API 키   : (config의 accessToken 값)');
});
