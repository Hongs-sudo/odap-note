// AI 교무실 — 오답노트 데이터 계산 (화면·Firebase와 분리, 단독 테스트 가능)
// 오답노트 프로그램(wrong.js)과 같은 규칙으로 문항을 구분합니다.

export const CAUSES = ['계산', '개념', '조건', '시간', '찍음'];

export const normNo = (s) => { const d = String(s ?? '').replace(/[^0-9]/g, ''); return d ? String(parseInt(d, 10)) : ''; };
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
export const wkey = (bookId, sec, no) => hash(`${bookId}|${sec}|${normNo(no)}`);

// 구역 제목 → 단원 이름 (예: "1.1 삼각형의 성질 2회차 - 3레벨" → "삼각형의 성질")
export const unitName = (label) => {
  const raw = String(label || '');
  const u = raw.replace(/^[^/]+\//, '').replace(/\s*-\s*\d+\s*레벨/, '').replace(/\s*\d+\s*회차.*$/, '').replace(/\s*\(\d+\)\s*$/, '').replace(/^\d+(\.\d+)*\s*/, '').trim();
  return u || raw.split('/')[0].trim() || raw;
};

// 학생 한 명의 오답 문항 (같은 문항은 한 번, 원인은 최근 기록 기준)
export function studentItems(student) {
  const noted = student.noted || {};
  const oldDone = new Set((student.sheets || []).flatMap((x) => x.records || []));
  const items = new Map();
  [...(student.records || [])].sort((a, b) => (a.at || 0) - (b.at || 0)).forEach((r) => {
    (r.wrongs || []).forEach((w) => {
      const k = wkey(r.bookId, w.sec, w.no);
      const prev = items.get(k);
      items.set(k, {
        k, bookId: r.bookId, title: r.title || '', label: w.label || '', unit: unitName(w.label), no: w.no,
        cause: w.cause || prev?.cause || null, at: r.at || 0,
        done: !!noted[k] || oldDone.has(r.id),
      });
    });
  });
  return [...items.values()];
}

// 1차 오답노트를 아직 안 만든 문항이 있는 학생들
export function pendingList(students) {
  return students.map((s) => {
    const items = studentItems(s);
    const left = items.filter((x) => !x.done);
    return { id: s.id, name: s.name || '이름 없음', grade: s.grade || '', total: items.length, left: left.length,
      books: [...new Set(left.map((x) => x.title))], lastAt: Math.max(0, ...items.map((x) => x.at)) };
  }).filter((x) => x.left > 0).sort((a, b) => b.left - a.left || b.lastAt - a.lastAt);
}

// 약점 분석: 단원별 오답 수, 원인 비율, 한 줄 코멘트
export function weakness(student) {
  const items = studentItems(student);
  const byUnit = new Map();
  items.forEach((x) => byUnit.set(x.unit, (byUnit.get(x.unit) || 0) + 1));
  const units = [...byUnit.entries()].map(([unit, n]) => ({ unit, n })).sort((a, b) => b.n - a.n);
  const withCause = items.filter((x) => x.cause);
  const causes = CAUSES.map((c) => ({ cause: c, n: withCause.filter((x) => x.cause === c).length }))
    .map((c) => ({ ...c, pct: withCause.length ? Math.round((c.n / withCause.length) * 100) : 0 }));
  return { total: items.length, done: items.filter((x) => x.done).length, top: units.slice(0, 3), units, causes, causeCount: withCause.length, comment: comment(student, units, causes, withCause.length, items.length) };
}

const CAUSE_TIP = {
  계산: '풀이 과정을 끝까지 적고 검산하는 습관이 필요해요',
  개념: '해당 단원 개념 정리부터 다시 짚는 게 좋겠어요',
  조건: '문제 조건에 밑줄을 긋고 읽는 연습이 필요해요',
  시간: '시간을 재고 푸는 실전 연습을 늘려 보세요',
  찍음: '모르는 유형이 많아요. 기본 유형부터 차근차근 채워야 해요',
};
function comment(student, units, causes, causeN, total) {
  if (!total) return `${student.name || '학생'} 학생은 아직 입력된 오답이 없어요.`;
  const name = student.name || '학생';
  const top = units.slice(0, 2).map((u) => `${u.unit}(${u.n}문항)`).join(', ');
  let s = `${name} 학생은 ${top}에서 가장 많이 틀렸어요.`;
  if (causeN >= 3) {
    const main = [...causes].sort((a, b) => b.n - a.n)[0];
    if (main.n) s += ` 원인은 ${main.cause}이 ${main.pct}%로 가장 많아요. ${CAUSE_TIP[main.cause]}.`;
  } else {
    s += ' 틀린 원인을 함께 체크하면 더 정확하게 분석할 수 있어요.';
  }
  return s;
}

// 지난번 확인 이후 새로 저장된 오답 기록
export function newRecords(students, since) {
  const out = [];
  students.forEach((s) => (s.records || []).forEach((r) => {
    if ((r.at || 0) > since && (r.wrongs || []).length) out.push({ sid: s.id, name: s.name || '학생', grade: s.grade || '', title: r.title || '', n: r.wrongs.length, at: r.at });
  }));
  return out.sort((a, b) => a.at - b.at);
}

// 처리 대기열·AI 사용액 요약
export function queueSummary(queueDocs) {
  const c = { queued: 0, error: 0, waiting: 0 };
  const errors = [];
  queueDocs.forEach((q) => {
    if (q.status === 'queued') c.queued++;
    else if (q.status === 'error') { c.error++; errors.push(q.title || q.id); }
    else if (q.status === 'waiting-folder') c.waiting++;
  });
  return { ...c, errors: errors.slice(0, 5) };
}
