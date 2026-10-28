// AI 교무실 — 프로젝트 현황판 · 앱 창 (앱 10개를 교무실 안에서 열기)
import { TEAMS, APPS, teamOf, sameSite } from './projects.js';
import { loadStats } from './stats.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 안 됨 */ } } };
const md = (t) => { const d = new Date(t); return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}`; };

const H = { team: null, app: store.get('office.app', null), big: false, commits: store.get('office.commits', null), stats: store.get('office.stats', null), odap: null, loading: false };

// ---------- 팀 고르기 ----------
function chips() {
  const all = [{ id: null, name: `전체 ${APPS.length}` }, ...TEAMS.map((t) => ({ id: t.id, name: `${t.name} ${APPS.filter((a) => a.team === t.id).length}` }))];
  $('#teamChips').innerHTML = all.map((c) => `<button type="button" class="chip ${H.team === c.id ? 'on' : ''}" data-chip="${c.id ?? ''}" aria-pressed="${H.team === c.id}">${esc(c.name)}</button>`).join('');
  $('#teamChips').querySelectorAll('[data-chip]').forEach((b) => b.onclick = () => setTeam(b.dataset.chip || null));
}
function setTeam(id) {
  H.team = id; chips(); cards();
  const t = id && teamOf(id);
  $('#boardFilter').textContent = t ? `· ${t.name} (${t.desc})` : `· 전체 ${APPS.length}개`;
  document.querySelectorAll('.name[data-team]').forEach((b) => b.classList.toggle('picked', b.dataset.team === id));
}
document.querySelectorAll('.name[data-team]').forEach((b) => b.addEventListener('click', () => {
  setTeam(H.team === b.dataset.team ? null : b.dataset.team);
  $('#board').scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

// ---------- 현황판 카드 ----------
function lastOf(app) { const c = H.commits?.data?.[app.repo]; return c ? md(c.at) : null; }
function cards() {
  const list = APPS.filter((a) => !H.team || a.team === H.team);
  $('#cards').innerHTML = list.map((a) => {
    const t = teamOf(a.team); const last = lastOf(a);
    return `<article class="pcard ${H.app === a.id ? 'open' : ''}">
      <div class="row between" style="align-items:flex-start">
        <div class="row" style="gap:10px;align-items:center;min-width:0">
          <span class="appicon" style="background:${a.color}" aria-hidden="true">${esc(a.icon)}</span>
          <div style="min-width:0"><div class="eyebrow small" style="letter-spacing:1px">${esc(t.name)}</div><h3>${esc(a.name)}</h3></div>
        </div>
        ${a.parent ? '<span class="badge soft">학부모 발송</span>' : ''}
      </div>
      <p class="pdesc">${esc(a.desc)}</p>
      ${metrics(a.id)}
      <div class="row between small muted">
        <span>${last ? `최근 수정 ${last}` : a.repo ? '최근 수정 확인 중' : '깃허브 밖에서 운영'}</span>
        <span>${sameSite(a.url) ? '교무실과 같은 주소' : '다른 주소 (새 창 권장)'}</span>
      </div>
      <div class="row" style="gap:8px">
        <button type="button" class="primary sm" data-open="${a.id}">교무실에서 열기</button>
        <a class="ghost" href="${esc(a.url)}" target="_blank" rel="noopener">새 창 ↗</a>
      </div>
    </article>`;
  }).join('');
  $('#cards').querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openApp(b.dataset.open, true));
}

// ---------- 카드 숫자 (각 앱 데이터를 읽기만) ----------
function metrics(id) {
  if (id === 'odap') {
    const o = H.odap;
    return o ? chipsOf([{ k: '오답노트 대기', v: `${o.pending}명` }, { k: '남은 문항', v: `${o.left}` }, { k: '이번 주 만든 노트', v: `${o.sheets}개` }]) : '<p class="mnote">숫자를 불러오는 중…</p>';
  }
  const m = H.stats?.data?.[id];
  if (!m) return `<p class="mnote">${H.loading ? '숫자를 불러오는 중…' : '숫자 없음'}</p>`;
  if (m.state === 'ok') return chipsOf(m.items);
  return `<p class="mnote ${m.state === 'error' ? 'err' : ''}">${esc(m.msg)}</p>`;
}
const chipsOf = (items) => `<div class="metrics">${items.map((x) => `<div class="metric"><span>${esc(x.k)}</span><b>${esc(x.v)}</b></div>`).join('')}</div>`;
async function refreshStats() {
  if (H.loading) return; H.loading = true; drawStatsAt(); cards();
  try { const data = await loadStats(); H.stats = { at: Date.now(), data }; store.set('office.stats', H.stats); } catch { /* 다음에 다시 */ }
  H.loading = false; drawStatsAt(); cards();
}
function drawStatsAt() {
  const t = H.stats?.at ? new Date(H.stats.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  $('#statsAt').textContent = H.loading ? '숫자 불러오는 중…' : t ? `${t} 기준` : '';
}
$('#statsBtn').onclick = refreshStats;
window.addEventListener('office:odap', (e) => { H.odap = e.detail; cards(); });

// ---------- 앱 창 ----------
function tabs() {
  $('#appTabs').innerHTML = APPS.map((a) => `<button type="button" role="tab" aria-selected="${H.app === a.id}" class="${H.app === a.id ? 'on' : ''}" data-tab-app="${a.id}">${esc(a.name)}</button>`).join('');
  $('#appTabs').querySelectorAll('[data-tab-app]').forEach((b) => b.onclick = () => openApp(b.dataset.tabApp, false));
}
function openApp(id, scroll) {
  const a = APPS.find((x) => x.id === id); if (!a) return;
  H.app = id; store.set('office.app', id);
  const f = $('#appFrame');
  if (f.dataset.app !== id) { f.src = a.url; f.dataset.app = id; }
  $('#appEmpty').hidden = true;
  $('#appTitle').textContent = a.name;
  $('#appNew').href = a.url;
  $('#appNote').textContent = sameSite(a.url)
    ? `${teamOf(a.team).name} · 이 브라우저에서 이 앱에 한 번 로그인했다면 그대로 이어져요. 처음이면 창 안에서 한 번 로그인해 주세요.`
    : `${teamOf(a.team).name} · 다른 주소의 앱이라 이 창 안에서 처음 한 번 로그인이 필요해요. 로그인이 안 되면 '새 창으로'를 눌러 주세요.`;
  tabs(); cards();
  if (scroll) $('#appWin').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#appReload').onclick = () => { const f = $('#appFrame'); if (f.src) f.src = f.src; };
$('#appBig').onclick = () => setBig(!H.big);
function setBig(on) {
  H.big = on; $('#appWin').classList.toggle('big', on);
  $('#appBig').setAttribute('aria-pressed', String(on)); $('#appBig').textContent = on ? '작게 보기' : '크게 보기';
  document.body.style.overflow = on ? 'hidden' : '';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && H.big) setBig(false); });

// ---------- 최근 앱 수정 기록 (깃허브, 1시간마다 새로) ----------
async function loadCommits() {
  if (H.commits && Date.now() - H.commits.at < 3600e3) return drawCommits();
  const data = {}; const feed = [];
  await Promise.all(APPS.filter((a) => a.repo).map(async (a) => {
    try {
      const r = await fetch(`https://api.github.com/repos/Hongs-sudo/${a.repo}/commits?per_page=3`);
      if (!r.ok) return;
      const list = await r.json();
      list.forEach((c, i) => {
        const at = Date.parse(c.commit.author.date); const msg = (c.commit.message || '').split('\n')[0];
        if (i === 0) data[a.repo] = { at, msg };
        feed.push({ app: a.name, at, msg });
      });
    } catch { /* 다음에 다시 */ }
  }));
  if (Object.keys(data).length) { H.commits = { at: Date.now(), data, feed: feed.sort((x, y) => y.at - x.at).slice(0, 12) }; store.set('office.commits', H.commits); }
  drawCommits(); cards();
}
function drawCommits() {
  const f = H.commits?.feed || [];
  $('#commits').innerHTML = f.length ? f.map((c) => `<li><time>${md(c.at)}</time><span><b>${esc(c.app)}</b> ${esc(c.msg.length > 46 ? c.msg.slice(0, 46) + '…' : c.msg)}</span></li>`).join('') : '<li class="muted">수정 기록을 불러오지 못했어요</li>';
}

chips(); cards(); tabs(); drawStatsAt();
loadCommits();
refreshStats(); setInterval(refreshStats, 10 * 60e3);
