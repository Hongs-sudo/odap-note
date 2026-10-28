// AI 교무실 — 다른 주소의 앱(로드맵·플래너)을 교무실에 한 번 연결
// 각 앱과 같은 이메일·비밀번호로 이 브라우저에 로그인해 두면, 현황판이 그 앱 데이터를 읽기만 합니다.
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { OTHER_FB } from './stats.js?v=5';

const NAMES = { roadmap: '수도 로드맵', planner: '수도플래너' };
const $ = (s) => document.querySelector(s);
const appOf = (id) => getApps().find((a) => a.name === id) || initializeApp(OTHER_FB[id], id);

const ERR = {
  'auth/invalid-credential': '이메일 또는 비밀번호가 맞지 않아요.',
  'auth/invalid-login-credentials': '이메일 또는 비밀번호가 맞지 않아요.',
  'auth/user-not-found': '이 앱에 가입된 이메일이 아니에요.',
  'auth/wrong-password': '비밀번호가 맞지 않아요.',
  'auth/too-many-requests': '시도가 너무 많아요. 잠시 뒤 다시 해 주세요.',
  'auth/network-request-failed': '인터넷 연결을 확인해 주세요.',
};

export function openConnect(id, done) {
  const dlg = $('#connectDlg');
  $('#connectTitle').textContent = `${NAMES[id]} 연결`;
  $('#connectMsg').textContent = '';
  $('#connectForm').reset();
  dlg.showModal();
  $('#connectForm').onsubmit = async (e) => {
    e.preventDefault();
    if (e.submitter?.value === 'cancel') { dlg.close(); return; }
    const btn = $('#connectGo'); btn.disabled = true; $('#connectMsg').textContent = '연결 중…';
    try {
      await signInWithEmailAndPassword(getAuth(appOf(id)), $('#connectEmail').value.trim(), $('#connectPw').value);
      $('#connectPw').value = '';
      dlg.close(); done?.();
    } catch (err) {
      $('#connectMsg').textContent = ERR[err.code] || `연결하지 못했어요 (${err.code || err.message})`;
    }
    btn.disabled = false;
  };
}
