// 학생 오답 입력 → 1차 오답노트(원본 문항 재타이핑 + 빠른정답)
// - 교재는 "교재 정리"에서 읽은 목록(catalogBooks)을 씁니다.
// - 문항 위치·정답은 PDF 글자층에서 읽고(무료), 문항 재타이핑만 AI를 씁니다. 한 번 타이핑한 쪽은 문항 은행에 저장돼 다시 쓰지 않습니다.
import * as F from './folders.js';
import { openPdf } from './analysis.js';
import { readOutline, readAnswers, normNo } from './outline.js';
import { printDoc } from './print/print.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const clean = (o) => JSON.parse(JSON.stringify(o)); // Firestore는 undefined를 받지 않음
const CAUSES = ['계산', '개념', '조건', '시간', '찍음'];
const today = () => new Date().toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
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
    if (b.outline?.v === 1) return b.outline;
    const pdf = await openBookPdf(b, 'q', roots);
    if (!pdf) throw new Error('이 교재의 문제 PDF를 찾지 못했습니다.');
    const o = await readOutline(pdf, onProgress);
    let ans = {};
    try { const ap = await openBookPdf(b, 'a', roots); if (ap) ans = await readAnswers(ap, o.sections.map((s) => s.key)); } catch { /* 해설 없음 */ }
    const outline = { v: 1, sections: o.sections, where: o.where, textPages: o.textPages, pages: o.pages, ans, at: Date.now() };
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
    const st = { bid: mine[0]?.id || '', type: '내신대비', picked: {}, solved: new Set(), causes: {}, q: '' };

    const draw = async () => {
      const b = bookOf(st.bid);
      ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 오답 입력</h2>
        <div class="row"><select id="wBook" style="flex:1"><option value="">교재 고르기</option>${mine.map((x) => `<option value="${x.id}" ${x.id === st.bid ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}${b && !mine.includes(b) ? `<option value="${b.id}" selected>${esc(b.title)}</option>` : ''}</select>
          <select id="wType" style="width:auto"><option ${st.type === '내신대비' ? 'selected' : ''}>내신대비</option><option ${st.type === '수업' ? 'selected' : ''}>수업</option></select></div>
        <div class="row" style="margin-top:6px"><input type="text" id="wFind" placeholder="다른 교재 찾기 (이름 일부)" value="${esc(st.q)}" style="flex:1"><button class="ghost small" id="wFindGo">찾기</button></div>
        <div id="wFound"></div>
        <div id="wGrid" style="margin-top:10px">${b ? '<p class="muted small">교재 구역을 읽는 중… (처음 한 번만, 몇 초 걸립니다)</p>' : '<p class="muted small">교재를 고르세요.</p>'}</div>
        <div class="row between" style="margin-top:14px"><span class="muted small" id="wSum"></span><div class="row"><button class="ghost" data-a="close">취소</button><button class="primary" id="wSave">저장</button></div></div></div>`);
      document.getElementById('wBook').onchange = (e) => { st.bid = e.target.value; st.picked = {}; st.solved = new Set(); draw(); };
      document.getElementById('wType').onchange = (e) => { st.type = e.target.value; };
      const find = () => {
        st.q = document.getElementById('wFind').value.trim(); if (!st.q) return;
        const hits = list.filter((x) => x.title.includes(st.q)).slice(0, 30);
        document.getElementById('wFound').innerHTML = `<div class="list" style="max-height:180px">${hits.map((x) => `<button data-pick="${x.id}"><span>${esc(x.title)}</span><span class="muted small">${esc(x.grade || '')} ${esc(x.kind || '')}</span></button>`).join('') || '<p class="muted small pad">찾는 교재가 없습니다.</p>'}</div>`;
        document.querySelectorAll('[data-pick]').forEach((btn) => btn.onclick = async () => {
          st.bid = btn.dataset.pick; st.picked = {}; st.solved = new Set();
          const ids = [...new Set([...(student.catalogIds || []), st.bid])];
          await saveStudent(student.id, { catalogIds: ids }); student.catalogIds = ids; mine.push(bookOf(st.bid));
          draw();
        });
      };
      document.getElementById('wFindGo').onclick = find;
      document.getElementById('wFind').onkeydown = (e) => { if (e.key === 'Enter') find(); };
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

  // ---------- 1차 오답노트 ----------
  async function makeNote(student, recordIds) {
    const recs = (student.records || []).filter((r) => recordIds.includes(r.id));
    const wrongs = []; const seen = new Set();
    recs.forEach((r) => r.wrongs.forEach((w) => { const k = r.bookId + '|' + w.sec + '|' + normNo(w.no); if (!seen.has(k)) { seen.add(k); wrongs.push({ ...w, bookId: r.bookId, title: r.title }); } }));
    if (!wrongs.length) return ctx.toast('고른 기록에 틀린 문항이 없습니다.');
    const log = [];
    const show = (done, total, extra = '') => ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 1차 오답노트 만드는 중</h2>
      <div class="progress" style="margin:10px 0"><div style="width:${Math.round((done / total) * 100)}%"></div></div>
      <p class="small">${done} / ${total}문항 ${extra}</p><div class="muted small" style="max-height:30vh;overflow:auto">${log.slice(-12).map(esc).join('<br>')}</div></div>`);
    let roots;
    try { roots = await ensureFolders(); } catch (e) { return ctx.toast(e.message); }
    show(0, wrongs.length);
    await catalog();
    const out = []; let usd = 0; const fail = [];
    for (let i = 0; i < wrongs.length; i++) {
      const w = wrongs[i];
      const b = bookOf(w.bookId);
      try {
        if (!b) throw new Error('교재 정보를 찾지 못했습니다');
        const o = w.sec.startsWith('p') && !b.outline ? { sections: [], where: {}, ans: {} } : await outlineOf(b, roots);
        const id = itemId(b.id, w.sec, w.no);
        let snap = await fs.getDoc(ref('bankItems', id));
        if (!snap.exists()) {
          const page = w.page || o.where?.[w.sec + '|' + normNo(w.no)];
          if (!page) throw new Error('문항 위치를 찾지 못했습니다');
          log.push(`${b.title} ${page}쪽 타이핑 중…`); show(i, wrongs.length, `· AI 사용 $${usd.toFixed(2)}`);
          usd += await retypePage(b, o, page, roots);
          snap = await fs.getDoc(ref('bankItems', id));
          if (!snap.exists() && o.pages && page < o.pages) { usd += await retypePage(b, o, page + 1, roots); snap = await fs.getDoc(ref('bankItems', id)); }
          if (!snap.exists()) throw new Error(`${page}쪽에서 ${w.no}번을 읽지 못했습니다`);
        }
        const it = snap.data();
        out.push({ w, it, answer: o.ans?.[w.sec + '|' + normNo(w.no)] || it.answer || '' });
        log.push(`✓ ${w.label} ${w.no}번`);
      } catch (e) { fail.push(`${w.title} · ${w.label} ${w.no}번 — ${e.message}`); log.push(`✗ ${w.label} ${w.no}번 — ${e.message}`); }
      show(i + 1, wrongs.length, `· AI 사용 $${usd.toFixed(2)}`);
    }
    if (usd) await logUsage(usd);
    const sheet = { id: 's' + Date.now().toString(36), kind: '1차', at: Date.now(), records: recordIds, count: out.length };
    await saveStudent(student.id, { sheets: fs.arrayUnion(sheet) });
    preview(student, out, fail, usd);
  }

  async function logUsage(usd) {
    await fs.setDoc(ref('aiUsage', new Date().toISOString().slice(0, 10)), { usd: fs.increment(usd), calls: fs.increment(1) }, { merge: true });
  }

  // 한 쪽 재타이핑 → 문항 은행에 저장. 반환: 쓴 비용($)
  async function retypePage(b, o, page, roots) {
    const pdf = await openBookPdf(b, 'q', roots);
    const pg = await pdf.getPage(page);
    const vp1 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: 1300 / vp1.width });
    const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    const image = cv.toDataURL('image/jpeg', 0.82).split(',')[1];
    const r = await ctx.ai('/ai/retype', { title: b.title, page, image });
    const secOf = (no) => { for (const s of o.sections || []) if (s.pages.includes(page) && s.nos.some((n) => normNo(n) === normNo(no))) return s.key; return (o.sections || []).find((s) => s.pages.includes(page))?.key || 'p' + page; };
    const batch = fs.writeBatch(db);
    for (const it of r.items || []) {
      const no = normNo(it.no); if (!no) continue;
      let figure = it.figure || null;
      if (figure?.needsRedraw && Array.isArray(figure.bbox)) figure = { img: crop(cv, figure.bbox), crop: true };
      else if (figure && !figure.svg) figure = null;
      const sec = secOf(it.no);
      batch.set(ref('bankItems', itemId(b.id, sec, no)), clean({ bookId: b.id, sec, page, no: it.no, nkey: no, unit: it.unit || '', stem: it.stem || '', choices: it.choices || null, box: it.box || null, figure, answer: it.answer || '', pts: it.pts || null, status: 'review', source: 'retype', at: Date.now() }));
    }
    batch.set(ref('catalogBooks', b.id), { retyped: { [page]: Date.now() } }, { merge: true });
    await batch.commit();
    return r.usage?.usd || 0;
  }
  function crop(cv, [x0, y0, x1, y1]) {
    const pad = 0.01; const W = cv.width, H = cv.height;
    const sx = Math.max(0, (x0 - pad) * W), sy = Math.max(0, (y0 - pad) * H), sw = Math.min(W, (x1 + pad) * W) - sx, sh = Math.min(H, (y1 + pad) * H) - sy;
    const k = Math.min(1, 700 / sw); const c = document.createElement('canvas'); c.width = sw * k; c.height = sh * k;
    c.getContext('2d').drawImage(cv, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  function preview(student, out, fail, usd) {
    ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 1차 오답노트 준비 완료</h2>
      <p class="small">문항 ${out.length}개${usd ? ` · 이번에 쓴 AI 비용 $${usd.toFixed(2)}` : ' · 모두 문항 은행에 있던 문항이라 AI 비용 없음'}</p>
      ${fail.length ? `<div class="card" style="background:var(--red-bg)"><b class="small">빠진 문항 ${fail.length}개</b><div class="small">${fail.map(esc).join('<br>')}</div></div>` : ''}
      <div class="row" style="margin-top:10px"><label class="small">한 쪽 문항 수</label><select id="nPer" style="width:auto"><option value="2">2문항</option><option value="4" selected>4문항</option><option value="6">6문항</option></select>
        <label class="small">표지</label><select id="nCover" style="width:auto"><option value="">없음</option><option value="classic">클래식</option><option value="insta">인스타 감성</option><option value="premium">프리미엄</option><option value="minimal">미니멀</option></select></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="ghost" data-a="close">닫기</button><button class="ghost" id="nTeacher">선생님용 (출처 표시)</button><button class="primary" id="nStudent">학생용 미리보기 · 인쇄</button></div></div>`);
    const go = (aud) => printDoc(buildDoc(student, out, aud, Number(document.getElementById('nPer').value), document.getElementById('nCover').value), { autoPrint: false }).catch((e) => ctx.toast(e.message));
    document.getElementById('nStudent').onclick = () => go('student');
    document.getElementById('nTeacher').onclick = () => go('teacher');
  }

  function buildDoc(student, out, audience, perPage, cover) {
    const date = today();
    const byBook = [];
    out.forEach((x) => { let g = byBook.find((y) => y.title === x.w.title); if (!g) byBook.push(g = { title: x.w.title, xs: [] }); g.xs.push(x); });
    let n = 0;
    const sections = [];
    if (cover) sections.push({ type: 'cover', preset: cover, kicker: 'WRONG NOTE · 1차 오답노트', title: `${student.name}\n오답노트`, subtitle: `${byBook.map((g) => g.title).join(' · ')} · ${date}` });
    const groups = [];
    for (const g of byBook) {
      const items = g.xs.map((x) => { n += 1; return { no: n, tag: `${shortLabel(x.w.label)} · ${x.w.no}번`, stem: x.it.stem, choices: x.it.choices, box: x.it.box, figure: x.it.figure, pts: x.it.pts, src: `${g.title} · ${x.w.label} ${x.w.no}번 · ${x.it.page}쪽${x.w.cause ? ' · 원인 ' + x.w.cause : ''}` }; });
      sections.push({ type: 'sheet', chip: '1차 오답', kick: 'WRONG NOTE · 1차 오답노트', title: g.title, unit: `${student.name} · ${date} · ${items.length}문항`, perPage, items });
      groups.push({ title: g.title, nos: items.map((it) => it.no), rows: [{ label: '정답', vals: g.xs.map((x) => x.answer || '해설 참고') }] });
    }
    sections.push({ type: 'answers', groups });
    return { meta: { title: `${student.name} 1차 오답노트`, kick: 'WRONG NOTE · 1차 오답노트', grade: student.grade || '', footer: `${student.name} · 1차 오답노트`, audience }, sections };
  }
  const shortLabel = (s) => String(s || '').replace(/\s*-\s*\d+\s*레벨/, '').replace(/^[^/]+\//, '');

  return { entry, makeNote, catalog, bookOf };
}
