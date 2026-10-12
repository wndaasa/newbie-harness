import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getQuestionsPath } from './paths.ts';
import type { PendingQuestion, QuestionKind } from './types.ts';

export type NewQuestion = {
  kind: QuestionKind;
  text: string;
  relatedTopic?: string;
};

// 답이 없는 질문은 잔소리가 되면 안 됨 — 7일이 지나면 조용히 만료
const PENDING_EXPIRY_DAYS = 7;

// 큐는 append-only 이벤트 로그다. CLI와 펫이 동시에 떠 있는 것이 제품의 전제이므로
// 어느 쪽도 남이 쓴 상태를 다시 쓰지 않는다(read-modify-write는 갱신을 유실시킨다).
// 현재 상태는 읽을 때 이벤트를 접어서 만든다.
type CreatedEvent = {
  ts: string;
  event: 'created';
  id: string;
  kind: QuestionKind;
  text: string;
  relatedTopic: string;
};

type ResolvedEvent = {
  ts: string;
  event: 'resolved';
  id: string;
  status: 'answered' | 'skipped';
};

type QueueEvent = CreatedEvent | ResolvedEvent;

function isQueueEvent(value: unknown): value is QueueEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.ts !== 'string' || typeof e.id !== 'string') return false;
  if (e.event === 'resolved') return true;
  return (
    e.event === 'created' &&
    typeof e.text === 'string' &&
    typeof e.kind === 'string'
  );
}

function readEvents(): QueueEvent[] {
  const path = getQuestionsPath();
  if (!existsSync(path)) return [];

  const events: QueueEvent[] = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isQueueEvent(parsed)) events.push(parsed);
      } catch {
        // 깨진 라인은 건너뜀 — append-only 파일의 부분 손상이 전체를 막으면 안 됨
      }
    }
  } catch {
    return [];
  }
  return events;
}

function isFresh(question: PendingQuestion): boolean {
  const created = Date.parse(question.createdAt);
  if (Number.isNaN(created)) return false;
  return Date.now() - created < PENDING_EXPIRY_DAYS * 86_400_000;
}

// fold 결과 = 살아있는 질문(pending & fresh)만. resolved된 id는 접는 과정에서
// 사라지므로 해소된 질문을 지우는 별도 정리 코드가 필요 없다.
// Map 삽입 순서 = 파일 순서 = 생성 순서이므로 "가장 오래된 pending" 규약이 유지된다.
function livePendingQuestions(): PendingQuestion[] {
  const byId = new Map<string, PendingQuestion>();
  for (const event of readEvents()) {
    if (event.event === 'created') {
      byId.set(event.id, {
        id: event.id,
        createdAt: event.ts,
        kind: event.kind,
        text: event.text,
        relatedTopic: event.relatedTopic ?? '',
      });
    } else {
      byId.delete(event.id);
    }
  }
  return [...byId.values()].filter(isFresh);
}

function serialize(event: QueueEvent): string {
  return JSON.stringify(event) + '\n';
}

// 이벤트 줄이 무한히 쌓이지 않도록 살아있는 질문만 created 이벤트로 다시 쓴다.
// /distill 경로(=CLI 단독, 드문 사용자 유발 이벤트)에서만 호출하고 rename으로 원자 교체한다.
// 컴팩션 중 펫이 덧붙인 resolved 이벤트는 유실될 수 있으나, 최악의 결과는 이미 답한
// 질문을 한 번 더 묻는 것이라 프로세스 간 잠금을 도입할 만한 손해가 아니다.
function compactQueue(): void {
  const path = getQuestionsPath();
  const body = livePendingQuestions()
    .map(q =>
      serialize({
        ts: q.createdAt,
        event: 'created',
        id: q.id,
        kind: q.kind,
        text: q.text,
        relatedTopic: q.relatedTopic,
      }),
    )
    .join('');

  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, body, 'utf8');
  renameSync(tmpPath, path);
}

// 쓰기 실패는 그대로 전파한다 — /distill 커맨드의 기존 catch가 오류로 표시한다.
export function appendPendingQuestions(newQuestions: NewQuestion[]): number {
  const path = getQuestionsPath();
  const now = new Date().toISOString();
  const lines = newQuestions
    .map(q =>
      serialize({
        ts: now,
        event: 'created',
        id: crypto.randomUUID(),
        kind: q.kind,
        text: q.text,
        relatedTopic: q.relatedTopic ?? '',
      }),
    )
    .join('');

  mkdirSync(dirname(path), { recursive: true });
  if (lines) appendFileSync(path, lines, 'utf8');
  compactQueue();
  return newQuestions.length;
}

export function countPendingQuestions(): number {
  return livePendingQuestions().length;
}

// 가장 오래된 유효 pending 질문. /checkin 표시와 answer/skip 대상이 항상 일치하도록
// 별도 상태 없이 결정적으로 선택한다.
export function getNextPendingQuestion(): PendingQuestion | null {
  return livePendingQuestions()[0] ?? null;
}

// 이벤트 한 줄을 덧붙일 뿐 남의 상태를 다시 쓰지 않는다.
// 쓰기 실패는 그대로 전파한다 — 저장되지 않은 답변을 저장된 것처럼 보고하면 안 된다.
export function resolveQuestion(
  id: string,
  status: 'answered' | 'skipped',
): void {
  const path = getQuestionsPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    serialize({ ts: new Date().toISOString(), event: 'resolved', id, status }),
    'utf8',
  );
}
