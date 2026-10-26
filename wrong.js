// 학생 오답 입력 → 1차 오답노트(원본 문항 재타이핑 + 빠른정답)
// - 교재는 "교재 정리"에서 읽은 목록(catalogBooks)을 씁니다.
// - 문항 위치·정답은 PDF 글자층에서 읽고(무료), 문항 재타이핑만 AI를 씁니다. 한 번 타이핑한 쪽은 문항 은행에 저장돼 다시 쓰지 않습니다.
import * as F from './folders.js';
import { openPdf } from './analysis.js';
import { readOutline, readAnswerBook, normNo } from './outline.js';
import { cropProblem, cropRegions, toJpegBase64, pageJpegBase64 } from './crop.js';
import { printDoc } from './print/print.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const clean = (o) => JSON.parse(JSON.stringify(o)); // Firestore는 undefined를 받지 않음
const CAUSES = ['계산', '개념', '조건', '시간', '찍음'];
const today = () => new Date().toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
const GRADES = ['중1-1', '중1-2', '중2-1', '중2-2', '중3-1', '중3-2', '중1', '중2', '중3', '고등', '전체 학년'];
const KINDS = ['내신대비', '시중교재', '교과서 자료', '고등 교재', '기출·시험지', '기타', '전체 분류'];
// 학생 학년 + 지금 학기 (8월~1월은 2학기)
const defaultGrade = (g) => { const m = String(g || '').match(/[1-3]/); if (!m) return '전체 학년'; const mo = new Date().getMonth() + 1; return `중${m[0]}-${mo >= 8 || mo <= 1 ? 2 : 1}`; };
// 구역 제목 → 단원 이름 (예: "1.1 삼각형의 성질 2회차 - 3레벨" → "삼각형의 성질", "시험지/1.1 유리수와 소수" → "유리수와 소수")
export const unitName = (label) => {
  const raw = String(label || '');
  const u = raw.replace(/^[^/]+\//, '').replace(/\s*-\s*\d+\s*레벨/, '').replace(/\s*\d+\s*회차.*$/, '').replace(/\s*\(\d+\)\s*$/, '').replace(/^\d+(\.\d+)*\s*/, '').trim();
  return u || raw.split('/')[0].trim() || raw;
};
const wkey = (bookId, sec, no) => hash(`${bookId}|${sec}|${normNo(no)}`);
const itemId = (bid, sec, no) => `${bid}_${hash(sec)}_${normNo(no)}`;

export function createWrong(ctx) {
  // ctx: { db, fs, aid, ai(path, body), toast, openModal, closeModal, uid, student(id) }
  const { fs, db } = ctx;
  const col = (n) => fs.collection(db, 'academies', ctx.aid(), n);
  const ref = (n, id) => fs.doc(db, 'academies', ctx.aid(), n, id);
  const C = { list: null, pdf: {} }; // 교재 목록, 열어 둔 PDF

  async function catalog() {
    if (!C.list) {
      const snap = await fs.getDocs(col('catalogBooks'));
      C.list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((b) => b.title && (b.files || []).some((f) => f.ext === 'pdf'));
    }
    return C.list;
  }
  const bookOf = (id) => C.list?.find((b) => b.id === id);
  const fileOf = (b, kind) => {
    const pdfs = (b.files || []).filter((f) => f.ext === 'pdf');
    if (kind === 'q') return pdfs.find((f) => f.role === '본책' && f.audience !== '교사용') || pdfs.find((f) => f.role === '본책');
    return pdfs.find((f) => f.role === '빠른정답') || pdfs.find((f) => f.role === '정답·해설');
  };

  // ---------- 폴더 허락 (버튼을 누른 직후에만 물을 수 있음) ----------
  async function ensureFolders() {
    const roots = await F.listRoots();
    const need = [];
    for (const r of roots) if ((await F.permission(r)) !== 'granted') need.push(r);
    if (need.length) await F.reconnectAll(need);
    return roots;
  }
  async function openBookPdf(b, kind, roots) {
    const f = fileOf(b, kind); if (!f) return null;
    const k = b.id + kind;
    if (!C.pdf[k]) {
      roots ||= await F.listRoots();
      const r = roots.find((x) => x.label === f.label);
      if (!r) throw new Error(`"${f.label}" 폴더가 이 PC에 연결되어 있지 않습니다. 교재 정리 탭에서 연결하세요.`);
      if ((await F.permission(r)) !== 'granted') throw new Error('MYBOX 폴더 허락이 필요합니다. 교재 정리 탭에서 "MYBOX 다시 연결"을 누르세요.');
      C.pdf[k] = openPdf(await F.openFile(r, f.rel));
    }
    return C.pdf[k];
  }

  // 교재 구역(단원·회차)과 정답: 처음 한 번만 읽고 저장
  async function outlineOf(b, roots, onProgress) {
    if (b.outline?.v === 2) return b.outline;
    const pdf = await openBookPdf(b, 'q', roots);
    if (!pdf) throw new Error('이 교재의 문제 PDF를 찾지 못했습니다.');
    const o = await readOutline(pdf, onProgress);
    let ans = {}, sol = {};
    try { const ap = await openBookPdf(b, 'a', roots); if (ap) ({ ans, sol } = await readAnswerBook(ap, o.sections.map((s) => s.key))); } catch { /* 해설 없음 */ }
    const outline = { v: 2, sections: o.sections, where: o.where, textPages: o.textPages, pages: o.pages, ans, sol, at: Date.now() };
    await fs.setDoc(ref('catalogBooks', b.id), { outline }, { merge: true });
    b.outline = outline;
    return outline;
  }

  async function saveStudent(sid, data) { await fs.updateDoc(ref('students', sid), data); }

  // ---------- 오답 입력 ----------
  async function entry(student) {
    ctx.openModal('<p class="pad center">교재 목록 불러오는 중…</p>');
    try { await ensureFolders(); } catch { /* 허락은 교재를 열 때 다시 확인 */ }
    const list = await catalog();
    const mine = (student.catalogIds || []).map(bookOf).filter(Boolean);
    const st = { bid: mine[0]?.id || '', type: '내신대비', picked: {}, solved: new Set(), causes: {}, q: '', fg: defaultGrade(student.grade), fk: '내신대비' };

    const dropBook = async (id) => {
      if (!(await removeBook(student, id))) return false;
      const i = mine.findIndex((x) => x.id === id); if (i >= 0) mine.splice(i, 1);
      if (st.bid === id) { st.bid = mine[0]?.id || ''; st.picked = {}; st.solved = new Set(); setTimeout(draw, 0); }
      else { const sel = document.getElementById('wBook'); sel?.querySelector(`option[value="${id}"]`)?.remove(); }
      return true;
    };
    const draw = async () => {
      const b = bookOf(st.bid);
      ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 오답 입력</h2>
        <div class="row"><select id="wBook" style="flex:1"><option value="">교재 고르기</option>${mine.map((x) => `<option value="${x.id}" ${x.id === st.bid ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}${b && !mine.includes(b) ? `<option value="${b.id}" selected>${esc(b.title)}</option>` : ''}</select>
          <button class="ghost small" id="wManage" type="button">교재 관리</button>
          <select id="wType" style="width:auto"><option ${st.type === '내신대비' ? 'selected' : ''}>내신대비</option><option ${st.type === '수업' ? 'selected' : ''}>수업</option></select></div>
 <div id="wMine" hidden></div>
        <details id="wBrowse" ${mine.length ? '' : 'open'} style="margin-top:6px"><summary class="small" style="cursor:pointer;color:var(--green)">교재 목록에서 고르기 / 추가하기</summary>
          <div class="row" style="margin-top:6px"><select id="fG" style="width:auto">${GRADES.map((g) => `<option ${st.fg === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
            <select id="fK" style="width:auto">${KINDS.map((k) => `<option ${st.fk === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
            <input type="text" id="wFind" placeholder="이름 일부 (띄어쓰기 무시)" value="${esc(st.q)}" style="flex:1"></div>
          <div id="wFound"></div></details>
        <div id="wGrid" style="margin-top:10px">${b ? '<p class="muted small">교재 구역을 읽는 중… (처음 한 번만, 몇 초 걸립니다)</p>' : '<p class="muted small">교재를 고르세요.</p>'}</div>
        <div class="row between" style="margin-top:14px"><span class="muted small" id="wSum"></span><div class="row"><button class="ghost" data-a="close">취소</button><button class="primary" id="wSave">저장</button></div></div></div>`);
      document.getElementById('wBook').onchange = (e) => { st.bid = e.target.value; st.picked = {}; st.solved = new Set(); draw(); };
      document.getElementById('wType').onchange = (e) => { st.type = e.target.value; };
      const mineBox = document.getElementById('wMine');
      const drawMine = () => {
        mineBox.innerHTML = `<div class="card" style="margin:6px 0"><b class="small">이 학생 교재 ${mine.length}종</b> <span class="muted small">— 쓰지 않는 교재는 ×로 빼세요. 입력해 둔 오답 기록은 그대로 남습니다.</span>
          <div style="margin-top:6px">${mine.map((x) => `<div class="row between small" style="border-top:1px solid var(--line);padding:4px 0"><span>${esc(x.title)}</span><button class="ghost small danger" data-rm="${x.id}">× 빼기</button></div>`).join('') || '<p class="muted small">아직 없음</p>'}</div></div>`;
        mineBox.querySelectorAll('[data-rm]').forEach((btn) => btn.onclick = async () => { if (await dropBook(btn.dataset.rm)) drawMine(); });
      };
      document.getElementById('wManage').onclick = () => { mineBox.hidden = !mineBox.hidden; if (!mineBox.hidden) drawMine(); };
      const find = () => {
        st.q = document.getElementById('wFind').value.trim(); st.fg = document.getElementById('fG').value; st.fk = document.getElementById('fK').value;
        const q = st.q.replace(/[\s_]+/g, '');
        const hits = list.filter((x) => (st.fg === '전체 학년' || (x.grade || '').startsWith(st.fg)) && (st.fk === '전체 분류' || x.kind === st.fk || (st.fk === '내신대비' && /내신/.test(x.title)))
          && (!q || x.title.replace(/[\s_]+/g, '').includes(q))).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
        const add = hits.filter((x) => !(student.catalogIds || []).includes(x.id));
        document.getElementById('wFound').innerHTML = `<div class="row between" style="margin:6px 0"><span class="muted small">${hits.length}종${hits.length > 300 ? ' (앞 300종만 표시)' : ''}</span>${add.length ? `<button class="ghost small" id="wAddAll">보이는 교재 ${add.length}종 모두 이 학생 교재로 추가</button>` : ''}</div>
          <p class="muted small" style="margin:0 0 4px">누르면 이 학생 교재로 추가됩니다. ✓ 표시된 교재를 다시 누르면 빠집니다.</p>
          <div class="list" style="max-height:220px">${hits.slice(0, 300).map((x) => `<button data-pick="${x.id}"><span>${(student.catalogIds || []).includes(x.id) ? '✓ ' : ''}${esc(x.title)}</span><span class="muted small">${esc(x.grade || '')} ${esc(x.kind || '')}</span></button>`).join('') || '<p class="muted small pad">찾는 교재가 없습니다. 학년·분류를 "전체"로 바꿔 보세요.</p>'}</div>`;
        const addIds = async (more) => { const ids = [...new Set([...(student.catalogIds || []), ...more])]; await saveStudent(student.id, { catalogIds: ids }); student.catalogIds = ids; more.forEach((id) => { const x = bookOf(id); if (x && !mine.includes(x)) mine.push(x); }); };
        document.querySelectorAll('[data-pick]').forEach((btn) => btn.onclick = async () => {
          const id = btn.dataset.pick;
          if ((student.catalogIds || []).includes(id)) { if (await dropBook(id)) find(); return; } // ✓ 교재를 다시 누르면 빼기
          await addIds([id]); st.bid = id; st.picked = {}; st.solved = new Set(); draw();
        });
        const all = document.getElementById('wAddAll');
        if (all) all.onclick = async () => { await addIds(add.map((x) => x.id)); ctx.toast(`${add.length}종을 추가했습니다. 위 목록에서 교재를 고르세요.`); if (!st.bid) st.bid = add[0]?.id || ''; draw(); };
      };
      ['fG', 'fK'].forEach((id) => document.getElementById(id).onchange = find);
      document.getElementById('wFind').oninput = find;
      find();
      document.getElementById('wSave').onclick = save;
      if (b) {
        try {
          const roots = await ensureFolders();
          const o = await outlineOf(b, roots, (p, n) => { const g = document.getElementById('wGrid'); if (g && p % 5 === 0) g.innerHTML = `<p class="muted small">교재 구역을 읽는 중… ${p}/${n}쪽</p>`; });
          grid(b, o);
        } catch (e) { document.getElementById('wGrid').innerHTML = `<p class="small" style="color:var(--red)">${esc(e.message)}</p>`; }
      }
    };

    const grid = (b, o) => {
      const g = document.getElementById('wGrid'); if (!g) return;
      if (!o.sections.length) {
        g.innerHTML = `<p class="small">이 교재는 PDF에 글자 정보가 없어(스캔본) 구역을 자동으로 읽지 못했습니다. 아래에 <b>PDF 쪽 번호와 문항 번호</b>를 적어 주세요.</p>
          <textarea id="wManual" rows="4" placeholder="예) 12쪽 3 5 7&#10;15쪽 2" style="width:100%"></textarea>`;
        return;
      }
      g.innerHTML = `<p class="muted small">틀린 번호를 누르세요. 다 맞은 구역은 <b>다 맞음</b>을 눌러 두면 오답률 계산에 들어갑니다.</p>
        <div style="max-height:52vh;overflow:auto">${o.sections.map((s) => `<div class="wsec" data-sec="${esc(s.key)}"><div class="row between"><strong class="small">${esc(s.label)}</strong><label class="small row"><input type="checkbox" data-solved="${esc(s.key)}" ${st.solved.has(s.key) ? 'checked' : ''}> 다 맞음·풀었음</label></div>
          <div class="nos">${s.nos.map((no) => `<button class="nob ${st.picked[s.key + '|' + no] ? 'on' : ''}" data-no="${esc(no)}" data-s="${esc(s.key)}">${esc(no)}</button>`).join('')}</div></div>`).join('')}</div>
        <div id="wCauses"></div>`;
      g.querySelectorAll('.nob').forEach((btn) => btn.onclick = () => {
        const k = btn.dataset.s + '|' + btn.dataset.no;
        if (st.picked[k]) delete st.picked[k]; else { st.picked[k] = true; st.solved.add(btn.dataset.s); }
        btn.classList.toggle('on', !!st.picked[k]);
        const cb = g.querySelector(`[data-solved="${CSS.escape(btn.dataset.s)}"]`); if (cb) cb.checked = st.solved.has(btn.dataset.s);
        causes(o);
      });
      g.querySelectorAll('[data-solved]').forEach((cb) => cb.onchange = () => { cb.checked ? st.solved.add(cb.dataset.solved) : st.solved.delete(cb.dataset.solved); sum(); });
      causes(o);
    };
    const causes = (o) => {
      const box = document.getElementById('wCauses'); if (!box) return;
      const ks = Object.keys(st.picked);
      box.innerHTML = ks.length ? `<h3 style="margin-top:12px">틀린 이유 <span class="muted small">(몰라도 비워 두면 됩니다. 쌓인 기록으로 나중에 예측합니다)</span></h3>
        <div class="causes">${ks.map((k) => { const [sk, no] = k.split('|'); const s = o.sections.find((x) => x.key === sk); return `<div class="row small"><span style="min-width:200px">${esc(s?.label || '')} · <b>${esc(no)}</b></span>${CAUSES.map((c) => `<label><input type="radio" name="c${esc(hash(k))}" value="${c}" data-ck="${esc(k)}" ${st.causes[k] === c ? 'checked' : ''}> ${c}</label>`).join(' ')}</div>`; }).join('')}</div>` : '';
      box.querySelectorAll('[data-ck]').forEach((r) => r.onchange = () => { st.causes[r.dataset.ck] = r.value; });
      sum();
    };
    const sum = () => { const s = document.getElementById('wSum'); if (s) s.textContent = `틀린 문항 ${Object.keys(st.picked).length}개 · 푼 구역 ${st.solved.size}개`; };

    async function save() {
      const b = bookOf(st.bid); if (!b) return ctx.toast('교재를 고르세요.');
      let wrongs = [];
      const man = document.getElementById('wManual');
      if (man) {
        man.value.split('\n').forEach((line) => { const m = line.match(/(\d+)\s*쪽\s*(.*)/); if (!m) return; (m[2].match(/\d+/g) || []).forEach((no) => wrongs.push({ sec: 'p' + m[1], label: `${m[1]}쪽`, no, page: Number(m[1]) })); });
      } else {
        const o = b.outline;
        wrongs = Object.keys(st.picked).map((k) => { const [sec, no] = k.split('|'); const s = o.sections.find((x) => x.key === sec); return { sec, label: s?.label || '', no, page: o.where[sec + '|' + normNo(no)] || null, cause: st.causes[k] || null }; });
      }
      if (!wrongs.length && !st.solved.size) return ctx.toast('틀린 번호를 고르거나 푼 구역을 표시하세요.');
      const rec = clean({ id: 'r' + Date.now().toString(36), at: Date.now(), bookId: b.id, title: b.title, type: st.type, solved: [...st.solved], wrongs, by: ctx.uid() });
      await saveStudent(student.id, { records: fs.arrayUnion(rec), catalogIds: [...new Set([...(student.catalogIds || []), b.id])] });
      ctx.closeModal(); ctx.toast(`저장했습니다 · 오답 ${wrongs.length}개`);
    }
    draw();
  }

  async function removeBook(student, bid) {
    const has = (student.records || []).some((r) => r.bookId === bid);
    if (!confirm(`"${bookOf(bid)?.title || '이 교재'}"을(를) ${student.name} 학생 교재에서 뺄까요?${has ? '\n입력해 둔 오답 기록과 오답노트는 그대로 남습니다.' : ''}`)) return false;
    const ids = (student.catalogIds || []).filter((x) => x !== bid);
    await saveStudent(student.id, { catalogIds: ids }); student.catalogIds = ids;
    return true;
  }

  // 학생의 오답을 교재 › 구역 단위로 모음 (같은 문항은 한 번만, 원인은 최근 것)
  function collect(student) {
    const noted = student.noted || {};
    const oldDone = new Set((student.sheets || []).flatMap((x) => x.records || [])); // 처음 버전(기록 단위)으로 만든 오답노트
    const books = new Map();
    [...(student.records || [])].sort((a, b) => a.at - b.at).forEach((r) => {
      if (!books.has(r.bookId)) books.set(r.bookId, { bookId: r.bookId, title: r.title, secs: new Map() });
      const B = books.get(r.bookId);
      r.wrongs.forEach((w) => {
        if (!B.secs.has(w.sec)) B.secs.set(w.sec, { sec: w.sec, label: w.label, unit: unitName(w.label), items: new Map() });
        const k = wkey(r.bookId, w.sec, w.no);
        B.secs.get(w.sec).items.set(k, { ...w, bookId: r.bookId, title: r.title, k, done: !!noted[k] || oldDone.has(r.id) });
      });
    });
    return [...books.values()].map((B) => ({ ...B, secs: [...B.secs.values()].map((S) => ({ ...S, items: [...S.items.values()] })) }));
  }
  // 학생 카드에 보여 줄 교재별 진행
  function progress(student) {
    return collect(student).map((B) => {
      const all = B.secs.flatMap((S) => S.items); const done = all.filter((x) => x.done).length;
      const left = [...new Set(B.secs.filter((S) => S.items.some((x) => !x.done)).map((S) => S.unit))];
      return { bookId: B.bookId, title: B.title, total: all.length, done, left };
    });
  }

  // ---------- 오답노트 범위 고르기 ----------
  async function noteSetup(student) {
    const books = collect(student);
    if (!books.length) return ctx.toast('먼저 오답을 입력하세요.');
    ctx.openModal('<p class="pad center">불러오는 중…</p>');
    const scopes = (await fs.getDocs(col('examScopes'))).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.at || 0) - (a.at || 0));
    const st = { redo: false, scope: '', on: new Set() };
    books.forEach((B) => B.secs.forEach((S) => { if (S.items.some((x) => !x.done)) st.on.add(B.bookId + '|' + S.sec); }));
    const units = [...new Set(books.flatMap((B) => B.secs.map((S) => S.unit)))];

    const count = () => books.reduce((a, B) => a + B.secs.filter((S) => st.on.has(B.bookId + '|' + S.sec)).reduce((x, S) => x + S.items.filter((i) => st.redo || !i.done).length, 0), 0);
    const draw = () => {
      ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 오답노트 범위 고르기</h2>
        <div class="row"><label class="small">시험 범위</label><select id="nScope" style="width:auto;min-width:220px"><option value="">직접 고르기</option>${scopes.map((x) => `<option value="${x.id}" ${st.scope === x.id ? 'selected' : ''}>${esc(x.name)}${x.school ? ' · ' + esc(x.school) : ''}</option>`).join('')}</select>
          <button class="ghost small" id="nSaveScope">지금 고른 단원을 범위로 저장</button>${st.scope ? '<button class="ghost small danger" id="nDelScope">이 범위 지우기</button>' : ''}
          <label class="small row" style="margin-left:auto"><input type="checkbox" id="nRedo" ${st.redo ? 'checked' : ''}> 이미 오답노트에 넣은 문항도 다시 넣기</label></div>
        <div style="max-height:56vh;overflow:auto;margin-top:8px">${books.map((B) => {
          const by = new Map(); B.secs.forEach((S) => { if (!by.has(S.unit)) by.set(S.unit, []); by.get(S.unit).push(S); });
          const all = B.secs.flatMap((S) => S.items); const done = all.filter((x) => x.done).length;
          return `<div class="card"><div class="row between"><b>${esc(B.title)}</b><span class="muted small">오답 ${all.length}개 · 오답노트 완료 ${done} · 남음 ${all.length - done}</span></div>
            ${[...by.entries()].map(([u, secs]) => `<div class="wsec"><label class="row small"><input type="checkbox" data-unit="${esc(B.bookId)}|${esc(u)}" ${secs.every((S) => st.on.has(B.bookId + '|' + S.sec)) ? 'checked' : ''}> <b>${esc(u)}</b></label>
              <div style="padding-left:24px">${secs.map((S) => { const left = S.items.filter((x) => !x.done).length; return `<label class="row small"><input type="checkbox" data-sec="${esc(B.bookId)}|${esc(S.sec)}" ${st.on.has(B.bookId + '|' + S.sec) ? 'checked' : ''}> ${esc(S.label)} <span class="muted">· 남은 ${left} / ${S.items.length} (${S.items.map((x) => `<span style="${x.done ? 'text-decoration:line-through' : 'color:var(--red)'}">${esc(x.no)}</span>`).join(', ')})</span></label>`; }).join('')}</div></div>`).join('')}</div>`;
        }).join('')}</div>
        <div class="row between" style="margin-top:12px"><span class="small" id="nCount"></span><div class="row"><button class="ghost" data-a="close">닫기</button><button class="primary" id="nMake">오답노트 만들기</button></div></div></div>`);
      const recount = () => { document.getElementById('nCount').textContent = `고른 문항 ${count()}개`; };
      recount();
      document.querySelectorAll('[data-sec]').forEach((cb) => cb.onchange = () => { cb.checked ? st.on.add(cb.dataset.sec) : st.on.delete(cb.dataset.sec); st.scope = ''; draw(); });
      document.querySelectorAll('[data-unit]').forEach((cb) => cb.onchange = () => {
        const [bid, u] = [cb.dataset.unit.slice(0, cb.dataset.unit.indexOf('|')), cb.dataset.unit.slice(cb.dataset.unit.indexOf('|') + 1)];
        books.find((B) => B.bookId === bid).secs.filter((S) => S.unit === u).forEach((S) => (cb.checked ? st.on.add(bid + '|' + S.sec) : st.on.delete(bid + '|' + S.sec)));
        st.scope = ''; draw();
      });
      document.getElementById('nRedo').onchange = (e) => { st.redo = e.target.checked; recount(); };
      document.getElementById('nScope').onchange = (e) => {
        st.scope = e.target.value; const sc = scopes.find((x) => x.id === st.scope);
        if (sc) { st.on = new Set(); books.forEach((B) => B.secs.forEach((S) => { if ((sc.units || []).includes(S.unit)) st.on.add(B.bookId + '|' + S.sec); })); }
        draw();
      };
      document.getElementById('nSaveScope').onclick = async () => {
        const chosen = [...new Set(books.flatMap((B) => B.secs.filter((S) => st.on.has(B.bookId + '|' + S.sec)).map((S) => S.unit)))];
        if (!chosen.length) return ctx.toast('범위로 저장할 단원을 먼저 고르세요.');
        const name = prompt(`범위 이름을 적어 주세요.\n(예: 2학기 중간)\n\n단원: ${chosen.join(', ')}`, ''); if (!name) return;
        const school = prompt('학교마다 범위가 다르면 학교 이름을 적어 주세요. (모든 학교 공통이면 비워 두기)', student.school || '') || '';
        const d = { name: name.trim(), school: school.trim(), units: chosen, at: Date.now(), by: ctx.uid() };
        const r = fs.doc(col('examScopes')); await fs.setDoc(r, d); scopes.unshift({ id: r.id, ...d }); st.scope = r.id; ctx.toast('시험 범위를 저장했습니다'); draw();
      };
      document.getElementById('nDelScope')?.addEventListener('click', async () => {
        const sc = scopes.find((x) => x.id === st.scope); if (!sc || !confirm(`"${sc.name}" 범위를 지울까요?`)) return;
        await fs.deleteDoc(ref('examScopes', sc.id)); scopes.splice(scopes.indexOf(sc), 1); st.scope = ''; draw();
      });
      document.getElementById('nMake').onclick = () => {
        const wrongs = books.flatMap((B) => B.secs.filter((S) => st.on.has(B.bookId + '|' + S.sec)).flatMap((S) => S.items.filter((i) => st.redo || !i.done)));
        if (!wrongs.length) return ctx.toast('고른 범위에 남은 문항이 없습니다. "다시 넣기"를 체크하면 이미 넣은 문항도 고를 수 있습니다.');
        makeNote(student, wrongs, scopes.find((x) => x.id === st.scope)?.name || '').catch((e) => ctx.toast(e.message));
      };
    };
    draw();
  }

  // ---------- 1차 오답노트 ----------
  async function makeNote(student, wrongs, scopeName = '') {
    const log = [];
    const show = (done, total, extra = '') => ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 1차 오답노트 만드는 중</h2>
      <div class="progress" style="margin:10px 0"><div style="width:${Math.round((done / total) * 100)}%"></div></div>
      <p class="small">${done} / ${total}문항 ${extra}</p><div class="muted small" style="max-height:30vh;overflow:auto">${log.slice(-12).map(esc).join('<br>')}</div></div>`);
    let roots;
    try { roots = await ensureFolders(); } catch (e) { return ctx.toast(e.message); }
    show(0, wrongs.length);
    await catalog();
    const t0 = Date.now(); const cost = { usd: 0 }; const rows = [];
    for (let i = 0; i < wrongs.length; i++) {
      const w = wrongs[i];
      try { rows.push(await prepItem(w, roots, cost, (m) => { log.push(m); show(i, wrongs.length, `· AI 사용 $${cost.usd.toFixed(2)}`); })); log.push(`✓ ${w.label} ${w.no}번`); }
      catch (e) { rows.push({ w, err: e.message }); log.push(`✗ ${w.label} ${w.no}번 — ${e.message}`); await queueRetry(w, e.message); }
      show(i + 1, wrongs.length, `· AI 사용 $${cost.usd.toFixed(2)}`);
    }
    if (cost.usd) await logUsage(cost.usd);
    const sheet = { id: 's' + Date.now().toString(36), kind: '1차', at: Date.now(), scope: scopeName, count: rows.filter((r) => !r.err).length };
    const fresh = (await fs.getDoc(ref('students', student.id))).data() || {};
    const noted = { ...(fresh.noted || {}) }; rows.filter((r) => !r.err).forEach((x) => { noted[x.w.k || wkey(x.w.bookId, x.w.sec, x.w.no)] = sheet.id; });
    await saveStudent(student.id, { sheets: fs.arrayUnion(sheet), noted });
    review(student, rows, { usd: cost.usd, sec: Math.round((Date.now() - t0) / 1000), scopeName, roots, sheetId: sheet.id });
  }

  async function logUsage(usd) {
    await fs.setDoc(ref('aiUsage', new Date().toISOString().slice(0, 10)), { usd: fs.increment(usd), calls: fs.increment(1) }, { merge: true });
  }
  // AI 호출: 일시 오류면 몇 초 쉬고 두 번 더 시도 (서버에서도 3번까지 다시 시도함)
  async function aiCall(path, body) {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await ctx.ai(path, body); } catch (e) {
        last = e; if (!/not allowed|overload|과부하|429|5\d\d|timeout|network|fetch|Failed|요청 실패/i.test(e.message)) throw e;
        if (i < 2) await new Promise((r) => setTimeout(r, [3000, 8000][i]));
      }
    }
    throw last;
  }
  // 실패한 문항은 버리지 않고 대기 목록에 (새벽 분석이 이어서 처리, 화면에서 다시 시도 가능)
  async function queueRetry(w, error) {
    const id = 'item_' + itemId(w.bookId, w.sec, w.no);
    await fs.setDoc(ref('analysisQueue', id), clean({ task: 'item', w: { bookId: w.bookId, title: w.title, sec: w.sec, label: w.label, no: w.no, page: w.page || null }, title: `${w.title} · ${w.label} ${w.no}번`, status: 'queued', priority: 0, error, createdAt: Date.now() }), { merge: true }).catch(() => {});
  }
  async function clearRetry(w) { await fs.updateDoc(ref('analysisQueue', 'item_' + itemId(w.bookId, w.sec, w.no)), { status: 'done', at: Date.now() }).catch(() => {}); }

  const isScan = (o) => !o.sections?.length || (o.textPages || 0) < (o.pages || 1) * 0.3;

  // 문항 하나 준비: ① 원본 잘라내기 ② (스캔본이면) AI 타이핑 ③ 해설지에서 해설 잘라내기 ④ 정답·해설이 없으면 AI 풀이
  async function prepItem(w, roots, cost, say = () => {}) {
    const b = bookOf(w.bookId); if (!b) throw new Error('교재 정보를 찾지 못했습니다');
    const o = await outlineOf(b, roots);
    const key = w.sec + '|' + normNo(w.no);
    const r = ref('bankItems', itemId(b.id, w.sec, w.no));
    let d = (await fs.getDoc(r)).data() || {};
    const page = w.page || o.where?.[key] || d.page;
    const up = {};
    if (!d.crop && !isScan(o) && page) {
      const c = await cropProblem(await openBookPdf(b, 'q', roots), page, w.no);
      if (c) { up.crop = c; up.page = page; }
    }
    const segs = o.sol?.[key];
    if (!d.sol && segs?.length) {
      const ap = await openBookPdf(b, 'a', roots);
      if (ap) { const c = await cropRegions(ap, segs); if (c) up.sol = c; }
    }
    if (!d.answer && o.ans?.[key]) up.answer = o.ans[key];
    if (Object.keys(up).length) await fs.setDoc(r, clean({ ...up, bookId: b.id, sec: w.sec, no: w.no, nkey: normNo(w.no), status: d.status || 'review', at: d.at || Date.now() }), { merge: true });
    d = { ...d, ...up };
    if (!d.crop && !d.stem) {
      if (!page) throw new Error('문항 위치를 찾지 못했습니다');
      say(`${b.title} ${page}쪽 AI 타이핑 중… (원본을 잘라 쓸 수 없는 교재)`);
      cost.usd += await retypePage(b, o, page, roots);
      d = (await fs.getDoc(r)).data() || {};
      if (!d.stem) throw new Error(`${page}쪽에서 ${w.no}번을 읽지 못했습니다`);
    }
    if (!d.sol && !d.answer && !d.aiSol) {
      say(`${w.label} ${w.no}번 AI 정답·풀이 쓰는 중… (해설지 없음)`);
      d.aiSol = await solve(b, d, r, cost);
    }
    return { w, it: d, scan: isScan(o), title: b.title };
  }
  async function solve(b, d, r, cost) {
    const image = d.crop ? await toJpegBase64(d.crop.img) : null;
    const res = await aiCall('/ai/solve', { title: b.title, image, item: d.stem ? { stem: d.stem, choices: d.choices, box: d.box } : null });
    cost.usd += res.usage?.usd || 0;
    const aiSol = clean({ answer: res.answer || '', solution: res.solution || '', key: res.key || '', check: res.check || null, at: Date.now() });
    await fs.setDoc(r, { aiSol }, { merge: true });
    return aiSol;
  }
  // 잘라낸 원본 → AI 타이핑 (원본이 흐릴 때)
  async function typeOne(row, cost) {
    const d = row.it; const r = ref('bankItems', itemId(row.w.bookId, row.w.sec, row.w.no));
    if (!d.crop) throw new Error('원본 그림이 없습니다');
    const res = await aiCall('/ai/retype1', { title: row.title, image: await toJpegBase64(d.crop.img) });
    cost.usd += res.usage?.usd || 0;
    const it = res.item || {};
    let figure = it.figure || null;
    if (figure?.needsRedraw && Array.isArray(figure.bbox)) figure = await subCrop(d.crop.img, figure.bbox);
    else if (figure && !figure.svg) figure = null;
    const ai = clean({ stem: it.stem || '', choices: it.choices || null, box: it.box || null, figure, pts: it.pts || null });
    await fs.setDoc(r, { ...ai, source: 'retype1' }, { merge: true });
    Object.assign(d, ai);
  }
  async function subCrop(dataUrl, [x0, y0, x1, y1]) {
    const im = new Image(); im.src = dataUrl; await im.decode();
    const W = im.width, H = im.height; const sx = Math.max(0, (x0 - 0.01) * W), sy = Math.max(0, (y0 - 0.01) * H);
    const sw = Math.min(W, (x1 + 0.01) * W) - sx, sh = Math.min(H, (y1 + 0.01) * H) - sy;
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    c.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
    return { img: c.toDataURL('image/png'), w: Math.round(sw), h: Math.round(sh) };
  }
  // 새벽 분석에서 실패 문항 이어서 처리
  async function retryItem(t) {
    await catalog();
    const roots = await F.listRoots();
    const cost = { usd: 0 };
    await prepItem(t.w, roots, cost);
    if (cost.usd) await logUsage(cost.usd);
    return { kind: 'item' };
  }

  // 한 쪽 재타이핑 → 문항 은행에 저장 (스캔본용). 반환: 쓴 비용($)
  async function retypePage(b, o, page, roots) {
    const pdf = await openBookPdf(b, 'q', roots);
    const image = await pageJpegBase64(pdf, page);
    const r = await aiCall('/ai/retype', { title: b.title, page, image });
    const secOf = (no) => { for (const s of o.sections || []) if (s.pages.includes(page) && s.nos.some((n) => normNo(n) === normNo(no))) return s.key; return (o.sections || []).find((s) => s.pages.includes(page))?.key || 'p' + page; };
    const batch = fs.writeBatch(db);
    for (const it of r.items || []) {
      const no = normNo(it.no); if (!no) continue;
      let figure = it.figure || null;
      if (figure?.needsRedraw && Array.isArray(figure.bbox)) figure = await subCrop('data:image/jpeg;base64,' + image, figure.bbox);
      else if (figure && !figure.svg) figure = null;
      const sec = secOf(it.no);
      batch.set(ref('bankItems', itemId(b.id, sec, no)), clean({ bookId: b.id, sec, page, no: it.no, nkey: no, unit: it.unit || '', stem: it.stem || '', choices: it.choices || null, box: it.box || null, figure, pts: it.pts || null, status: 'review', source: 'retype', at: Date.now(), ...(it.answer ? { answerAI: it.answer } : {}) }), { merge: true });
    }
    batch.set(ref('catalogBooks', b.id), { retyped: { [page]: Date.now() } }, { merge: true });
    await batch.commit();
    return r.usage?.usd || 0;
  }

  // ---------- 문항 확인 화면 ----------
  function review(student, rows, info) {
    rows.forEach((x) => { if (x.err) return; x.q ||= x.it.crop && !x.scan ? 'crop' : 'ai'; x.s ||= x.it.sol ? 'crop' : x.it.aiSol ? 'ai' : 'ans'; });
    const cost = { usd: info.usd };
    const busy = new Set();
    const qView = (x) => x.q === 'crop' && x.it.crop ? `<img src="${x.it.crop.img}" class="thumb">` : `<div class="ttext">${esc(x.it.stem || '(AI 타이핑 전)')}${x.it.choices ? '<br>' + x.it.choices.map((c, i) => '①②③④⑤'[i] + ' ' + esc(c)).join('  ') : ''}${x.it.figure ? '<br><span class="muted">[그림]</span>' : ''}</div>`;
    const sView = (x) => x.s === 'crop' && x.it.sol ? `<img src="${x.it.sol.img}" class="thumb">` : x.s === 'ai' && x.it.aiSol ? `<div class="ttext">${esc(x.it.aiSol.solution)}${x.it.aiSol.check && x.it.aiSol.check.match === false ? `<br><b style="color:var(--red)">GPT 답 ${esc(x.it.aiSol.check.gptAnswer)} — 확인 필요</b>` : ''}</div>` : '<div class="ttext muted">빠른 정답만 넣습니다</div>';
    const ans = (x) => x.it.answer || x.it.aiSol?.answer || x.it.answerAI || '';
    const draw = () => {
      const ok = rows.filter((x) => !x.err), bad = rows.filter((x) => x.err);
      const nAI = ok.filter((x) => x.q === 'ai').length + ok.filter((x) => x.s === 'ai').length;
      ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 1차 오답노트 문항 확인</h2>
        <p class="small muted">문항 ${ok.length}개 · 원본 잘라내기 ${ok.filter((x) => x.q === 'crop').length} · 해설지 ${ok.filter((x) => x.s === 'crop').length} · AI 사용 ${nAI}곳 ($${cost.usd.toFixed(2)}) · 걸린 시간 ${info.sec}초</p>
        ${bad.length ? `<div class="card" style="background:var(--red-bg)"><div class="row between"><b class="small">빠진 문항 ${bad.length}개 — 다시 시도 대기에 넣어 두었습니다 (새벽 분석 때도 이어서 처리)</b><button class="primary small" id="rAll">빠진 문항 모두 다시 시도</button></div>${bad.map((x) => `<div class="row between small" style="border-top:1px solid #f0d0cd;padding:4px 0"><span>${esc(x.w.title)} · ${esc(x.w.label)} ${esc(x.w.no)}번 — ${esc(x.err)}</span><button class="ghost small" data-retry="${rows.indexOf(x)}" ${busy.has(x) ? 'disabled' : ''}>${busy.has(x) ? '다시 시도 중…' : '다시 시도'}</button></div>`).join('')}</div>` : ''}
        <div class="row small" style="margin:6px 0"><span>한꺼번에:</span><button class="ghost small" data-bulk="crop">모두 원본</button><button class="ghost small" data-bulk="scan">흐린 것만 AI 타이핑</button><button class="ghost small" data-bulk="ai">모두 AI 타이핑</button></div>
        <div style="max-height:52vh;overflow:auto">${ok.map((x, n) => { const i = rows.indexOf(x); return `<div class="rv">
          <div class="rvn">${String(n + 1).padStart(2, '0')}</div>
          <div><div class="lab">문제 · ${esc(shortLabel(x.w.label))} ${esc(x.w.no)}번${x.scan ? ' · <b style="color:#a8812f">스캔본</b>' : ''}</div>${qView(x)}</div>
          <div><div class="lab">해설 · 정답 ${esc(ans(x)) || '-'}</div>${sView(x)}</div>
          <div><div class="lab">문제</div><div class="seg"><button data-i="${i}" data-q="crop" class="${x.q === 'crop' ? 'on' : ''}" ${x.it.crop ? '' : 'disabled'}>원본 그대로</button><button data-i="${i}" data-q="ai" class="${x.q === 'ai' ? 'on' : ''}">AI 타이핑</button></div>
            <div class="lab" style="margin-top:8px">해설</div><div class="seg"><button data-i="${i}" data-s="crop" class="${x.s === 'crop' ? 'on' : ''}" ${x.it.sol ? '' : 'disabled'}>해설지</button><button data-i="${i}" data-s="ai" class="${x.s === 'ai' ? 'on' : ''}">AI 풀이</button></div>
            ${busy.has(x) ? '<div class="warn">AI 작업 중…</div>' : ''}</div></div>`; }).join('')}</div>
        <div class="row" style="margin-top:10px"><label class="small">한 쪽 문항 수</label><select id="nPer" style="width:auto"><option value="2">2문항</option><option value="4" selected>4문항</option><option value="6">6문항</option></select>
          <label class="small">표지</label><select id="nCover" style="width:auto"><option value="">없음</option><option value="classic">클래식</option><option value="insta">인스타 감성</option><option value="premium">프리미엄</option><option value="minimal">미니멀</option></select>
          <label class="small row"><input type="checkbox" id="nSol" checked> 정답 및 해설 쪽 넣기</label></div>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" data-a="close">닫기</button><button class="ghost" id="nTeacher">선생님용 (출처 표시)</button><button class="primary" id="nStudent">학생용 미리보기 · 인쇄</button></div></div>`);
      const keep = { per: document.getElementById('nPer'), cover: document.getElementById('nCover'), sol: document.getElementById('nSol') };
      Object.entries(prefs).forEach(([k, v]) => { if (keep[k]) keep[k][k === 'sol' ? 'checked' : 'value'] = v; });
      Object.entries(keep).forEach(([k, el]) => el.onchange = () => { prefs[k] = k === 'sol' ? el.checked : el.value; });
      const go = (aud) => printDoc(buildDoc(student, rows.filter((x) => !x.err), aud, Number(keep.per.value), keep.cover.value, info.scopeName, keep.sol.checked), { autoPrint: false }).catch((e) => ctx.toast(e.message));
      document.getElementById('nStudent').onclick = () => go('student');
      document.getElementById('nTeacher').onclick = () => go('teacher');
      document.querySelectorAll('[data-q],[data-s]').forEach((btn) => btn.onclick = () => setMode(rows[btn.dataset.i], btn.dataset.q ? 'q' : 's', btn.dataset.q || btn.dataset.s));
      document.querySelectorAll('[data-retry]').forEach((btn) => btn.onclick = () => retry([rows[btn.dataset.retry]]));
      document.getElementById('rAll')?.addEventListener('click', () => retry(rows.filter((x) => x.err)));
      document.querySelectorAll('[data-bulk]').forEach((btn) => btn.onclick = async () => {
        const m = btn.dataset.bulk;
        for (const x of rows.filter((y) => !y.err)) {
          if (m === 'crop' && x.it.crop) x.q = 'crop';
          else if (m === 'scan') { if (x.scan) await setMode(x, 'q', 'ai', true); else if (x.it.crop) x.q = 'crop'; }
          else if (m === 'ai') await setMode(x, 'q', 'ai', true);
        }
        draw();
      });
    };
    const prefs = {};
    async function setMode(x, kind, mode, quiet) {
      const before = cost.usd;
      try {
        if (kind === 'q' && mode === 'ai' && !x.it.stem) { busy.add(x); if (!quiet) draw(); await typeOne(x, cost); }
        if (kind === 's' && mode === 'ai' && !x.it.aiSol) { busy.add(x); if (!quiet) draw(); const b = bookOf(x.w.bookId); x.it.aiSol = await solve(b, x.it, ref('bankItems', itemId(x.w.bookId, x.w.sec, x.w.no)), cost); }
        x[kind] = mode;
      } catch (e) { ctx.toast(`AI 작업 실패: ${e.message} — 잠시 뒤 다시 눌러 주세요`); }
      busy.delete(x);
      if (cost.usd > before) await logUsage(cost.usd - before).catch(() => {});
      if (!quiet) draw();
    }
    async function retry(list) {
      const before = cost.usd;
      list.forEach((x) => busy.add(x)); draw();
      for (const x of list) {
        try { const r = await prepItem(x.w, info.roots, cost); Object.assign(x, r, { err: null }); x.q = x.it.crop && !x.scan ? 'crop' : 'ai'; x.s = x.it.sol ? 'crop' : x.it.aiSol ? 'ai' : 'ans'; await clearRetry(x.w); }
        catch (e) { x.err = e.message; }
        busy.delete(x); draw();
      }
      if (cost.usd > before) await logUsage(cost.usd - before).catch(() => {});
      // 이번 오답노트에 들어간 문항으로 표시
      const fresh = (await fs.getDoc(ref('students', student.id))).data() || {};
      const noted = { ...(fresh.noted || {}) }; rows.filter((x) => !x.err).forEach((x) => { noted[x.w.k || wkey(x.w.bookId, x.w.sec, x.w.no)] ||= info.sheetId; });
      await saveStudent(student.id, { noted });
    }
    draw();
  }

  function buildDoc(student, rows, audience, perPage, cover, scopeName = '', withSol = true) {
    const date = today();
    const byBook = [];
    rows.forEach((x) => { let g = byBook.find((y) => y.title === x.w.title); if (!g) byBook.push(g = { title: x.w.title, xs: [] }); g.xs.push(x); });
    let n = 0;
    const sections = [];
    if (cover) sections.push({ type: 'cover', preset: cover, kicker: 'WRONG NOTE · 1차 오답노트', title: `${student.name}\n오답노트`, subtitle: `${scopeName ? scopeName + ' · ' : ''}${byBook.map((g) => g.title).join(' · ')} · ${date}` });
    const groups = []; const sols = [];
    for (const g of byBook) {
      const items = g.xs.map((x) => {
        n += 1; x.n = n;
        const it = x.it; const chk = it.aiSol?.check;
        const src = `${g.title} · ${x.w.label} ${x.w.no}번 · ${it.page || x.w.page || ''}쪽${x.w.cause ? ' · 원인 ' + x.w.cause : ''}${x.q === 'ai' ? ' · AI 타이핑' : ''}${x.s === 'ai' && chk?.match === false ? ' · GPT 답 ' + chk.gptAnswer + ' 확인 필요' : ''}`;
        const base = { no: n, tag: `${shortLabel(x.w.label)} · ${x.w.no}번`, src };
        return x.q === 'crop' && it.crop ? { ...base, stem: '', figure: { img: it.crop.img, w: it.crop.w, h: it.crop.h, crop: true } }
          : { ...base, stem: it.stem, choices: it.choices, box: it.box, figure: it.figure, pts: it.pts };
      });
      sections.push({ type: 'sheet', chip: '1차 오답', kick: 'WRONG NOTE · 1차 오답노트', title: g.title, unit: `${student.name} · ${scopeName ? scopeName + ' · ' : ''}${date} · ${items.length}문항`, perPage, items });
      groups.push({ title: g.title, nos: items.map((it) => it.no), rows: [{ label: '정답', vals: g.xs.map((x) => x.it.answer || x.it.aiSol?.answer || x.it.answerAI || '해설 참고') }] });
      g.xs.forEach((x) => {
        const answer = x.it.answer || x.it.aiSol?.answer || x.it.answerAI || '';
        if (x.s === 'crop' && x.it.sol) sols.push({ no: x.n, answer, tag: shortLabel(x.w.label) + ' · ' + x.w.no + '번', text: `<img class="crop" src="${x.it.sol.img}" width="${x.it.sol.w}" height="${x.it.sol.h}" style="width:${(x.it.sol.w / 200 * 25.4).toFixed(1)}mm">` });
        else if (x.s === 'ai' && x.it.aiSol) sols.push({ no: x.n, answer, tag: shortLabel(x.w.label) + ' · ' + x.w.no + '번 · AI 풀이', text: x.it.aiSol.solution, key: x.it.aiSol.key });
      });
    }
    sections.push({ type: 'answers', groups });
    if (withSol && sols.length) sections.push({ type: 'solutions', items: sols });
    return { meta: { title: `${student.name} 1차 오답노트`, kick: 'WRONG NOTE · 1차 오답노트', grade: student.grade || '', footer: `${student.name} · 1차 오답노트`, audience }, sections };
  }
  const shortLabel = (s) => String(s || '').replace(/\s*-\s*\d+\s*레벨/, '').replace(/^[^/]+\//, '');

  return { entry, noteSetup, makeNote, removeBook, progress, catalog, bookOf, retryItem };
}
