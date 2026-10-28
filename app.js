// 수학도서관 오답노트 — 교재 라이브러리 · 교재 정리 · 학생 오답 입력 · 1차 오답노트 · 연결 설정
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, orderBy,
  onSnapshot, serverTimestamp, where,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { FIREBASE_CONFIG, API_BASE } from './config.js';
import { writeBatch, getDocs, limit, increment, arrayUnion, deleteField, getCountFromServer } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { createLibrary } from './library.js';
import { printDoc } from './print/print.js';
import { createWrong } from './wrong.js';
import { localDay } from './analysis.js';
import * as FOLD from './folders.js';

// 앱 버전: 고칠 때마다 올림. 연결 설정에서 지금 쓰는 버전과 서버의 최신 버전을 비교해 보여 줌
const APP_VERSION = '2026.10.28-3';
// ---------- 공통 ----------
const $ = (s) => document.querySelector(s);
const main = $('#main');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = (n) => (n ? `${(n / 1048576).toFixed(1)}MB` : '');
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800);
}
const modal = $('#modal');
function openModal(html) { $('#modalBody').innerHTML = html; if (!modal.open) modal.showModal(); }
function closeModal() { if (modal.open) modal.close(); }

if (FIREBASE_CONFIG.apiKey === 'REPLACE_ME') {
  main.innerHTML = `<div class="card"><h2>설정이 필요합니다</h2><p>config.js 파일에 Firebase 설정값과 API 주소를 넣어 주세요. 방법은 SETUP.md 2·4단계에 있습니다.</p></div>`;
  throw new Error('config.js not set');
}

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const S = { user: null, aid: null, academy: null, role: null, view: 'books', sets: [], books: [], students: [], unsub: [], uploads: {} };
const col = (name) => collection(db, 'academies', S.aid, name);
const ref = (name, id) => doc(db, 'academies', S.aid, name, id);

// ---------- API (Cloudflare Worker) ----------
async function api(path, opts = {}) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(API_BASE + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || `요청 실패 (${res.status})`);
  return body;
}
// AI 기능은 POST + JSON
const ai = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function uploadFile(key, file, onProgress) {
  return auth.currentUser.getIdToken().then((token) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}/files/${encodeURIComponent(key)}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let b = {}; try { b = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      xhr.status < 300 ? resolve(b) : reject(new Error(b.error || `업로드 실패 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('네트워크 오류로 업로드하지 못했습니다.'));
    xhr.send(file);
  }));
}

// ---------- 로그인 · 학원 연결 ----------
onAuthStateChanged(auth, async (user) => {
  S.unsub.forEach((u) => u()); S.unsub = [];
  S.user = user;
  $('#logoutBtn').hidden = !user;
  $('#tabs').hidden = true;
  if (!user) return renderLogin();
  const me = await getDoc(doc(db, 'users', user.uid));
  if (!me.exists() || !me.data().academyId) return renderCreateAcademy();
  S.aid = me.data().academyId;
  const [ac, mem] = await Promise.all([getDoc(doc(db, 'academies', S.aid)), getDoc(doc(db, 'academies', S.aid, 'members', user.uid))]);
  if (!mem.exists()) { main.innerHTML = '<div class="card">이 학원의 구성원으로 등록되지 않은 계정입니다. 원장님께 문의하세요.</div>'; return; }
  S.academy = ac.data(); S.role = mem.data().role;
  $('#academyName').textContent = S.academy.name;
  $('#tabs').hidden = false;
  listen();
  render();
  lib().runner.start(); // 새벽 분석: 정해 둔 시간에 프로그램이 열려 있으면 자동 실행
  permBanner();
});

function renderLogin() {
  $('#academyName').textContent = '';
  main.innerHTML = `<div class="card center pad"><h2>로그인</h2><p class="muted">원장님 구글 계정으로 로그인하세요.</p><button class="primary" id="loginBtn">구글로 로그인</button></div>`;
  $('#loginBtn').onclick = async () => {
    const p = new GoogleAuthProvider();
    try { await signInWithPopup(auth, p); } catch (e) {
      if (String(e.code).includes('popup')) await signInWithRedirect(auth, p); else toast(e.message);
    }
  };
}

function renderCreateAcademy() {
  main.innerHTML = `<div class="card"><h2>처음 설정</h2><p class="muted small">학원 정보를 한 번만 만들면 됩니다. 나중에 선생님 계정을 이 학원에 추가할 수 있습니다.</p>
    <label class="f">학원 이름</label><input type="text" id="acName" value="수학도서관">
    <div class="row" style="margin-top:12px"><button class="primary" id="acCreate">학원 만들기</button></div></div>`;
  $('#acCreate').onclick = async () => {
    const name = $('#acName').value.trim() || '수학도서관';
    const u = S.user;
    const acRef = doc(collection(db, 'academies'));
    await setDoc(acRef, { name, ownerUid: u.uid, createdAt: serverTimestamp() });
    await setDoc(doc(db, 'academies', acRef.id, 'members', u.uid), { role: 'owner', name: u.displayName || '', email: u.email || '', joinedAt: serverTimestamp() });
    await setDoc(doc(db, 'users', u.uid), { academyId: acRef.id });
    location.reload();
  };
}

$('#logoutBtn').onclick = () => signOut(auth);
$('#tabs').onclick = (e) => {
  const b = e.target.closest('button[data-view]'); if (!b) return;
  S.view = b.dataset.view;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  render();
};

function listen() {
  const sub = (name, key, field) => S.unsub.push(onSnapshot(query(col(name), orderBy(field)), (snap) => {
    S[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!modal.open) render();
  }, (err) => toast(`불러오기 오류: ${err.message}`)));
  sub('bookSets', 'sets', 'createdAt');
  sub('books', 'books', 'order');
  // 선생님 계정은 본인 담당 학생만 불러옵니다 (보안 규칙과 맞춤)
  const sq = S.role === 'owner'
    ? query(col('students'), orderBy('name'))
    : query(col('students'), where('teacherUid', '==', S.user.uid), orderBy('name'));
  S.unsub.push(onSnapshot(sq, (snap) => {
    S.students = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!modal.open) render();
  }, (err) => toast(`불러오기 오류: ${err.message}`)));
}

let LIB = null;
function lib() {
  LIB ||= createLibrary({
    main: () => main, toast, db, aid: () => S.aid, api: ai, openModal, closeModal,
    itemTask: (t) => async () => wr().retryItem(t),
    fs: { doc, getDoc, setDoc, getDocs, collection, writeBatch, query, where, orderBy, limit, updateDoc, increment, arrayUnion, deleteField },
  });
  return LIB;
}
let WR = null;
function wr() {
  WR ||= createWrong({
    db, aid: () => S.aid, ai, toast, openModal, closeModal, uid: () => S.user.uid,
    fs: { doc, getDoc, setDoc, getDocs, collection, writeBatch, updateDoc, deleteDoc, increment, arrayUnion },
  });
  return WR;
}
function render() {
  if (S.view === 'books') renderBooks();
  else if (S.view === 'catalog') lib().show();
  else if (S.view === 'students') renderStudents();
  else renderSettings();
}

// ---------- 교재 라이브러리 ----------
function renderBooks() {
  const loose = S.books.filter((b) => !S.sets.some((s) => s.id === b.setId));
  main.innerHTML = `
    <div class="row between"><h2>교재 라이브러리</h2><button class="primary" data-a="newSet">+ 교재 세트</button></div>
    ${S.sets.length ? '' : '<div class="empty">먼저 교재 세트를 만드세요.<br><span class="small">예) 중2-2 중간고사 대비</span></div>'}
    ${S.sets.map(setCard).join('')}
    ${loose.length ? `<div class="card"><h3>세트 없는 교재</h3>${loose.map(bookBlock).join('')}</div>` : ''}`;
}
function setCard(s) {
  const books = S.books.filter((b) => b.setId === s.id);
  return `<div class="card">
    <div class="row between"><div><h3>${esc(s.name)}</h3><span class="muted small">${esc(s.grade || '')} · 교재 ${books.length}권</span></div>
      <div class="row"><button class="ghost small" data-a="newBook" data-id="${s.id}">+ 교재</button><button class="ghost small" data-a="editSet" data-id="${s.id}">수정</button></div></div>
    ${books.map(bookBlock).join('') || '<p class="muted small">이 세트에 교재를 추가하세요. 단계별 교재를 순서대로 넣으면 됩니다.</p>'}
  </div>`;
}
function bookBlock(b) {
  const ready = b.mainFile && b.answerFile;
  return `<div style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
    <div class="row between"><div class="row"><span class="badge gold">${esc(b.order ?? '')}단계</span><strong>${esc(b.title)}</strong>
      <span class="badge ${ready ? '' : 'red'}">${ready ? '파일 등록 완료' : '파일 필요'}</span></div>
      <div class="row"><button class="ghost small" data-a="editBook" data-id="${b.id}">수정</button></div></div>
    <div class="slots">${slot(b, 'mainFile', '교재 PDF')}${slot(b, 'answerFile', '정답·해설 PDF')}</div>
  </div>`;
}
function slot(b, field, label) {
  const f = b[field]; const up = S.uploads[`${b.id}:${field}`];
  if (up != null) return `<div class="slot"><div class="small">${label} 올리는 중… ${Math.round(up * 100)}%</div><div class="progress"><div style="width:${up * 100}%"></div></div></div>`;
  if (f) return `<div class="slot done"><div class="row between"><span class="small"><strong>${label}</strong> ${f.source === 'mybox' ? '· MYBOX' : ''}</span>
      <span class="row"><button class="ghost small" data-a="openFile" data-key="${esc(f.key)}">보기</button><button class="ghost small" data-a="pick" data-id="${b.id}" data-f="${field}">바꾸기</button></span></div>
      <div class="name muted">${esc(f.name)} ${mb(f.size)}</div></div>`;
  return `<div class="slot"><div class="small"><strong>${label}</strong></div><div class="row" style="margin-top:6px">
    <button class="ghost small" data-a="upload" data-id="${b.id}" data-f="${field}">파일 올리기</button>
    <button class="ghost small" data-a="mybox" data-id="${b.id}" data-f="${field}">MYBOX에서</button></div></div>`;
}

function setForm(s = {}) {
  openModal(`<h2>${s.id ? '교재 세트 수정' : '새 교재 세트'}</h2>
    <label class="f">세트 이름</label><input type="text" id="fName" value="${esc(s.name || '')}" placeholder="중2-2 중간고사 대비">
    <label class="f">학년</label><input type="text" id="fGrade" value="${esc(s.grade || '중2')}">
    <div class="row between" style="margin-top:16px">${s.id ? '<button class="ghost danger" id="fDel">세트 삭제</button>' : '<span></span>'}
      <div class="row"><button class="ghost" data-a="close">취소</button><button class="primary" id="fSave">저장</button></div></div>`);
  $('#fSave').onclick = async () => {
    const data = { name: $('#fName').value.trim(), grade: $('#fGrade').value.trim() };
    if (!data.name) return toast('세트 이름을 입력하세요.');
    if (s.id) await updateDoc(ref('bookSets', s.id), data);
    else await addDoc(col('bookSets'), { ...data, createdAt: serverTimestamp(), createdBy: S.user.uid });
    closeModal(); render();
  };
  if (s.id) $('#fDel').onclick = async () => {
    if (S.books.some((b) => b.setId === s.id)) return toast('세트 안의 교재를 먼저 지우거나 옮기세요.');
    if (!confirm('이 세트를 삭제할까요?')) return;
    await deleteDoc(ref('bookSets', s.id)); closeModal(); render();
  };
}

function bookForm(b = {}, setId) {
  const sid = b.setId || setId;
  const nextOrder = S.books.filter((x) => x.setId === sid).length + 1;
  openModal(`<h2>${b.id ? '교재 수정' : '교재 추가'}</h2>
    <label class="f">교재 이름</label><input type="text" id="fTitle" value="${esc(b.title || '')}" placeholder="예) 내신대비 기본편">
    <label class="f">단계 (순서)</label><input type="number" id="fOrder" min="1" value="${esc(b.order ?? nextOrder)}">
    <label class="f">교재 세트</label><select id="fSet">${S.sets.map((s) => `<option value="${s.id}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    <div class="row between" style="margin-top:16px">${b.id ? '<button class="ghost danger" id="fDel">교재 삭제</button>' : '<span></span>'}
      <div class="row"><button class="ghost" data-a="close">취소</button><button class="primary" id="fSave">저장</button></div></div>`);
  $('#fSave').onclick = async () => {
    const data = { title: $('#fTitle').value.trim(), order: Number($('#fOrder').value) || 1, setId: $('#fSet').value };
    if (!data.title) return toast('교재 이름을 입력하세요.');
    if (b.id) await updateDoc(ref('books', b.id), data);
    else await addDoc(col('books'), { ...data, status: 'registered', createdAt: serverTimestamp(), createdBy: S.user.uid });
    closeModal(); render();
  };
  if (b.id) $('#fDel').onclick = async () => {
    if (!confirm('교재와 올린 파일을 삭제할까요? 학생 기록이 생긴 뒤에는 삭제하지 마세요.')) return;
    for (const f of [b.mainFile, b.answerFile]) if (f) await api(`/files/${encodeURIComponent(f.key)}`, { method: 'DELETE' }).catch(() => {});
    await deleteDoc(ref('books', b.id)); closeModal(); render();
  };
}

const fileKey = (bookId, field) => `academies/${S.aid}/books/${bookId}/${field === 'mainFile' ? 'book' : 'answer'}.pdf`;

function pickLocal(bookId, field) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/pdf,.pdf';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    if (!/\.pdf$/i.test(file.name)) return toast('PDF 파일만 올릴 수 있습니다.');
    if (file.size > 95 * 1048576) return toast('95MB 이하 파일만 바로 올릴 수 있습니다. 큰 파일은 MYBOX에서 가져오세요.');
    const k = `${bookId}:${field}`; const key = fileKey(bookId, field);
    S.uploads[k] = 0; render();
    try {
      const r = await uploadFile(key, file, (p) => { S.uploads[k] = p; render(); });
      delete S.uploads[k];
      await updateDoc(ref('books', bookId), { [field]: { key, name: file.name, size: r.size ?? file.size, source: 'upload', at: Date.now() } });
      toast('업로드 완료');
    } catch (e) { delete S.uploads[k]; render(); toast(e.message); }
  };
  inp.click();
}

// ---------- MYBOX 파일 고르기 ----------
async function myboxPicker(bookId, field) {
  const trail = [{ id: null, name: 'MYBOX' }];
  const show = async (items, note = '') => {
    openModal(`<h2>MYBOX에서 가져오기</h2>
      <div class="row"><input type="text" id="mbQ" placeholder="파일 이름으로 검색" style="flex:1"><button class="ghost" id="mbSearch">검색</button></div>
      <div class="crumb">${trail.map((t, i) => `<button data-i="${i}">${esc(t.name)}</button>`).join(' › ')}</div>
      ${note ? `<p class="muted small">${note}</p>` : ''}
      <div class="list" id="mbList">${items.length ? items.map((it) => `<button data-id="${esc(it.id)}" data-type="${it.type}" data-name="${esc(it.name)}">
        <span>${it.type === 'folder' ? '📁' : '📄'} ${esc(it.name)}</span><span class="muted small">${it.type === 'folder' ? '' : mb(it.size)}</span></button>`).join('')
        : '<p class="muted small pad center">PDF나 폴더가 없습니다. 암호화 폴더와 공유받은 폴더는 보이지 않습니다.</p>'}</div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" data-a="close">닫기</button></div>`);
    $('#mbSearch').onclick = async () => {
      const q = $('#mbQ').value.trim(); if (!q) return;
      try { const r = await api(`/mybox/search?q=${encodeURIComponent(q)}`); show(filterPdf(r.items, true), `"${esc(q)}" 검색 결과`); } catch (e) { toast(e.message); }
    };
    document.querySelectorAll('.crumb button').forEach((b) => b.onclick = () => { trail.splice(Number(b.dataset.i) + 1); load(); });
    $('#mbList').onclick = async (e) => {
      const b = e.target.closest('button[data-id]'); if (!b) return;
      if (b.dataset.type === 'folder') { trail.push({ id: b.dataset.id, name: b.dataset.name }); return load(); }
      $('#mbList').innerHTML = `<p class="pad center">“${esc(b.dataset.name)}” 가져오는 중… (큰 파일은 1분 정도 걸립니다)</p>`;
      try {
        const key = fileKey(bookId, field);
        const r = await api('/mybox/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: b.dataset.id, key }) });
        await updateDoc(ref('books', bookId), { [field]: { key, name: r.name, size: r.size, source: 'mybox', myboxId: b.dataset.id, at: Date.now() } });
        closeModal(); render(); toast('MYBOX에서 가져왔습니다');
      } catch (err) { toast(err.message); load(); }
    };
  };
  const filterPdf = (items, onlyFiles) => items.filter((i) => (!onlyFiles && i.type === 'folder') || /\.pdf$/i.test(i.name));
  const load = async () => {
    openModal('<p class="pad center">MYBOX 목록 불러오는 중…</p>');
    try {
      const cur = trail[trail.length - 1];
      const r = await api(`/mybox/list${cur.id ? `?folderId=${encodeURIComponent(cur.id)}` : ''}`);
      show(filterPdf(r.items, false), r.nextCursor ? '항목이 많아 앞쪽 200개만 보입니다. 검색을 이용하세요.' : '');
    } catch (e) { openModal(`<h2>MYBOX 연결 오류</h2><p>${esc(e.message)}</p><p class="muted small">연결 설정 탭에서 상태를 확인하세요.</p><div class="row" style="justify-content:flex-end"><button class="ghost" data-a="close">닫기</button></div>`); }
  };
  load();
}

async function openFile(key) {
  const w = window.open('', '_blank');
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/files/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('파일을 열 수 없습니다.');
    const url = URL.createObjectURL(await res.blob());
    if (w) w.location = url; else location.href = url;
  } catch (e) { if (w) w.close(); toast(e.message); }
}

// ---------- 학생 ----------
let catalogReady = false;
function renderStudents() {
  const mine = S.role === 'owner' ? S.students : S.students.filter((s) => s.teacherUid === S.user.uid);
  if (!catalogReady) wr().catalog().then(() => { catalogReady = true; if (S.view === 'students' && !modal.open) render(); }).catch(() => {});
  main.innerHTML = `<div class="row between"><h2>학생</h2><button class="primary" data-a="newStudent">+ 학생 등록</button></div>
    ${mine.length ? '' : '<div class="empty">학생을 등록한 뒤 <b>오답 입력</b>을 누르세요. 교재는 오답 입력 화면에서 찾아 고르면 자동으로 이 학생 교재로 들어갑니다.</div>'}
    ${mine.map((s) => {
      const books = (s.catalogIds || []).map((id) => wr().bookOf(id)).filter(Boolean);
      const recs = [...(s.records || [])].sort((a, b) => b.at - a.at);
      const prog = wr().progress(s);
      const total = prog.reduce((a, p) => a + p.total, 0), done = prog.reduce((a, p) => a + p.done, 0);
      return `<div class="card"><div class="row between"><div><h3>${esc(s.name)}</h3><span class="muted small">${esc(s.grade || '')} ${esc(s.school || '')} · 오답 ${total}개 · 오답노트 완료 ${done} · 남음 ${total - done}</span></div>
        <div class="row"><button class="primary small" data-a="wrongIn" data-id="${s.id}">+ 오답 입력</button>${total ? `<button class="primary small" data-a="makeNote" data-id="${s.id}">오답노트 만들기</button>` : ''}<button class="ghost small" data-a="editStudent" data-id="${s.id}">수정</button></div></div>
        <div class="row" style="margin-top:8px">${books.map((b) => `<span class="badge">${esc(b.title)} <button class="chipx" data-a="dropBook" data-id="${s.id}" data-key="${b.id}" title="이 학생 교재에서 빼기">×</button></span>`).join('') || (catalogReady ? '<span class="muted small">아직 고른 교재 없음</span>' : '')}</div>
        ${prog.length ? `<div style="margin-top:8px">${prog.map((p) => `<div class="prog small"><span style="flex:1">${esc(p.title)}</span><span class="bar"><i style="width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%"></i></span><span>${p.done}/${p.total}</span><span class="muted" style="flex:1.4">${p.left.length ? '남은 단원: ' + esc(p.left.join(', ')) : '모두 오답노트 완료'}</span></div>`).join('')}</div>` : ''}
        ${(s.sheets || []).length ? `<div style="margin-top:10px"><b class="small">만든 오답노트 ${(s.sheets || []).length}개</b>${[...(s.sheets || [])].sort((a, b) => b.at - a.at).map((sh) => `<div class="prog small"><span style="flex:1.6"><b>${new Date(sh.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</b> · ${esc(sh.kind || '1차')}${sh.scope ? ' · ' + esc(sh.scope) : ''} · ${sh.count || 0}문항${sh.books?.length ? ` <span class="muted">· ${esc(sh.books.join(', '))}</span>` : ''}${sh.items ? '' : ' <span class="muted">(이전 버전 · 다시 열 수 없음)</span>'}</span>
          ${sh.items ? `<button class="ghost small" data-a="sheetPrint" data-aud="student" data-id="${s.id}" data-key="${sh.id}">학생용</button><button class="ghost small" data-a="sheetPrint" data-aud="teacher" data-id="${s.id}" data-key="${sh.id}">선생님용</button><button class="ghost small" data-a="sheetEdit" data-id="${s.id}" data-key="${sh.id}">고쳐서 다시 만들기</button>` : ''}<button class="ghost small danger" data-a="sheetDel" data-id="${s.id}" data-key="${sh.id}" title="오답노트 지우기">×</button></div>`).join('')}</div>` : ''}
        ${recs.length ? `<details style="margin-top:6px"><summary class="small muted" style="cursor:pointer">입력 기록 ${recs.length}건</summary>${recs.map((r) => `<div class="rec"><span style="flex:1"><b>${new Date(r.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</b> · ${esc(r.title)} · ${esc(r.type || '')} · <span style="color:var(--red)">오답 ${r.wrongs.length}</span>${r.wrongs.length ? ` <span class="muted">(${esc(r.wrongs.slice(0, 10).map((w) => (w.label ? w.label.replace(/\s*-\s*\d+\s*레벨/, '').replace(/^[^/]+\//, '') + ' ' : '') + w.no).join(', '))}${r.wrongs.length > 10 ? ' …' : ''})</span>` : ''}</span>
          <button class="ghost small danger" data-a="delRec" data-id="${s.id}" data-key="${r.id}" title="기록 지우기">×</button></div>`).join('')}</details>` : ''}
      </div>`;
    }).join('')}`;
}

function studentForm(s = {}) {
  const ids = [...(s.catalogIds || [])];
  openModal(`<h2>${s.id ? '학생 수정' : '학생 등록'}</h2>
    <label class="f">이름</label><input type="text" id="fName" value="${esc(s.name || '')}">
    <div class="row"><div style="flex:1"><label class="f">학년</label><input type="text" id="fGrade" value="${esc(s.grade || '중2')}"></div>
      <div style="flex:1"><label class="f">학교</label><input type="text" id="fSchool" value="${esc(s.school || '')}"></div></div>
    ${s.id ? `<label class="f">사용 교재 (오답 입력 화면에서 찾아 고르면 자동으로 추가됩니다)</label><div class="checks">${ids.map((id) => { const b = wr().bookOf(id); return b ? `<label><input type="checkbox" value="${id}" checked> ${esc(b.title)}</label>` : ''; }).join('') || '<p class="muted small">아직 없음</p>'}</div>` : ''}
    <div class="row between" style="margin-top:16px">${s.id ? '<button class="ghost danger" id="fDel">학생 삭제</button>' : '<span></span>'}
      <div class="row"><button class="ghost" data-a="close">취소</button><button class="primary" id="fSave">저장</button></div></div>`);
  $('#fSave').onclick = async () => {
    const data = { name: $('#fName').value.trim(), grade: $('#fGrade').value.trim(), school: $('#fSchool').value.trim() };
    if (!data.name) return toast('이름을 입력하세요.');
    if (s.id) { data.catalogIds = [...document.querySelectorAll('.checks input:checked')].map((c) => c.value); await updateDoc(ref('students', s.id), data); }
    else await addDoc(col('students'), { ...data, catalogIds: [], records: [], sheets: [], teacherUid: S.user.uid, createdAt: serverTimestamp() });
    closeModal(); render();
  };
  if (s.id) $('#fDel').onclick = async () => { if (confirm(`${s.name} 학생을 삭제할까요? 오답 기록도 함께 지워집니다.`)) { await deleteDoc(ref('students', s.id)); closeModal(); render(); } };
}

async function delRecord(sid, rid) {
  const s = S.students.find((x) => x.id === sid); if (!s) return;
  if (!confirm('이 오답 기록을 지울까요?')) return;
  await updateDoc(ref('students', sid), { records: (s.records || []).filter((r) => r.id !== rid) });
}

// ---------- 연결 설정 ----------
async function renderSettings() {
  main.innerHTML = `<h2>연결 설정</h2>
    <div class="card"><div class="kv"><span class="muted">계정</span><span>${esc(S.user.email)}</span>
      <span class="muted">내 UID</span><span><code>${esc(S.user.uid)}</code></span>
      <span class="muted">학원 ID</span><span><code>${esc(S.aid)}</code></span>
      <span class="muted">API 주소</span><span><code>${esc(API_BASE)}</code></span>
      <span class="muted">앱 버전</span><span id="verBox"><b>${APP_VERSION}</b> <span class="muted small">확인 중…</span></span></div>
      <p class="muted small">UID는 서버 허용 목록(ALLOWED_UIDS)에 넣는 값입니다. 선생님을 추가할 때도 그분의 UID를 여기서 확인해 넣습니다.</p></div>
    <div class="card" id="health"><p class="muted">연결 상태 확인 중…</p></div>
    <div class="card" id="nightly"><p class="muted">새벽 분석 설정 불러오는 중…</p></div>
    <div class="card"><h3>출력 시험</h3><p class="muted small">재타이핑 시범(내신대비B 1.1 1회차 10문항 + 유사 1 + 정답·해설)으로 A4 출력과 인쇄를 시험합니다.</p>
      <div class="row"><button class="ghost small" data-a="sample" data-aud="student">학생용 미리보기</button><button class="ghost small" data-a="sample" data-aud="teacher">선생님용(출처 표시)</button><select id="smpPer" style="width:auto"><option value="2">한 쪽 2문항</option><option value="4" selected>한 쪽 4문항</option><option value="6">한 쪽 6문항</option></select></div></div>`;
  renderNightly();
  checkVersion();
  const out = [];
  try {
    const h = await fetch(`${API_BASE}/health`).then((r) => r.json());
    out.push(['API 서버', '정상']);
    out.push(['교재 저장소(R2)', h.storage ? '정상' : '연결 안 됨']);
    out.push(['MYBOX 토큰', h.mybox ? '등록됨' : '미등록']);
    try { await api('/me'); out.push(['내 계정 허용', '허용됨']); } catch (e) { out.push(['내 계정 허용', e.message]); }
    if (h.mybox) {
      try { const r = await api('/mybox/list'); out.push(['MYBOX 연결', `정상 (최상위 항목 ${r.items.length}개)`]); } catch (e) { out.push(['MYBOX 연결', e.message]); }
    }
  } catch { out.push(['API 서버', '연결 안 됨 — config.js의 API 주소와 서버 배포를 확인하세요']); }
  $('#health').innerHTML = `<h3>연결 상태</h3><div class="kv" style="margin-top:8px">${out.map(([k, v]) => `<span class="muted">${k}</span><span>${esc(v)}</span>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="ghost small" data-a="recheck">다시 확인</button></div>`;
}

async function renderNightly() {
  const box = document.getElementById('nightly'); if (!box) return;
  const s = (await getDoc(ref('settings', 'nightly'))).data() || { enabled: false, start: '02:00', end: '06:00', dailyBudgetUSD: 5 };
  const u = (await getDoc(ref('aiUsage', localDay()))).data() || {};
  const cnt = async (...w) => { try { return (await getCountFromServer(query(col('analysisQueue'), ...w))).data().count; } catch { return '?'; } };
  const [qToc, qItem, qWait, qErr] = await Promise.all([
    cnt(where('status', '==', 'queued'), where('task', '==', 'toc')), cnt(where('status', '==', 'queued'), where('task', '==', 'item')),
    cnt(where('status', '==', 'waiting-folder')), cnt(where('status', '==', 'error'))]);
  const runs = (await getDocs(col('aiUsage'))).docs.filter((d) => d.id.startsWith('run_')).map((d) => ({ day: d.id.slice(4), ...d.data() })).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 7);
  const hm = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-');
  box.innerHTML = `<h3>새벽 자동 분석</h3><p class="muted small">정한 시간에 이 PC에서 오답노트 앱이 열려 있으면 대기 목록을 쉬지 않고 이어서 처리합니다. 앱 창은 최소화하거나 가리지 말고 띄워 두세요(화면 꺼짐은 괜찮음). PC 절전은 꺼 두세요.</p>
    <div class="row"><label class="row small"><input type="checkbox" id="nOn" ${s.enabled ? 'checked' : ''}> 사용</label>
      <input type="time" id="nStart" value="${s.start}" style="width:auto"> ~ <input type="time" id="nEnd" value="${s.end}" style="width:auto">
      <span class="small">하루 AI 예산 $</span><input type="number" id="nBudget" min="0" step="1" value="${s.dailyBudgetUSD ?? 5}" style="width:80px">
      <button class="primary small" id="nSave">저장</button><button class="ghost small" id="nTest">지금 1건 시험 실행</button></div>
    <div class="kv" style="margin-top:10px"><span class="muted">대기 중</span><span>단원 수 분석 ${qToc}권 · 빠진 문항 다시 시도 ${qItem}건${qWait ? ` · 폴더 연결 필요 ${qWait}건` : ''}${qErr ? ` · 오류 ${qErr}건` : ''}</span>
      <span class="muted">오늘 AI 사용</span><span>$${(u.usd || 0).toFixed(2)} · ${u.calls || 0}회 <span class="muted small">(${localDay()} 0시부터)</span></span></div>
    <h3 style="margin-top:14px">최근 새벽 분석 기록</h3>
    ${runs.length ? `<table class="small" style="width:100%;border-collapse:collapse;margin-top:6px"><tr style="background:var(--green-bg)"><th style="text-align:left;padding:4px">날짜</th><th>시작~끝</th><th>처리</th><th>비용</th><th style="text-align:left">멈춘 이유</th></tr>
      ${runs.map((r) => { const ev = r.events || [], sleep = ev.filter((x) => /잠듦|가려지거나/.test(x)).length; return `<tr style="border-bottom:1px solid var(--line)"><td style="padding:4px">${r.day.slice(5).replace('-', '.')}</td><td style="text-align:center">${hm(r.startAt)}~${hm(r.endAt || r.lastAt)}</td><td style="text-align:center">${r.done || 0}건</td><td style="text-align:center">$${(r.usd || 0).toFixed(2)}</td>
        <td style="${/허락|오류|읽지 못함/.test(r.stop || '') ? 'color:var(--red)' : ''}">${esc(r.stop || (r.endAt ? '' : '진행 중이거나 중간에 꺼짐'))}${sleep ? ` <span style="color:var(--red)">· 잠듦 ${sleep}번</span>` : ''}${(r.errors || []).length ? ` <span class="muted">· 오류 ${r.errors.length}건</span>` : ''}</td></tr>
        ${ev.length || (r.items || []).length || (r.errors || []).length ? `<tr><td colspan="5" style="padding:0 4px 6px"><details><summary class="muted" style="cursor:pointer">자세히 보기</summary><div style="padding:4px 8px;line-height:1.7">
          ${ev.map((x) => `<div style="color:${/잠듦|가려지거나/.test(x) ? 'var(--red)' : 'var(--sub)'}">● ${esc(x)}</div>`).join('')}
          ${(r.errors || []).map((x) => `<div style="color:var(--red)">✗ ${esc(x)}</div>`).join('')}
          ${(r.items || []).map((x) => `<div>✓ ${esc(x)}</div>`).join('')}</div></details></td></tr>` : ''}`; }).join('')}</table>
      ${runs[0]?.events?.some((x) => /잠듦|가려지거나/.test(x)) ? '<p class="small" style="color:var(--red);margin:6px 0 0">새벽에 앱이 잠든 기록이 있습니다. PC 절전 모드를 "안 함"으로 두고, 앱 창은 최소화하거나 다른 창으로 가리지 말고 띄워 두세요 (화면 꺼짐은 괜찮음).</p>' : ''}`
      : '<p class="muted small">아직 기록이 없습니다. 새벽 분석이 한 번이라도 돌면 여기에 날짜별로 남습니다. 오늘 밤 이후에도 비어 있으면 앱이 닫혀 있었거나 PC가 절전 상태였던 것입니다.</p>'}`;
  document.getElementById('nSave').onclick = async () => {
    await setDoc(ref('settings', 'nightly'), { enabled: nOn.checked, start: nStart.value, end: nEnd.value, dailyBudgetUSD: Number(nBudget.value) || 0 }, { merge: true });
    toast('새벽 분석 설정 저장');
  };
  document.getElementById('nTest').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = '시험 실행 중…';
    try {
      await reconnectFolders(); // 버튼을 누른 김에 폴더 허락도 다시 받음
      const reason = await lib().runner.testOne();
      toast(!reason ? '시험 실행 성공 — 1건 처리했습니다. 교재 정리 탭에서 단원 수를 확인하세요' : reason === '남은 일 없음' ? '대기 목록이 비어 있습니다' : `시험 실행 멈춤: ${reason}`);
    } catch (er) { toast('시험 실행 오류: ' + er.message); }
    renderNightly();
  };
}

async function checkVersion() {
  const box = document.getElementById('verBox'); if (!box) return;
  try {
    const v = (await (await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })).json()).version;
    box.innerHTML = v === APP_VERSION ? `<b>${APP_VERSION}</b> <span class="badge">최신</span>`
      : `<b>${APP_VERSION}</b> <span class="badge red">새 버전 ${esc(v)} 있음</span> <span class="small">앱을 껐다 켜면 바뀝니다</span>`;
  } catch { box.innerHTML = `<b>${APP_VERSION}</b>`; }
}

// 폴더 허락이 풀려 있으면(앱·크롬을 다시 켠 뒤) 맨 위에 알림 — 새벽 분석·원본 잘라내기에 필요
async function reconnectFolders() {
  const roots = await FOLD.listRoots(); const need = [];
  for (const r of roots) if ((await FOLD.permission(r)) !== 'granted') need.push(r);
  if (need.length) await FOLD.reconnectAll(need);
  return need.length;
}
async function permBanner() {
  document.getElementById('permBanner')?.remove();
  if (!FOLD.supported()) return;
  const roots = await FOLD.listRoots().catch(() => []);
  let need = 0; for (const r of roots) if ((await FOLD.permission(r)) !== 'granted') need++;
  const last = (await getDocs(col('aiUsage'))).docs.filter((d) => d.id.startsWith('run_')).map((d) => ({ day: d.id.slice(4), ...d.data() })).sort((a, b) => b.day.localeCompare(a.day))[0];
  const lastBad = last && last.day === localDay() && /허락/.test(last.stop || '');
  if (!need && !lastBad) return;
  const div = document.createElement('div'); div.id = 'permBanner'; div.className = 'card'; div.style.cssText = 'background:var(--gold-bg);max-width:860px;margin:12px auto 0';
  div.innerHTML = `<div class="row between"><span class="small"><b>MYBOX 폴더 허락이 필요합니다.</b> ${lastBad ? '오늘 새벽 분석이 이 때문에 쉬었습니다. ' : ''}누른 뒤 크롬이 물으면 <b>"방문할 때마다 허용"</b>을 고르세요. 그래야 새벽에 다시 묻지 않습니다.</span><button class="primary small" id="permGo">MYBOX 다시 연결</button></div>`;
  main.before(div);
  document.getElementById('permGo').onclick = async () => { await reconnectFolders(); permBanner(); toast('폴더를 다시 연결했습니다'); };
}

async function printSample(aud) {
  const doc = await (await fetch('./print/sample.json')).json();
  doc.meta.audience = aud;
  const per = Number(document.getElementById('smpPer')?.value || 4);
  doc.sections.forEach((s) => { if (s.type === 'sheet') s.perPage = per; });
  await printDoc(doc, { autoPrint: false });
}

// ---------- 클릭 처리 ----------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const { a, id, f, key } = b.dataset;
  const book = () => S.books.find((x) => x.id === id);
  ({
    close: closeModal,
    newSet: () => setForm(),
    editSet: () => setForm(S.sets.find((x) => x.id === id)),
    newBook: () => bookForm({}, id),
    editBook: () => bookForm(book()),
    upload: () => pickLocal(id, f),
    mybox: () => myboxPicker(id, f),
    pick: () => openModal(`<h2>파일 바꾸기</h2><p class="muted small">새 파일로 덮어씁니다.</p><div class="row"><button class="primary" data-a="upload" data-id="${id}" data-f="${f}">파일 올리기</button><button class="ghost" data-a="mybox" data-id="${id}" data-f="${f}">MYBOX에서</button><button class="ghost" data-a="close">취소</button></div>`),
    openFile: () => openFile(key),
    newStudent: () => studentForm(),
    editStudent: () => studentForm(S.students.find((x) => x.id === id)),
    wrongIn: () => wr().entry(S.students.find((x) => x.id === id)).catch((er) => toast(er.message)),
    makeNote: () => wr().noteSetup(S.students.find((x) => x.id === id)).catch((er) => toast(er.message)),
    sheetPrint: () => wr().printSheet(S.students.find((x) => x.id === id), key, b.dataset.aud),
    sheetEdit: () => wr().editSheet(S.students.find((x) => x.id === id), key),
    sheetDel: async () => { const st = S.students.find((x) => x.id === id); if (st && await wr().deleteSheet(st, key)) toast('오답노트를 지웠습니다'); },
    dropBook: async () => { const st = S.students.find((x) => x.id === id); if (st && await wr().removeBook(st, key)) render(); },
    delRec: () => { e.preventDefault(); delRecord(id, key); },
    recheck: renderSettings,
    sample: () => printSample(b.dataset.aud).catch((er) => toast(er.message)),
  }[a] || (() => {}))();
  if (a === 'upload' && modal.open) closeModal();
});
modal.addEventListener('close', () => render());
