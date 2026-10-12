import { join } from 'node:path';
import { getNewbieHome } from './globalNewbie.ts';

export function getMemoryBaseDir(): string {
  return join(getNewbieHome(), 'memory');
}

export function getLogsBaseDir(): string {
  return join(getMemoryBaseDir(), 'logs');
}

export function getDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return join(getLogsBaseDir(), yyyy, mm, `${yyyy}-${mm}-${dd}.md`);
}

export function getMemoryIndexPath(): string {
  return join(getMemoryBaseDir(), 'MEMORY.md');
}

// 사용자 소유의 메모리 정책 파일. /distill이 유지, 요약, 제거 판단에 반영한다.
export function getPolicyPath(): string {
  return join(getNewbieHome(), 'policy.md');
}

// 추론된 패턴(insight)은 사실 topic과 분리 저장한다. 리콜에서 본문은 주입하지 않고
// MEMORY.md 인덱스 한 줄로만 노출된다.
export function getInsightsBaseDir(): string {
  return join(getMemoryBaseDir(), 'insights');
}

// /distill이 생성한 사용자 확인 질문 큐. CLI와 펫이 동시에 쓰므로 append-only 이벤트 로그다.
export function getQuestionsPath(): string {
  return join(getMemoryBaseDir(), 'questions.jsonl');
}

// 체크인(기분 기록)은 월 단위 jsonl로 축적 — 리플렉션의 입력 데이터
export function getCheckinsBaseDir(): string {
  return join(getMemoryBaseDir(), 'checkins');
}

export function getCheckinMonthPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return join(getCheckinsBaseDir(), `${yyyy}-${mm}.jsonl`);
}
