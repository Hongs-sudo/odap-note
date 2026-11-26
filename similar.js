// 2차 유사문항: 1차 오답노트 → 문항마다 같은 수준(유사1)·한 단계 위(유사2) 문항을 찾아 두 세트로 만듦
// - 시험 대비 준비: 시험 기간에 한 번 누르면 같은 학년 학원 교재 문항을 미리 모으고(무료) 단원·유형·난이도를 붙여 둠(AI)
// - 후보는 이 학생에게 배정되지 않은 교재에서만, 모자라면 AI 변형 문항(다른 AI가 따로 풀어 확인)
import * as F from './folders.js';
import { pageText, normNo } from './outline.js';
import { problemText, cropProblem, toJpegBase64 } from './crop.js';
import { printDoc } from './print/print.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (o) => JSON.parse(JSON.stringify(o));
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const gnum = (g) => (String(g || '').match(/[1-3]/) || [])[0] || '';
const md = (t) => new Date(t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
// 단원 이름 비슷한 정도 (한글 두 글자씩 겹치는 비율)
const grams = (s) => { const t = String(s || '').replace(/[^가-힣a-zA-Z]/g, ''); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
export const unitSim = (a, b) => { const A = grams(a), B = grams(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach((x) => { if (B.has(x)) n++; }); return n / Math.min(A.size, B.size); };
const SETS = [{ k: '2차-① 유사1', short: '유사1', lv: 'same', label: '같은 수준' }, { k: '2차-② 유사2', short: '유사2', lv: 'up', label: '한 단계 위' }];
const examNames = () => {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1;
  const now = m >= 8 || m <= 1 ? [`${m <= 1 ? y - 1 : y} 2학기 ${m >= 8 && m <= 10 ? '중간' : '기말'}`] : [`${y} 1학기 ${m <= 5 ? '중간' : '기말'}`];
  const ny = m >= 8 ? y + 1 : y;
  return [...new Set([...now, `${y} 2학기 기말`, `${ny} 1학기 중간`, `${ny} 1학기 기말`, `${ny} 2학기 중간`, `${ny} 2학기 기말`])];
};

export function createSimilar(ctx) {
  // ctx: { W: wr(), fs, db, aid, toast, openModal, closeModal, uid, role(), students(), sets(), groups(list), filterChips(list) }
  const { fs, db } = ctx;
  const W = () => ctx.W().internals;
  const col = (n) => fs.collection(db, 'academies', ctx.aid(), n);
  const ref = (n, id) => fs.doc(db, 'academies', ctx.aid(), n, id);
  const aiCall = (p, b) => W().aiCall(p, b);

  // ---------- 시험 대비 준비 ----------
  const preps = async () => (await fs.getDocs(col('examScopes'))).docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.kind === 'prep').sort((a, b) => (b.at || 0) - (a.at || 0));
  // 학년에 맞는 학원 교재 (세트 교재 + 교재 정리의 같은 학년 교재)
  async function gradeBooks(g) {
    const list = await ctx.W().catalog();
    const sem = new Date().getMonth() + 1 >= 7 || new Date().getMonth() + 1 <= 1 ? '2' : '1';
    return list.filter((b) => !b.retired && !b.replacedBy && gnum(b.grade) === g && (b.source === 'folder-set' || (['내신대비', '시중교재'].includes(b.kind) && (!/-/.test(b.grade || '') || String(b.grade).endsWith('-' + sem)))));
  }
  async function newPrep() {
    ctx.openModal('<p class="pad center">교재 목록 불러오는 중…</p>');
    const G = {};
    for (const g of ['1', '2', '3']) {
      const books = await gradeBooks(g);
      const units = [...new Set(books.filter((b) => b.source === 'folder-set' && b.outline?.sections).flatMap((b) => b.outline.sections.map((s) => W().unitName(s.label))))].filter(Boolean);
      G[g] = { books, units, on: new Set(books.map((b) => b.id)), uon: new Set(units) };
    }
    const st = { exam: examNames().find((x) => /기말/.test(x)) || examNames()[0], grades: new Set(['1', '2']) };
    const draw = () => {
      ctx.openModal(`<div class="wide"><h2>새 시험 준비</h2><p class="muted small">고른 범위의 유사문항 후보를 새벽 분석이 미리 모아 둡니다. 문항 모으기는 무료, 단원·난이도 표시만 AI 비용이 듭니다(하루 예산 안에서 나눠 처리).</p>
        <div class="row" style="gap:14px;flex-wrap:wrap"><span class="small"><b>시험</b> <select id="pExam" style="width:auto">${examNames().map((x) => `<option ${x === st.exam ? 'selected' : ''}>${x}</option>`).join('')}</select></span>
          <span class="small"><b>학년</b> ${['1', '2', '3'].map((g) => `<label><input type="checkbox" data-g="${g}" ${st.grades.has(g) ? 'checked' : ''}> 중${g}</label>`).join(' ')}</span></div>
        <div style="max-height:56vh;overflow:auto;margin-top:8px">${[...st.grades].sort().map((g) => { const x = G[g]; return `<div class="card"><b>중${g}</b>
          <div class="small" style="margin-top:6px"><b>범위 단원</b> <span class="muted">(학생 교재에서 읽은 단원 · 이번 시험 범위만 남기세요)</span><br>${x.units.length ? x.units.map((u) => `<label style="display:inline-block;margin:2px 10px 2px 0"><input type="checkbox" data-u="${g}|${esc(u)}" ${x.uon.has(u) ? 'checked' : ''}> ${esc(u)}</label>`).join('') : '<span class="muted">아직 읽은 단원이 없습니다. 이대로 시작하면 학기 전체를 모읍니다.</span>'}</div>
          <div class="small" style="margin-top:6px"><b>모을 교재 ${x.on.size}권</b><br>${x.books.map((b) => `<label style="display:inline-block;margin:2px 10px 2px 0"><input type="checkbox" data-b="${g}|${b.id}" ${x.on.has(b.id) ? 'checked' : ''}> ${esc(b.title)}</label>`).join('') || '<span class="muted">같은 학년 교재가 없습니다</span>'}</div></div>`; }).join('')}</div>
        <div class="row between" style="margin-top:10px"><span class="muted small">학생에게 배정된 교재도 모아 두지만, 그 학생의 유사문항 후보에서는 빠집니다.</span><div class="row"><button class="ghost" data-a="close">취소</button><button class="primary" id="pGo">준비 시작</button></div></div></div>`);
      document.getElementById('pExam').onchange = (e) => { st.exam = e.target.value; };
      document.querySelectorAll('[data-g]').forEach((c) => c.onchange = () => { c.checked ? st.grades.add(c.dataset.g) : st.grades.delete(c.dataset.g); draw(); });
      document.querySelectorAll('[data-u]').forEach((c) => c.onchange = () => { const [g, u] = [c.dataset.u.slice(0, 1), c.dataset.u.slice(2)]; c.checked ? G[g].uon.add(u) : G[g].uon.delete(u); });
      document.querySelectorAll('[data-b]').forEach((c) => c.onchange = () => { const [g, id] = [c.dataset.b.slice(0, 1), c.dataset.b.slice(2)]; c.checked ? G[g].on.add(id) : G[g].on.delete(id); });
      document.getElementById('pGo').onclick = async () => {
        if (!st.grades.size) return ctx.toast('학년을 고르세요.');
        const batch = fs.writeBatch(db); const now = Date.now();
        for (const g of st.grades) {
          const x = G[g]; const ids = [...x.on]; if (!ids.length) continue;
          const pid = 'prep_' + hash(st.exam + '|' + g);
          batch.set(ref('examScopes', pid), clean({ kind: 'prep', name: st.exam, grade: `중${g}`, units: [...x.uon], bookIds: ids, at: now, by: ctx.uid(), stats: { books: ids.length, pooled: 0, items: 0, tagged: 0, inRange: 0 } }));
          for (const id of ids) {
            const b = x.books.find((y) => y.id === id); const f = (b.files || []).find((ff) => ff.role === '본책') || (b.files || [])[0];
            batch.set(ref('analysisQueue', `pool_${pid}_${id}`), clean({ task: 'pool', prepId: pid, bookId: id, title: `유사문항 모으기 · ${b.title}`, label: f?.label || '', rel: f?.rel || '', status: 'queued', priority: 1, rank: 1, createdAt: now }));
          }
          batch.set(ref('analysisQueue', `tag_${pid}`), { task: 'tag', prepId: pid, title: `단원·난이도 표시 · ${st.exam} 중${g}`, status: 'queued', priority: 1, rank: 2, createdAt: now });
        }
        await batch.commit();
        ctx.closeModal(); ctx.toast('시험 준비를 넣었습니다. 오늘 밤 새벽 분석에서 처리합니다'); render();
      };
    };
    draw();
  }

  // 새벽 분석: 교재 한 권의 문항 글자 모으기 (무료)
  async function runPool(t) {
    const prep = (await fs.getDoc(ref('examScopes', t.prepId))).data(); if (!prep) return { kind: 'pool' };
    await ctx.W().catalog();
    const b = ctx.W().bookOf(t.bookId); if (!b) throw new Error('교재 정보를 찾지 못했습니다');
    const roots = await F.listRoots();
    const o = await W().outlineOf(b, roots);
    if (W().isScan(o)) { await fs.updateDoc(ref('examScopes', t.prepId), { 'stats.pooled': fs.increment(1) }); return { kind: 'pool', skipped: '스캔본' }; }
    const pdf = await W().openBookPdf(b, 'q', roots);
    const had = new Map((await fs.getDocs(fs.query(col('bankItems'), fs.where('bookId', '==', b.id)))).docs.map((d) => [d.id, d.data()]));
    const byPage = new Map();
    for (const s of o.sections || []) for (const no of s.nos || []) {
      const p = o.where?.[s.key + '|' + normNo(no)]; if (!p) continue;
      if (!byPage.has(p)) byPage.set(p, []); byPage.get(p).push({ s, no });
    }
    const units = prep.units || [];
    let batch = fs.writeBatch(db), n = 0, cnt = 0, inr = 0;
    const step = async () => { if (++n % 400 === 0) { await batch.commit(); batch = fs.writeBatch(db); } };
    for (const [p, list] of byPage) {
      const pt = await pageText(pdf, p);
      for (const { s, no } of list) {
        const id = W().itemId(b.id, s.key, no); const old = had.get(id) || {};
        const text = old.text || problemText(pt, no);
        const u0 = W().unitName(s.label);
        const inRange = !units.length || units.some((u) => unitSim(u, u0) >= 0.5 || unitSim(u, s.label) >= 0.5);
        batch.set(ref('bankItems', id), clean({ bookId: b.id, sec: s.key, no, nkey: normNo(no), page: p, text, label: s.label, unit0: u0, grade: prep.grade, prep: t.prepId, inRange,
          tagged: !!old.tag || !inRange, ...(o.ans?.[s.key + '|' + normNo(no)] && !old.answer ? { answer: o.ans[s.key + '|' + normNo(no)] } : {}), status: old.status || 'pool', at: old.at || Date.now() }), { merge: true });
        cnt++; if (inRange) inr++; await step();
      }
    }
    batch.update(ref('examScopes', t.prepId), { 'stats.pooled': fs.increment(1), 'stats.items': fs.increment(cnt), 'stats.inRange': fs.increment(inr) });
    await batch.commit();
    return { kind: 'pool', count: cnt };
  }
  // 새벽 분석: 단원·유형·난이도 표시 (25문항씩, 남으면 다음에 이어서)
  async function runTag(t) {
    const prep = (await fs.getDoc(ref('examScopes', t.prepId))).data(); if (!prep) return { kind: 'tag', more: false };
    const q = await fs.getDocs(fs.query(col('bankItems'), fs.where('prep', '==', t.prepId), fs.where('tagged', '==', false), fs.limit(25)));
    if (!q.docs.length) {
      const left = await fs.getDocs(fs.query(col('analysisQueue'), fs.where('status', '==', 'queued'), fs.where('task', '==', 'pool')));
      return { kind: 'tag', more: left.docs.some((d) => d.data().prepId === t.prepId) }; // 아직 모으는 중이면 다음에 다시
    }
    // 글자층이 있으면 글자로, 없으면(그림처럼 된 교재) 문항을 잘라 그림으로 보냄 (한 번에 그림 12개까지)
    const docs = q.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
    const texts = docs.filter((d) => (d.text || '').length > 12);
    const imgs = docs.filter((d) => (d.text || '').length <= 12).slice(0, 12);
    const items = texts.map((d) => ({ id: d.id, sec: d.label, text: d.text }));
    const roots = imgs.length ? await F.listRoots() : [];
    const done = new Set(texts.map((d) => d.id));
    for (const d of imgs) {
      try {
        const b = ctx.W().bookOf(d.bookId) || (await ctx.W().catalog(), ctx.W().bookOf(d.bookId));
        const pdf = await W().openBookPdf(b, 'q', roots);
        const c = pdf && d.page ? await cropProblem(pdf, d.page, d.no) : null;
        if (c) { items.push({ id: d.id, sec: d.label, image: await toJpegBase64(c.img, 700) }); done.add(d.id); }
        else { await fs.updateDoc(d.ref, { tagged: true }); } // 위치를 못 찾은 문항은 건너뜀
      } catch { /* 폴더 허락이 없으면 다음에 */ }
    }
    if (!items.length) return { kind: 'tag', more: true };
    const r = await aiCall('/ai/tag', { grade: prep.grade, units: prep.units || [], items });
    const by = Object.fromEntries((r.items || []).map((x) => [x.id, x]));
    const batch = fs.writeBatch(db);
    docs.filter((d) => done.has(d.id)).forEach((d) => { const x = by[d.id]; batch.update(d.ref, { tagged: true, ...(x ? { tag: clean({ unit: x.unit || '', type: x.type || '', level: Number(x.level) || null }) } : {}), ...(x?.summary && (d.text || '').length <= 12 ? { text: x.summary, textFrom: 'ai' } : {}) }); });
    batch.update(ref('examScopes', t.prepId), { 'stats.tagged': fs.increment(done.size) });
    await batch.commit();
    return { kind: 'tag', more: true, usage: r.usage };
  }

  // ---------- 유사문항 탭 ----------
  async function render() {
    const main = document.getElementById('main');
    const owner = ctx.role() === 'owner';
    let list = owner ? ctx.students() : ctx.students().filter((s) => s.teacherUid === ctx.uid());
    const { chips, filtered } = ctx.filterChips(list); list = filtered;
    let P = []; try { P = await preps(); } catch { /* 처음 */ }
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    main.innerHTML = `<div class="row between"><h2>유사문항 (2차)</h2>${owner ? '<button class="primary" id="pNew">+ 새 시험 준비</button>' : ''}</div>
      <div class="card"><h3 style="margin:0 0 6px">시험 대비 준비</h3><p class="muted small" style="margin:0 0 6px">시험 기간이 시작될 때 한 번 누르면, 그 범위의 유사문항 후보를 새벽에 미리 모아 둡니다.</p>
        ${P.length ? `<table class="small" style="width:100%;border-collapse:collapse">${P.map((p) => { const s = p.stats || {}; return `<tr style="border-top:1px solid var(--line)"><td style="padding:6px"><b>${esc(p.name)}</b> · ${esc(p.grade)}</td><td>${(p.units || []).length ? esc(p.units.slice(0, 4).join(', ')) + (p.units.length > 4 ? ' …' : '') : '학기 전체'}</td>
          <td>교재 ${s.pooled || 0}/${s.books || 0}권 · 문항 ${s.items || 0}</td><td><span class="prog"><span class="bar" style="width:160px"><i style="width:${pct(s.tagged || 0, s.inRange || 0)}%"></i></span></span> 단원·난이도 ${pct(s.tagged || 0, s.inRange || 0)}%</td></tr>`; }).join('')}</table>`
          : '<p class="muted small">아직 준비한 시험이 없습니다. 준비 없이도 유사문항은 만들 수 있지만, 미리 준비해 두면 후보가 더 잘 맞고 빨리 나옵니다.</p>'}</div>
      ${chips}
      ${ctx.groups(list).map(([g, xs]) => `<h3 style="margin:18px 0 6px;color:var(--green)">${esc(g)} <span class="muted small">· ${xs.length}명</span></h3>${xs.map(studentCard).join('')}`).join('') || '<div class="empty">학생이 없습니다.</div>'}`;
    document.getElementById('pNew')?.addEventListener('click', () => newPrep().catch((e) => ctx.toast(e.message)));
    main.querySelectorAll('[data-sim]').forEach((b) => b.onclick = () => make(ctx.students().find((s) => s.id === b.dataset.sid), b.dataset.sim).catch((e) => ctx.toast(e.message)));
    main.querySelectorAll('[data-simp]').forEach((b) => b.onclick = () => ctx.W().printSheet(ctx.students().find((s) => s.id === b.dataset.sid), b.dataset.simp, b.dataset.aud));
  }
  function studentCard(s) {
    const sheets = s.sheets || [];
    const firsts = sheets.filter((x) => !x.kind || x.kind === '1차').sort((a, b) => b.at - a.at);
    return `<div class="card"><div><h3 style="margin:0">${esc(s.name)}</h3><span class="muted small">${esc(s.grade || '')} ${esc(s.school || '')} · 1차 오답노트 ${firsts.length}개</span></div>
      ${firsts.length ? `<table class="small" style="width:100%;border-collapse:collapse;margin-top:6px">${firsts.map((f) => {
        const two = sheets.filter((x) => x.from === f.id);
        return `<tr style="border-top:1px solid var(--line)"><td style="padding:6px"><b>${md(f.at)}</b>${f.scope ? ' · ' + esc(f.scope) : ''} · ${f.count || 0}문항 <span class="muted">${esc((f.books || []).join(', '))}</span></td>
          <td style="text-align:right">${two.map((t) => `<span class="badge">${esc(t.kind.split(' ').pop())} ${t.count}문항</span> <button class="ghost small" data-simp="${t.id}" data-sid="${s.id}" data-aud="student">학생용</button><button class="ghost small" data-simp="${t.id}" data-sid="${s.id}" data-aud="teacher">선생님용</button>`).join(' ')}
          ${f.items ? `<button class="${two.length ? 'ghost' : 'primary'} small" data-sim="${f.id}" data-sid="${s.id}">${two.length ? '다시 만들기' : '유사문항 만들기'}</button>` : '<span class="muted">이전 버전</span>'}</td></tr>`;
      }).join('')}</table>` : '<p class="muted small">1차 오답노트를 먼저 만드세요 (학생 탭).</p>'}</div>`;
  }

  // ---------- 만들기 ----------
  async function make(student, sheetId) {
    const log = [];
    const show = (msg) => ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 유사문항 찾는 중</h2><p class="small">${esc(msg)}</p><div class="muted small" style="max-height:40vh;overflow:auto">${log.slice(-14).map(esc).join('<br>')}</div></div>`);
    show('1차 오답노트 불러오는 중…');
    await ctx.W().catalog();
    const { sh, rows } = await W().loadSheet(student, sheetId);
    const ok = rows.filter((x) => !x.err);
    const g = gnum(student.grade);
    const labels = [...new Set(ok.flatMap((x) => W().labelsOf(ctx.W().bookOf(x.w.bookId))))];
    let roots = []; try { roots = await W().ensureFolders(labels); } catch { /* 폴더 없이도 글자 후보는 찾음 */ }
    show(`중${g} 문항 후보 불러오는 중…`);
    const mine = new Set(student.catalogIds || []); const used = new Set(student.simUsed || []);
    const pool = (await fs.getDocs(fs.query(col('bankItems'), fs.where('grade', '==', `중${g}`)))).docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.text && c.text.length > 12 && !mine.has(c.bookId) && !used.has(c.id) && !c.gen);
    log.push(`후보 문항 ${pool.length}개 (이 학생 교재 ${mine.size}권은 뺌)`);
    const cost = { usd: 0 }; const add = (u) => { cost.usd += u?.usd || 0; };
    const picks = [];
    for (let i = 0; i < ok.length; i++) {
      const x = ok[i]; const it = x.it;
      show(`${i + 1} / ${ok.length}문항 · AI 사용 $${cost.usd.toFixed(2)}`);
      let text = it.text || it.stem || '';
      if (!text && it.page) { try { const pdf = await W().openBookPdf(ctx.W().bookOf(x.w.bookId), 'q', roots); text = problemText(await pageText(pdf, it.page), x.w.no); } catch { /* 폴더 없음 */ } }
      const u0 = W().unitName(x.w.label);
      let cands = pool.filter((c) => (it.tag?.unit && c.tag?.unit ? c.tag.unit === it.tag.unit : Math.max(unitSim(u0, c.tag?.unit || c.unit0), unitSim(u0, c.unit0)) >= 0.5));
      cands.sort((a, b) => ((b.tag?.type && b.tag.type === it.tag?.type) - (a.tag?.type && a.tag.type === it.tag?.type)) || Math.abs((a.tag?.level || 2) - (it.tag?.level || 2)) - Math.abs((b.tag?.level || 2) - (it.tag?.level || 2)));
      cands = cands.slice(0, 24);
      let same = [], up = [];
      if (cands.length && (text || it.crop)) {
        try {
          const image = !text && it.crop ? await toJpegBase64(it.crop.img, 800) : null;
          const r = await aiCall('/ai/similar', { orig: { text, image, type: it.tag?.type, level: it.tag?.level, cause: x.w.cause }, cands: cands.map((c) => ({ id: c.id, text: c.text, level: c.tag?.level, type: c.tag?.type })) });
          add(r.usage); const ids = new Set(cands.map((c) => c.id));
          same = (r.same || []).filter((id) => ids.has(id)); up = (r.up || []).filter((id) => ids.has(id) && !same.slice(0, 1).includes(id));
        } catch (e) { log.push(`✗ ${i + 1}번 후보 고르기 실패: ${e.message}`); }
      }
      const row = { x, n: i + 1, text, alts: { same: same.map((id) => ({ pool: pool.find((c) => c.id === id) })), up: up.map((id) => ({ pool: pool.find((c) => c.id === id) })) }, pick: {} };
      for (const S of SETS) {
        if (!row.alts[S.lv].length) {
          try { const gen = await variant(x, text, S.lv, cost); if (gen) row.alts[S.lv].push({ gen }); } catch (e) { log.push(`✗ ${i + 1}번 ${S.short} AI 변형 실패: ${e.message}`); }
        }
        row.pick[S.lv] = 0;
      }
      log.push(`✓ ${i + 1}번 · 유사1 ${row.alts.same[0]?.gen ? 'AI 변형' : row.alts.same.length ? '학원 교재' : '없음'} · 유사2 ${row.alts.up[0]?.gen ? 'AI 변형' : row.alts.up.length ? '학원 교재' : '없음'}`);
      picks.push(row);
      used.add(row.alts.same[0]?.pool?.id); used.add(row.alts.up[0]?.pool?.id); // 같은 문항이 두 번 들어가지 않게
    }
    if (cost.usd) await W().logUsage(cost.usd);
    choose(student, sh, picks, roots, cost);
  }
  // AI 변형 문항: Claude가 만들고, GPT가 답을 모른 채 풀어 같은지 확인 (다르면 한 번 더 만들기)
  async function variant(x, text, lv, cost) {
    const item = { stem: x.it.stem || text, choices: x.it.choices || null, answer: x.it.answer || x.it.aiSol?.answer || '' };
    if (!item.stem && x.it.crop) { // 글자가 없는 원본: 먼저 그림을 글자로 옮김
      const t1 = await aiCall('/ai/retype1', { title: ctx.W().bookOf(x.w.bookId)?.title || '', image: await toJpegBase64(x.it.crop.img) }); cost.usd += t1.usage?.usd || 0;
      item.stem = t1.item?.stem || ''; item.choices = t1.item?.choices || null;
    }
    if (!item.stem) return null;
    let best = null;
    for (let k = 0; k < 2; k++) {
      const r = await aiCall('/ai/generate', { item, analysis: `단원: ${W().unitName(x.w.label)}${x.w.cause ? ', 틀린 이유: ' + x.w.cause : ''}`, level: lv, count: 1 }); cost.usd += r.usage?.usd || 0;
      const g = r.items?.[0]; if (!g?.stem) continue;
      let check = null;
      try { const v = await aiCall('/ai/verify', { item: { stem: g.stem, choices: g.choices, box: g.box }, expected: g.answer }); cost.usd += v.usage?.usd || 0; check = { match: !!v.match, gptAnswer: v.gptAnswer }; } catch (e) { check = { error: e.message }; }
      best = { ...g, check };
      if (check.match) break;
    }
    if (!best) return null;
    const gid = 'gen_' + hash(best.stem + Date.now() + Math.random());
    const doc = clean({ gen: true, bookId: x.w.bookId, sec: x.w.sec, label: x.w.label, unit0: W().unitName(x.w.label), stem: best.stem, choices: best.choices || null, figure: best.figure?.svg ? best.figure : null, answer: '', aiSol: { answer: best.answer, solution: best.solution || '', key: best.tag || '', check: best.check }, level: lv, status: 'review', at: Date.now() });
    await fs.setDoc(ref('bankItems', gid), doc);
    return { id: gid, ...doc };
  }

  // 고르기 화면: 원본 | 유사1 | 유사2, 칸을 누르면 다음 후보
  function choose(student, sh, picks, roots, cost) {
    const on = { same: true, up: true };
    const view = (a) => {
      if (!a) return '<div class="ttext muted">후보 없음 — 이 칸은 빠집니다</div>';
      if (a.gen) return `<div class="ttext">${esc(a.gen.stem)}${a.gen.choices ? '<br>' + a.gen.choices.map((c, i) => '①②③④⑤'[i] + ' ' + esc(c)).join('  ') : ''}</div><div class="small" style="color:${a.gen.aiSol?.check?.match ? 'var(--green)' : 'var(--red)'}">AI 변형 · ${a.gen.aiSol?.check?.match ? '두 번 풀어 답 일치 ✓' : '확인 필요'} · 정답 ${esc(a.gen.aiSol?.answer || '')}</div>`;
      const b = ctx.W().bookOf(a.pool.bookId);
      return `${a.crop ? `<img src="${a.crop}" class="thumb">` : `<div class="ttext">${esc(a.pool.text)}</div>`}<div class="small muted">학원 교재 · ${esc(b?.title || '')} ${esc(W().shortLabel(a.pool.label))} ${esc(a.pool.no)}번${a.pool.tag?.level ? ' · 난이도 ' + a.pool.tag.level : ''}</div>`;
    };
    const draw = () => {
      const n = (lv) => picks.filter((r) => r.alts[lv][r.pick[lv]]).length;
      ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · ${md(sh.at)} 1차 오답노트(${picks.length}문항) → 2차 유사문항 고르기</h2>
        <div class="row small" style="gap:16px"><b>만들 세트</b><label><input type="checkbox" id="cSame" ${on.same ? 'checked' : ''}> 유사1 세트 (같은 수준) ${n('same')}문항</label><label><input type="checkbox" id="cUp" ${on.up ? 'checked' : ''}> 유사2 세트 (한 단계 위) ${n('up')}문항</label><span class="muted">AI 사용 $${cost.usd.toFixed(2)}</span></div>
        <p class="muted small" style="margin:4px 0">칸을 누르면 다음 후보로 바뀝니다. 학원 교재 후보는 만들 때 원본을 잘라 넣습니다.</p>
        <div style="max-height:58vh;overflow:auto">${picks.map((r, i) => `<div class="rv" style="grid-template-columns:40px 1fr 1fr 1fr">
          <div class="rvn">${String(r.n).padStart(2, '0')}</div>
          <div><div class="lab">1차 원본 · ${esc(W().shortLabel(r.x.w.label))} ${esc(r.x.w.no)}번${r.x.w.cause ? ' · ' + esc(r.x.w.cause) : ''}</div>${r.x.it.crop ? `<img src="${r.x.it.crop.img}" class="thumb">` : `<div class="ttext">${esc(r.text)}</div>`}</div>
          ${SETS.map((S) => `<div data-cyc="${i}|${S.lv}" style="cursor:pointer"><div class="lab">${S.short} · ${S.label} <span class="muted">(${r.alts[S.lv].length ? `${r.pick[S.lv] + 1}/${r.alts[S.lv].length}` : '0'}) ▸</span></div>${view(r.alts[S.lv][r.pick[S.lv]])}</div>`).join('')}</div>`).join('')}</div>
        <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="ghost" data-a="close">취소</button><button class="primary" id="cGo">유사문항 세트 만들기</button></div></div>`);
      document.getElementById('cSame').onchange = (e) => { on.same = e.target.checked; };
      document.getElementById('cUp').onchange = (e) => { on.up = e.target.checked; };
      document.querySelectorAll('[data-cyc]').forEach((el) => el.onclick = () => { const [i, lv] = el.dataset.cyc.split('|'); const r = picks[i]; if (r.alts[lv].length > 1) { r.pick[lv] = (r.pick[lv] + 1) % r.alts[lv].length; draw(); } });
      document.getElementById('cGo').onclick = () => build(student, sh, picks, roots, cost, on).catch((e) => ctx.toast(e.message));
    };
    draw();
  }

  async function build(student, sh, picks, roots, cost, on) {
    const log = [];
    const before = cost.usd;
    const out = {};
    for (const S of SETS) {
      if (!on[S.lv]) continue;
      const rows = [];
      for (const r of picks) {
        const a = r.alts[S.lv][r.pick[S.lv]]; if (!a) continue;
        ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · ${S.k} 만드는 중</h2><p class="small">${rows.length + 1}번째 문항 준비 중… (원본 잘라내기·해설)</p><div class="muted small">${log.slice(-8).map(esc).join('<br>')}</div></div>`);
        if (a.gen) { rows.push({ w: { bookId: r.x.w.bookId, sec: r.x.w.sec, label: r.x.w.label, no: '', title: S.k, gid: a.gen.id, from: r.n }, it: a.gen, q: 'ai', s: 'ai' }); continue; }
        const c = a.pool; const b = ctx.W().bookOf(c.bookId);
        const w = { bookId: c.bookId, sec: c.sec, label: c.label, no: c.no, page: c.page, title: b?.title || '' };
        try {
          const p = await W().prepItem(w, roots, cost);
          rows.push({ w: { ...w, title: S.k, btitle: w.title, from: r.n }, it: p.it, q: p.it.crop && !p.scan ? 'crop' : 'ai', s: p.it.sol ? 'crop' : p.it.aiSol ? 'ai' : 'ans' });
        } catch (e) { log.push(`✗ ${r.n}번 ${S.short}: ${e.message}`); }
      }
      out[S.lv] = rows;
    }
    if (cost.usd > before) await W().logUsage(cost.usd - before);
    const fresh = (await fs.getDoc(ref('students', student.id))).data() || {};
    let sheets = (fresh.sheets || []).filter((x) => !(x.from === sh.id && SETS.some((S) => on[S.lv] && x.kind === S.k))); // 다시 만들면 바꿈
    const made = [];
    for (const S of SETS) {
      const rows = out[S.lv]; if (!rows?.length) continue;
      const one = clean({ id: 's' + Date.now().toString(36) + S.lv, kind: S.k, from: sh.id, at: Date.now(), scope: sh.scope || '', count: rows.length, books: [...new Set(rows.map((x) => x.w.btitle || 'AI 변형'))],
        items: rows.map((x) => ({ bookId: x.w.bookId, title: x.w.title, btitle: x.w.btitle || null, sec: x.w.sec, label: x.w.label, no: x.w.no || '', page: x.w.page || null, gid: x.w.gid || null, from: x.w.from, q: x.q, s: x.s })), opts: { per: 4, cover: '', sol: true } });
      sheets.push(one); made.push(one);
    }
    const usedIds = picks.flatMap((r) => SETS.map((S) => r.alts[S.lv][r.pick[S.lv]]?.pool?.id)).filter(Boolean);
    await W().saveStudent(student.id, { sheets, simUsed: [...new Set([...(fresh.simUsed || []), ...usedIds])] });
    const st2 = { ...student, ...fresh, sheets };
    ctx.openModal(`<div class="wide"><h2>${esc(student.name)} · 2차 유사문항 완성</h2>
      ${made.map((m) => `<div class="row between" style="border-top:1px solid var(--line);padding:8px 0"><span><b>${esc(m.kind)}</b> · ${m.count}문항</span><span class="row"><button class="ghost small" data-pp="${m.id}" data-aud="teacher">선생님용 (출처 표시)</button><button class="primary small" data-pp="${m.id}" data-aud="student">학생용 미리보기 · 인쇄</button></span></div>`).join('')}
      ${log.length ? `<p class="small" style="color:var(--red)">${log.map(esc).join('<br>')}</p>` : ''}
      <p class="muted small">만든 세트는 유사문항 탭과 학생 카드의 "만든 오답노트"에 남습니다. AI 사용 $${cost.usd.toFixed(2)}</p>
      <div class="row" style="justify-content:flex-end"><button class="ghost" data-a="close">닫기</button></div></div>`);
    document.querySelectorAll('[data-pp]').forEach((b) => b.onclick = () => ctx.W().printSheet(st2, b.dataset.pp, b.dataset.aud));
  }

  return { render, newPrep, runPool, runTag };
}
