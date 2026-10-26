// 원본 문항·해설 잘라내기: PDF 글자층으로 위치를 찾고, 고해상도로 그려서 그 부분만 잘라 냅니다 (AI 없음)
import { pageText, lines, normNo } from './outline.js';

const DPI = 200;

// 문제 쪽에서 번호 no 문항이 차지하는 영역 (PDF 좌표, 위가 0)
export function problemBox(pt, no) {
  const { W, H, items } = pt;
  const ls = lines(items, W, true).filter((l) => l.y > H * 0.07 && l.y < H * 0.93);
  const hs = items.map((i) => i.h).filter(Boolean).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)] || 10;
  const isNum = (l) => { const t = l.text.split(' ')[0]; return /^\d{1,4}$/.test(t) && Number(t) > 0 && (l.items[0].h >= 12 || l.items[0].h >= med * 1.08 || l.text === t) ? t : null; };
  const nums = ls.map((l) => ({ l, t: isNum(l) })).filter((x) => x.t);
  const cand = nums.filter((x) => normNo(x.t) === normNo(no)).sort((a, b) => b.l.items[0].h - a.l.items[0].h);
  if (!cand.length) return null;
  const { l } = cand[0];
  const nh = l.items[0].h || 12;
  const col = l.col;
  // 번호 줄에 본문이 없으면(번호·출처만) 그 줄은 빼고, 본문이 이어지면 번호 줄부터 자름
  const rest = l.items.slice(1).filter((i) => i.h >= nh * 0.7 && !/^\d$/.test(i.s.trim()));
  const y0 = rest.length ? l.y - nh - 2 : l.y + 2;
  const nextNum = nums.filter((x) => x.l.col === col && x.l.y > l.y + 2).sort((a, b) => a.l.y - b.l.y)[0];
  const foot = items.filter((i) => i.y >= H * 0.92).map((i) => i.y - (i.h || 10));
  const bottom = (foot.length ? Math.min(...foot) : H * 0.95) - 4;
  const y1 = nextNum ? nextNum.l.y - (nextNum.l.items[0].h || 12) - 3 : bottom;
  const x0 = l.items[0].x - 4;
  const otherCol = nums.filter((x) => x.l.col !== col);
  let x1;
  if (col === 0) {
    const right = otherCol.length ? Math.min(...otherCol.map((x) => x.l.items[0].x)) : null;
    const bodyRight = items.filter((i) => i.y > y0 && i.y < y1 && i.x > W * 0.55).length;
    x1 = right ? right - 6 : bodyRight ? W - x0 + 4 : W / 2;
  } else x1 = W - 14;
  return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(W, x1), y1: Math.min(H, y1) };
}

// 쪽 그림 캐시 (최근 3쪽)
const pageCache = [];
async function pageCanvas(pdf, n) {
  const hit = pageCache.find((x) => x.pdf === pdf && x.n === n); if (hit) return hit.c;
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: DPI / 72 });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  pageCache.unshift({ pdf, n, c }); if (pageCache.length > 3) pageCache.pop();
  return c;
}

// 한 영역 잘라서 여백·단 구분선 정리 → canvas
async function cutOne(pdf, p, box) {
  const src = await pageCanvas(pdf, p);
  const k = DPI / 72;
  const sx = Math.floor(box.x0 * k), sy = Math.floor(box.y0 * k), sw = Math.ceil((box.x1 - box.x0) * k), sh = Math.ceil((box.y1 - box.y0) * k);
  if (sw < 10 || sh < 10) return null;
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const g = c.getContext('2d'); g.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return trim(c);
}
function trim(c) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const dark = (x, y) => { const i = (y * w + x) * 4; return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < 225; };
  const colDark = (x, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) if (dark(x, y)) n++; return n; };
  const rowDark = (y, x0, x1) => { let n = 0; for (let x = x0; x < x1; x++) if (dark(x, y)) n++; return n; };
  let x0 = 0, x1 = w, y0 = 0, y1 = h;
  // 단 구분선(세로로 길게 이어진 선)이 양 끝에 있으면 잘라 냄
  for (let x = w - 1; x > w * 0.9; x--) if (colDark(x, 0, h) > h * 0.55) { x1 = x - 2; break; }
  for (let x = 0; x < w * 0.08; x++) if (colDark(x, 0, h) > h * 0.55) { x0 = x + 3; }
  // 아래쪽 가로 구분선(점선 포함)
  for (let y = h - 1; y > h * 0.85; y--) if (rowDark(y, x0, x1) > (x1 - x0) * 0.5) { y1 = y - 2; break; }
  // 흰 여백
  while (y1 > y0 + 1 && !rowDark(y1 - 1, x0, x1)) y1--;
  while (y0 < y1 - 1 && !rowDark(y0, x0, x1)) y0++;
  while (x1 > x0 + 1 && !colDark(x1 - 1, y0, y1)) x1--;
  while (x0 < x1 - 1 && !colDark(x0, y0, y1)) x0++;
  const m = 10;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w, x1 + m); y1 = Math.min(h, y1 + m);
  if (y1 - y0 < 12) return null;
  const o = document.createElement('canvas'); o.width = x1 - x0; o.height = y1 - y0;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
// 여러 조각(다음 단으로 이어진 해설)을 위아래로 이어 붙임
function stack(parts) {
  const w = Math.max(...parts.map((p) => p.width)); const gap = 12;
  const h = parts.reduce((a, p) => a + p.height, 0) + gap * (parts.length - 1);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  let y = 0; for (const p of parts) { g.drawImage(p, 0, y); y += p.height + gap; }
  return c;
}
function encode(c) {
  const png = c.width * c.height < 450000;
  return { img: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), w: c.width, h: c.height };
}

export async function cropProblem(pdf, page, no) {
  const pt = await pageText(pdf, page);
  const box = problemBox(pt, no);
  if (!box) return null;
  const c = await cutOne(pdf, page, box);
  return c ? encode(c) : null;
}
export async function cropRegions(pdf, segs) {
  const parts = [];
  for (const s of segs || []) { const c = await cutOne(pdf, s.p, s); if (c) parts.push(c); }
  return parts.length ? encode(parts.length > 1 ? stack(parts) : parts[0]) : null;
}
// AI에 보낼 때는 JPEG base64
export async function toJpegBase64(dataUrl, maxW = 1200) {
  const im = new Image(); im.src = dataUrl; await im.decode();
  const k = Math.min(1, maxW / im.width);
  const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88).split(',')[1];
}
export async function pageJpegBase64(pdf, n) { const c = await pageCanvas(pdf, n); return c.toDataURL('image/jpeg', 0.82).split(',')[1]; }
