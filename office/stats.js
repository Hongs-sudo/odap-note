// AI 교무실 — 현황판 카드 숫자 (각 앱 데이터를 읽기만 함)
// 교무실과 같은 주소(hongs-sudo.github.io)의 앱은 이 브라우저에 남아 있는 각 앱의 로그인을 그대로 빌려
// Firestore를 읽기 전용(REST 조회)으로 읽습니다. 쓰기·수정은 하지 않습니다.

const FB = {
  naesin: { apiKey: 'AIzaSyCkLTkcgzVqVYVAq2qCnbq7HHKbggUo9PQ', projectId: 'sudo-naesin' },
  suhaeng: { apiKey: 'AIzaSyBDAqrnCpQ7dif-mqI4UMFapYB5t75f6nU', projectId: 'sudo-suhaeng' },
  weekly: { apiKey: 'AIzaSyDM2dCFlxEdbKvrmhJC_ipBkD31Nxa1FDE', projectId: 'mathlibrary-bd75b' },
  onemm: { apiKey: 'AIzaSyB6fL3WsiCqG8pJn9QqFfFvWFXFFu0dzO4', projectId: 'mathlibrary-1mm' },
  early: { apiKey: 'AIzaSyCHTsFIv1RaQB6fEvjP_oxHGJJr0ululC0', projectId: 'sudo-earlyadopter' },
  minutes: { apiKey: 'AIzaSyAnfqK1Ij6SQBssAW_GtMg47wNNRpDvHUo', projectId: 'sudo-proceedings' },
  // 다른 주소의 앱 2개 — 교무실에서 한 번 로그인(connect.js)하면 읽을 수 있음
  roadmap: { apiKey: 'AIzaSyBuQ02C_vNciOA4lxwUzhcwYcrAV3FgpIs', projectId: 'sudo-roadmap', authDomain: 'sudo-roadmap.firebaseapp.com', other: true },
  planner: { apiKey: 'AIzaSyCJzfPGi5v5Xs6IJW3MuZRwbtRSwFbYHbA', projectId: 'sudoplanner', authDomain: 'sudoplanner.firebaseapp.com', other: true },
};
export const OTHER_FB = { roadmap: FB.roadmap, planner: FB.planner };

// ---------- 날짜 ----------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const strip = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

// ---------- 각 앱의 로그인 정보 (이 브라우저에 저장된 것) ----------
async function savedUsers() {
  const out = [];
  try {
    const db = await new Promise((ok, no) => { const r = indexedDB.open('firebaseLocalStorageDb'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); r.onupgradeneeded = () => r.transaction.abort(); });
    if (db.objectStoreNames.contains('firebaseLocalStorage')) {
      const rows = await new Promise((ok, no) => { const r = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      rows.forEach((x) => out.push([x.fbase_key, x.value]));
    }
    db.close();
  } catch { /* 저장소 없음 */ }
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('firebase:authUser:')) out.push([k, JSON.parse(localStorage.getItem(k))]); } } catch { /* 없음 */ }
  return out;
}
async function tokenFor(cfg, users) {
  const hit = users.find(([k, v]) => k.startsWith(`firebase:authUser:${cfg.apiKey}:`) && v && !v.isAnonymous && v.stsTokenManager);
  if (!hit) return null;
  const t = hit[1].stsTokenManager;
  if (t.accessToken && t.expirationTime - Date.now() > 120e3) return t.accessToken;
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${cfg.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(t.refreshToken)}` });
  if (!r.ok) return null;
  return (await r.json()).id_token || null;
}

// ---------- Firestore 읽기 (REST, 읽기 전용) ----------
function val(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('mapValue' in v) return obj(v.mapValue.fields);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  return null;
}
const obj = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)]));
async function list(cfg, token, path, mask) {
  const docs = []; let page = '';
  for (let i = 0; i < 30; i++) {
    const q = new URLSearchParams({ pageSize: '300' }); if (page) q.set('pageToken', page);
    (mask || []).forEach((m) => q.append('mask.fieldPaths', m));
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/${path}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(r.status === 403 ? '읽기 권한 없음' : `읽기 실패 (${r.status})`);
    const j = await r.json();
    (j.documents || []).forEach((d) => docs.push({ id: decodeURIComponent(d.name.split('/').pop()), ...obj(d.fields) }));
    if (!j.nextPageToken) break; page = j.nextPageToken;
  }
  return docs;
}

// ---------- 앱별 숫자 ----------
// 돌려주는 값: [{ k: '이름', v: '값' }, …]
const CALC = {
  async naesin(c, t) {
    const exams = await list(c, t, 'exams', ['school']);
    const an = await list(c, t, 'analyses', ['status']);
    return [{ k: '보관 시험지', v: `${exams.length}건` }, { k: '학교', v: `${new Set(exams.map((e) => e.school).filter(Boolean)).size}곳` }, { k: '분석 완료', v: `${an.filter((a) => a.status !== 'ai').length}건` }];
  },
  async suhaeng(c, t) {
    const st = await list(c, t, 'students', ['status']);
    const rec = await list(c, t, 'programs/suhaeng/records', ['rounds']);
    const scored = rec.reduce((a, r) => a + Object.values(r.rounds || {}).filter((x) => x && typeof x.score === 'number' && x.status !== '결시' && !x.aiScore).length, 0);
    return [{ k: '재원 학생', v: `${st.filter((s) => s.status === '재원').length}명` }, { k: '입력된 점수', v: `${scored}회` }];
  },
  async weekly(c, t) {
    const docs = await list(c, t, 'students', ['updatedAt']);
    const ws = weekStart();
    return [{ k: '전체 보고서', v: `${docs.length}건` }, { k: '이번 주 작성·수정', v: `${docs.filter((d) => (d.updatedAt || 0) >= ws).length}건` }];
  },
  async onemm(c, t) {
    const r = await list(c, t, 'reports', ['status']);
    const n = (s) => r.filter((x) => x.status === s).length;
    return [{ k: '전체', v: `${r.length}건` }, { k: '작성 중', v: `${n('draft')}건` }, { k: '완료', v: `${n('done')}건` }, { k: '상담 끝', v: `${n('consulted')}건` }];
  },
  async early(c, t) {
    const st = await list(c, t, 'students', ['records']);
    const recs = st.flatMap((s) => s.records || []);
    const today = ymd();
    const wait = recs.filter((x) => x && x.sch && x.score == null && (!x.isoDate || x.isoDate <= today)).length;
    return [{ k: '점수 입력', v: `${recs.filter((x) => x && x.score != null).length}/${st.length * 6}` }, { k: '입력 대기', v: `${wait}건` }];
  },
  async roadmap(c, t) {
    const st = await list(c, t, 'students', ['updatedAt', 'createdAt', 'name']);
    const ws = weekStart(); const at = (x) => (typeof x === 'number' ? x : Date.parse(x || '') || 0);
    const last = Math.max(0, ...st.map((x) => at(x.updatedAt)));
    const items = [{ k: '학생', v: `${st.length}명` }, { k: '이번 주 수정', v: `${st.filter((x) => at(x.updatedAt) >= ws).length}명` }];
    if (last) { const d = new Date(last); items.push({ k: '최근 수정', v: `${d.getMonth() + 1}.${pad(d.getDate())}` }); }
    return items;
  },
  async planner(c, t) {
    // 학생 명단: roll/meta.students, 플래너: entries 문서 이름 'planner:이름:날짜'
    const meta = (await list(c, t, 'workspaces/sudo/roll', ['students'])).find((d) => d.id === 'meta');
    const ent = await list(c, t, 'workspaces/sudo/entries', ['updatedAt']);
    const pl = ent.map((d) => d.id.split(':')).filter((x) => x[0] === 'planner' && x[2]);
    const last = pl.map((x) => x[2]).sort().pop();
    const items = [{ k: '스터디그룹 학생', v: `${(meta?.students || []).length}명` }];
    if (last) items.push({ k: `최근 플래너 (${last.slice(5).replace('-', '.')})`, v: `${new Set(pl.filter((x) => x[2] === last).map((x) => x[1])).size}명` });
    items.push({ k: '플래너 쓴 학생', v: `${new Set(pl.map((x) => x[1])).size}명` });
    return items;
  },
  async minutes(c, t) {
    const m = await list(c, t, 'minutes', ['date', 'label']);
    const last = m.filter((x) => x.date && x.date <= ymd()).sort((a, b) => b.date.localeCompare(a.date))[0];
    return [{ k: '회의록', v: `${m.length}건` }, { k: '최근 회의', v: last ? `${last.date.slice(5).replace('-', '.')} ${strip(last.label)}` : '없음' }];
  },
};

// 데일리 리포트: 원장님 기록은 데일리 리포트 앱이 깃허브 보관 파일에 맞춰 둠 → 그 파일을 읽기만 함
// (깃허브 연결은 데일리 리포트 앱에서 설정한 것을 그대로 씀. 없으면 이 브라우저 기록으로)
async function dailyData() {
  let cfg = {}; try { cfg = JSON.parse(localStorage.getItem('dailyreport.sync') || '{}'); } catch { /* 없음 */ }
  const token = localStorage.getItem('dailyreport.token');
  if (cfg.repo && token) {
    try {
      const repo = cfg.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/|\/$/g, '');
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(cfg.path || '데일리리포트_데이터.json')}?t=${Date.now()}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' }, cache: 'no-store' });
      if (r.ok) return { D: JSON.parse(await r.text()), src: '깃허브 보관 파일' };
    } catch { /* 이 브라우저 기록으로 */ }
  }
  let D; try { D = JSON.parse(localStorage.getItem('dailyreport.v1') || 'null'); } catch { D = null; }
  return { D, src: '이 브라우저 기록' };
}
async function daily() {
  const { D, src } = await dailyData();
  if (!D || !Array.isArray(D.records)) return { state: 'login', msg: '이 브라우저에서 데일리 리포트를 한 번 열면 숫자가 보여요' };
  const today = ymd();
  const recs = D.records.filter((r) => r.date === today);
  const links = D.links || [];
  const unsent = recs.filter((r) => !links.some((x) => x.recId === r.id && x.kind === 'parent')).length;
  return { state: 'ok', src, items: [{ k: '재원 학생', v: `${(D.students || []).filter((s) => s.active !== false).length}명` }, { k: '오늘 기록', v: `${new Set(recs.map((r) => r.studentId)).size}명` }, { k: '오늘 미발송', v: `${unsent}건` }] };
}

// 결과: { [앱id]: { state: 'ok'|'login'|'error'|'other', items?, msg? } }
export async function loadStats() {
  const users = await savedUsers();
  const out = { daily: await daily() };
  await Promise.all(Object.entries(FB).map(async ([id, cfg]) => {
    try {
      const t = await tokenFor(cfg, users);
      if (!t) { out[id] = cfg.other ? { state: 'connect', msg: '교무실에서 한 번 연결하면 숫자가 보여요' } : { state: 'login', msg: '앱 창에서 한 번 로그인하면 숫자가 보여요' }; return; }
      out[id] = { state: 'ok', items: await CALC[id](cfg, t) };
    } catch (e) { out[id] = { state: 'error', msg: `숫자를 불러오지 못했어요 (${e.message})` }; }
  }));
  return out;
}
