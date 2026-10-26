// 교재 목록 정리: 파일 목록 → 교재 단위 묶기, 역할, 교사용·학생용, 중복 판정
// (서버 쪽 catalog.py와 같은 규칙)
const ROLE_PAT = [
  ['빠른정답', /빠른\s*정답/],
  ['정답·해설', /정답\s*(및|과)\s*(풀이|해설)|정답및\s*풀이|정답및해설|정답과풀이|해설|답지|풀이|정답/],
  ['부가자료', /부가자료|특별부록|빈출유형모음집|기출BOOK/i],
  ['워크북', /워크북|workbook/i],
];
const HIGH = { 공통수학1: '공통수학1', 공통수학2: '공통수학2', 공수1: '공통수학1', 공수2: '공통수학2', 대수: '대수', 미적분1: '미적분1', 미적분2: '미적분2', 미적1: '미적분1', 미적2: '미적분2', '확률과 통계': '확률과 통계', 확통: '확률과 통계', 기하: '기하' };

export const fileRole = (n) => (ROLE_PAT.find(([, p]) => p.test(n)) || ['본책'])[0];
export const audience = (n) => (n.includes('교사용') ? '교사용' : n.includes('학생용') ? '학생용' : '');

export function gradeSem(n) {
  for (const k of Object.keys(HIGH)) if (n.includes(k)) return '고등·' + HIGH[k];
  if (/수능|고등|고[123]/.test(n)) return '고등';
  let m = n.match(/(?:중\s*|중등|중학\s*수학\s*|중등수학\s*|^|[^0-9])([123])\s*-\s*\(?(상|하|[12])\)?/);
  if (m) return `중${m[1]}-${({ 상: '1', 하: '2' })[m[2]] || m[2]}`;
  // '중2_2학기', '2학년 2학기', '2학기 … 1학년'처럼 학년·학기가 따로 적힌 경우 ('2024학년도'는 학년으로 보지 않음)
  let g = '';
  m = n.match(/중\s*([123])/); if (m) g = m[1];
  else { m = n.match(/(?<![0-9])([1-3])\s*학년(?!도)|(?<![0-9])([7-9])\s*학년(?!도)/); if (m) g = m[1] || String(m[2] - 6); }
  if (!g) return '';
  const sm = n.match(/(?<![0-9])([12])\s*학기/);
  return sm ? `중${g}-${sm[1]}` : `중${g}`;
}
// 학교 기출 시험지·배점표·원안 (교재가 아니라 목차 분석은 하지 않고, 유사문항 찾기 자료로만 씀)
export const isExam = (n) => /고사\s*원안|원안|배점표|채점\s*기준|채점표|서술형\s*채점|시험지/.test(n) || (/(중간|기말)\s*고사/.test(n) && /학년도|20\d\d/.test(n) && !/대비/.test(n));
// 파일 이름에 학기가 없으면 폴더 경로에서 보충 (예: 중2_2학기 전범위/내신대비B)
function gradeOf(f) {
  const a = gradeSem(f.name), b = gradeSem(f.parts.join('/') + '/' + f.name);
  if (!a) return b; if (a.includes('-') || !b.startsWith(a + '-')) return a; return b;
}
export const edition = (n) => (/2022|22\s*개정|2025 중1 적용/.test(n) ? '22개정' : /2015|15\s*개정|2019개정/.test(n) ? '15개정' : '');
const series = (parts) => { for (const p of parts) { const m = p.match(/^\((중등|고등)\)\s*(.+)/); if (m) return m[2].replace(/_부가자료$/, '').trim(); } return ''; };
const nkey = (f) => f.stem.replace(/_?unlocked/i, '').trim().toLowerCase();

export function cleanTitle(stem) {
  let s = stem.replace(/_?unlocked/gi, '').replace(/\.pdf$/i, '').replace(/\[(좋은책 신사고|진학사|천재|비상교육)\]/g, '')
    .replace(/(빠른\s*정답|정답\s*(및|과)\s*(풀이|해설)|정답및\s*풀이|정답및해설|정답과\s*풀이|해설|답지|풀이|정답|문제|본문|본책|본교재|교사용|학생용|진도)/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, '').replace(/[_\s]+/g, ' ').replace(/^[\s\-_+]+|[\s\-_+]+$/g, '');
  if ((s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length) s += ')';
  return s;
}

// files: [{root, label, rel, size, mtime}]
export function buildCatalog(files) {
  files = files.map((f) => {
    const parts = f.rel.normalize('NFC').split('/'); const name = parts.pop();
    const i = name.lastIndexOf('.'); const ext = i > 0 ? name.slice(i + 1).toLowerCase() : '';
    return { ...f, rel: f.rel.normalize('NFC'), parts, name, ext, stem: i > 0 ? name.slice(0, i) : name, dupOf: null, dupKind: '' };
  });
  const sizeReview = [];
  // 1) 같은 크기 + 같은 이름 → 자동 정리, 같은 크기·다른 이름 → 확인
  const bySize = new Map();
  for (const f of files) { const k = f.size + '|' + f.ext; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k).push(f); }
  for (const [, g0] of bySize) {
    if (g0.length < 2 || g0[0].size < 20000) continue;
    const groups = g0[0].ext === 'hwp' ? Object.values(g0.reduce((a, f) => ((a[nkey(f)] = a[nkey(f)] || []).push(f), a), {})).filter((g) => g.length > 1) : [g0];
    for (const g of groups) {
      g.sort((a, b) => (a.root.startsWith('N:\\공유') ? 0 : 1) - (b.root.startsWith('N:\\공유') ? 0 : 1) || a.mtime - b.mtime);
      const keep = g[0];
      for (const x of g.slice(1)) {
        if (nkey(x) === nkey(keep)) { x.dupOf = keep.root + '\\' + keep.rel; x.dupKind = '동일 파일(이름·크기 같음)'; }
        else sizeReview.push({ size: x.size, a: [keep.label, keep.rel], b: [x.label, x.rel] });
      }
    }
  }
  // 2) 잠금해제본(_unlocked)이 있으면 그것을 사용
  for (const f of files) {
    if (f.dupOf || !/unlocked/i.test(f.stem)) continue;
    for (const g of files) {
      if (g === f || g.dupOf || g.root !== f.root || g.ext !== f.ext) continue;
      if (nkey(g) === nkey(f) && Math.abs(g.size - f.size) <= 0.02 * Math.max(f.size, 1)) { g.dupOf = f.root + '\\' + f.rel; g.dupKind = '잠금 원본(잠금해제본 사용)'; }
    }
  }
  // 3) 교재 단위로 묶기
  const books = new Map();
  for (const f of files) {
    if (f.dupOf) continue;
    const top = f.parts[0] || '';
    let key, title, kind;
    if (f.label.includes('교과서') && /^중[123]_/.test(top)) { key = 'tb|' + top; title = '교과서 자료 · ' + top; kind = '교과서 자료'; }
    else if (f.label.includes('2022개정') && top === '정명T') { const sub = f.parts[1] || top; key = 'jm|' + sub; title = '정명T 자료 · ' + sub; kind = '수업자료'; }
    else if (f.label.includes('교과서')) { const t = cleanTitle(f.stem).replace(/(편집|전범위).*$/, '$1'); key = 'tbe|' + t; title = '교과서 편집본 · ' + t; kind = '교과서 자료'; }
    else if (f.ext === 'pdf' || f.ext === 'zip') {
      const ser = series(f.parts); const gs = gradeOf(f);
      let comp = fileRole(f.name); if (comp === '정답·해설' || comp === '빠른정답') comp = '본책';
      const ed = edition(f.name);
      if (ser) { title = `${ser} ${gs}`.trim() + (comp !== '본책' ? ' ' + comp : '') + (f.name.includes('특강') && !ser.includes('특강') ? ' 특강' : ''); key = ['s', ser, gs, comp === '본책' ? '' : comp, ed].join('|'); }
      else { title = cleanTitle(f.stem); key = 'f|' + f.label + '|' + title; }
      if (ed) title += ` (${ed})`;
      kind = ser ? '시중교재' : isExam(f.name) ? '기출·시험지' : (/내신대비/.test(f.label + f.name) ? '내신대비' : gs.startsWith('고등') ? '고등 교재' : '기타');
    } else { key = 'etc|' + f.label + '|' + top; title = '한글·기타 파일 · ' + (top || f.label); kind = '한글/기타'; }
    if (!books.has(key)) books.set(key, { key, title, kind, files: [], grade: '' });
    const b = books.get(key); b.files.push(f); if (!b.grade) b.grade = gradeOf(f) || gradeSem(title);
  }
  const out = [];
  for (const b of books.values()) {
    if (b.files.some((f) => f.ext === 'pdf')) { b.files.filter((f) => f.ext === 'zip').forEach((f) => { f.dupOf = '같은 교재의 풀린 PDF'; f.dupKind = '압축본(풀린 PDF 사용)'; }); b.files = b.files.filter((f) => f.ext !== 'zip'); }
    const roles = {}; b.files.forEach((f) => { const r = fileRole(f.name); roles[r] = (roles[r] || 0) + 1; });
    const aud = [...new Set(b.files.map((f) => audience(f.name)).filter(Boolean))].sort();
    const grp = {}; b.files.filter((f) => f.ext === 'pdf').forEach((f) => { const k = fileRole(f.name) + '|' + audience(f.name); (grp[k] = grp[k] || []).push(f); });
    const review = ['교과서 자료', '수업자료', '한글/기타'].includes(b.kind) ? [] : Object.entries(grp).filter(([, g]) => g.length > 1).map(([k, g]) => ({ role: k.replace('|', ' ').trim(), files: g.map((x) => [x.label, x.rel, x.size]) }));
    out.push({ key: b.key, title: b.title, kind: b.kind, grade: b.grade, roles, audience: aud, base: aud.includes('교사용') ? '교사용' : aud[0] || '', review,
      zipped: b.files.some((f) => f.ext === 'zip') && !b.files.some((f) => f.ext === 'pdf'),
      files: b.files.map((f) => ({ label: f.label, root: f.root, rel: f.rel, size: f.size, ext: f.ext, role: fileRole(f.name), audience: audience(f.name) })) });
  }
  const dups = files.filter((f) => f.dupOf).map((f) => ({ label: f.label, rel: f.rel, size: f.size, kind: f.dupKind, keep: f.dupOf }));
  return { books: out, dups, sizeReview };
}
