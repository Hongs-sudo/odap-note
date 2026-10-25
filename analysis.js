// 교재 분석(목차·단원 수, 문항 재타이핑)과 새벽 자동 분석
// - 정해 둔 시간대에 이 PC의 크롬에서 프로그램이 열려 있으면, 대기 목록을 이어서 처리합니다.
// - 끝 시각이나 하루 AI 예산에 닿으면 멈추고 다음 날 이어 갑니다.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';
let pdfjsP = null;
async function pdfjs() {
  pdfjsP ||= import(PDFJS + 'pdf.min.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return m; });
  return pdfjsP;
}

export async function openPdf(file) {
  const lib = await pdfjs();
  return lib.getDocument({ data: await file.arrayBuffer(), cMapUrl: PDFJS.replace('build/', 'cmaps/'), cMapPacked: true }).promise;
}

// PDF 한 쪽 → JPEG(base64)
export async function pageImage(pdf, n, width = 1100) {
  const page = await pdf.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
}

// 표지 다음 몇 쪽을 작게 이어 붙여 목차를 찾게 함
export async function tocSheet(pdf, from = 1, to = 16) {
  const imgs = [];
  for (let i = from; i <= Math.min(to, pdf.numPages); i++) imgs.push(await pageImage(pdf, i, 520));
  return imgs;
}

export function inWindow(s, now = new Date()) {
  if (!s?.enabled) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const [a, b] = [s.start || '02:00', s.end || '06:00'].map((t) => { const [h, mm] = t.split(':').map(Number); return h * 60 + mm; });
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

// 실행기: api(path, body) 함수와 저장소 콜백을 받아 동작
export function createRunner({ api, getSettings, nextTask, saveResult, logUsage, todaySpent, onStatus }) {
  let running = false, timer = null, wake = null;
  async function step() {
    const s = await getSettings();
    if (running || !inWindow(s)) return;
    if ((await todaySpent()) >= (s.dailyBudgetUSD ?? 5)) { onStatus?.('오늘 AI 예산에 닿아 멈췄습니다'); return; }
    const task = await nextTask();
    if (!task) { onStatus?.('대기 중인 분석이 없습니다'); return; }
    running = true;
    try {
      wake = await navigator.wakeLock?.request('screen').catch(() => null);
      onStatus?.(`분석 중: ${task.title}`);
      const res = await task.run({ api, isOver: async () => !inWindow(await getSettings()) || (await todaySpent()) >= (s.dailyBudgetUSD ?? 5) });
      await saveResult(task, res);
      if (res?.usage) await logUsage(res.usage);
    } catch (e) {
      onStatus?.(`오류: ${e.message}`);
      await saveResult(task, { error: e.message });
    } finally { running = false; wake?.release?.(); }
  }
  return {
    start() { if (!timer) { timer = setInterval(step, 60_000); step(); } },
    stop() { clearInterval(timer); timer = null; },
    runNow: step,
    get running() { return running; },
  };
}

// 작업 정의 --------------------------------------------------
// 목차 → 중단원 수
export function tocTask({ file, title }) {
  return async ({ api }) => {
    const pdf = await openPdf(file);
    const images = await tocSheet(pdf, 1, Math.min(18, pdf.numPages));
    const r = await api('/ai/toc', { title, images });
    return { kind: 'toc', units: r.units, count: r.count, tocPage: r.tocPage, usage: r.usage };
  };
}

// 문항 재타이핑: 쪽 단위로 이어서 처리 (cursor = 다음에 할 쪽)
export function retypeTask({ file, title, cursor = 1, answerFile }) {
  return async ({ api, isOver }) => {
    const pdf = await openPdf(file);
    const items = []; let page = cursor; const usage = { input: 0, output: 0, usd: 0 };
    while (page <= pdf.numPages) {
      if (await isOver()) break;
      const image = await pageImage(pdf, page, 1300);
      const r = await api('/ai/retype', { title, page, image });
      (r.items || []).forEach((it) => items.push({ ...it, page }));
      usage.input += r.usage?.input || 0; usage.output += r.usage?.output || 0; usage.usd += r.usage?.usd || 0;
      page++;
    }
    return { kind: 'retype', items, cursor: page, done: page > pdf.numPages, usage };
  };
}
