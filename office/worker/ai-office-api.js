// 수학도서관 AI 교무실 전용 서버 (Cloudflare Worker: ai-office-api)
// - 교무실 화면(GitHub Pages)에서만 호출, 원장님 구글 계정으로 로그인한 경우만 허용
// - 학생 이름은 받지 않고, 단원·원인 집계만 받아 Claude가 의견을 씁니다
//
// Cloudflare 설정 (Worker > Settings > Variables and Secrets)
//   ANTHROPIC_API_KEY : (Secret) Claude API 키 — 원장님이 직접 입력
//   ALLOWED_EMAILS    : 허용할 구글 계정 이메일 (쉼표로 여러 개)
//   MODEL             : (선택) 사용할 Claude 모델, 기본 claude-sonnet-5-5

const PROJECT_ID = 'sudo-odap';
const ORIGINS = ['https://hongs-sudo.github.io'];
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache = { at: 0, keys: [] };

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Vary': 'Origin',
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, claude: !!env.ANTHROPIC_API_KEY, model: env.MODEL || 'claude-sonnet-5-5' });

    if (url.pathname === '/comment' && req.method === 'POST') {
      try {
        const user = await verify(req.headers.get('Authorization'), env);
        if (!user) return json({ error: '허용된 계정이 아닙니다.' }, 403);
        if (!env.ANTHROPIC_API_KEY) return json({ error: '서버에 Claude API 키가 아직 없습니다.' }, 500);
        const data = await req.json();
        const out = await comment(data, env);
        return json(out);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }
    return json({ error: 'not found' }, 404);
  },
};

// ---------- 구글(Firebase) 로그인 확인 ----------
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function jwks() {
  if (Date.now() - jwksCache.at < 3600e3 && jwksCache.keys.length) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  const j = await r.json();
  jwksCache = { at: Date.now(), keys: j.keys || [] };
  return jwksCache.keys;
}
async function verify(auth, env) {
  const token = String(auth || '').replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, p;
  try { header = JSON.parse(new TextDecoder().decode(b64url(parts[0]))); p = JSON.parse(new TextDecoder().decode(b64url(parts[1]))); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256') return null;
  if (p.aud !== PROJECT_ID || p.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return null;
  if (!p.sub || p.exp < now || p.iat > now + 300) return null;
  const jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const allowed = String(env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!p.email_verified || !allowed.includes(String(p.email || '').toLowerCase())) return null;
  return { uid: p.sub, email: p.email };
}

// ---------- Claude 의견 ----------
const SYSTEM = `당신은 1:1 맞춤 수학학원 '수학도서관'의 AI 교무실에서 일하는 '오답노트 담당' 직원입니다.
원장님께 학생 한 명의 오답 데이터를 보고드립니다.
- 정중하고 차분한 존댓말, 2~3문장, 220자 이내로 씁니다.
- 학생 이름은 쓰지 말고 '이 학생'이라고 합니다.
- 가장 많이 틀린 단원과, 원인 데이터가 있으면 가장 큰 원인을 근거로 짚고, 다음 수업에서 바로 할 수 있는 구체적인 지도 방법 하나를 제안합니다.
- 원인 데이터가 없거나 적으면 단원 위주로만 말하고, 원인을 추측하지 않습니다.
- 과장된 표현, 이모지, 머리말 없이 본문만 씁니다.`;

async function comment(d, env) {
  const units = (d.units || []).slice(0, 8).map((u) => `${String(u.unit).slice(0, 40)} ${Number(u.n) || 0}문항`).join(', ');
  const causes = (d.causes || []).filter((c) => c.n).map((c) => `${c.cause} ${c.n}문항(${c.pct}%)`).join(', ');
  const prompt = `학년: ${String(d.grade || '모름').slice(0, 10)}
전체 오답: ${Number(d.total) || 0}문항 (1차 오답노트 완료 ${Number(d.done) || 0}문항)
단원별 오답: ${units || '없음'}
원인이 체크된 문항: ${Number(d.causeCount) || 0}문항${causes ? ' — ' + causes : ''}
최근 2주 오답: ${Number(d.recent) || 0}문항`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.MODEL || 'claude-sonnet-5-5', max_tokens: 400, system: SYSTEM, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `Claude 요청 실패 (${r.status})`);
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  return { text, usage: j.usage || null, model: j.model };
}
