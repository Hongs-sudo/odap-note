// N: 드라이브(MYBOX) 폴더 연결 — 크롬·엣지의 폴더 접근 기능 사용
// 폴더 연결 정보는 이 PC의 브라우저(IndexedDB)에 저장되고, 파일은 읽기만 합니다.
const DB = 'odap-folders', STORE = 'roots';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); });
}

export const supported = () => 'showDirectoryPicker' in window;

export async function listRoots() {
  const db = await idb();
  return new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result || []); });
}

// 새 폴더 연결: label(예: 개인·시중교재 참고), category(시중교재/내신대비/교과서/2022개정/기타), path(안내용 원래 경로)
export async function addRoot({ label, category, path }) {
  const handle = await window.showDirectoryPicker({ mode: 'read', id: 'odap-' + (label || 'root').slice(0, 20) });
  const id = 'r' + Date.now();
  const rec = { id, label: label || handle.name, category: category || '기타', path: path || handle.name, handle, addedAt: Date.now(), lastScan: null, fileCount: 0 };
  await tx('readwrite', (s) => s.put(rec));
  return rec;
}
export async function removeRoot(id) { await tx('readwrite', (s) => s.delete(id)); }
export async function updateRoot(rec) { await tx('readwrite', (s) => s.put(rec)); }

// 권한 확인: 'granted' | 'prompt' | 'denied'
export async function permission(rec) { try { return await rec.handle.queryPermission({ mode: 'read' }); } catch { return 'denied'; } }
// 사용자가 버튼을 눌렀을 때만 호출 (브라우저 보안 규칙)
export async function reconnectAll(roots) {
  const out = [];
  for (const r of roots) { try { out.push([r.id, await r.handle.requestPermission({ mode: 'read' })]); } catch { out.push([r.id, 'denied']); } }
  return out;
}

// 폴더 안 파일을 모두 읽어 목록 만들기 (PDF·ZIP·HWP만, 하위 폴더 포함)
export async function scan(rec, onProgress) {
  const files = [];
  async function walk(dir, prefix, depth) {
    if (depth > 8) return;
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') { await walk(h, prefix + name + '/', depth + 1); continue; }
      if (!/\.(pdf|zip|hwp|hwpx)$/i.test(name)) continue;
      const f = await h.getFile();
      files.push({ root: rec.path, label: rec.label, category: rec.category, rel: prefix + name, size: f.size, mtime: f.lastModified });
      if (files.length % 50 === 0) onProgress?.(files.length);
    }
  }
  await walk(rec.handle, '', 0);
  rec.lastScan = Date.now(); rec.fileCount = files.length;
  await updateRoot(rec);
  return files;
}

// 교재 파일 열기 (재타이핑·목차 분석용)
export async function openFile(rec, rel) {
  let dir = rec.handle;
  const parts = rel.split('/');
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return (await dir.getFileHandle(parts.at(-1))).getFile();
}

// 이름이 같은 폴더에 대한 기본 분류 추천
export function guessCategory(path) {
  if (/교과서/.test(path)) return '교과서';
  if (/2022개정/.test(path)) return '2022개정';
  if (/내신대비/.test(path)) return '내신대비';
  if (/시중교재|교재자료/.test(path)) return '시중교재';
  return '기타';
}

export const DEFAULT_ROOTS = [
  { label: '개인·교재자료', path: 'N:\\개인\\2026 중등부\\D. 교재자료', category: '시중교재' },
  { label: '개인·교과서', path: 'N:\\개인\\교과서', category: '교과서' },
  { label: '개인·시중교재 참고', path: 'N:\\개인\\시중교재 참고자료', category: '시중교재' },
  { label: '개인·2022개정', path: 'N:\\개인\\2022개정 교재자료', category: '2022개정' },
  { label: '공유·교재자료', path: 'N:\\공유\\공유받은\\2026 중등부\\D. 교재자료', category: '시중교재' },
  { label: '공유·2학기 중간대비', path: 'N:\\공유\\공유받은\\2026 중등부\\A. 내신대비\\내신대비교재\\C. 2026년 2학기 중간대비\\중2_2학기 전범위', category: '내신대비' },
];
