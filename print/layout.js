// 브라우저 안에서 실행: 문항 길이를 재서 A4 쪽에 배치
window.__layout = function () {
  const meta = JSON.parse(document.body.dataset.meta || '{}');
  const LOGO = document.querySelector('link[href$="style.css"]').href.replace('style.css', 'assets/logo_h.png');
  const report = { pages: 0, warnings: [], placements: [] };
  const mm = (v) => v * 96 / 25.4;

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function makePage(d) {
    return el(`<div class="page"><div class="hd"><div><div class="kick">${esc(d.kick)}</div><h1>${esc(d.title)}</h1></div><img class="logo" src="${LOGO}"></div>
      <div class="bar"><span class="chip">${esc(d.chip)}</span><span class="unit">${esc(d.unit)}</span>${d.nowho ? '' : `<span class="who"><span>${esc(meta.grade || '')}</span><span>반 <u></u></span><span>이름 <u></u></span></span>`}</div>
      <div class="body"></div><div class="ft"><span>${esc((meta.footer || '') + (d.chip ? ' · ' + d.chip : ''))}</span><span class="pg"></span><img src="${LOGO}"></div></div>`);
  }

  // ---------- 문제지: 한 쪽 2/4/6문항, 긴 문제 자동 맞춤 ----------
  function layoutSheet(sec) {
    const per = +sec.dataset.per || 4, rows = Math.max(1, Math.round(per / 2));
    const d = { kick: sec.dataset.kick, title: sec.dataset.title, chip: sec.dataset.chip, unit: sec.dataset.unit };
    const probePage = makePage(d); sec.before(probePage);
    const body = probePage.querySelector('.body');
    const H = body.clientHeight, BW = body.clientWidth, GAP = mm(8), W = (BW - GAP) / 2;
    const slotH = H / rows;
    probePage.remove();
    const items = [...sec.querySelector('template.items').content.children];
    const probe = el(`<div style="position:absolute;left:-9999px;top:0"></div>`); document.body.appendChild(probe);
    const measure = (node, width) => { const c = node.cloneNode(true); const box = el(`<div style="width:${width}px"></div>`); box.appendChild(c); probe.appendChild(box); const h = box.getBoundingClientRect().height; box.remove(); return h; };

    const MIN = 0.85, PADB = mm(14); // 풀이 여백 최소 14mm
    const plans = items.map((node) => {
      const h = measure(node, W) + PADB;
      if (h <= slotH) return { node, k: 1, scale: 1, wide: false };
      if (h <= H) return { node, k: Math.ceil(h / slotH - 1e-6), scale: 1, wide: false };
      if (H / h >= MIN) return { node, k: rows, scale: H / h, wide: false };
      const hw = measure(node, BW) + PADB;
      if (hw <= H) return { node, k: Math.ceil(hw / slotH - 1e-6), scale: 1, wide: true };
      return { node, k: rows, scale: Math.max(MIN, H / hw), wide: true, overflow: H / hw < MIN };
    });
    probe.remove();

    const pages = [];
    let cur = null;
    const newPage = () => { cur = { grid: [Array(rows).fill(null), Array(rows).fill(null)], list: [] }; pages.push(cur); };
    newPage();
    const fits = (col, r, k) => r + k <= rows && cur.grid[col].slice(r, r + k).every((x) => x === null);
    for (const p of plans) {
      let placed = false;
      while (!placed) {
        if (p.wide) {
          for (let r = 0; r + p.k <= rows && !placed; r++) {
            const lastUsed = Math.max(...[0, 1].map((c) => cur.grid[c].map((x, i) => (x ? i : -1)).reduce((a, b) => Math.max(a, b), -1)));
            if (r <= lastUsed) continue;
            if (fits(0, r, p.k) && fits(1, r, p.k)) { for (let i = r; i < r + p.k; i++) cur.grid[0][i] = cur.grid[1][i] = p; cur.list.push({ p, col: 0, r, wide: true }); placed = true; }
          }
        } else {
          // 열 우선(왼쪽 위→아래, 오른쪽 위→아래), 앞서 놓은 문항보다 앞자리로는 끼워 넣지 않음
          const order = [];
          for (let c = 0; c < 2; c++) for (let r = 0; r < rows; r++) order.push([c, r]);
          const lastIdx = cur.list.length ? Math.max(...cur.list.map((x) => (x.wide ? 2 * rows - 1 : x.col * rows + x.r + x.p.k - 1))) : -1;
          for (const [c, r] of order) { if (c * rows + r <= lastIdx) continue; if (fits(c, r, p.k)) { for (let i = r; i < r + p.k; i++) cur.grid[c][i] = p; cur.list.push({ p, col: c, r }); placed = true; break; } }
        }
        if (!placed) newPage();
      }
    }

    const out = pages.map((pg) => {
      const page = makePage(d); const b = page.querySelector('.body');
      const wideRows = new Set(); pg.list.filter((x) => x.wide).forEach((x) => { for (let i = x.r; i < x.r + x.p.k; i++) wideRows.add(i); });
      // 세로 구분선: 넓은 문항이 없는 줄에만
      let r0 = null;
      for (let r = 0; r <= rows; r++) {
        const narrow = r < rows && !wideRows.has(r);
        if (narrow && r0 === null) r0 = r;
        if (!narrow && r0 !== null) { b.appendChild(el(`<div style="position:absolute;left:${W + GAP / 2}px;top:${r0 * slotH}px;height:${(r - r0) * slotH}px;border-left:.25mm solid #DCE3E0"></div>`)); r0 = null; }
      }
      for (const x of pg.list) {
        const w = x.wide ? BW : W, left = x.wide ? 0 : x.col * (W + GAP);
        const box = el(`<div class="full" style="left:${left}px;top:${x.r * slotH}px;width:${w}px;height:${x.p.k * slotH}px;${x.r > 0 ? 'border-top:.2mm dashed #e6ebe8;padding-top:2.5mm' : ''}"></div>`);
        const q = x.p.node.cloneNode(true);
        if (x.p.scale < 1) { q.style.transform = `scale(${x.p.scale})`; q.style.width = `${w / x.p.scale}px`; }
        box.appendChild(q);
        if (x.p.overflow) { box.appendChild(el('<span class="warn">문항이 길어 넘침 · 확인 필요</span>')); report.warnings.push('문항 ' + q.dataset.no + ' 넘침'); }
        b.appendChild(box);
        report.placements.push({ no: +q.dataset.no, slots: x.p.k, scale: +x.p.scale.toFixed(2), wide: !!x.wide });
      }
      return page;
    });
    sec.replaceWith(...out);
  }

  // ---------- 빠른 정답·상세 해설: 2단 흐름, 넘치면 다음 쪽 ----------
  function layoutFlow(sec) {
    const d = { kick: sec.dataset.kick, title: sec.dataset.title, chip: sec.dataset.chip, unit: sec.dataset.unit };
    const blocks = [...sec.querySelector('template.flowitems').content.children];
    const pages = [];
    let page, flow;
    const start = () => { page = makePage(d); flow = el('<div class="flow"></div>'); page.querySelector('.body').appendChild(flow); sec.before(page); pages.push(page); };
    start();
    const over = () => flow.scrollWidth > flow.clientWidth + 2;
    for (const blk of blocks) {
      // 정답표 묶음은 표 단위로 쪼개 넣기
      const parts = blk.classList.contains('ans-sec') ? (() => { const h = blk.querySelector('h2'); return [...blk.querySelectorAll('table')].map((t, i) => { const w = el('<div class="ans-sec"></div>'); if (i === 0) w.appendChild(h.cloneNode(true)); w.appendChild(t.cloneNode(true)); return w; }); })() : [blk];
      for (const part of parts) {
        const n = part.cloneNode(true); flow.appendChild(n);
        if (over()) { n.remove(); start(); flow.appendChild(part.cloneNode(true)); }
      }
    }
    sec.remove();
  }

  // ---------- 표(교재 목록) ----------
  function layoutTable(sec) {
    const d = { kick: sec.dataset.kick, title: sec.dataset.title, chip: sec.dataset.chip, unit: sec.dataset.unit, nowho: true };
    const head = sec.querySelector('template.thead').innerHTML;
    const rows = [...sec.querySelector('template.tbody').content.querySelectorAll('tr')];
    const note = sec.querySelector('template.tnote');
    let page, tb, body;
    const start = () => { page = makePage(d); body = page.querySelector('.body'); const ncol = (head.match(/<th/g) || []).length; const cg = ncol >= 6 ? '<colgroup><col style="width:36%"><col style="width:9%"><col style="width:16%"><col style="width:11%"><col style="width:6%"><col style="width:10%"><col style="width:12%"></colgroup>' : ncol === 3 ? '<colgroup><col style="width:38%"><col style="width:20%"><col style="width:42%"></colgroup>' : ''; const t = el(`<table class="cat">${cg}<thead>${head}</thead><tbody></tbody></table>`); body.appendChild(t); tb = t.querySelector('tbody'); sec.before(page); };
    start();
    if (note) body.insertBefore(el(`<p style="font-size:8pt;color:#68736F;margin-bottom:2mm">${note.innerHTML}</p>`), body.firstChild);
    for (const r of rows) { const n = r.cloneNode(true); tb.appendChild(n); if (body.scrollHeight > body.clientHeight + 1) { n.remove(); start(); tb.appendChild(r.cloneNode(true)); } }
    sec.remove();
  }

  // ---------- 손풀이: 한 쪽 2문항, 쪽의 50%를 넘으면 1문항 ----------
  function layoutHand(sec) {
    const headTxt = sec.dataset.head;
    const mk = () => el(`<div class="page"><div class="hs-hd"><span><b>수학도서관</b> · ${esc(headTxt)}</span><img src="${LOGO}"></div><div class="hs-frame"></div><div class="hs-pg"></div></div>`);
    const probePage = mk(); sec.before(probePage);
    const frame = probePage.querySelector('.hs-frame'); const FH = frame.clientHeight, FW = frame.clientWidth;
    probePage.remove();
    const items = [...sec.querySelector('template.hitems').content.children];
    const probe = el(`<div style="position:absolute;left:-9999px;width:${FW}px"></div>`); document.body.appendChild(probe);
    const plans = items.map((n) => { const c = n.cloneNode(true); c.style.height = 'auto'; probe.appendChild(c); const h = c.getBoundingClientRect().height; c.remove(); return { n, half: h <= FH / 2, h }; });
    probe.remove();
    let page = null, used = 0;
    for (const p of plans) {
      if (!page || (p.half ? used + 1 > 2 : used > 0)) { page = mk(); sec.before(page); used = 0; }
      const c = p.n.cloneNode(true); c.classList.add(p.half ? 'half' : 'whole');
      if (!p.half && p.h > FH) { const s = Math.max(0.8, FH / p.h); c.style.transform = `scale(${s})`; c.style.transformOrigin = 'top left'; c.style.width = `${100 / s}%`; if (FH / p.h < 0.8) report.warnings.push('손풀이 ' + c.dataset.no + ' 넘침'); }
      page.querySelector('.hs-frame').appendChild(c);
      used += p.half ? 1 : 2;
      report.placements.push({ hand: +c.dataset.no, half: p.half });
    }
    sec.remove();
  }

  document.querySelectorAll('section.sheet').forEach(layoutSheet);
  document.querySelectorAll('section.flowsec').forEach(layoutFlow);
  document.querySelectorAll('section.tablesec').forEach(layoutTable);
  document.querySelectorAll('section.handsec').forEach(layoutHand);

  // 쪽 번호
  const numbered = [...document.querySelectorAll('.page')].filter((p) => p.querySelector('.pg, .hs-pg'));
  numbered.forEach((p, i) => { const g = p.querySelector('.pg'); if (g) g.textContent = `${i + 1} / ${numbered.length}`; const h = p.querySelector('.hs-pg'); if (h) h.textContent = i + 1; });
  report.pages = document.querySelectorAll('.page').length;
  return report;
};
