export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'insight';
export type LogRole = 'user' | 'assistant';

export type QuestionKind = 'stale-memory' | 'topic-confirm' | 'pattern-why';

export type PendingQuestion = {
  id: string;
  createdAt: string; // ISO timestamp
  kind: QuestionKind;
  text: string;
  relatedTopic: string; // 관련 topic slug, 없으면 빈 문자열
  // status 필드는 없다 — 큐 fold가 살아있는(=pending) 질문만 돌려주므로 상태는 존재 여부로 표현된다
};
