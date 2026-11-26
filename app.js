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
import { createSetBuilder } from './sets.js';
import { createSimilar } from './similar.js';

// 앱 버전: 고칠 때마다 올림. 연결 설정에서 지금 쓰는 버전과 서버의 최신 버전을 비교해 보여 줌
const APP_VERSION = '2026.11.26-8';
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

// 선생님 참여 링크(?join=코드)로 들어오면 코드를 기억해 두고 주소에서는 지움 (로그인 창을 거쳐도 남도록)
try {
  const j = new URLSearchParams(location.search).get('join');
  if (j) { localStorage.setItem('odap-join', j.toUpperCase()); history.replaceState(null, '', location.pathname); }
} catch { /* 저장 안 되는 브라우저 */ }
const joinCodeSaved = () => { try { return localStorage.getItem('odap-join') || ''; } catch { return ''; } };

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const S = { members: [], user: null, aid: null, academy: null, role: null, view: 'books', sets: [], books: [], students: [], unsub: [], uploads: {} };
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
  if (!me.exists() || !me.data().academyId) {
    // 참여 신청한 선생님: 원장님이 승인했으면(구성원 문서가 생겼으면) 바로 학원으로 들어감
    const pend = me.data()?.pendingAcademyId;
    if (pend) {
      const ok = await getDoc(doc(db, 'academies', pend, 'members', user.uid)).then((d) => d.exists()).catch(() => false);
      if (ok) { await setDoc(doc(db, 'users', user.uid), { academyId: pend, pendingAcademyId: null }, { merge: true }); location.reload(); return; }
      return renderPending(pend, me.data().pendingName || '');
    }
    return renderJoinOrCreate();
  }
  S.aid = me.data().academyId;
  const [ac, mem] = await Promise.all([getDoc(doc(db, 'academies', S.aid)), getDoc(doc(db, 'academies', S.aid, 'members', user.uid))]);
  if (!mem.exists()) { main.innerHTML = '<div class="card">이 학원의 구성원으로 등록되지 않은 계정입니다. 원장님께 문의하세요.</div>'; return; }
  S.academy = ac.data(); S.role = mem.data().role;
  $('#academyName').textContent = S.academy.name;
  $('#tabs').hidden = false;
  // 선생님 계정은 교재 정리(폴더 읽기·새벽 분석) 탭을 쓰지 않음
  document.querySelector('#tabs button[data-view="catalog"]').hidden = S.role !== 'owner';
  listen();
  render();
  if (S.role === 'owner') lib().runner.start(); // 새벽 분석: 원장 PC에서 정해 둔 시간에 프로그램이 열려 있으면 자동 실행
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

// ---------- 선생님 참여 ----------
function renderJoinOrCreate() {
  $('#academyName').textContent = '';
  main.innerHTML = `<div class="card"><h2>학원 참여 (선생님)</h2><p class="muted small">원장님께 받은 <b>참여 코드</b>를 넣고 신청하세요. 원장님이 승인하면 바로 쓸 수 있습니다.</p>
      <div class="row"><div style="flex:1"><label class="f">참여 코드</label><input type="text" id="jCode" placeholder="예) K7Q4-M2XP" value="${esc(joinCodeSaved())}" style="text-transform:uppercase"></div>
        <div style="flex:1"><label class="f">이름</label><input type="text" id="jName" value="${esc(S.user.displayName || '')}" placeholder="예) 김선애"></div></div>
      <div class="row" style="margin-top:12px"><button class="primary" id="jGo">참여 신청</button></div></div>
    <details class="card"><summary class="small muted" style="cursor:pointer">원장님이 처음 설정하는 경우 (학원 새로 만들기)</summary><div id="ownerBox" style="margin-top:8px"></div></details>`;
  $('#jGo').onclick = async () => {
    const code = $('#jCode').value.trim().toUpperCase().replace(/\s+/g, ''); const name = $('#jName').value.trim();
    if (!code || !name) return toast('참여 코드와 이름을 넣으세요.');
    try {
      const c = await getDoc(doc(db, 'joinCodes', code));
      if (!c.exists()) return toast('참여 코드가 맞지 않습니다. 원장님께 다시 확인하세요.');
      const aid = c.data().aid;
      await setDoc(doc(db, 'academies', aid, 'joinRequests', S.user.uid), { code, name, email: S.user.email || '', at: Date.now() });
      await setDoc(doc(db, 'users', S.user.uid), { pendingAcademyId: aid, pendingName: c.data().academyName || '' }, { merge: true });
      try { localStorage.removeItem('odap-join'); } catch { /* 무시 */ }
      renderPending(aid, c.data().academyName || '');
    } catch (e) { toast('신청하지 못했습니다: ' + e.message); }
  };
  renderCreateAcademy($('#ownerBox'));
}
function renderPending(aid, name) {
  main.innerHTML = `<div class="card center pad"><h2>승인 기다리는 중</h2><p>${esc(name || '학원')}에 참여 신청을 보냈습니다.<br>원장님이 승인하면 <b>다시 확인</b>을 누르세요.</p>
    <div class="row" style="justify-content:center"><button class="primary" id="pCheck">다시 확인</button><button class="ghost" id="pCancel">신청 취소</button></div></div>`;
  $('#pCheck').onclick = () => location.reload();
  $('#pCancel').onclick = async () => {
    await deleteDoc(doc(db, 'academies', aid, 'joinRequests', S.user.uid)).catch(() => {});
    await setDoc(doc(db, 'users', S.user.uid), { pendingAcademyId: null }, { merge: true }); location.reload();
  };
}

function renderCreateAcademy(box) {
  const target = box || main;
  target.innerHTML = `<div${box ? '' : ' class="card"'}><h2>처음 설정</h2><p class="muted small">원장님만 한 번 합니다. 선생님은 이 버튼을 누르지 말고 위의 참여 코드로 신청하세요.</p>
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
  // 원장: 선생님 목록 (학생 탭의 선생님별 보기·담당 표시)
  if (S.role === 'owner') S.unsub.push(onSnapshot(col('members'), (snap) => { S.members = snap.docs.map((d) => ({ uid: d.id, ...d.data() })); if (!modal.open && (S.view === 'students' || S.view === 'similar')) render(); }, () => {}));
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
    outlineTask: (t) => async () => wr().prepOutline(t),
    extraTasks: { pool: (t) => async () => si().runPool(t), tag: (t) => async () => si().runTag(t) },
    fs: { doc, getDoc, setDoc, getDocs, collection, writeBatch, query, where, orderBy, limit, updateDoc, increment, arrayUnion, deleteField },
  });
  return LIB;
}
let WR = null;
function wr() {
  WR ||= createWrong({
    db, aid: () => S.aid, ai, toast, openModal, closeModal, uid: () => S.user.uid, sets: () => S.sets,
    fs: { doc, getDoc, setDoc, getDocs, collection, writeBatch, updateDoc, deleteDoc, increment, arrayUnion },
  });
  return WR;
}
let SI = null;
function si() {
  SI ||= createSimilar({
    W: wr, db, aid: () => S.aid, uid: () => S.user.uid, role: () => S.role, toast, openModal, closeModal,
    students: () => S.students, sets: () => S.sets, groups: studentGroups, filterChips,
    fs: { doc, getDoc, setDoc, getDocs, collection, writeBatch, updateDoc, deleteDoc, query, where, limit, increment },
  });
  return SI;
}
let SB = null;
function sb() {
  SB ||= createSetBuilder({
    db, aid: () => S.aid, uid: () => S.user.uid, toast, openModal, closeModal, students: () => S.students,
    reloadCatalog: async () => { await wr().catalog(true); catalogReady = true; },
    fs: { doc, getDoc, setDoc, getDocs, collection, writeBatch, updateDoc, deleteDoc, deleteField, serverTimestamp, query, where },
  });
  return SB;
}
function render() {
  if (S.view === 'books') renderBooks();
  else if (S.view === 'catalog') lib().show();
  else if (S.view === 'students') renderStudents();
  else if (S.view === 'similar') { if (!catalogReady) wr().catalog().then(() => { catalogReady = true; }).catch(() => {}); si().render().catch((e) => toast(e.message)); }
  else renderSettings();
}

// ---------- 교재 라이브러리 ----------
function renderBooks() {
  const loose = S.books.filter((b) => !S.sets.some((s) => s.id === b.setId));
  if (!catalogReady && S.sets.some((s) => s.source === 'folder')) wr().catalog().then(() => { catalogReady = true; if (S.view === 'books' && !modal.open) render(); }).catch(() => {});
  const sets = [...S.sets].sort((a, b) => (a.order ?? -1) - (b.order ?? -1));
  main.innerHTML = `
    <div class="row between"><h2>교재 라이브러리</h2>${S.role === 'owner' ? `<div class="row">${S.sets.some((x) => x.source === 'folder') ? '<button class="ghost danger" data-a="folderReset">폴더 세트 처음부터 다시</button>' : ''}<button class="ghost" data-a="folderSets">폴더로 세트 만들기</button><button class="primary" data-a="newSet">+ 교재 세트</button></div>` : ''}</div>
    ${S.sets.length ? '' : '<div class="empty">먼저 교재 세트를 만드세요.<br><span class="small">예) 중2-2 중간고사 대비 · PC의 교재 폴더가 있으면 "폴더로 세트 만들기"</span></div>'}
    ${sets.map((s) => (s.source === 'folder' ? folderSetCard(s) : setCard(s))).join('')}
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
// 폴더로 만든 세트: 교재는 PC 폴더의 PDF를 그대로 연결 (교재 정보는 catalogBooks)
function folderSetCard(s) {
  const all = (s.groups || []).flatMap((g) => g.ids || []);
  const B = (id) => wr().bookOf(id);
  const ready = all.filter((id) => B(id)?.outline).length;
  return `<div class="card">
    <div class="row between"><div><h3>${esc(s.name)}</h3><span class="muted small">${esc(s.grade || '')} · 교재 ${all.length}권 · 폴더 연결: ${esc(s.root || '')} · 구역 읽음 ${ready}/${all.length}</span></div>
      <div class="row"><button class="primary small" data-a="setAssign" data-id="${s.id}">학생에게 배정</button>${S.role === 'owner' ? `<button class="ghost small" data-a="folderSets">폴더 다시 읽기</button><button class="ghost small danger" data-a="setDel" data-id="${s.id}">세트 지우기</button>` : ''}</div></div>
    ${(s.groups || []).map((g, gi) => `<div style="border-top:1px dashed var(--line);margin-top:10px;padding-top:8px">
      ${g.name || g.quick ? `<div class="row between"><b class="small">${esc(g.name || '')}</b>${g.quick ? `<button class="ghost small" data-a="setPdf" data-id="${s.id}" data-g="${gi}" data-f="quick">빠른정답모음 PDF</button>` : ''}</div>` : ''}
      ${(g.ids || []).map((id) => { const b = B(id); if (!b) return catalogReady ? `<div class="small muted">교재 정보 없음 (${esc(id)})</div>` : ''; const st = b.outline ? `구역 ${b.outline.sections.length}개 읽음` : b.units ? `단원 ${b.units}` : '처음 오답 입력 때 구역 읽음';
        return `<div class="row between" style="border-top:1px solid var(--line);padding:6px 0;font-size:13px"><span><span class="badge gold">${esc(b.code || '')}</span> <b>${esc(b.title)}</b> ${b.sub ? `<span class="muted">${esc(b.sub)}</span>` : ''}</span>
          <span class="row"><span class="badge">${b.count ? b.count + '문항' : '회별'}</span><span class="badge">${b.sameFile ? '정답·해설: PDF 뒤쪽' : (b.files || []).length > 2 ? `해설 ${(b.files || []).length - 1}개` : '정답·해설 ✓'}</span><span class="badge ${b.outline ? '' : 'gold'}">${st}</span>
          <button class="ghost small" data-a="setPdf" data-key="${id}" data-f="0">문제</button>${b.sameFile ? '' : `<button class="ghost small" data-a="setPdf" data-key="${id}" data-f="1">해설</button>`}</span></div>`; }).join('')}</div>`).join('')}
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
// 담당 선생님 이름: 원장은 "○○ 원장", 선생님은 "○○T"
const teacherName = (uid) => { const m = S.members.find((x) => x.uid === uid); if (!m) return '담당 없음'; const n = m.name || m.email || '이름 없음'; return m.role === 'owner' ? `${n} 원장` : /T$|선생님$/.test(n) ? n : `${n}T`; };
const tFilterGet = () => { try { return localStorage.getItem('odap-tfilter') || 'all'; } catch { return 'all'; } };
// 원장 화면: 선생님별 보기 버튼 (학생 탭·유사문항 탭)
function filterChips(list) {
  if (S.role !== 'owner' || !S.members.length) return { chips: '', filtered: list };
  const known = new Set(S.members.map((m) => m.uid));
  const opts = [['all', '전체', S.students.length], ...[...S.members].sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : String(a.name || '').localeCompare(String(b.name || ''), 'ko')))
    .map((m) => [m.uid, teacherName(m.uid), S.students.filter((x) => x.teacherUid === m.uid).length])];
  const orphan = S.students.filter((x) => !known.has(x.teacherUid)).length;
  if (orphan) opts.push(['none', '담당 없음', orphan]);
  let f = tFilterGet(); if (!opts.some((o) => o[0] === f)) f = 'all';
  const filtered = f === 'all' ? list : f === 'none' ? list.filter((x) => !known.has(x.teacherUid)) : list.filter((x) => x.teacherUid === f);
  const chips = `<div class="row" style="flex-wrap:wrap;gap:6px;margin:6px 0 4px">${opts.map(([v, l, n]) => `<button class="${v === f ? 'primary' : 'ghost'} small" data-a="tFilter" data-id="${v}">${esc(l)} <span style="opacity:.75">${n}</span></button>`).join('')}</div>`;
  return { chips, filtered };
}
function renderStudents() {
  const owner = S.role === 'owner';
  const base = owner ? S.students : S.students.filter((s) => s.teacherUid === S.user.uid);
  const { chips, filtered: mine } = filterChips(base);
  if (!catalogReady) wr().catalog().then(() => { catalogReady = true; if (S.view === 'students' && !modal.open) render(); }).catch(() => {});
  main.innerHTML = `<div class="row between"><h2>학생</h2><button class="primary" data-a="newStudent">+ 학생 등록</button></div>${chips}
    ${mine.length ? '' : '<div class="empty">학생을 등록한 뒤 <b>오답 입력</b>을 누르세요. 교재는 오답 입력 화면에서 찾아 고르면 자동으로 이 학생 교재로 들어갑니다.</div>'}
    ${studentGroups(mine).map(([g, list]) => `<h3 style="margin:18px 0 6px;color:var(--green)">${esc(g)} <span class="muted small">· ${list.length}명</span></h3>${list.map((s) => {
      const books = (s.catalogIds || []).map((id) => wr().bookOf(id)).filter(Boolean);
      const recs = [...(s.records || [])].sort((a, b) => b.at - a.at);
      const prog = wr().progress(s);
      const total = prog.reduce((a, p) => a + p.total, 0), done = prog.reduce((a, p) => a + p.done, 0);
      return `<div class="card"><div class="row between"><div><h3>${esc(s.name)}${owner && S.members.length ? ` <span class="badge" style="font-weight:400">담당 ${esc(teacherName(s.teacherUid))}</span>` : ''}</h3><span class="muted small">${esc(s.grade || '')} ${esc(s.school || '')} · 오답 ${total}개 · 오답노트 완료 ${done} · 남음 ${total - done}</span></div>
        <div class="row"><button class="primary small" data-a="wrongIn" data-id="${s.id}">+ 오답 입력</button>${total ? `<button class="primary small" data-a="makeNote" data-id="${s.id}">오답노트 만들기</button>` : ''}<button class="ghost small" data-a="editStudent" data-id="${s.id}">수정</button></div></div>
        <div class="row" style="margin-top:8px">${books.map((b) => `<span class="badge">${esc(b.title)} <button class="chipx" data-a="dropBook" data-id="${s.id}" data-key="${b.id}" title="이 학생 교재에서 빼기">×</button></span>`).join('') || (catalogReady ? '<span class="muted small">아직 고른 교재 없음</span>' : '')}</div>
        ${prog.length ? `<div style="margin-top:8px">${prog.map((p) => `<div class="prog small"><span style="flex:1">${esc(p.title)}</span><span class="bar"><i style="width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%"></i></span><span>${p.done}/${p.total}</span><span class="muted" style="flex:1.4">${p.left.length ? '남은 단원: ' + esc(p.left.join(', ')) : '모두 오답노트 완료'}</span></div>`).join('')}</div>` : ''}
        ${(s.sheets || []).length ? `<div style="margin-top:10px"><b class="small">만든 오답노트 ${(s.sheets || []).length}개</b>${[...(s.sheets || [])].sort((a, b) => b.at - a.at).map((sh) => `<div class="prog small"><span style="flex:1.6"><b>${new Date(sh.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</b> · ${esc(sh.kind || '1차')}${sh.scope ? ' · ' + esc(sh.scope) : ''} · ${sh.count || 0}문항${sh.books?.length ? ` <span class="muted">· ${esc(sh.books.join(', '))}</span>` : ''}${sh.items ? '' : ' <span class="muted">(이전 버전 · 다시 열 수 없음)</span>'}</span>
          ${sh.items ? `<button class="ghost small" data-a="sheetPrint" data-aud="student" data-id="${s.id}" data-key="${sh.id}">학생용</button><button class="ghost small" data-a="sheetPrint" data-aud="teacher" data-id="${s.id}" data-key="${sh.id}">선생님용</button><button class="ghost small" data-a="sheetEdit" data-id="${s.id}" data-key="${sh.id}">고쳐서 다시 만들기</button>` : ''}<button class="ghost small danger" data-a="sheetDel" data-id="${s.id}" data-key="${sh.id}" title="오답노트 지우기">×</button></div>`).join('')}</div>` : ''}
        ${recs.length ? `<details style="margin-top:6px"><summary class="small muted" style="cursor:pointer">입력 기록 ${recs.length}건</summary>${recs.map((r) => `<div class="rec"><span style="flex:1"><b>${new Date(r.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</b> · ${esc(r.title)} · ${esc(r.type || '')} · <span style="color:var(--red)">오답 ${r.wrongs.length}</span>${r.wrongs.length ? ` <span class="muted">(${esc(r.wrongs.slice(0, 10).map((w) => (w.label ? w.label.replace(/\s*-\s*\d+\s*레벨/, '').replace(/^[^/]+\//, '') + ' ' : '') + w.no).join(', '))}${r.wrongs.length > 10 ? ' …' : ''})</span>` : ''}</span>
          <button class="ghost small danger" data-a="delRec" data-id="${s.id}" data-key="${r.id}" title="기록 지우기">×</button></div>`).join('')}</details>` : ''}
      </div>`;
    }).join('')}`).join('')}`;
}

// 학생 탭: 학년별(중1 → 중2 → 중3 → 고등 → 학년 미입력) · 이름 가나다순
function gradeRank(g) {
  const t = String(g || '').replace(/\s+/g, '');
  if (!t) return [99, '학년 미입력'];
  if (/고|^[456]$/.test(t)) { const n = (t.match(/[1-3]/) || [])[0]; return [10 + Number(n || 0), n ? `고${n}` : '고등']; }
  const n = (t.match(/[1-3]/) || [])[0];
  if (n && /중|^[1-3]$|^[1-3]학년/.test(t)) return [Number(n), `중${n}`];
  if (/초|^[1-6]학년/.test(t)) return [0, '초등'];
  return [50, t];
}
function studentGroups(list) {
  const m = new Map();
  for (const s of list) { const [r, label] = gradeRank(s.grade); const k = r + '|' + label; if (!m.has(k)) m.set(k, { r, label, list: [] }); m.get(k).list.push(s); }
  return [...m.values()].sort((a, b) => a.r - b.r || a.label.localeCompare(b.label, 'ko'))
    .map((x) => [x.label, x.list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'))]);
}

function studentForm(s = {}) {
  const ids = [...(s.catalogIds || [])];
  openModal(`<h2>${s.id ? '학생 수정' : '학생 등록'}</h2>
    <label class="f">이름</label><input type="text" id="fName" value="${esc(s.name || '')}">
    <div class="row"><div style="flex:1"><label class="f">학년</label><input type="text" id="fGrade" value="${esc(s.grade || '중2')}"></div>
      <div style="flex:1"><label class="f">학교</label><input type="text" id="fSchool" value="${esc(s.school || '')}"></div></div>
    ${S.role === 'owner' && S.members.length ? `<label class="f">담당 선생님</label><select id="fTeacher">${S.members.map((m) => `<option value="${m.uid}" ${m.uid === (s.teacherUid || S.user.uid) ? 'selected' : ''}>${esc(teacherName(m.uid))}</option>`).join('')}${s.teacherUid && !S.members.some((m) => m.uid === s.teacherUid) ? '<option value="" selected>담당 없음 (학원에서 빠진 선생님)</option>' : ''}</select>
      <p class="muted small" style="margin:2px 0 0">담당을 바꾸면 그 선생님 화면에 보이고, 오답 기록·오답노트도 함께 넘어갑니다.</p>` : ''}
    ${s.id ? `<label class="f">사용 교재 (오답 입력 화면에서 찾아 고르면 자동으로 추가됩니다)</label><div class="checks">${ids.map((id) => { const b = wr().bookOf(id); return b ? `<label><input type="checkbox" value="${id}" checked> ${esc(b.title)}</label>` : ''; }).join('') || '<p class="muted small">아직 없음</p>'}</div>` : ''}
    <div class="row between" style="margin-top:16px">${s.id ? '<button class="ghost danger" id="fDel">학생 삭제</button>' : '<span></span>'}
      <div class="row"><button class="ghost" data-a="close">취소</button><button class="primary" id="fSave">저장</button></div></div>`);
  $('#fSave').onclick = async () => {
    const data = { name: $('#fName').value.trim(), grade: $('#fGrade').value.trim(), school: $('#fSchool').value.trim() };
    if (!data.name) return toast('이름을 입력하세요.');
    const tsel = document.getElementById('fTeacher')?.value;
    if (s.id) { data.catalogIds = [...document.querySelectorAll('.checks input:checked')].map((c) => c.value); if (tsel) data.teacherUid = tsel; await updateDoc(ref('students', s.id), data); }
    else await addDoc(col('students'), { ...data, catalogIds: [], records: [], sheets: [], teacherUid: tsel || S.user.uid, createdAt: serverTimestamp() });
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
    <div class="card" id="folderBox"><p class="muted">교재 폴더 확인 중…</p></div>
    ${S.role === 'owner' ? '<div class="card" id="teachers"><p class="muted">선생님 목록 불러오는 중…</p></div>' : ''}
    <div class="card" id="health"><p class="muted">연결 상태 확인 중…</p></div>
    ${S.role === 'owner' ? '<div class="card" id="nightly"><p class="muted">새벽 분석 설정 불러오는 중…</p></div>' : ''}
    <div class="card"><h3>출력 시험</h3><p class="muted small">재타이핑 시범(내신대비B 1.1 1회차 10문항 + 유사 1 + 정답·해설)으로 A4 출력과 인쇄를 시험합니다.</p>
      <div class="row"><button class="ghost small" data-a="sample" data-aud="student">학생용 미리보기</button><button class="ghost small" data-a="sample" data-aud="teacher">선생님용(출처 표시)</button><select id="smpPer" style="width:auto"><option value="2">한 쪽 2문항</option><option value="4" selected>한 쪽 4문항</option><option value="6">한 쪽 6문항</option></select></div></div>`;
  if (S.role === 'owner') { renderNightly(); renderTeachers(); }
  renderFolders();
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
  const [qToc, qItem, qWait, qErr, qOut] = await Promise.all([
    cnt(where('status', '==', 'queued'), where('task', '==', 'toc')), cnt(where('status', '==', 'queued'), where('task', '==', 'item')),
    cnt(where('status', '==', 'waiting-folder')), cnt(where('status', '==', 'error')), cnt(where('status', '==', 'queued'), where('task', '==', 'outline'))]);
  const runs = (await getDocs(col('aiUsage'))).docs.filter((d) => d.id.startsWith('run_')).map((d) => ({ day: d.id.slice(4), ...d.data() })).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 7);
  const hm = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-');
  box.innerHTML = `<h3>새벽 자동 분석</h3><p class="muted small">정한 시간에 이 PC에서 오답노트 앱이 열려 있으면 대기 목록을 쉬지 않고 이어서 처리합니다. 앱 창은 최소화하거나 가리지 말고 띄워 두세요(화면 꺼짐은 괜찮음). PC 절전은 꺼 두세요.</p>
    <div class="row"><label class="row small"><input type="checkbox" id="nOn" ${s.enabled ? 'checked' : ''}> 사용</label>
      <input type="time" id="nStart" value="${s.start}" style="width:auto"> ~ <input type="time" id="nEnd" value="${s.end}" style="width:auto">
      <span class="small">하루 AI 예산 $</span><input type="number" id="nBudget" min="0" step="1" value="${s.dailyBudgetUSD ?? 5}" style="width:80px">
      <button class="primary small" id="nSave">저장</button><button class="ghost small" id="nTest">지금 1건 시험 실행</button></div>
    <div class="kv" style="margin-top:10px"><span class="muted">대기 중</span><span>${qOut ? `학생 교재 구역 미리 읽기 ${qOut}권 · ` : ''}단원 수 분석 ${qToc}권 · 빠진 문항 다시 시도 ${qItem}건${qWait ? ` · 폴더 연결 필요 ${qWait}건` : ''}${qErr ? ` · 오류 ${qErr}건` : ''}</span>
      <span class="muted">학생 교재</span><span id="nReady" class="small muted">확인 중…</span>
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
  wr().catalog(true).then((list) => {
    const ids = [...new Set(S.students.flatMap((x) => x.catalogIds || []))].filter((id) => wr().bookOf(id) && !wr().bookOf(id).retired);
    const ok = ids.filter((id) => wr().bookOf(id).outline?.v === 2).length;
    const el = document.getElementById('nReady'); if (el) el.innerHTML = `${ids.length}권 중 <b>구역·정답 준비 끝 ${ok}권</b>${ids.length - ok ? ` · 남은 ${ids.length - ok}권은 오늘 밤 가장 먼저 읽습니다` : ''}`;
  }).catch(() => {});
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

// ---------- 선생님 관리 (원장) ----------
const joinLink = (code) => `${location.origin}${location.pathname.replace(/index\.html$/, '')}?join=${encodeURIComponent(code)}`;
const newCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 8; i++) c += A[Math.floor(Math.random() * A.length)] + (i === 3 ? '-' : ''); return c; };
async function renderTeachers() {
  const box = document.getElementById('teachers'); if (!box) return;
  const ac = (await getDoc(doc(db, 'academies', S.aid))).data() || {};
  const reqs = (await getDocs(col('joinRequests'))).docs.map((d) => ({ uid: d.id, ...d.data() }));
  const mem = (await getDocs(col('members'))).docs.map((d) => ({ uid: d.id, ...d.data() }));
  box.innerHTML = `<h3>선생님</h3><p class="muted small">선생님께 아래 <b>참여 코드</b>와 앱 주소를 알려 주세요. 선생님이 신청하면 여기에 나타나고, <b>승인</b>을 누르면 바로 쓸 수 있습니다(AI 기능 허용 포함).</p>
    <div class="row"><span class="small">참여 코드</span> ${ac.joinCode ? `<b style="font-size:20px;letter-spacing:.08em">${esc(ac.joinCode)}</b>` : '<span class="muted small">아직 없음</span>'} <button class="ghost small" id="tCode">${ac.joinCode ? '새 코드로 바꾸기' : '참여 코드 만들기'}</button></div>
    ${ac.joinCode ? `<div class="row" style="margin-top:6px"><span class="small">참여 링크</span><input type="text" readonly id="tLink" value="${esc(joinLink(ac.joinCode))}" style="flex:1;font-size:13px" onclick="this.select()"><button class="primary small" id="tCopyLink">링크 복사</button><button class="ghost small" id="tCopyMsg">안내 문구 복사</button></div>
      <p class="muted small" style="margin:4px 0 0">안내 문구를 카톡에 붙여 넣어 보내세요. 선생님이 링크를 열면 참여 코드가 미리 채워집니다.</p>` : ''}
    ${reqs.length ? `<h3 style="margin-top:12px">승인 기다리는 신청 ${reqs.length}건</h3>${reqs.map((r) => `<div class="row between" style="border-top:1px solid var(--line);padding:6px 0"><span><b>${esc(r.name)}</b> <span class="muted small">${esc(r.email || '')} · ${new Date(r.at).toLocaleString('ko-KR')}</span></span>
      <span class="row"><button class="primary small" data-tok="${r.uid}">승인</button><button class="ghost small danger" data-tno="${r.uid}">거절</button></span></div>`).join('')}` : ''}
    <h3 style="margin-top:12px">구성원 ${mem.length}명</h3>${mem.map((m) => `<div class="row between" style="border-top:1px solid var(--line);padding:6px 0"><span><b>${esc(m.name || '')}</b> <span class="badge ${m.role === 'owner' ? 'gold' : ''}">${m.role === 'owner' ? '원장' : '선생님'}</span> <span class="muted small">${esc(m.email || '')}</span></span>
      ${m.role === 'owner' ? '' : `<button class="ghost small danger" data-tout="${m.uid}">빼기</button>`}</div>`).join('')}`;
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast(`${what}를 복사했습니다. 카톡에 붙여 넣으세요`); } catch { const i = document.getElementById('tLink'); i?.select(); toast('복사가 막혀 있습니다. 링크 칸을 선택해 Ctrl+C를 누르세요'); } };
  document.getElementById('tCopyLink')?.addEventListener('click', () => copy(joinLink(ac.joinCode), '참여 링크'));
  document.getElementById('tCopyMsg')?.addEventListener('click', () => copy(`[수학도서관 오답노트] 선생님 참여 안내\n아래 링크를 PC 크롬에서 열고, 본인 구글 계정으로 로그인한 뒤 이름을 넣고 [참여 신청]을 눌러 주세요. 원장님이 승인하면 바로 쓸 수 있습니다.\n${joinLink(ac.joinCode)}\n사용 문의는 홍재화원장에게 문의해주세요.`, '안내 문구'));
  document.getElementById('tCode').onclick = async () => {
    if (ac.joinCode && !confirm('새 코드로 바꾸면 예전 코드로는 신청할 수 없습니다. 바꿀까요?')) return;
    const code = newCode();
    if (ac.joinCode) await deleteDoc(doc(db, 'joinCodes', ac.joinCode)).catch(() => {});
    await setDoc(doc(db, 'joinCodes', code), { aid: S.aid, academyName: S.academy?.name || '', by: S.user.uid, at: Date.now() });
    await updateDoc(doc(db, 'academies', S.aid), { joinCode: code });
    renderTeachers();
  };
  box.querySelectorAll('[data-tok]').forEach((b) => b.onclick = async () => {
    const r = reqs.find((x) => x.uid === b.dataset.tok); b.disabled = true;
    try {
      await ai('/admin/allow', { uid: r.uid, name: r.name, allow: true });
      await setDoc(ref('members', r.uid), { role: 'teacher', name: r.name, email: r.email || '', joinedAt: serverTimestamp() });
      await deleteDoc(ref('joinRequests', r.uid));
      toast(`${r.name} 선생님을 승인했습니다`);
    } catch (e) { toast('승인하지 못했습니다: ' + e.message); }
    renderTeachers();
  });
  box.querySelectorAll('[data-tno]').forEach((b) => b.onclick = async () => { if (!confirm('이 신청을 거절할까요?')) return; await deleteDoc(ref('joinRequests', b.dataset.tno)); renderTeachers(); });
  box.querySelectorAll('[data-tout]').forEach((b) => b.onclick = async () => {
    const m = mem.find((x) => x.uid === b.dataset.tout);
    if (!confirm(`${m.name} 선생님을 학원에서 뺄까요? 그 선생님이 등록한 학생 기록은 남고, 원장님 화면에서 계속 볼 수 있습니다.`)) return;
    await ai('/admin/allow', { uid: m.uid, allow: false }).catch(() => {});
    await deleteDoc(ref('members', m.uid)); renderTeachers();
  });
}

// ---------- 교재 폴더 (세트 교재 PDF가 있는 폴더를 이 PC에 연결) ----------
async function neededFolders() {
  const need = [...new Map(S.sets.filter((s) => s.source === 'folder' && s.root).map((s) => [s.root, s])).values()];
  const roots = FOLD.supported() ? await FOLD.listRoots().catch(() => []) : [];
  const out = [];
  for (const s of need) {
    const r = roots.find((x) => x.label === s.root);
    out.push({ label: s.root, path: s.rootPath || '', state: !r ? 'missing' : (await FOLD.permission(r)) === 'granted' ? 'ok' : 'prompt', rec: r });
  }
  return out;
}
async function connectFolder(label, path) {
  try {
    const rec = await FOLD.addRoot({ label, path, category: '내신대비', mode: 'sets' });
    if (rec.handle.name !== label) { await FOLD.removeRoot(rec.id); toast(`"${label}" 폴더를 골라 주세요. (고른 폴더: ${rec.handle.name})`); return false; }
    toast(`"${label}" 폴더를 연결했습니다`); return true;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); return false; }
}
async function renderFolders() {
  const box = document.getElementById('folderBox'); if (!box) return;
  if (!FOLD.supported()) { box.innerHTML = '<h3>교재 폴더</h3><p class="muted small">교재 폴더 연결은 PC의 크롬·엣지에서만 됩니다.</p>'; return; }
  const list = await neededFolders();
  box.innerHTML = `<h3>교재 폴더</h3><p class="muted small">오답노트 문항은 이 PC에 연결한 교재 폴더의 PDF에서 잘라 옵니다. MYBOX(N: 드라이브)의 같은 이름 폴더를 연결하세요.</p>
    ${list.map((f) => `<div class="row between" style="border-top:1px solid var(--line);padding:6px 0"><span><b>${esc(f.label)}</b> ${f.rec ? `<span class="muted small">${esc(f.rec.path)}</span>` : ''}</span>
      <span class="row"><span class="badge ${f.state === 'ok' ? '' : 'red'}">${f.state === 'ok' ? '연결됨' : f.state === 'prompt' ? '허락 필요' : '연결 안 됨'}</span>${f.state === 'ok' ? '' : `<button class="primary small" data-fconn="${esc(f.label)}">${f.state === 'prompt' ? '다시 연결' : '연결'}</button>`}</span></div>`).join('') || '<p class="muted small">폴더로 만든 교재 세트가 아직 없습니다.</p>'}`;
  box.querySelectorAll('[data-fconn]').forEach((b) => b.onclick = async () => {
    const f = list.find((x) => x.label === b.dataset.fconn);
    if (f.state === 'prompt') await FOLD.reconnectAll([f.rec]); else await connectFolder(f.label, f.path);
    renderFolders(); permBanner();
  });
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
  const last = S.role === 'owner' ? (await getDocs(col('aiUsage'))).docs.filter((d) => d.id.startsWith('run_')).map((d) => ({ day: d.id.slice(4), ...d.data() })).sort((a, b) => b.day.localeCompare(a.day))[0] : null;
  const lastBad = last && last.day === localDay() && /허락/.test(last.stop || '');
  const missing = (await neededFolders()).filter((f) => f.state === 'missing');
  if (missing.length) {
    const div = document.createElement('div'); div.id = 'permBanner'; div.className = 'card'; div.style.cssText = 'background:var(--gold-bg);max-width:860px;margin:12px auto 0';
    div.innerHTML = `<div class="row between"><span class="small"><b>교재 폴더를 이 PC에 연결하세요.</b> MYBOX(N: 드라이브)에서 <b>${missing.map((f) => esc(f.label)).join(', ')}</b> 폴더를 고른 뒤 [파일 보기]를 누르세요.</span><button class="primary small" id="permGo">교재 폴더 연결</button></div>`;
    main.before(div);
    document.getElementById('permGo').onclick = async () => { for (const f of missing) await connectFolder(f.label, f.path); permBanner(); };
    return;
  }
  if (!need && !lastBad) return;
  const div = document.createElement('div'); div.id = 'permBanner'; div.className = 'card'; div.style.cssText = 'background:var(--gold-bg);max-width:860px;margin:12px auto 0';
  div.innerHTML = `<div class="row between"><span class="small"><b>교재 폴더 허락이 필요합니다.</b> ${lastBad ? '오늘 새벽 분석이 이 때문에 쉬었습니다. ' : ''}누른 뒤 크롬이 물으면 <b>"방문할 때마다 허용"</b>을 고르세요. 그래야 새벽에 다시 묻지 않습니다.</span><button class="primary small" id="permGo">폴더 다시 연결</button></div>`;
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
    tFilter: () => { try { localStorage.setItem('odap-tfilter', id); } catch { /* 무시 */ } render(); },
    folderSets: () => sb().start().catch((er) => toast(er.message)),
    folderReset: () => sb().reset().catch((er) => toast(er.message)),
    setAssign: () => sb().assign(S.sets.find((x) => x.id === id), wr().bookOf),
    setDel: () => sb().removeSet(S.sets.find((x) => x.id === id)),
    setPdf: () => { const fi = b.dataset.f; if (fi === 'quick') { const g = S.sets.find((x) => x.id === id)?.groups?.[Number(b.dataset.g)]; if (g?.quick) sb().openPdfFile(g.quick); return; } const bk = wr().bookOf(key); const f = bk?.files?.[Number(fi)]; if (f) sb().openPdfFile(f); },
  }[a] || (() => {}))();
  if (a === 'upload' && modal.open) closeModal();
});
modal.addEventListener('close', () => render());
