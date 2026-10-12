// 세션 객체 타입.
//
// 그동안 session은 어디서나 암묵적 any로 흘러다녀서, 필드 오타나 잘못된
// 접근이 컴파일 단계에서 전혀 걸러지지 않았다. 실제 스펙은 config.ts의
// createSession이 만드는 객체와 storage.ts의 createSessionPersistence가
// 덧붙이는 필드다.

import type { PermissionMode } from '../agent/permissions.ts';
import type { SessionModelMessage, SessionRow } from './storage.ts';

/**
 * 대화 상대·성격.
 *
 * - agent: 코딩 탭. 파일·셸·git 도구를 전부 쓴다
 * - chat:  채팅 탭. 파일·셸 도구 없이 대화와 웹 검색만
 */
export type SessionMode = 'agent' | 'chat';

/** 탭으로 고를 수 있는 모드 */
export type TabMode = 'agent' | 'chat';

/**
 * 접힌 이력. 창이 차서 앞부분을 요약으로 접은 결과를 세션 파일에도 남겨, 다음
 * 턴과 앱 재시작 뒤에도 같은 자리에서 이어가고 다시 접지 않는다 (agent/compact.ts).
 */
export type SessionCompaction = {
  /** messages 앞에서 접힌 메시지 수 */
  foldedCount: number;
  /** 접힌 구간의 사용자 요청 원문 (누적) */
  prompts: string[];
  summary: string;
};

/** 기록 위치. createSessionPersistence가 만들고 세션 전환 시 갱신됨 */
export type SessionPersistence = {
  /** 마지막으로 append한 transcript 엔트리의 uuid (parentUuid 연결용) */
  lastTranscriptUuid?: string;
  projectPath: string;
  sessionId: string;
  sessionPath: string;
};

export type Session = SessionPersistence & {
  provider: string;
  model: string;
  /**
   * 추론 강도(none/low/medium/high…). OpenAI 추론 모델에만 의미가 있고,
   * 모델 선택과 같은 수명이다 — 세션 안에서 바뀌고 앱을 켜면 .env 값으로 돌아간다.
   */
  reasoningEffort?: string;
  maxTokens: number;
  /** 프로바이더를 호출하지 않고 모의 응답을 씀 (스모크·테스트) */
  mock: boolean;
  /** 메모리 회상·기록을 건너뜀 */
  noMemory: boolean;
  /** 접힌 이력. 없으면 아직 접은 적이 없거나 /clear로 비운 것 */
  compaction?: SessionCompaction;
  /**
   * 사용자가 멈춤 안내의 "허용하고 이어서"로 허용한 명령. 루프가 판정 없이 실행한다.
   * 정확히 같은 문자열만 통과하고, 파일에 남기지 않아 앱을 다시 켜면 사라진다
   */
  approvedCommands?: string[];
  /** 세션을 재개했을 때 화면에 복원할 행 */
  initialRows: SessionRow[];
  messages: SessionModelMessage[];
  mode: SessionMode;
  permissionMode: PermissionMode;
  /** 프로바이더 호출 직전에만 채워짐 (config.buildSystemPrompt 결과) */
  systemPrompt?: string;
};
