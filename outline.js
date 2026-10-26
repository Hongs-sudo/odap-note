// 교재 PDF의 글자층으로 '구역(단원·회차) · 문항 번호 · 쪽'과 해설지의 '빠른정답'을 읽습니다.
// AI를 쓰지 않아 비용이 들지 않습니다. 글자층이 없는 스캔본은 빈 결과를 돌려줍니다.

export const normNo = (s) => { const d = String(s ?? '').replace(/[^0-9]/g, ''); return d ? String(parseInt(d, 10)) : ''; };
export const normKey = (s) => String(s || '').replace(/\s+/g, '').replace(/[·•]/g, '');
// "시험지/1.1 유리수와 소수1.1 유리수와 소수"처럼 겹쳐 읽힌 제목 정리
export const cleanLabel = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); const m = s.match(/^(.*?)(.{3,}?)\s?\2$/); return m ? (m[1] + m[2]).trim() : s; };
// 예) "1.1 삼각형의 성질 1회차 - 2레벨"
const HEAD = /(\d+(?:\.\d+)+)\s*([^\d\s][^\n]*?)\s*(\d+)\s*회차(?:\s*-\s*\d+\s*레벨)?/;

// 한 쪽의 글자 조각 → 줄(단 구분 포함)
export async function pageText(pdf, n) {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const raw = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
    s: it.str, x: it.transform[4], y: vp.height - it.transform[5], h: Math.abs(it.transform[3]) || it.height || 0, w: it.width || 0,
  }));
  // 굵게 보이려고 같은 글자를 같은 자리에 두 번 찍은 교재가 있어 겹친 조각은 하나만 남김
  const items = [];
  for (const it of raw) if (!items.some((o) => o.s === it.s && Math.abs(o.x - it.x) < 0.6 && Math.abs(o.y - it.y) < 0.6)) items.push(it);
  return { W: vp.width, H: vp.height, items };
}

export function lines(items, W, split = true) {
  const cols = split ? [items.filter((i) => i.x < W * 0.5), items.filter((i) => i.x >= W * 0.5)] : [items];
  const out = [];
  cols.forEach((arr, c) => {
    const sorted = [...arr].sort((a, b) => a.y - b.y || a.x - b.x);
    let cur = null;
    for (const it of sorted) {
      if (cur && Math.abs(it.y - cur.y) <= Math.max(2, (it.h || 8) * 0.45)) cur.items.push(it);
      else { cur = { y: it.y, col: c, items: [it] }; out.push(cur); }
    }
  });
  out.forEach((l) => { l.items.sort((a, b) => a.x - b.x); l.text = joinItems(l.items); });
  return out;
}
function joinItems(arr) {
  let s = '';
  arr.forEach((it, i) => { const prev = arr[i - 1]; if (prev && it.x - (prev.x + prev.w) > (it.h || 8) * 0.25) s += ' '; s += it.s; });
  return s.replace(/\s+/g, ' ').trim();
}

// 문제 PDF 한 쪽 → { head, nos }
export function readProblemPage({ W, H, items }) {
  const all = lines(items, W, false);
  const top = all.filter((l) => l.y < H * 0.12);
  const headLine = all.find((l) => HEAD.test(l.text));
  const head = headLine ? headLine.text.match(HEAD)[0] : (top[0]?.text || '');
  const hs = items.map((i) => i.h).filter(Boolean).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)] || 10;
  const nos = [];
  for (const l of lines(items, W, true)) {
    if (l.y < H * 0.07 || l.y > H * 0.93) continue;
    const first = l.items[0];
    const t = l.text.split(' ')[0]; // 숫자가 한 글자씩 쪼개져 있어도 줄로 합친 뒤 첫 덩어리를 봄
    if (/^\d{1,4}$/.test(t) && Number(t) > 0 && (first.h >= 12 || first.h >= med * 1.08 || l.text === t)) nos.push(t);
  }
  return { head: cleanLabel(head), nos };
}

// 문제 PDF 전체 → 구역 목록
export async function readOutline(pdf, onProgress) {
  const raw = []; let textPages = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const pt = await pageText(pdf, p);
    if (pt.items.length > 3) textPages++;
    const r = readProblemPage(pt);
    onProgress?.(p, pdf.numPages);
    if (r.nos.length) raw.push({ p, ...r });
  }
  const sections = []; const where = {};
  for (const { p, head, nos } of raw) {
    const key = normKey(head) || 'p' + p;
    let sec = sections.find((s) => s.key === key);
    if (!sec) { sec = { key, label: head || `${p}쪽`, pages: [], nos: [], hits: [] }; sections.push(sec); }
    nos.forEach((no) => sec.hits.push([no, p]));
  }
  // "01"처럼 앞에 0을 붙이는 교재면 같은 자릿수만 문항 번호로 인정 (장 표지의 쪽 번호 등 제외)
  for (const sec of sections) {
    const z = sec.hits.find(([no]) => /^0\d/.test(no));
    for (const [no, p] of sec.hits) {
      if (z && no.length !== z[0].length) continue;
      if (!sec.nos.includes(no)) sec.nos.push(no);
      if (!sec.pages.includes(p)) sec.pages.push(p);
      where[sec.key + '|' + normNo(no)] ??= p;
    }
    delete sec.hits;
  }
  return { sections: sections.filter((s) => s.nos.length), where, textPages, pages: pdf.numPages };
}

// 해설 PDF → { ans: {구역키|번호: 정답}, sol: {구역키|번호: [잘라낼 영역…]} }
// 1) 빠른정답 표  2) 그래도 빠진 번호는 상세 해설의 "01 정답 ④" 줄에서 보충
// sol: 상세 해설에서 그 문항 해설이 차지하는 영역(다음 단·쪽으로 이어지면 여러 조각)
// keys: 문제 PDF에서 읽은 구역 키 목록 (제목 줄을 알아보는 데 씀)
export async function readAnswerBook(pdf, keys = []) {
  const known = new Set(keys);
  const headOf = (t) => { const m = t.match(HEAD); if (m) return normKey(m[0]); const k = normKey(cleanLabel(t)); if (known.has(k)) return k; if (/^\S+\/\S/.test(t) && !/\d\s*\/\s*\d/.test(t)) return k; return null; };
  const quick = {}, detail = {}, sol = {};
  let secQ = null, secD = null, open = null;
  const close = () => { if (open && open.segs.length) sol[open.k] = open.segs; open = null; };
  for (let p = 1; p <= pdf.numPages; p++) {
    const pt = await pageText(pdf, p);
    const ls = lines(pt.items, pt.W, true);
    const isQuick = ls.some((l) => /빠른\s*정답/.test(l.text));
    if (isQuick) {
      for (const l of ls) {
        if (/^(빠른\s*정답|정답과\s*해설)$/.test(l.text)) continue;
        const h = headOf(l.text); if (h) { secQ = h; continue; }
        if (!secQ) continue;
        parsePairs(l.items.map((i) => i.s.trim()).filter(Boolean)).forEach(([no, ans]) => { const k = secQ + '|' + normNo(no); if (!(k in quick)) quick[k] = ans; });
      }
      continue;
    }
    const { W, H } = pt;
    for (const c of [0, 1]) {
      const body = ls.filter((l) => l.col === c && l.y > H * 0.075 && l.y < H * 0.93);
      if (!body.length) continue;
      const its = body.flatMap((l) => l.items);
      const x0 = Math.min(...its.map((i) => i.x)) - 3;
      const other = ls.filter((l) => l.col === 1 && l.y > H * 0.075 && l.y < H * 0.93).flatMap((l) => l.items);
      const x1 = c === 0 ? (other.length ? Math.min(...other.map((i) => i.x)) - 6 : W / 2) : W - 12; // 수식이 그림으로 들어간 교재가 있어 글자 끝 대신 쪽 끝까지 (여백은 잘라 낼 때 정리)
      const top = Math.min(...body.map((l) => l.y - (l.items[0].h || 10))) - 2;
      const foot = ls.filter((l) => l.y >= H * 0.93).map((l) => l.y - (l.items[0].h || 10));
      const bottom = (foot.length ? Math.min(...foot) : H * 0.95) - 3;
      const marks = [];
      for (const l of body) {
        const h = headOf(l.text);
        if (h) { marks.push({ type: 'head', k: h, top: l.y - (l.items[0].h || 10) - 2 }); continue; }
        const m = l.text.match(/^(\d{1,3})\s*정답\s*(.*)$/);
        if (m) marks.push({ type: 'sol', no: m[1], ans: m[2], base: l.y, top: l.y - (l.items[0].h || 10) - 2 });
      }
      marks.sort((a, b) => a.top - b.top);
      // 앞 단·쪽에서 이어지는 해설
      const firstTop = marks.length ? marks[0].top : bottom;
      if (open && firstTop - top > 12 && open.segs.length < 3) open.segs.push({ p, x0, x1, y0: top, y1: firstTop - 2 });
      marks.forEach((mk, i) => {
        const next = marks[i + 1]?.top ?? bottom;
        if (mk.type === 'head') { close(); secD = mk.k; return; }
        close();
        if (!secD) return;
        const k = secD + '|' + normNo(mk.no);
        if (mk.ans && !(k in detail)) detail[k] = mk.ans.replace(/\s*\/\s*/g, '/').trim();
        open = { k, segs: [{ p, x0, x1, y0: mk.base + 2, y1: next - 2 }] };
      });
    }
  }
  close();
  return { ans: { ...detail, ...quick }, sol };
}
export async function readAnswers(pdf, keys = []) { return (await readAnswerBook(pdf, keys)).ans; }
// "1 28 2 115 3 ①, ③ 4 58 / 5" → [[1,'28'],[2,'115'],[3,'①, ③'],[4,'58 / 5']]
function parsePairs(toks) {
  const res = []; let i = 0;
  while (i < toks.length && !/^\d{1,2}$/.test(toks[i])) i++;
  while (i < toks.length) {
    const no = Number(toks[i]); let j = i + 1; const ans = [];
    while (j < toks.length) {
      if (ans.length && toks[j] === String(no + 1) && !/[\/,]$/.test(ans[ans.length - 1])) break;
      ans.push(toks[j]); j++;
    }
    if (ans.length) res.push([no, ans.join(' ').replace(/\s*,\s*/g, ', ').replace(/\s*\/\s*/g, '/')]);
    i = j;
  }
  return res;
}
