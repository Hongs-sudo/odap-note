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
  const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
    s: it.str, x: it.transform[4], y: vp.height - it.transform[5], h: Math.abs(it.transform[3]) || it.height || 0, w: it.width || 0,
  }));
  return { W: vp.width, H: vp.height, items };
}

function lines(items, W, split = true) {
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

// 해설 PDF → 정답 { 구역키|번호: 답 }
// 1) 빠른정답 표  2) 그래도 빠진 번호는 상세 해설의 "01 정답 ④" 줄에서 보충
// keys: 문제 PDF에서 읽은 구역 키 목록 (제목 줄을 알아보는 데 씀)
export async function readAnswers(pdf, keys = []) {
  const known = new Set(keys);
  const headOf = (t) => { const m = t.match(HEAD); if (m) return normKey(m[0]); const k = normKey(cleanLabel(t)); if (known.has(k)) return k; if (/^\S+\/\S/.test(t) && !/\d\s*\/\s*\d/.test(t)) return k; return null; };
  const quick = {}, detail = {};
  let secQ = null, secD = null;
  for (let p = 1; p <= pdf.numPages; p++) {
    const pt = await pageText(pdf, p);
    const ls = lines(pt.items, pt.W, true);
    const isQuick = ls.some((l) => /빠른\s*정답/.test(l.text));
    for (const l of ls) {
      if (/^(빠른\s*정답|정답과\s*해설)$/.test(l.text)) continue;
      const h = headOf(l.text);
      if (h) { if (isQuick) secQ = h; else secD = h; continue; }
      if (isQuick) {
        if (!secQ) continue;
        parsePairs(l.items.map((i) => i.s.trim()).filter(Boolean)).forEach(([no, ans]) => { const k = secQ + '|' + normNo(no); if (!(k in quick)) quick[k] = ans; });
      } else if (secD) {
        const m = l.text.match(/^(\d{1,3})\s*정답\s*(.+)$/);
        if (m) { const k = secD + '|' + normNo(m[1]); if (!(k in detail)) detail[k] = m[2].replace(/\s*\/\s*/g, '/').trim(); }
      }
    }
  }
  return { ...detail, ...quick };
}
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
