// "교재 정리" 화면: 폴더 연결 → 목록·중복·단원 수 → 인쇄/PDF, 새벽 분석 대기 목록
import * as F from './folders.js';
import { buildCatalog, isExam } from './catalog.js';
import { printDoc } from './print/print.js';
import { createRunner, tocTask, retypeTask, inWindow } from './analysis.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const bookId = (key) => { let h = 2166136261; for (const ch of key) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return 'b' + (h >>> 0).toString(36); };
const ROLE = { 본책: '본책', '정답·해설': '해설', 빠른정답: '빠른정답', 워크북: '워크북', 부가자료: '부가' };

export function createLibrary(ctx) {
  // ctx: { main, toast, fs: {doc,getDoc,setDoc,getDocs,collection,writeBatch,query,where,orderBy,limit,updateDoc,serverTimestamp,increment}, db, aid, api, openModal, closeModal }
  const { fs, db } = ctx;
  const col = (n) => fs.collection(db, 'academies', ctx.aid(), n);
  const ref = (n, id) => fs.doc(db, 'academies', ctx.aid(), n, id);
  const st = { roots: [], perms: {}, scanning: false, filter: { kind: '', grade: '', q: '' }, books: [], dups: [], sizeReview: [], meta: {}, status: '' };

  async function loadMeta() {
    const snap = await fs.getDocs(col('catalogBooks'));
    st.meta = {}; snap.forEach((d) => (st.meta[d.id] = d.data()));
  }

  async function refreshRoots() {
    st.roots = await F.listRoots();
    for (const r of st.roots) st.perms[r.id] = await F.permission(r);
  }

  async function scanAll() {
    if (st.scanning) return;
    const need = st.roots.filter((r) => st.perms[r.id] !== 'granted');
    if (need.length) { (await F.reconnectAll(need)).forEach(([id, p]) => (st.perms[id] = p)); }
    st.scanning = true; render();
    try {
      const all = [];
      for (const r of st.roots.filter((x) => st.perms[x.id] === 'granted')) {
        st.status = `${r.label} 읽는 중…`; render();
        all.push(...(await F.scan(r, (n) => { st.status = `${r.label} 읽는 중… ${n}개`; renderStatus(); })));
      }
      const c = buildCatalog(all);
      st.books = c.books; st.dups = c.dups; st.sizeReview = c.sizeReview;
      // 교재별 기록 저장(단원 수·선택은 유지)
      let batch = fs.writeBatch(db), n = 0;
      for (const b of c.books) {
        const id = bookId(b.key);
        batch.set(ref('catalogBooks', id), { key: b.key, title: b.title, kind: b.kind, grade: b.grade, roles: b.roles, audience: b.audience, base: b.base, zipped: b.zipped,
          files: b.files.map((f) => ({ label: f.label, rel: f.rel, size: f.size, role: f.role, audience: f.audience, ext: f.ext })), review: b.review.length, seenAt: Date.now() }, { merge: true });
        if (++n % 400 === 0) { await batch.commit(); batch = fs.writeBatch(db); }
      }
      await batch.commit();
      await fs.setDoc(ref('catalogInfo', 'last'), { at: Date.now(), files: all.length, books: c.books.length, dups: c.dups.length, review: c.books.filter((b) => b.review.length).length + c.sizeReview.length });
      await loadMeta();
      st.status = `정리 완료: 파일 ${all.length}개 → 교재 ${c.books.length}종, 중복 ${c.dups.length}개`;
      ctx.toast(st.status);
    } catch (e) { st.status = '오류: ' + e.message; ctx.toast(st.status); }
    st.scanning = false; render();
  }

  const unitsOf = (b) => st.meta[bookId(b.key)]?.units;
  function filtered() {
    const { kind, grade, q } = st.filter;
    return st.books.filter((b) => (!kind || b.kind === kind) && (!grade || b.grade.startsWith(grade)) && (!q || b.title.includes(q)))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.grade.localeCompare(b.grade) || a.title.localeCompare(b.title));
  }

  function renderStatus() { const s = document.getElementById('libStatus'); if (s) s.textContent = st.status; }

  function render() {
    const m = ctx.main();
    if (!F.supported()) { m.innerHTML = '<div class="card">이 기능은 PC의 크롬 또는 엣지에서만 됩니다.</div>'; return; }
    const prompt = st.roots.some((r) => st.perms[r.id] === 'prompt');
    const list = filtered();
    const kinds = [...new Set(st.books.map((b) => b.kind))];
    m.innerHTML = `
      <div class="row between"><h2>교재 정리</h2><div class="row"><button class="ghost" data-l="addRoot">+ 폴더 연결</button><button class="primary" data-l="scan" ${st.scanning ? 'disabled' : ''}>${st.scanning ? '읽는 중…' : '폴더 다시 읽기'}</button></div></div>
      ${prompt ? `<div class="card" style="background:var(--gold-bg)"><div class="row between"><span>크롬을 다시 켜서 MYBOX 폴더 허락이 필요합니다.</span><button class="primary" data-l="reconnect">MYBOX 다시 연결</button></div></div>` : ''}
      <div class="card"><h3>연결된 폴더 ${st.roots.length}곳</h3>
        ${st.roots.length ? st.roots.map((r) => `<div class="row between" style="border-top:1px solid var(--line);padding:6px 0;margin-top:6px"><div><strong>${esc(r.label)}</strong> <span class="badge">${esc(r.category)}</span><div class="muted small">${esc(r.path)} · ${r.fileCount || 0}개 · ${r.lastScan ? new Date(r.lastScan).toLocaleString('ko-KR') : '아직 안 읽음'}</div></div>
          <div class="row"><span class="badge ${st.perms[r.id] === 'granted' ? '' : 'red'}">${st.perms[r.id] === 'granted' ? '연결됨' : '허락 필요'}</span><button class="ghost small danger" data-l="rmRoot" data-id="${r.id}">빼기</button></div></div>`).join('')
        : `<p class="muted small">아래 버튼으로 N: 드라이브의 교재 폴더를 하나씩 연결하세요. 추천 폴더: ${F.DEFAULT_ROOTS.map((d) => esc(d.label)).join(', ')}</p>`}
        <p class="muted small" id="libStatus">${esc(st.status)}</p></div>
      ${st.books.length ? `
      <div class="card"><div class="row between"><h3>교재 ${list.length}종 <span class="muted small">/ 전체 ${st.books.length} · 중복 정리 ${st.dups.length} · 확인 필요 ${st.books.filter((b) => b.review.length).length + st.sizeReview.length}</span></h3>
        <div class="row"><button class="ghost small" data-l="review">확인 필요 보기</button><button class="ghost small" data-l="queueToc">단원 수 분석 대기에 넣기</button><button class="primary small" data-l="print">목록 인쇄 · PDF</button></div></div>
        <div class="row" style="margin:8px 0"><select id="fKind" style="width:auto"><option value="">전체 분류</option>${kinds.map((k) => `<option ${st.filter.kind === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
          <select id="fGrade" style="width:auto"><option value="">전체 학년</option>${['중1', '중2', '중3', '고등'].map((g) => `<option ${st.filter.grade === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
          <input type="text" id="fQ" placeholder="교재 이름 검색" value="${esc(st.filter.q)}" style="flex:1"></div>
        <div style="overflow:auto;max-height:60vh"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:var(--green-bg)"><th style="text-align:left;padding:6px">교재</th><th>학년</th><th>구성</th><th>기준</th><th>단원 수</th></tr></thead><tbody>
        ${list.slice(0, 400).map((b) => { const u = unitsOf(b); return `<tr style="border-bottom:1px solid var(--line)"><td style="padding:6px">${esc(b.title)} ${b.zipped ? '<span class="badge gold">압축 풀기 필요</span>' : ''}${b.review.length ? '<span class="badge red">확인</span>' : ''}</td><td style="text-align:center">${esc(b.grade.replace('고등·', ''))}</td><td style="text-align:center">${Object.keys(b.roles).map((r) => ROLE[r] || r).join('·')}</td><td style="text-align:center">${b.base ? esc(b.base) : ''}</td>
          <td style="text-align:center"><input type="number" min="1" max="40" value="${u || ''}" placeholder="?" data-units="${esc(b.key)}" style="width:64px;min-height:30px;padding:2px 6px"></td></tr>`; }).join('')}
        </tbody></table></div><p class="muted small">단원 수는 목차의 번호 붙은 중단원 수입니다. 새벽 분석이 채우고, 직접 고칠 수도 있습니다.</p></div>` : ''}`;
    document.getElementById('fKind')?.addEventListener('change', (e) => { st.filter.kind = e.target.value; render(); });
    document.getElementById('fGrade')?.addEventListener('change', (e) => { st.filter.grade = e.target.value; render(); });
    document.getElementById('fQ')?.addEventListener('change', (e) => { st.filter.q = e.target.value.trim(); render(); });
    m.querySelectorAll('[data-units]').forEach((inp) => inp.addEventListener('change', async () => {
      const id = bookId(inp.dataset.units); const v = Number(inp.value) || null;
      await fs.setDoc(ref('catalogBooks', id), { units: v, unitsSource: 'manual', unitsAt: Date.now() }, { merge: true });
      st.meta[id] = { ...(st.meta[id] || {}), units: v }; ctx.toast('단원 수 저장');
    }));
  }

  function addRootForm() {
    ctx.openModal(`<h2>폴더 연결</h2><p class="muted small">버튼을 누르면 폴더 고르기 창이 열립니다. N: 드라이브에서 교재 폴더를 고르세요. 읽기만 하고 아무것도 바꾸지 않습니다.</p>
      <label class="f">추천 폴더에서 고르기</label><select id="rPick"><option value="">직접 입력</option>${F.DEFAULT_ROOTS.map((d, i) => `<option value="${i}">${esc(d.label)} — ${esc(d.path)}</option>`).join('')}</select>
      <label class="f">이름</label><input type="text" id="rLabel" placeholder="예) 개인·시중교재 참고">
      <label class="f">원래 경로 (안내용)</label><input type="text" id="rPath" placeholder="N:\\개인\\시중교재 참고자료">
      <label class="f">분류</label><select id="rCat">${['시중교재', '내신대비', '교과서', '2022개정', '기타'].map((c) => `<option>${c}</option>`).join('')}</select>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="ghost" data-a="close">취소</button><button class="primary" id="rGo">폴더 고르기</button></div>`);
    const pick = document.getElementById('rPick');
    pick.onchange = () => { const d = F.DEFAULT_ROOTS[pick.value]; if (!d) return; rLabel.value = d.label; rPath.value = d.path; rCat.value = d.category; };
    document.getElementById('rGo').onclick = async () => {
      try { await F.addRoot({ label: rLabel.value.trim(), path: rPath.value.trim(), category: rCat.value }); ctx.closeModal(); await refreshRoots(); render(); ctx.toast('폴더를 연결했습니다. "폴더 다시 읽기"를 누르세요.'); }
      catch (e) { if (e.name !== 'AbortError') ctx.toast(e.message); }
    };
  }

  function reviewModal() {
    const groups = [];
    st.books.filter((b) => b.review.length).forEach((b) => b.review.forEach((r) => groups.push({ title: b.title, sub: r.role, files: r.files, id: bookId(b.key) })));
    st.sizeReview.forEach((x) => groups.push({ title: x.a[1].split('/').pop(), sub: '크기 같음·이름 다름', files: [[x.a[0], x.a[1], x.size], [x.b[0], x.b[1], x.size]], id: bookId('size|' + x.a[1]) }));
    ctx.openModal(`<h2>확인이 필요한 묶음 ${groups.length}개</h2><p class="muted small">같은 교재로 보이지만 크기가 다른 파일입니다. 사용할 파일을 고르면 다음부터 그 파일을 씁니다. (원본 파일은 지우지 않습니다)</p>
      <div style="max-height:60vh;overflow:auto">${groups.map((g, gi) => `<div class="card"><strong>${esc(g.title)}</strong> <span class="muted small">${esc(g.sub)}</span>
        ${g.files.map((f, i) => `<label style="display:flex;gap:8px;padding:4px 0"><input type="radio" name="g${gi}" value="${esc(f[1])}" data-id="${g.id}" ${st.meta[g.id]?.keep === f[1] ? 'checked' : ''}> <span class="small">${esc(f[0])} · ${esc(f[1])} <span class="muted">(${(f[2] / 1048576).toFixed(1)}MB)</span></span></label>`).join('')}
        <label style="display:flex;gap:8px;padding:4px 0"><input type="radio" name="g${gi}" value="*both" data-id="${g.id}" ${st.meta[g.id]?.keep === '*both' ? 'checked' : ''}> <span class="small">서로 다른 교재(둘 다 사용)</span></label></div>`).join('')}</div>
      <div class="row" style="justify-content:flex-end"><button class="primary" data-a="close">닫기</button></div>`);
    document.querySelectorAll('#modalBody input[type=radio]').forEach((r) => r.addEventListener('change', async () => {
      await fs.setDoc(ref('catalogBooks', r.dataset.id), { keep: r.value, keepAt: Date.now() }, { merge: true });
      st.meta[r.dataset.id] = { ...(st.meta[r.dataset.id] || {}), keep: r.value };
    }));
  }

  async function printCatalog() {
    const rows = filtered().map((b) => { const u = unitsOf(b); return [b.title, b.grade.replace('고등·', ''), Object.keys(b.roles).map((r) => ROLE[r] || r).join('·'), b.base ? b.base + ' 기준' : '', String(b.files.filter((f) => f.ext === 'pdf').length), u ? u + '단원' : '분석 대기', b.zipped ? '압축 풀기 필요' : b.review.length ? '확인 필요' : '']; });
    await printDoc({ meta: { title: '수학도서관 교재 목록', footer: '수학도서관 교재 목록' }, sections: [
      { type: 'catalog', chip: '교재 목록', kick: 'LIBRARY · 교재 목록', title: '교재 목록' + (st.filter.grade ? ' · ' + st.filter.grade : ''), unit: '단원 수 = 목차의 번호 붙은 중단원 수', columns: ['교재', '학년', '구성', '기준', 'PDF', '단원 수', '상태'], rows,
        note: `교재 ${rows.length}종 · ${new Date().toLocaleDateString('ko-KR')} 기준` },
      { type: 'catalog', chip: '중복 정리', kick: 'CLEAN-UP · 자동 정리', title: '자동으로 정리한 중복 파일', unit: '원본은 그대로 두고 목록에서만 하나로 묶음', columns: ['파일', '위치', '판정'], rows: st.dups.map((d) => [d.rel.split('/').pop(), d.label, d.kind]) },
    ] });
  }

  // ---------- 새벽 분석 ----------
  // 우선순위: 0 중2-2 내신대비 → 1 중2-2 기타 → 2 다른 중등 → 3 나머지
  const prioOf = (b) => (b.grade.startsWith('중2-2') ? (b.kind === '내신대비' ? 0 : 1) : b.grade.startsWith('중') ? 2 : 3);
  async function queueToc() {
    const todo = st.books.filter((b) => !unitsOf(b) && !b.zipped && b.files.some((f) => f.ext === 'pdf' && f.role === '본책') && !['교과서 자료', '한글/기타', '수업자료', '기출·시험지'].includes(b.kind));
    const want = new Set(todo.map((b) => 'toc_' + bookId(b.key)));
    let batch = fs.writeBatch(db), n = 0;
    const step = async () => { if (++n % 400 === 0) { await batch.commit(); batch = fs.writeBatch(db); } };
    for (const b of todo) {
      const f = b.files.find((x) => x.ext === 'pdf' && x.role === '본책' && x.audience === '교사용') || b.files.find((x) => x.ext === 'pdf' && x.role === '본책');
      batch.set(ref('analysisQueue', 'toc_' + bookId(b.key)), { task: 'toc', bookId: bookId(b.key), title: b.title, label: f.label, rel: f.rel, status: 'queued', createdAt: Date.now(), priority: prioOf(b) }, { merge: true });
      await step();
    }
    // 예전에 넣었지만 이제 대상이 아닌 것(학교 시험지 등)은 건너뜀으로 표시
    let skipped = 0;
    const old = await fs.getDocs(fs.query(col('analysisQueue'), fs.where('status', '==', 'queued')));
    for (const d of old.docs) if (d.data().task === 'toc' && !want.has(d.id)) { batch.update(d.ref, { status: 'skipped' }); skipped++; await step(); }
    await batch.commit();
    const first = todo.filter((b) => prioOf(b) === 0).length;
    ctx.toast(`단원 수 분석 대기 ${todo.length}권 (중2-2 내신대비 ${first}권부터)` + (skipped ? ` · 시험지 등 ${skipped}건 제외` : ''));
  }

  const runner = createRunner({
    api: ctx.api,
    getSettings: async () => (await fs.getDoc(ref('settings', 'nightly'))).data() || {},
    todaySpent: async () => (await fs.getDoc(ref('aiUsage', new Date().toISOString().slice(0, 10)))).data()?.usd || 0,
    nextTask: async () => {
      // 프로그램을 켠 뒤 교재 정리 탭을 한 번도 안 열었어도 폴더·교재 정보를 직접 불러옴
      if (!st.roots.length) await refreshRoots();
      if (!Object.keys(st.meta).length) await loadMeta();
      // 색인 없이 쓰려고 '상태 + 우선순위' 같음 조건으로만 차례대로 찾음
      for (let p = 0; p <= 3; p++) {
        const s = await fs.getDocs(fs.query(col('analysisQueue'), fs.where('status', '==', 'queued'), fs.where('priority', '==', p), fs.limit(30)));
        for (const x of [...s.docs].sort((a, b) => (a.data().createdAt || 0) - (b.data().createdAt || 0))) {
          const t = x.data(); const m = st.meta[t.bookId];
          // 오답노트에서 빠진 문항 다시 시도
          if (t.task === 'item') { if (!ctx.itemTask) continue; return { id: x.id, ref: x.ref, title: t.title, task: t, run: ctx.itemTask(t) }; }
          // 학교 시험지로 다시 분류됐거나 이미 단원 수가 있는 교재는 건너뜀
          if (t.task === 'toc' && (m?.kind === '기출·시험지' || isExam(t.title) || m?.units)) { await fs.updateDoc(x.ref, { status: 'skipped' }); continue; }
          const r = st.roots.find((rr) => rr.label === t.label);
          if (!r) { await fs.updateDoc(x.ref, { status: 'waiting-folder' }); continue; }
          // 크롬을 다시 켜서 폴더 허락이 풀렸으면, 대기 목록은 그대로 두고 멈춤 (아침에 "MYBOX 다시 연결"을 누르면 다음 밤에 이어서)
          if ((await F.permission(r)) !== 'granted') { ctx.toast?.('MYBOX 폴더 허락이 필요해 새벽 분석을 쉬었습니다'); return null; }
          const file = await F.openFile(r, t.rel);
          return { id: x.id, ref: x.ref, title: t.title, task: t, run: t.task === 'toc' ? tocTask({ file, title: t.title }) : retypeTask({ file, title: t.title, cursor: t.cursor || 1 }) };
        }
      }
      return null;
    },
    saveResult: async (task, res) => {
      if (res.error) { await fs.updateDoc(task.ref, { status: 'error', error: res.error, at: Date.now() }); return; }
      if (res.kind === 'item') { await fs.updateDoc(task.ref, { status: 'done', at: Date.now() }); return; }
      if (res.kind === 'toc') {
        await fs.setDoc(ref('catalogBooks', task.task.bookId), { units: res.count, toc: res.units, unitsSource: 'ai', unitsAt: Date.now() }, { merge: true });
        await fs.updateDoc(task.ref, { status: 'done', at: Date.now(), count: res.count });
      } else {
        let batch = fs.writeBatch(db);
        res.items.forEach((it, i) => batch.set(fs.doc(col('bankItems')), { ...it, bookId: task.task.bookId, status: 'review', createdAt: Date.now() }));
        await batch.commit();
        await fs.updateDoc(task.ref, { status: res.done ? 'done' : 'queued', cursor: res.cursor, at: Date.now() });
      }
    },
    logUsage: async (u) => { await fs.setDoc(ref('aiUsage', new Date().toISOString().slice(0, 10)), { usd: fs.increment(u.usd || 0), input: fs.increment(u.input || 0), output: fs.increment(u.output || 0), calls: fs.increment(1) }, { merge: true }); },
    onStatus: (s) => { st.status = s; renderStatus(); },
  });

  // 클릭
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-l]'); if (!b) return;
    const a = b.dataset.l;
    if (a === 'addRoot') addRootForm();
    if (a === 'scan') scanAll();
    if (a === 'reconnect') { (await F.reconnectAll(st.roots)).forEach(([id, p]) => (st.perms[id] = p)); render(); }
    if (a === 'rmRoot' && confirm('이 폴더 연결을 뺄까요? (파일은 그대로)')) { await F.removeRoot(b.dataset.id); await refreshRoots(); render(); }
    if (a === 'review') reviewModal();
    if (a === 'print') printCatalog().catch((er) => ctx.toast(er.message));
    if (a === 'queueToc') queueToc();
  });

  return {
    async show() {
      await refreshRoots(); await loadMeta();
      if (!st.books.length) st.books = Object.values(st.meta).filter((m) => m.title).map((m) => ({ ...m, review: Array(m.review || 0).fill({}), files: m.files || [], roles: m.roles || {}, audience: m.audience || [] }));
      render();
    },
    runner,
    inWindow,
  };
}
