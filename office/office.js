// 수학도서관 AI 교무실 — 오답노트 담당 (오답노트 프로그램 데이터와 연결)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, doc, getDoc, getDocsFromServer, collection, query, where, orderBy, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { FIREBASE_CONFIG } from '../config.js';
import { pendingList, weakness, newRecords, queueSummary } from './logic.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 안 됨 */ } } };

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
// 일부 브라우저(앱 내장 브라우저, 회사·학원 네트워크)는 실시간 연결을 끊으므로 롱폴링 방식으로 연결
const db = initializeFirestore(app, { experimentalForceLongPolling: true });

const S = { aid: null, role: null, uid: null, students: [], queue: [], usage: null, tab: 'todo', weakSid: null, unsub: [], first: true, busy: false };

// ---------- Claude 의견 (교무실 전용 서버) ----------
const OFFICE_API = 'https://ai-office-api.ilmvm66.workers.dev';
const AI_KEY = 'office.aiComments';
const aiCache = store.get(AI_KEY, {});
const sig = (w) => [w.total, w.done, w.causeCount, w.units.slice(0, 5).map((u) => u.unit + u.n).join('|')].join('/');
function cachedAi(st, w) { const c = aiCache[st.id]; return c && c.sig === sig(w) ? c : null; }
async function askClaude(st, w) {
  const hit = cachedAi(st, w); if (hit) return hit.text;
  const token = await auth.currentUser.getIdToken();
  const body = { grade: st.grade || '', total: w.total, done: w.done, recent: w.recent, causeCount: w.causeCount, units: w.units.slice(0, 8), causes: w.causes };
  const res = await fetch(OFFICE_API + '/comment', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.text) throw new Error(j.error || `요청 실패 (${res.status})`);
  const text = j.text.replace('이 학생', `${st.name || '이'} 학생`);
  aiCache[st.id] = { sig: sig(w), text, at: Date.now() }; store.set(AI_KEY, aiCache);
  return text;
}

// ---------- 시계 ----------
const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }); };
tick(); setInterval(tick, 20000);

// ---------- 칠판 자동 전환 ----------
const BOARDS = ['피타고라스 정리', '삼각형 내각의 합', '중점연결정리', '원주각과 중심각'];
{
  const box = $('#chalk');
  BOARDS.forEach((_, i) => { const im = new Image(); im.src = `assets/chalk${i + 1}.jpg`; im.alt = ''; if (i === 0) im.className = 'on'; box.appendChild(im); });
  let cur = 0;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!still) setInterval(() => {
    const imgs = box.querySelectorAll('img'); imgs[cur].classList.remove('on');
    cur = (cur + 1) % BOARDS.length; imgs[cur].classList.add('on');
    $('#chalkName span:last-child').textContent = `오늘의 칠판 · ${BOARDS[cur]}`;
  }, 6000);
}

// ---------- 음성 안내 ----------
const voice = { on: store.get('office.voice', false), v: null };
function pickVoice() {
  const vs = (window.speechSynthesis?.getVoices() || []).filter((v) => v.lang?.startsWith('ko'));
  voice.v = vs.find((v) => /InJoon|인준/i.test(v.name)) || vs.find((v) => /Heami|해미/i.test(v.name)) || vs[0] || null;
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text) {
  if (!voice.on || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text); u.lang = 'ko-KR'; if (voice.v) u.voice = voice.v; u.rate = 1.05;
  speechSynthesis.speak(u);
}
const drawVoice = () => { $('#voiceBtn').setAttribute('aria-pressed', String(voice.on)); $('#voiceBtn').textContent = voice.on ? '음성 안내 켜짐' : '음성 안내 켜기'; };
drawVoice();
$('#voiceBtn').onclick = () => { voice.on = !voice.on; store.set('office.voice', voice.on); drawVoice(); if (voice.on) say('음성 안내를 켰습니다.'); else speechSynthesis?.cancel(); };

// ---------- 활동 기록 ----------
const LOG_KEY = 'office.log';
const logs = store.get(LOG_KEY, []);
function log(who, text, me = false, at = Date.now()) {
  logs.unshift({ at, who, text, me }); logs.splice(40);
  store.set(LOG_KEY, logs); drawLog();
}
function drawLog() {
  $('#log').innerHTML = logs.length ? logs.map((l) => `<li><time>${hm(l.at)}</time><span><b class="${l.me ? 'me' : ''}">${esc(l.who)}</b> ${esc(l.text)}</span></li>`).join('') : '<li class="muted">아직 기록이 없어요</li>';
}
drawLog();

// ---------- 직원 말풍선·상태 ----------
function staff(status, bubble, alert = false) {
  const t = $('#tag1'); const b = $('#bubble1');
  t.className = 'name ' + (status === 'todo' ? 'todo' : 'on');
  t.textContent = `학습관리팀 · ${status === 'todo' ? '오답노트 할 일 있음' : status === 'work' ? '작업 중' : '앱 4개'}`;
  b.textContent = bubble; b.classList.toggle('alert', alert);
}

// ---------- 로그인·연결 ----------
$('#loginBtn').onclick = async () => {
  const p = new GoogleAuthProvider();
  try { await signInWithPopup(auth, p); } catch (e) { if (String(e.code).includes('popup')) await signInWithRedirect(auth, p); else $('#loginMsg').textContent = e.message; }
};
$('#logoutBtn').onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  S.unsub.forEach((u) => u()); S.unsub = [];
  $('#logoutBtn').hidden = !user;
  if (!user) { $('#login').hidden = false; conn('로그인 필요', true); return; }
  $('#login').hidden = true; S.uid = user.uid;
  try {
    const me = await getDoc(doc(db, 'users', user.uid));
    S.aid = me.data()?.academyId;
    if (!S.aid) return fail('오답노트 프로그램에서 학원 설정을 먼저 마쳐 주세요.');
    const mem = await getDoc(doc(db, 'academies', S.aid, 'members', user.uid));
    if (!mem.exists()) return fail('이 학원의 구성원으로 등록되지 않은 계정입니다.');
    S.role = mem.data().role;
  } catch (e) { return fail('데이터에 연결하지 못했어요: ' + e.message); }
  conn('오답노트 데이터 연결됨');
  listen();
});
function conn(text, warn = false) { const p = $('#connPill'); p.textContent = (warn ? '' : '● ') + text; p.classList.toggle('warn', warn); }
function fail(msg) { conn('연결 안 됨', true); staff('idle', msg, true); $('#tabBody').innerHTML = `<p class="empty">${esc(msg)}</p>`; }

function listen() {
  const col = (n) => collection(db, 'academies', S.aid, n);
  const sq = S.role === 'owner' ? query(col('students'), orderBy('name')) : query(col('students'), where('teacherUid', '==', S.uid), orderBy('name'));
  S.unsub.push(onSnapshot(sq, (snap) => {
    if (snap.metadata.fromCache && snap.empty) return; // 아직 서버 응답 전: 빈 화면으로 덮지 않음
    S.students = snap.docs.map((d) => ({ id: d.id, ...d.data() })); onStudents();
  }, (e) => fail('학생 정보를 읽지 못했어요: ' + e.message)));
  // 실시간 연결이 막혀도 1분마다 서버에서 다시 읽어 옴
  const pull = async () => { try { const snap = await getDocsFromServer(sq); S.students = snap.docs.map((d) => ({ id: d.id, ...d.data() })); onStudents(); } catch { /* 다음에 다시 */ } };
  pull(); const t = setInterval(pull, 60000); S.unsub.push(() => clearInterval(t));
  S.unsub.push(onSnapshot(query(col('analysisQueue'), where('status', 'in', ['queued', 'error', 'waiting-folder'])), (snap) => { S.queue = snap.docs.map((d) => ({ id: d.id, ...d.data() })); drawStats(); if (S.tab === 'queue') drawTab(); }, () => {}));
  const day = new Date().toISOString().slice(0, 10);
  S.unsub.push(onSnapshot(doc(db, 'academies', S.aid, 'aiUsage', day), (d) => { S.usage = d.data() || null; if (S.tab === 'queue') drawTab(); }, () => {}));
}

// ---------- 새 오답 감지 ----------
const SEEN_KEY = 'office.seenAt';
function onStudents() {
  const since = store.get(SEEN_KEY, Date.now() - 24 * 3600e3);
  const fresh = newRecords(S.students, since);
  if (fresh.length) {
    fresh.forEach((r) => log('오답노트 담당', `${r.name}(${r.grade}) · ${r.title} · 오답 ${r.n}개 입력됨`, false, r.at));
    const last = fresh[fresh.length - 1];
    const msg = fresh.length === 1 ? `${last.name} 학생 오답 ${last.n}개가 입력됐어요. 오답노트 대기 목록에 넣어 둘게요.` : `새 오답 기록 ${fresh.length}건이 들어왔어요. 대기 목록에 정리해 둘게요.`;
    if (!S.first) say(msg.replace(/\(.*?\)/g, ''));
    store.set(SEEN_KEY, Math.max(...fresh.map((r) => r.at)));
  } else if (S.first) store.set(SEEN_KEY, Math.max(since, Date.now() - 24 * 3600e3));
  S.first = false;
  drawStats(); drawStaff(); drawStudentSelect(); drawTab();
}

function drawStats() {
  const pend = pendingList(S.students);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = newRecords(S.students, start.getTime()).reduce((a, r) => a + r.n, 0);
  $('#stToday').textContent = today;
  $('#stPending').innerHTML = `${pend.length}<small class="muted" style="font-size:13px;font-weight:400"> 명</small>`;
  $('#stLeft').textContent = pend.reduce((a, p) => a + p.left, 0);
  $('#stErr').textContent = queueSummary(S.queue).error;
}
function drawStaff() {
  if (S.busy) return;
  const pend = pendingList(S.students);
  const glow = document.querySelector('.glow.gold');
  if (pend.length) {
    const top = pend[0];
    staff('todo', `오답노트 만들 학생이 ${pend.length}명 있어요. ${top.name} 학생이 ${top.left}문항으로 가장 많아요.`);
    glow.classList.add('pulse');
  } else {
    staff('done', '대기 중인 오답이 없어요. 새 오답이 들어오면 바로 알려 드릴게요.');
    glow.classList.remove('pulse');
  }
}

// ---------- 오답노트 담당 패널 ----------
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => setTab(b.dataset.tab));
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  drawTab();
}
function drawTab() {
  const body = $('#tabBody');
  if (!S.aid) return;
  if (S.tab === 'todo') {
    const pend = pendingList(S.students);
    body.innerHTML = pend.length ? `<p class="muted small">오답은 입력됐지만 1차 오답노트에 아직 들어가지 않은 문항이 있는 학생이에요.</p>
      <ul class="list">${pend.map((p) => `<li><div><b>${esc(p.name)}</b> <span class="muted small">${esc(p.grade)}</span><div class="muted small">${esc(p.books.join(' · '))}</div></div>
      <div class="row"><span class="badge">${p.left}문항 남음</span><button class="ghost" type="button" data-weak="${esc(p.id)}">약점 보기</button><a class="ghost" href="../" target="_blank" rel="noopener">오답노트에서 만들기 ↗</a></div></li>`).join('')}</ul>`
      : '<p class="empty">오답노트를 기다리는 학생이 없어요.</p>';
    body.querySelectorAll('[data-weak]').forEach((b) => b.onclick = () => { S.weakSid = b.dataset.weak; setTab('weak'); });
  } else if (S.tab === 'weak') {
    const list = S.students.filter((s) => (s.records || []).length);
    if (!list.length) { body.innerHTML = '<p class="empty">오답이 입력된 학생이 아직 없어요.</p>'; return; }
    if (!list.some((s) => s.id === S.weakSid)) S.weakSid = list[0].id;
    const st = list.find((s) => s.id === S.weakSid); const w = weakness(st);
    body.innerHTML = `<label>학생<select id="weakSel">${list.map((s) => `<option value="${esc(s.id)}" ${s.id === st.id ? 'selected' : ''}>${esc(s.name)} ${esc(s.grade || '')}</option>`).join('')}</select></label>
      <div class="weak-grid">
        <div><h3>많이 틀린 단원 TOP 3</h3><ol class="top3">${w.top.map((u) => `<li>${esc(u.unit)} <span class="badge soft">${u.n}문항</span></li>`).join('')}</ol>
          <p class="muted small">전체 오답 ${w.total}문항 · 오답노트 완료 ${w.done}</p></div>
        <div><h3>틀린 원인</h3>${w.causeCount ? w.causes.map((c) => `<div class="bar"><span>${c.cause}</span><div class="track"><div class="fill" style="width:${c.pct}%"></div></div><span>${c.pct}%</span></div>`).join('') : '<p class="muted small">원인이 체크된 문항이 아직 없어요. 오답 입력 때 원인을 함께 고르면 분석돼요.</p>'}</div>
      </div>
      <div class="comment"><div class="row between wrap-gap"><b>오답노트 담당 의견</b><span class="muted small" id="aiTag">${cachedAi(st, w) ? 'Claude 의견' : '기본 분석'}</span></div>
        <p id="aiText" style="margin:6px 0 10px">${esc(cachedAi(st, w)?.text || w.comment)}</p>
        <button class="ghost" type="button" id="aiBtn">${cachedAi(st, w) ? 'Claude 의견 다시 보기' : 'Claude에게 의견 받기'}</button></div>`;
    $('#weakSel').onchange = (e) => { S.weakSid = e.target.value; drawTab(); };
    $('#aiBtn').onclick = async () => {
      const btn = $('#aiBtn'); btn.disabled = true; btn.textContent = 'Claude가 쓰는 중…';
      staff('work', `${st.name} 학생 오답을 살펴보고 있어요.`);
      try {
        const text = await askClaude(st, w);
        $('#aiText').textContent = text; $('#aiTag').textContent = 'Claude 의견';
        staff('done', text); say(text); log('오답노트 담당', text);
      } catch (e) {
        staff('done', 'Claude 의견을 받지 못해 기본 분석을 보여 드려요.', true); log('오답노트 담당', 'Claude 의견 실패: ' + e.message);
      }
      btn.disabled = false; btn.textContent = 'Claude 의견 다시 보기';
      setTimeout(drawStaff, 15000);
    };
  } else {
    const q = queueSummary(S.queue); const u = S.usage;
    body.innerHTML = `<div class="kv"><div>대기 문항<b>${q.queued}</b></div><div>처리 오류<b>${q.error}</b></div><div>폴더 연결 필요<b>${q.waiting}</b></div><div>오늘 AI 사용<b>$${(u?.usd || 0).toFixed(2)}</b><span class="muted small">${u?.calls || 0}회</span></div></div>
      ${q.errors.length ? `<h3 style="margin-top:12px">다시 확인할 문항</h3><ul class="list">${q.errors.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="empty">처리 오류가 난 문항이 없어요.</p>'}
      ${q.waiting ? '<p class="muted small">MYBOX 폴더 연결이 필요한 작업이 있어요. 오답노트 프로그램의 교재 정리 탭에서 다시 연결해 주세요.</p>' : ''}`;
  }
}

// ---------- 업무 지시 ----------
function drawStudentSelect() {
  const list = S.students.filter((s) => (s.records || []).length);
  const sel = $('#orderStudent'); const keep = sel.value;
  sel.innerHTML = list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} ${esc(s.grade || '')}</option>`).join('');
  if (list.some((s) => s.id === keep)) sel.value = keep;
}
$('#orderTask').onchange = () => { $('#orderStudentWrap').hidden = $('#orderTask').value !== 'weak'; };
$('#orderForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!S.aid || S.busy) return;
  const task = $('#orderTask').value; const btn = e.submitter || $('#orderForm .primary');
  const label = $('#orderTask').selectedOptions[0].textContent;
  log('원장님', label, true);
  S.busy = true; btn.disabled = true;
  staff('work', '네, 바로 확인할게요.'); say('네, 바로 확인할게요.');
  await new Promise((r) => setTimeout(r, 1200));
  let msg;
  if (task === 'todo') {
    const pend = pendingList(S.students);
    msg = pend.length ? `오답노트 만들 학생은 ${pend.length}명이에요. ${pend.slice(0, 3).map((p) => `${p.name} ${p.left}문항`).join(', ')}${pend.length > 3 ? ' 순이에요' : '이에요'}.` : '지금 오답노트를 기다리는 학생은 없어요.';
    setTab('todo');
  } else if (task === 'weak') {
    const st = S.students.find((s) => s.id === $('#orderStudent').value);
    if (!st) msg = '분석할 학생을 골라 주세요.';
    else {
      const w = weakness(st); S.weakSid = st.id;
      staff('work', `${st.name} 학생 오답을 Claude와 살펴보고 있어요.`);
      try { msg = await askClaude(st, w); } catch (err) { msg = w.comment; log('오답노트 담당', 'Claude 의견 실패, 기본 분석으로 대신해요: ' + err.message); }
      setTab('weak');
    }
  } else {
    const q = queueSummary(S.queue);
    msg = `대기 문항 ${q.queued}개, 처리 오류 ${q.error}개${q.waiting ? `, 폴더 연결이 필요한 작업 ${q.waiting}개` : ''}예요. 오늘 AI 사용액은 ${(S.usage?.usd || 0).toFixed(2)}달러예요.`;
    setTab('queue');
  }
  S.busy = false; btn.disabled = false;
  staff('done', msg); say(msg); log('오답노트 담당', msg);
  setTimeout(drawStaff, 12000);
};
