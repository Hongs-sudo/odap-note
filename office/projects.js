// AI 교무실에 모으는 앱 10개와 4개 팀
// 팀 자리(h)는 교무실 그림(1536×1024) 속 직원 머리 위치입니다.
export const TEAMS = [
  { id: 'learn', name: '학습관리팀', desc: '학생의 매일·매주 학습', h: [745, 350], d: [800, 410] },
  { id: 'naesin', name: '내신·시험팀', desc: '내신 기출·수행평가·주간보고', h: [943, 480], d: [1005, 535] },
  { id: 'report', name: '리포트·상담팀', desc: '학부모 보고서·입시 상담', h: [538, 470], d: [590, 530] },
  { id: 'ops', name: '원장실', desc: '회의·교무실 전체 운영', h: [808, 565], d: [820, 640] },
];

// repo: 깃허브 저장소 이름(최근 수정 기록을 읽어 옴), parent: 학부모에게 나가는 자료를 만드는 앱
export const APPS = [
  { id: 'odap', team: 'learn', name: '오답노트', icon: '오답', color: '#A3243B', url: 'https://hongs-sudo.github.io/odap-note/', repo: 'odap-note', desc: '교재 목차에서 틀린 번호를 체크하고 1차 오답노트를 만들어요.' },
  { id: 'daily', team: 'learn', name: '데일리 리포트', icon: '데일리', color: '#1F2937', url: 'https://hongs-sudo.github.io/daily-report/', repo: 'daily-report', parent: true, desc: '학생별 진도·과제 달성률과 출결을 기록하고 학부모 리포트를 만들어요.' },
  { id: 'planner', team: 'learn', name: '수도플래너', icon: '플래너', color: '#C2410C', url: 'https://sudoplanner.pages.dev/', desc: '주간 학습플래너와 스터디그룹 출석을 함께 관리해요.' },
  { id: 'roadmap', team: 'learn', name: '수도 로드맵', icon: '로드맵', color: '#B08A2E', url: 'https://sudo-roadmap.ilmvm66.workers.dev/', desc: '학생별 분기 학습 로드맵을 선생님들이 함께 써요.' },
  { id: 'naesin', team: 'naesin', name: '수도 내신분석', icon: '분석', color: '#0A4844', url: 'https://hongs-sudo.github.io/naesin-analysis/', repo: 'naesin-analysis', desc: '학교별 기출 보관함과 누적 분석, 분석지를 만들어요.' },
  { id: 'suhaeng', team: 'naesin', name: '수행평가 관리', icon: '수행', color: '#0A4844', url: 'https://hongs-sudo.github.io/suhaeng/', repo: 'suhaeng', desc: '중등부 수행평가·서술형 점수를 입력하고 분석해요.' },
  { id: 'weekly', team: 'naesin', name: '내신대비 주간보고서', icon: '내신', color: '#0F766E', url: 'https://hongs-sudo.github.io/naesin-report/', repo: 'naesin-report', parent: true, desc: '중등부 내신대비 주간보고서를 학부모 발송용으로 만들어요.' },
  { id: 'onemm', team: 'report', name: '1MM 보고서', icon: '1MM', color: '#0A4844', url: 'https://hongs-sudo.github.io/1mm-report/', repo: '1mm-report', parent: true, desc: '1개월 학습보고서를 선생님들이 함께 작성해요.' },
  { id: 'early', team: 'report', name: '얼리어답터 관리', icon: '얼리', color: '#0A4844', url: 'https://hongs-sudo.github.io/early-adopter/', repo: 'early-adopter', parent: true, desc: '예비고1 희망 고교 기출 응시 결과로 지원에 유리한 학교를 판단해요.' },
  { id: 'minutes', team: 'ops', name: '중등부 주간회의록', icon: '회의록', color: '#6D28D9', url: 'https://hongs-sudo.github.io/meeting-minutes/', repo: 'meeting-minutes', desc: '주차별 회의록을 작성·인쇄·공유해요.' },
];

export const teamOf = (id) => TEAMS.find((t) => t.id === id);
export const sameSite = (url) => url.startsWith('https://hongs-sudo.github.io/');
