// 폴더로 교재 세트 만들기 — 연결한 폴더의 하위 폴더 구조를 읽어 세트·교재를 자동으로 나눔
// 규칙
// - 맨 위 폴더(중1·중2·중3) = 학년, 그 아래 폴더 = 세트 안의 묶음(예: 중간대비·기말대비, 삼각비+원·이차함수·통계)
// - 이름에 "모의고사"가 들어간 교재 → 학년별 모의고사 세트(중1 모의고사·중2 모의고사·중3 모의고사)
// - 문제·정답및해설 PDF는 교재 기호(A1, B2, 모의고사A, 주말모의고사(18회) …)로 짝지음
// - "교재 완성본" 폴더에 같은 교재의 문제 PDF가 있으면 그것을 씀, 해설이 두 벌이면 "_수정"본을 씀
// - "C2+D2" 같은 합본이 있으면 C2·D2는 따로 만들지 않고 합본 하나로 (해설은 C2·D2 해설을 함께 씀)
// - 정답·해설 PDF가 따로 없는 교재(주말모의고사)는 같은 PDF 뒤쪽의 정답과 해설을 씀
// - 빼는 것: 초기작업·전체오답·추가자료 폴더, 맨 위에 있는 파일(신청현황·견적서·표지 등)
import { cleanTitle } from './catalog.js';
import * as F from './folders.js';
import { bookId } from './library.js';

const SKIP_DIR = /^(초기작업|전체오답|추가자료)$|전자칠판/;
const roleOf = (n) => (/빠른\s*정답/.test(n) ? 'quick' : /정답\s*및\s*해설|정답과\s*해설|해설/.test(n) ? 'answer' : 'problem');
// 교재 기호
export function codeOf(n) {
  let m = n.match(/주말\s*모의고사\s*\(([^)]*)\)/); if (m) return '주말모의고사 ' + m[1];
  m = n.match(/모의고사\s*([A-Z])\s*\(/) || n.match(/모의고사\s*([A-Z])(?![a-z])/); if (m) return '모의고사' + m[1];
  m = n.match(/(?:내신교재|내신대비)\s*([A-D]\d?(?:-\d)?(?:\+[A-D]\d?)?)(?![A-Za-z])/); if (m) return m[1];
  return '';
}
// 기호 정렬: A1 < A2 < A3-1 < A3-2 < A4 < B < B2 < C … < 모의고사A … < 주말모의고사
function codeRank(c) {
  if (c.startsWith('주말')) return [9, 0, 0, Number((c.match(/\d+/) || [0])[0])];
  if (c.startsWith('모의고사')) return [8, c.charCodeAt(4), 0, 0];
  const m = c.match(/^([A-D])(\d*)(?:-(\d))?/) || [];
  return [1, (m[1] || 'Z').charCodeAt(0), Number(m[2] || 0), Number(m[3] || 0)];
}
const cmpCode = (a, b) => { const x = codeRank(a), y = codeRank(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.localeCompare(b); };
const CIRCLE = ['①', '②', '③', '④', '⑤', '⑥'];
const termOf = (dir) => (/중간/.test(dir) ? '중간' : /기말/.test(dir) ? '기말' : '');
const gradeNo = (dir) => (dir.match(/중\s*([123])/) || [])[1];
const qCount = (n) => Number((n.match(/(\d+)\s*문항/) || [])[1]) || null;
const subtitle = (stem) => {
  stem = stem.replace(/_?완성본/, '');
  let m = stem.match(/_문제_(?!\d+문항)([^_]+)$/); if (m) return m[1].trim(); // 모의고사…_문제_삼각비+원의 성질
  m = stem.match(/(교과서[_\s][^_]+|중단원레벨업|기출문제완전정복\+?[^_]*|고난도정복하기|\((?![^()]*회)[^()]*(?:\([^)]*\))?[^()]*\))/);
  if (!m) return '';
  let t = m[1]; if (t.startsWith('(')) t = t.slice(1, -1);
  return t.replace(/^교과서[_\s]/, '교과서 ').replace(/_/g, ' ').trim();
};

// files: [{rel, size, mtime}] (폴더 기준 상대 경로) → { sets:[…], skipped:[…], notes:[…] }
export function planSets(files, rootLabel, opts = {}) {
  const skipped = [], notes = [];
  const pdfs = [];
  for (const f of files) {
    const parts = f.rel.normalize('NFC').split('/'); const name = parts.pop();
    if (!/\.pdf$/i.test(name)) continue;
    if (!parts.length) { skipped.push({ rel: f.rel, why: '맨 위 파일(신청현황·견적서·표지 등)' }); continue; }
    const bad = parts.find((p) => SKIP_DIR.test(p));
    if (bad) { skipped.push({ rel: f.rel, why: `${bad} 폴더` }); continue; }
    const g = gradeNo(parts[0]); if (!g) { skipped.push({ rel: f.rel, why: '학년 폴더 밖' }); continue; }
    // "교재 완성본" 폴더는 바로 위 폴더와 같은 묶음
    const dirs = parts.slice(1).filter((p) => !/완성본/.test(p));
    pdfs.push({ ...f, rel: f.rel.normalize('NFC'), name, stem: name.replace(/\.pdf$/i, ''), grade: g, sub: dirs[0] || '', done: parts.some((p) => /완성본/.test(p)) || /완성본/.test(name), role: roleOf(name), code: codeOf(name), mock: /모의고사/.test(name) });
  }
  // 묶음 이름
  const subsOf = (g) => [...new Set(pdfs.filter((p) => p.grade === g && p.sub).map((p) => p.sub))].sort();
  const groupName = (g, sub) => {
    if (!sub) return '';
    const subs = subsOf(g);
    if (subs.every((s) => termOf(s))) return `${CIRCLE[subs.indexOf(sub)] || ''} 2학기 ${termOf(sub)}대비`.trim();
    return sub.replace(/^[A-Z]\./, '');
  };
  const sets = new Map();
  const setOf = (g, mock) => {
    const key = (mock ? 'mock|' : 'main|') + g;
    if (!sets.has(key)) {
      const ps = pdfs.filter((p) => p.grade === g && !p.mock);
      const terms = [...new Set(ps.map((p) => termOf(p.sub) || termOf(p.name)).filter(Boolean))];
      const name = opts.names?.[key] || (mock ? `중${g} 모의고사` : `중${g}-2 ${terms.length === 1 ? terms[0] + '대비' : terms.length > 1 && subsOf(g).length > 1 ? '내신대비' : '내신대비 (중간·기말 통합)'}`);
      sets.set(key, { key, name, grade: `중${g}`, mock, order: (mock ? 10 : 0) + Number(g), groups: new Map() });
    }
    return sets.get(key);
  };
  const grpOf = (set, g, sub) => {
    const name = groupName(g, sub);
    if (!set.groups.has(name)) set.groups.set(name, { name, sub, books: new Map(), quick: null });
    return set.groups.get(name);
  };
  for (const p of pdfs) {
    const set = setOf(p.grade, p.mock); const grp = grpOf(set, p.grade, p.sub);
    if (p.role === 'quick') { grp.quick = { rel: p.rel, size: p.size, name: p.name }; continue; }
    if (!p.code) { skipped.push({ rel: p.rel, why: '교재 기호를 알 수 없음' }); continue; }
    if (!grp.books.has(p.code)) grp.books.set(p.code, { code: p.code, problems: [], answers: [] });
    grp.books.get(p.code)[p.role === 'answer' ? 'answers' : 'problems'].push(p);
  }
  const out = [];
  for (const set of [...sets.values()].sort((a, b) => a.order - b.order)) {
    const groups = [];
    for (const grp of [...set.groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
      const bk = grp.books;
      // 합본: C2+D2 → C2·D2 해설을 함께 쓰고 C2·D2는 따로 만들지 않음
      for (const [code, b] of bk) if (code.includes('+')) {
        for (const part of code.split('+')) { const x = bk.get(part); if (!x) continue; b.answers.push(...x.answers); bk.delete(part); }
        notes.push(`${set.name} ${grp.name} ${code}: 합본 문제 PDF + ${code.split('+').join('·')} 해설`);
      }
      const books = [];
      for (const b of [...bk.values()].sort((a, b2) => cmpCode(a.code, b2.code))) {
        const pick = (arr, pref) => [...arr].sort((a, c) => (pref(c) - pref(a)) || (c.mtime || 0) - (a.mtime || 0))[0];
        const q = pick(b.problems, (x) => (x.done ? 1 : 0));
        if (!q) { skipped.push({ rel: b.answers[0]?.rel || b.code, why: '문제 PDF 없음' }); continue; }
        b.problems.filter((x) => x !== q).forEach((x) => skipped.push({ rel: x.rel, why: '같은 교재의 다른 판(완성본 사용)' }));
        let answers = b.answers;
        if (!b.code.includes('+') && answers.length > 1) { const a = pick(answers, (x) => (/수정/.test(x.name) ? 1 : 0)); answers.filter((x) => x !== a).forEach((x) => skipped.push({ rel: x.rel, why: '같은 교재의 다른 해설(수정본 사용)' })); answers = [a]; }
        const sameFile = !answers.length;
        const term = termOf(q.sub) || (set.mock ? termOf(q.name) : '');
        const title = `중${q.grade}-2 ${term ? term + '대비 ' : ''}${b.code}${grp.sub && !termOf(grp.sub) ? ' · ' + grp.name : ''}`.replace(/\s+/g, ' ').trim();
        books.push({
          code: b.code, title, sub: subtitle(q.stem) || (answers[0] ? subtitle(answers[0].stem) : ''), count: qCount(q.name), sameFile, mock: /주말\s*모의고사/.test(q.name),
          fullTitle: cleanTitle(q.stem).replace(/완성본/g, '').replace(/\s+/g, ' ').trim(),
          files: [{ label: rootLabel, rel: q.rel, size: q.size, role: '본책', audience: '', ext: 'pdf' },
            ...answers.map((a) => ({ label: rootLabel, rel: a.rel, size: a.size, role: '정답·해설', audience: '', ext: 'pdf' }))],
          problemName: q.name,
        });
      }
      if (books.length) groups.push({ name: grp.name, sub: grp.sub, quick: grp.quick ? { label: rootLabel, ...grp.quick } : null, books });
    }
    if (groups.length) out.push({ key: set.key, name: set.name, grade: set.grade, mock: set.mock, order: set.order, groups });
  }
  return { sets: out, skipped, notes };
}

// ---------------- 화면: 폴더 연결 → 읽기 → 미리보기 → 만들기 ----------------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
export const SET_ROOT = { label: '내 PC·2학기 내신대비교재', path: 'C:\\Users\\user\\Desktop\\수학도서관\\중등내신대비\\2학기 내신대비교재', category: '내신대비', mode: 'sets' };
// 원장님이 정한 세트 이름 (이 폴더를 처음 읽을 때 기본값)
const FIRST_NAMES = { 'main|1': '중1-2 내신대비', 'main|2': '중2-2 내신대비 (중간·기말 통합)', 'main|3': '중3-2 기말대비' };
const ansLabel = (b) => (b.sameFile ? '정답·해설: 같은 PDF 뒤쪽' : b.files.length > 2 ? `해설 ${b.files.length - 1}개 함께` : '문제+해설');

export function createSetBuilder(ctx) {
  // ctx: { fs, db, aid, uid, toast, openModal, closeModal, reloadCatalog, students() }
  const { fs, db } = ctx;
  const col = (n) => fs.collection(db, 'academies', ctx.aid(), n);
  const ref = (n, id) => fs.doc(db, 'academies', ctx.aid(), n, id);

  async function pickRoot() {
    const roots = (await F.listRoots()).filter((r) => r.mode === 'sets');
    if (roots.length) return roots[0];
    return new Promise((resolve) => {
      ctx.openModal(`<h2>폴더로 세트 만들기 — 폴더 연결</h2>
        <p class="small">세트로 만들 교재 폴더를 한 번만 연결합니다. 버튼을 누르면 폴더 고르기 창이 열립니다.</p>
        <div class="card small" style="background:var(--green-bg)">바탕 화면 → <b>수학도서관</b> → <b>중등내신대비</b> → <b>2학기 내신대비교재</b> 폴더를 한 번 눌러 고른 뒤 <b>[폴더 선택]</b> → 크롬이 물으면 <b>[파일 보기]</b>를 누르세요.<div class="muted" style="margin-top:4px">${esc(SET_ROOT.path)}</div></div>
        <p class="muted small">읽기만 하고 파일은 바꾸지 않습니다. 이 폴더는 "교재 정리"의 폴더 목록에도 보입니다.</p>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" data-a="close">취소</button><button class="primary" id="sbPick">폴더 고르기</button></div>`);
      document.getElementById('sbPick').onclick = async () => {
        try { resolve(await F.addRoot(SET_ROOT)); } catch (e) { if (e.name !== 'AbortError') ctx.toast(e.message); }
      };
    });
  }

  async function start() {
    const root = await pickRoot(); if (!root) return;
    if ((await F.permission(root)) !== 'granted') { const [[, p]] = await F.reconnectAll([root]); if (p !== 'granted') return ctx.toast('폴더 허락이 필요합니다. 다시 누르고 [파일 보기]를 고르세요.'); }
    ctx.openModal('<p class="pad center" id="sbMsg">폴더를 읽는 중…</p>');
    const files = await F.scan(root, (n) => { const m = document.getElementById('sbMsg'); if (m) m.textContent = `폴더를 읽는 중… 파일 ${n}개`; });
    const saved = (await fs.getDoc(ref('settings', 'folderSets'))).data() || {};
    const names = { ...(/2학기 내신대비교재/.test(root.path) ? FIRST_NAMES : {}), ...(saved.names?.[root.label] || {}) };
    preview(root, planSets(files, root.label, { names }));
  }

  function preview(root, plan) {
    const nBooks = (s) => s.groups.reduce((a, g) => a + g.books.length, 0);
    ctx.openModal(`<div class="wide"><h2>폴더로 세트 만들기 — 미리보기</h2>
      <p class="muted small"><b>${esc(root.label)}</b> (${esc(root.path)})를 읽어 하위 폴더 기준으로 나눴습니다. 문제·정답및해설 PDF는 이름으로 짝지었고, 파일은 폴더에 그대로 두고 연결만 합니다. 세트 이름은 고칠 수 있습니다.</p>
      <div style="max-height:62vh;overflow:auto">
      ${plan.sets.map((s, i) => `<div class="card" style="margin-top:8px"><div class="row between"><div style="flex:1"><input type="text" data-sn="${i}" value="${esc(s.name)}" style="font-weight:700;font-size:16px;max-width:360px"> <span class="muted small">${esc(s.grade)} · 교재 ${nBooks(s)}권</span></div>
        <label class="small row"><input type="checkbox" data-sc="${i}" checked> 만들기</label></div>
        ${s.groups.map((g) => `<div style="border-top:1px dashed var(--line);padding:6px 0;margin-top:6px">${g.name ? `<b class="small">${esc(g.name)}</b> ` : ''}<span class="muted small">${g.quick ? (g.name ? '· ' : '') + '빠른정답모음 PDF 함께 연결' : ''}</span>
          <div style="margin-top:4px">${g.books.map((b) => `<span class="badge" style="margin:2px 4px 2px 0;background:#fff;border:1px solid var(--line);color:var(--ink)"><b style="color:var(--green)">${esc(b.code)}</b>${b.sub ? ' ' + esc(b.sub) : ''}${b.count ? ` · ${b.count}문항` : ''} · <span class="${b.sameFile ? '' : 'muted'}">${ansLabel(b)}</span></span>`).join('')}</div></div>`).join('')}</div>`).join('')}
      ${plan.notes.length ? `<p class="small">${plan.notes.map(esc).join('<br>')}</p>` : ''}
      <details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">세트에 넣지 않은 PDF ${plan.skipped.length}개 보기</summary><div class="small muted" style="line-height:1.7;margin-top:4px">${plan.skipped.map((x) => `· ${esc(x.rel)} <b>— ${esc(x.why)}</b>`).join('<br>')}</div></details></div>
      <div class="row between" style="margin-top:12px"><span class="muted small">같은 이름으로 다시 만들면 새로 만들지 않고 고쳐집니다(학생 기록 유지).</span><div class="row"><button class="ghost" data-a="close">취소</button><button class="primary" id="sbGo">세트 만들기</button></div></div></div>`);
    const btn = document.getElementById('sbGo');
    const count = () => { btn.textContent = `세트 ${document.querySelectorAll('[data-sc]:checked').length}개 만들기`; };
    document.querySelectorAll('[data-sc]').forEach((c) => (c.onchange = count)); count();
    btn.onclick = async () => {
      plan.sets.forEach((s, i) => { s.name = document.querySelector(`[data-sn="${i}"]`).value.trim() || s.name; s.on = document.querySelector(`[data-sc="${i}"]`).checked; });
      btn.disabled = true; btn.textContent = '만드는 중…';
      try { const r = await create(root, plan.sets.filter((s) => s.on)); ctx.closeModal(); ctx.toast(`세트 ${r.sets}개 · 교재 ${r.books}권을 만들었습니다${r.replaced ? ` (N: 드라이브의 같은 교재 ${r.replaced}종은 목록에서 숨김)` : ''}`); }
      catch (e) { btn.disabled = false; count(); ctx.toast('오류: ' + e.message); }
    };
  }

  async function create(root, sets) {
    const all = (await fs.getDocs(col('catalogBooks'))).docs.map((d) => ({ id: d.id, ...d.data() }));
    const byId = Object.fromEntries(all.map((x) => [x.id, x]));
    let batch = fs.writeBatch(db), n = 0, nb = 0, replaced = 0;
    const step = async () => { if (++n % 400 === 0) { await batch.commit(); batch = fs.writeBatch(db); } };
    const names = {}; const setNames = {};
    const now = Date.now();
    for (const s of sets) {
      const sid = 'fs_' + hash(root.label + '|' + s.key);
      names[s.key] = s.name;
      const groups = [];
      for (const g of s.groups) {
        const ids = [];
        for (const b of g.books) {
          const id = bookId('set|' + root.label + '|' + b.files[0].rel);
          const old = byId[id];
          const same = old && JSON.stringify((old.files || []).map((f) => [f.rel, f.size])) === JSON.stringify(b.files.map((f) => [f.rel, f.size]));
          const roles = {}; b.files.forEach((f) => { roles[f.role] = (roles[f.role] || 0) + 1; });
          batch.set(ref('catalogBooks', id), {
            key: 'set|' + root.label + '|' + b.files[0].rel, title: b.title, fullTitle: b.fullTitle, sub: b.sub, code: b.code, count: b.count,
            kind: '내신대비', grade: s.grade + '-2', roles, audience: [], base: '', zipped: false, review: 0, files: b.files,
            source: 'folder-set', setId: sid, setName: s.name, group: g.name, sameFile: b.sameFile, mock: b.mock, multiAnswer: true, seenAt: now,
            ...(old && !same ? { outline: fs.deleteField() } : {}), // 파일이 바뀌었으면 구역을 다시 읽음
          }, { merge: true });
          await step(); ids.push(id); nb++;
          // 단원 수 분석(새벽): 모의고사·주말모의고사는 목차가 없어 넣지 않음
          if (!/모의고사/.test(b.code) && !old?.units) { batch.set(ref('analysisQueue', 'toc_' + id), { task: 'toc', bookId: id, title: b.title, label: root.label, rel: b.files[0].rel, status: 'queued', createdAt: now, priority: 0 }, { merge: true }); await step(); }
          setNames[b.files[0].rel.split('/').pop()] = id;
        }
        groups.push({ name: g.name, ids, quick: g.quick ? { label: g.quick.label, rel: g.quick.rel, name: g.quick.name, size: g.quick.size } : null });
      }
      const ex = (await fs.getDoc(ref('bookSets', sid))).data();
      batch.set(ref('bookSets', sid), { name: s.name, grade: s.grade, source: 'folder', root: root.label, rootPath: root.path, key: s.key, order: s.order, groups, updatedAt: now,
        ...(ex ? {} : { createdAt: fs.serverTimestamp(), createdBy: ctx.uid() }) }, { merge: true });
      await step();
    }
    // N: 드라이브에 같은 파일(이름 같음)이 있는 교재는 교재 찾기 목록에서 숨김 (이미 고른 학생 기록은 그대로)
    for (const x of all) {
      if (x.source === 'folder-set' || x.replacedBy) continue;
      const hit = (x.files || []).map((f) => setNames[String(f.rel || '').split('/').pop()]).find(Boolean);
      if (hit) { batch.set(ref('catalogBooks', x.id), { replacedBy: hit }, { merge: true }); replaced++; await step(); }
    }
    const saved = (await fs.getDoc(ref('settings', 'folderSets'))).data() || {};
    batch.set(ref('settings', 'folderSets'), { names: { ...(saved.names || {}), [root.label]: { ...(saved.names?.[root.label] || {}), ...names } }, at: now }, { merge: true });
    await batch.commit();
    await ctx.reloadCatalog();
    return { sets: sets.length, books: nb, replaced };
  }

  // 세트 교재 PDF 열기 (폴더에서 바로)
  async function openPdfFile(f) {
    const w = window.open('', '_blank');
    try {
      const r = (await F.listRoots()).find((x) => x.label === f.label);
      if (!r) throw new Error(`"${f.label}" 폴더가 이 PC에 연결되어 있지 않습니다.`);
      if ((await F.permission(r)) !== 'granted') await F.reconnectAll([r]);
      const url = URL.createObjectURL(await F.openFile(r, f.rel));
      if (w) w.location = url; else location.href = url;
    } catch (e) { w?.close(); ctx.toast(e.message); }
  }

  // 학생에게 세트 배정
  function assign(set, bookOf) {
    const ids = (set.groups || []).flatMap((g) => g.ids || []).filter((id) => bookOf(id));
    const sts = ctx.students();
    ctx.openModal(`<h2>${esc(set.name)} — 학생에게 배정</h2><p class="muted small">고른 학생의 교재에 이 세트 ${ids.length}권이 모두 들어갑니다. 쓰지 않는 교재는 나중에 오답 입력 화면의 "교재 관리"에서 뺄 수 있습니다.</p>
      <div class="checks" style="max-height:50vh;overflow:auto">${sts.map((s) => { const has = ids.filter((id) => (s.catalogIds || []).includes(id)).length; return `<label><input type="checkbox" value="${s.id}" ${has === ids.length && ids.length ? 'checked disabled' : ''}> ${esc(s.name)} <span class="muted small">${esc(s.grade || '')} ${esc(s.school || '')}${has ? ` · 이미 ${has}권` : ''}</span></label>`; }).join('') || '<p class="muted small">등록된 학생이 없습니다.</p>'}</div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" data-a="close">취소</button><button class="primary" id="saGo">배정</button></div>`);
    document.getElementById('saGo').onclick = async () => {
      const pick = [...document.querySelectorAll('.checks input:checked:not(:disabled)')].map((c) => c.value);
      for (const sid of pick) { const s = sts.find((x) => x.id === sid); await fs.updateDoc(ref('students', sid), { catalogIds: [...new Set([...(s.catalogIds || []), ...ids])] }); }
      ctx.closeModal(); ctx.toast(`${pick.length}명에게 ${set.name}을(를) 배정했습니다`);
    };
  }

  async function removeSet(set) {
    if (!confirm(`"${set.name}" 세트를 지울까요?\n교재 PDF와 학생 기록은 그대로 남고, 세트 묶음만 없어집니다.`)) return;
    await fs.deleteDoc(ref('bookSets', set.id)); ctx.toast('세트를 지웠습니다');
  }

  return { start, preview, create, openPdfFile, assign, removeSet };
}
