// 브라우저용 출력: 문서 JSON → 새 창에 A4 배치 → 인쇄(또는 'PDF로 저장')
// 서버 렌더러(engine/render.js)와 같은 디자인·배치 규칙을 씁니다.
const BASE = new URL('./', import.meta.url).href;
const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';
const CIRC = ['①', '②', '③', '④', '⑤'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

function tex(k, s) {
  if (s == null) return '';
  return String(s)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => k.renderToString(t, { displayMode: true, throwOnError: false, strict: false }))
    .replace(/\$([^$]+?)\$/g, (_, t) => k.renderToString(t, { throwOnError: false, strict: false }))
    .replace(/\n/g, '<br>');
}

function itemHTML(k, it, meta) {
  const teacher = meta.audience === 'teacher';
  // crop: 원본에서 잘라낸 문항 그림 → 원래 크기(200dpi 기준 mm)로, 칸보다 크면 칸에 맞춤
  const f = it.figure;
  const dim = f?.w ? ` width="${f.w}" height="${f.h}"${f.crop ? ` style="width:${(f.w / 200 * 25.4).toFixed(1)}mm"` : ''}` : '';
  const fig = f ? `<div class="fig${f.pending ? ' pending' : ''}${f.crop ? ' crop' : ''}">${f.svg || `<img src="${f.img}"${dim}>`}</div>` : '';
  const box = it.box ? `<div class="box"><span class="bt">${esc(it.box.title || '보기')}</span>${it.box.lines.map((l) => tex(k, l)).join('<br>')}</div>` : '';
  let ch = '';
  if (it.choices?.length) {
    const n = it.choiceCols || (it.choices.join('').length > 46 ? 2 : 5);
    ch = `<div class="ch ${n >= 5 ? 'c5' : n === 3 ? 'c3' : n === 2 ? 'c2' : 'c1'}">${it.choices.map((c, i) => `<span>${CIRC[i]} ${tex(k, c)}</span>`).join('')}</div>`;
  }
  return `<div class="q" data-no="${it.no}"><div class="qh"><span class="no">${pad(it.no)}</span>${it.tag ? `<span class="tag">${esc(it.tag)}</span>` : ''}${teacher && it.src ? `<span class="src">${esc(it.src)}</span>` : ''}</div>
    <div class="stem">${tex(k, it.stem)}${it.pts ? ` <span class="pts">[${it.pts}점]</span>` : ''}</div>${fig}${box}${ch}${it.qr ? `<div class="qr">${it.qr}</div>` : ''}</div>`;
}

export function buildBody(k, doc) {
  const meta = doc.meta || {};
  return (doc.sections || []).map((s) => {
    if (s.type === 'sheet') return `<section class="sheet" data-per="${s.perPage || 4}" data-chip="${esc(s.chip)}" data-kick="${esc(s.kick || meta.kick)}" data-title="${esc(s.title || meta.title)}" data-unit="${esc(s.unit || meta.unit)}"><template class="items">${s.items.map((it) => itemHTML(k, it, meta)).join('')}</template></section>`;
    if (s.type === 'answers') {
      const g = s.groups.map((gr) => {
        const tables = [];
        for (let i = 0; i < gr.nos.length; i += 6) {
          const six = (a) => a.concat(Array(6 - a.length).fill(''));
          tables.push(`<table class="ans"><tr><th>번호</th>${six(gr.nos.slice(i, i + 6).map(pad)).map((n) => `<th>${n}</th>`).join('')}</tr>${gr.rows.map((r) => `<tr><td>${esc(r.label)}</td>${six(r.vals.slice(i, i + 6)).map((v) => `<td>${tex(k, v)}</td>`).join('')}</tr>`).join('')}</table>`);
        }
        return `<div class="ans-sec"><h2>${esc(gr.title)} <small>빠른 정답</small></h2>${tables.join('')}</div>`;
      }).join('');
      return `<section class="flowsec" data-chip="빠른 정답" data-kick="ANSWERS · 빠른 정답" data-title="빠른 정답" data-unit="${esc(meta.title)}"><template class="flowitems">${g}</template></section>`;
    }
    if (s.type === 'solutions') {
      const b = s.items.map((x) => `<div class="sol"><div class="sh"><span class="sn">${pad(x.no)}</span><span class="sa">정답 ${tex(k, x.answer)}</span>${x.tag ? `<span class="st">${esc(x.tag)}</span>` : ''}</div>${tex(k, x.text)}${x.key ? `<div class="key">핵심 · ${tex(k, x.key)}</div>` : ''}</div>`).join('');
      return `<section class="flowsec" data-chip="상세 해설" data-kick="SOLUTIONS · 상세 해설" data-title="정답 및 해설" data-unit="${esc(meta.title)}"><template class="flowitems">${b}</template></section>`;
    }
    if (s.type === 'hand') {
      const b = s.items.map((it) => `<div class="hs-item" data-no="${it.no}"><div>${itemHTML(k, { ...it, tag: null }, { audience: 'student' })}</div><div class="hs-steps">${(it.steps || []).map((st) => `<div class="t">${tex(k, st.title)}</div>${(st.lines || []).map((l) => `<div class="l">${tex(k, l)}</div>`).join('')}`).join('')}${it.answer ? `<div><span class="hs-ans">${tex(k, it.answer)}</span></div>` : ''}${it.note ? `<div class="hs-note">※ ${tex(k, it.note)}</div>` : ''}</div></div>`).join('');
      return `<section class="handsec" data-head="${esc(s.head || meta.title)}"><template class="hitems">${b}</template></section>`;
    }
    if (s.type === 'catalog') {
      return `<section class="tablesec" data-chip="${esc(s.chip)}" data-kick="${esc(s.kick)}" data-title="${esc(s.title)}" data-unit="${esc(s.unit)}"><template class="thead"><tr>${s.columns.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></template><template class="tbody">${s.rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</template>${s.note ? `<template class="tnote">${esc(s.note)}</template>` : ''}</section>`;
    }
    if (s.type === 'cover') return coverHTML(s);
    return '';
  }).join('');
}

function coverHTML(c) {
  const L = BASE + 'assets/logo_h.png';
  const T = (c.title || '').split('\n').map(esc).join('<br>');
  const p = {
    classic: `<div class="page" style="background:#FBF8F1;padding:24mm 20mm"><div style="position:absolute;left:0;right:0;top:0;height:3mm;background:#0A4844"></div><div style="display:flex;justify-content:space-between;align-items:center"><span style="letter-spacing:.3em;font-size:9pt;color:#A8812F;font-weight:700">${esc(c.kicker)}</span><img src="${L}" style="height:10mm"></div><div style="margin-top:60mm;font-family:var(--serif);font-weight:700;font-size:40pt;line-height:1.25;color:#0A4844">${T}</div><div style="margin-top:8mm;width:28mm;height:1mm;background:#D8B55B"></div><div style="margin-top:8mm;font-size:13pt;color:#3C4744">${esc(c.subtitle)}</div></div>`,
    insta: `<div class="page" style="padding:14mm"><div style="flex:1;border-radius:9mm;padding:1.6mm;background:linear-gradient(135deg,#C13584,#F77737,#FCAF45,#833AB4)"><div style="height:100%;border-radius:7.6mm;background:linear-gradient(160deg,#FFF6E5,#FBEFF6 55%,#EFEFFC);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center"><img src="${L}" style="width:62mm"><div style="margin-top:12mm;letter-spacing:.35em;color:#A8812F;font-weight:700;font-size:12pt">${esc(c.kicker)}</div><div style="margin-top:5mm;font-weight:900;font-size:36pt;line-height:1.25;color:#0A4844">${T}</div><div style="margin-top:6mm;font-size:13pt">${esc(c.subtitle)}</div></div></div></div>`,
    premium: `<div class="page" style="background:#0A4844;color:#fff;padding:24mm 20mm"><div style="margin-top:auto;letter-spacing:.35em;color:#D8B55B;font-size:10pt;font-weight:700">${esc(c.kicker)}</div><div style="margin-top:5mm;font-weight:900;font-size:38pt;line-height:1.25">${T}</div><div style="margin:7mm 0 30mm;font-size:13pt;color:#CFE3DF">${esc(c.subtitle)}</div></div>`,
    minimal: `<div class="page" style="padding:22mm 20mm"><div style="height:80mm;border-radius:6mm;background:#EEF4F1;display:flex;align-items:center;justify-content:center"><img src="${L}" style="height:16mm"></div><div style="margin-top:22mm;font-weight:900;font-size:34pt;color:#0A4844">${T}</div><div style="margin-top:5mm;font-size:13pt;color:#68736F">${esc(c.subtitle)}</div></div>`,
  };
  return p[c.preset] || p.classic;
}

let katexP = null;
function loadKatex() {
  katexP ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = KATEX + 'katex.min.js'; s.onload = () => res(window.katex); s.onerror = rej; document.head.appendChild(s); });
  return katexP;
}

// 새 창에서 배치 후 인쇄. 반환: 배치 결과(쪽 수, 경고)
export async function printDoc(doc, { autoPrint = true, win = null } = {}) {
  // 버튼을 누른 순간에 창부터 열어야 팝업 차단에 걸리지 않음
  const w = win || window.open('', '_blank');
  if (!w) throw new Error('팝업이 막혀 있습니다. 주소창 오른쪽에서 팝업을 허용해 주세요.');
  if (!win) w.document.write('<p style="font:15px sans-serif;padding:24px">A4로 배치하는 중…</p>');
  const k = await loadKatex();
  w.document.open();
  const meta = doc.meta || {};
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(meta.title || '수학도서관')}</title>
    <link rel="stylesheet" href="${KATEX}katex.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/gaegu@5.2.5/400.css">
    <link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&family=Noto+Serif+KR:wght@400;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${BASE}style.css">
    <style>table.cat{width:100%;border-collapse:collapse;font-size:8.6pt;table-layout:fixed}table.cat th{background:var(--gt);color:var(--g);padding:1.6mm 1mm;border-top:.4mm solid var(--g)}table.cat td{padding:1.4mm 1mm;border-bottom:.2mm solid var(--line);text-align:center;word-break:keep-all}table.cat td:first-child{text-align:left}
    .printbar{position:sticky;top:0;z-index:9;background:#0A4844;color:#fff;padding:8px 14px;display:flex;gap:10px;align-items:center;font:14px 'Noto Sans KR',sans-serif}.printbar button{background:#D8B55B;border:0;border-radius:6px;padding:6px 14px;font-weight:700;cursor:pointer}@media print{.printbar{display:none}}</style>
    </head><body data-meta='${esc(JSON.stringify(meta))}'><div class="printbar"><b>${esc(meta.title || '')}</b><span id="info"></span><span style="flex:1"></span><button onclick="print()">전체 인쇄 · PDF로 저장</button></div>${buildBody(k, doc)}</body></html>`);
  w.document.close();
  await new Promise((r) => (w.document.readyState === 'complete' ? r() : w.addEventListener('load', r)));
  await w.document.fonts.ready;
  const s = w.document.createElement('script'); s.src = BASE + 'layout.js'; w.document.body.appendChild(s);
  await new Promise((r) => (s.onload = r));
  const rep = w.__layout();
  w.document.getElementById('info').textContent = `A4 ${rep.pages}쪽${rep.warnings.length ? ' · 확인 필요 ' + rep.warnings.length : ''} — 'PDF로 저장'을 고르면 PDF 파일이 됩니다`;
  if (autoPrint) setTimeout(() => w.print(), 400);
  return rep;
}
