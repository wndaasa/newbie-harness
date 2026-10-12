import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { getNewbieHome } from '../memory/globalNewbie.ts';
import { agentTmpDir } from '../tools/agentWorkspace.ts';
import { toolRowTarget, toolRowTitle } from '../ui/toolLabels.ts';
import { normalizePermissionMode, type PermissionMode } from '../agent/permissions.ts';
import { isReasoningEffort } from '../providers/openaiResponses.ts';
import type { Session, SessionCompaction, TabMode } from './types.ts';
import type { BlockedCall, TurnStopCause } from '../agent/loop.ts';

const SESSION_DIR = 'sessions';
const TRANSCRIPT_EXTENSION = '.jsonl';

export type SessionTranscriptRole =
  | 'assistant'
  | 'compact'
  | 'error'
  | 'stop'
  | 'system'
  | 'user';

/** 이력을 접는 줄 ("압축 중..." → "압축 완료") */
export type SessionCompactRow = {
  /** 모델이 받는 압축문 전체 (요약과 요청 원문 목록). 화면이 펼쳐서 보여 준다 */
  brief?: string;
  /** 실패했을 때의 사유 */
  error?: string;
  /** 접기 전후 입력 토큰의 차이 */
  freedTokens?: number;
  /** skipped는 접을 만큼 쌓인 대화가 없었던 것 */
  state: 'done' | 'failed' | 'running' | 'skipped';
  /** manual은 /compact, auto는 창이 차서 루프가 접은 것 */
  trigger: 'auto' | 'manual';
};

/** 턴이 답 없이 멈춘 이유를 알리는 줄. 화면이 사유에 맞는 버튼을 붙인다 */
export type SessionStopRow = {
  /** cause가 denied일 때 막힌 호출 */
  blocked?: BlockedCall[];
  cause: Exclude<TurnStopCause, 'done' | 'aborted'>;
};

export type SessionRow = {
  /** 보낸/완성된 시각 (ISO). "n분 전" 표시용 */
  at?: string;
  content: string;
  id?: string;
  /** 사용자 행: 모델이 읽은 시각. 없으면 아직 안 읽음 */
  readAt?: string;
  /** 사용자 메시지에 첨부된 이미지 (data URL) */
  images?: string[];
  input?: Record<string, unknown>;
  name?: string;
  /** 오류 행의 분류 (화면이 조치 버튼을 고르는 근거) */
  errorKind?: string;
  /** 오류 행에서 제공자가 실제로 보낸 문장. 화면은 접어 두고 필요할 때 편다 */
  errorDetail?: string;
  /** assistant 행의 추론 요약 (본문 위 접이식 블록) */
  reasoning?: string;
  result?: string;
  /** 서브에이전트 안의 도구 행: 그것을 띄운 spawn_agent 행의 id. 화면이 그 아래 중첩한다 */
  parentId?: string;
  /** tool 행은 message 엔트리의 toolCalls에서 복원됨 (row 엔트리로는 저장하지 않음) */
  role: SessionTranscriptRole | 'tool';
  target?: string;
  toolStatus?: 'blocked' | 'done' | 'error' | 'running';
  /**
   * 막힌 도구 행: 사용자가 "이 명령 허용"으로 이 명령만 허용할 수 있다. 실행 중에만
   * 붙는다. 허용 목록은 앱을 다시 켜면 사라지므로 복원된 행에는 버튼을 내지 않는다
   */
  allowable?: boolean;
  /** 막힌 도구 행: 사용자가 이 명령을 허용했다 */
  allowed?: boolean;
  /** compact 행의 상태 */
  compact?: SessionCompactRow;
  /** stop 행의 멈춘 이유 */
  stop?: SessionStopRow;
};

/** 프로바이더 중립 도구 호출 기록. API 포맷 변환은 src/providers/toolHistory.ts가 맡음 */
export type SessionToolCall = {
  /**
   * 승인 게이트에서 막혀 실행되지 않은 호출.
   *
   * ok: false로만 남기면 다시 열었을 때 "도구가 오류를 냈다"로 복원돼, 무엇이
   * 왜 막혔는지가 사라진다. 차단은 감사 흔적이라 실패와 구분해서 남긴다.
   */
  blocked?: boolean;
  /**
   * spawn_agent 호출이면 그 안에서 자식 루프가 실행한 도구 호출. 화면에 중첩해
   * 보여주고 세션에도 남기지만, 모델에게는 결과 텍스트만 간다 (toolHistory는
   * 필드를 골라 담으므로 자연히 빠진다)
   */
  children?: SessionToolCall[];
  id: string;
  /** 도구가 결과와 함께 돌려준 이미지 (data URL). 저장 시에는 파일로 빠진다 */
  images?: string[];
  input: Record<string, unknown>;
  name: string;
  ok: boolean;
  result: string;
};

/**
 * 백그라운드 보조 에이전트의 보고. 자동 알림 메시지에 실려 저장된다.
 *
 * spawn_agent 호출 기록은 자식이 끝나기 전에 적혀 보고와 자식 호출이 없다. 파일은
 * 덧쓰지 않으므로 나중에 도착한 보고를 별도 메시지에 싣고, 다시 열 때 callId로
 * 그 행에 붙인다
 */
export type SessionAgentReport = {
  /** 이 보고를 낳은 spawn_agent 호출의 id */
  callId: string;
  /** 자식 루프가 실행한 도구 호출 (화면 중첩용) */
  children: SessionToolCall[];
  ok: boolean;
  /** 자식의 최종 보고 (실패면 오류 메시지) */
  text: string;
};

export type SessionModelMessage = {
  /** 백그라운드 보조 에이전트의 보고가 있으면 함께 남긴다 (automatic 메시지) */
  agentReport?: SessionAgentReport;
  /** 보낸(사용자) 또는 완성된(assistant) 시각, ISO. 화면의 "n분 전" 표시용 */
  at?: string;
  /**
   * 사용자가 아니라 앱이 넣은 user 역할 메시지 (보조 에이전트 보고 알림). 압축의
   * 턴 경계·요청 목록에서 빼고, 끼어듦 표식도 붙이지 않으며, 화면에 사용자
   * 말풍선으로 되살리지 않는다
   */
  automatic?: boolean;
  content: string;
  images?: string[];
  /**
   * 에이전트가 작업하는 도중 끼어든 사용자 메시지. 프로바이더로 나갈 때
   * "작업 중 도착한 메시지" 표식이 붙는다 (toolHistory). 화면에는 원문만
   */
  interjected?: boolean;
  /** 사용자 메시지를 모델이 읽은 시각. 끼어든 메시지는 다음 라운드에 읽힌다 */
  readAt?: string;
  /**
   * assistant가 이 텍스트(또는 도구 호출) 앞에 한 추론의 요약. 화면 표시용이라
   * 프로바이더에 되돌려 보내지 않는다 (toolHistory가 떼어낸다)
   */
  reasoning?: string;
  role: 'assistant' | 'user';
  /** assistant 라운드가 끝난 이유 (streams.ts의 정규화 어휘). 길이 상한 잘림 추적용 */
  stopReason?: string;
  /** assistant가 이 텍스트 뒤에 실행한 도구 호출·결과 (한 루프 라운드 단위) */
  toolCalls?: SessionToolCall[];
};

type TranscriptEntry = {
  /** message 엔트리이고 automatic일 때: 실려 온 보조 에이전트 보고 */
  agentReport?: SessionAgentReport;
  /** message 엔트리: 보낸/완성된 시각. 없으면 timestamp(기록 시각)로 대신한다 */
  at?: string;
  automatic?: boolean;
  content?: string;
  cwd: string;
  /** row 엔트리이고 role이 error일 때: 분류와 제공자 원문 (조치 버튼·상세 복원용) */
  errorKind?: string;
  errorDetail?: string;
  interjected?: boolean;
  readAt?: string;
  /**
   * message 엔트리이고 user일 때, 오류로 끝난 턴과 그 다시 시도의 짝.
   *
   *   - failed: 화면에만 그린다. 모델 이력에서는 빠진 요청이다
   *   - retried: 이력에만 넣는다. 말풍선은 failed 쪽이 이미 그렸다
   */
  turnState?: 'failed' | 'retried';
  /** 예전 형식: 본문에 박힌 data URL (읽기 호환용) */
  images?: string[];
  /** 현재 형식: <sessionId>-images/ 아래 저장된 파일 이름 */
  imageRefs?: string[];
  parentUuid: string | null;
  /** type이 message이고 assistant일 때: 추론 요약 */
  reasoning?: string;
  /** type이 message이고 assistant일 때: 종료 사유 */
  stopReason?: string;
  role?: string;
  rowId?: string;
  sessionId: string;
  timestamp: string;
  toolCalls?: SessionToolCall[];
  /** type이 mode일 때: 이 세션이 어느 탭에서 시작됐는지 */
  mode?: TabMode;
  /** type이 config일 때: 그 시점의 제공자·모델·추론 강도·권한 모드 */
  config?: SessionConfig;
  type: 'clear' | 'compact' | 'config' | 'message' | 'mode' | 'model' | 'name' | 'row' | 'usage';
  /** type이 usage일 때: 마지막으로 실측한 토큰 사용량 */
  usage?: SessionUsage;
  /** type이 compact일 때: 그 시점까지 접힌 이력 */
  compaction?: SessionCompaction;
  /** row 엔트리이고 role이 compact일 때: 압축 줄의 상태 */
  compactRow?: SessionCompactRow;
  /** row 엔트리이고 role이 stop일 때: 멈춘 이유 */
  stop?: SessionStopRow;
  uuid: string;
};

/**
 * 대화에 딸린 설정. 사용자가 이 대화에서 고른 제공자·모델·추론 강도·권한 모드다.
 *
 * 예전에는 메모리에만 있어서 앱을 다시 켜거나 다른 대화로 갔다 오면 .env
 * 기본값으로 돌아갔다 — 대화 내용은 그대로인데 모델만 바뀌어 있었다. 바뀔 때마다
 * 엔트리를 남기고 마지막 것을 복원한다.
 */
export type SessionConfig = {
  model: string;
  permissionMode?: PermissionMode;
  provider: string;
  reasoningEffort?: string;
};

/**
 * 이 대화에서 마지막으로 실측한 토큰 사용량.
 *
 * 컨텍스트 게이지는 프로바이더가 알려준 실측값으로 그린다. 그런데 그 값이
 * 메모리에만 있어서, 다른 대화로 갔다 오면 게이지가 빈 채로 남았다 — 대화에
 * 내용이 그대로 있는데도 얼마나 찼는지 알 수 없었다. 마지막 측정값을 세션에
 * 남겨 복원할 때 되살린다.
 */
export type SessionUsage = {
  cached?: number;
  input: number;
  output: number;
};

export type LoadedSession = {
  /** 마지막으로 접힌 이력. 접은 적이 없거나 그 뒤 clear가 있으면 undefined */
  compaction?: SessionCompaction;
  /** 마지막으로 기록된 설정. config 엔트리가 없던 시절의 세션은 undefined */
  config?: SessionConfig;
  lastTranscriptUuid?: string;
  messages: SessionModelMessage[];
  /** 이 대화가 시작된 탭 */
  mode: TabMode;
  projectPath: string;
  rows: SessionRow[];
  sessionId: string;
  sessionPath: string;
  /** 복원 시점의 컨텍스트 게이지용. 측정 기록이 없으면 undefined */
  usage?: SessionUsage;
};

export type SessionSummary = {
  created: Date;
  firstPrompt: string;
  /** 어느 탭의 대화인지. mode 엔트리가 없는 예전 세션은 코딩으로 본다 */
  mode: TabMode;
  modified: Date;
  name: string;
  projectPath: string;
  sessionId: string;
  sessionPath: string;
};

export function createSessionPersistence(projectPath = process.cwd()) {
  const sessionId = randomUUID();
  return {
    lastTranscriptUuid: undefined,
    projectPath: resolve(projectPath),
    sessionId,
    sessionPath: getSessionPath(sessionId, projectPath),
  };
}

// 세션을 다른 프로젝트 폴더로 재지정 (새 대화에서 작업 폴더 변경용).
// sessionId는 유지하고 기록 위치(projectPath·sessionPath)만 새 폴더로 옮긴다.
// 이미 기록이 있는 세션에 쓰면 이력이 두 파일로 쪼개지므로, 호출 측에서
// 기록 없는 세션에만 사용해야 한다.
export function repointSessionProject(session: Session, projectPath: string): void {
  session.projectPath = resolve(projectPath);
  session.sessionPath = getSessionPath(session.sessionId, projectPath);
}

export function loadSessionById(identifier: string, projectPath = process.cwd()): LoadedSession {
  const sessionId = resolveSessionId(identifier, projectPath);
  if (!sessionId) {
    throw new Error(`세션을 찾을 수 없습니다: ${identifier}`);
  }

  return loadSession(sessionId, projectPath);
}

export function loadLatestSession(projectPath = process.cwd()): LoadedSession {
  const latest = listSessions(projectPath)[0];
  if (!latest) {
    throw new Error('재개할 세션이 없습니다.');
  }

  return loadSession(latest.sessionId, projectPath);
}

export function loadSession(sessionId: string, projectPath = process.cwd()): LoadedSession {
  const sessionPath = getSessionPath(sessionId, projectPath);
  if (!existsSync(sessionPath)) {
    throw new Error(`세션을 찾을 수 없습니다: ${sessionId}`);
  }

  const rows: SessionRow[] = [];
  const messages: SessionModelMessage[] = [];
  let lastTranscriptUuid: string | undefined;
  let usage: SessionUsage | undefined;
  let config: SessionConfig | undefined;
  let compaction: SessionCompaction | undefined;
  // mode 엔트리가 없던 시절의 세션은 전부 코딩 대화다
  let mode: TabMode = 'agent';

  for (const entry of readTranscriptEntries(sessionPath)) {
    lastTranscriptUuid = entry.uuid;

    if (entry.type === 'mode') {
      if (entry.mode === 'chat' || entry.mode === 'agent') mode = entry.mode;
      continue;
    }

    if (entry.type === 'config') {
      config = sanitizeConfig(entry.config) ?? config;
      continue;
    }

    if (entry.type === 'clear') {
      rows.length = 0;
      messages.length = 0;
      // 대화를 비웠으면 이전 측정값도 의미가 없다. 설정은 대화 내용이 아니라
      // 그대로 둔다 — /clear 뒤에도 같은 모델로 이어 쓰는 게 자연스럽다
      usage = undefined;
      compaction = undefined;
      continue;
    }

    if (entry.type === 'compact') {
      compaction = sanitizeCompaction(entry.compaction) ?? compaction;
      continue;
    }

    if (entry.type === 'usage') {
      usage = sanitizeUsage(entry.usage);
      continue;
    }

    if (entry.type === 'message' && isModelRole(entry.role)) {
      const toolCalls =
        entry.role === 'assistant'
          ? sanitizeToolCalls(entry.toolCalls, sessionPath, sessionId)
          : undefined;
      // 예전 세션은 images(data URL)를, 이후 세션은 imageRefs(파일 이름)를 가진다
      const images = entry.images?.length
        ? entry.images
        : loadSessionImages(sessionPath, sessionId, entry.imageRefs);
      const reasoning =
        entry.role === 'assistant' && typeof entry.reasoning === 'string' && entry.reasoning.trim()
          ? entry.reasoning
          : undefined;
      const stopReason =
        entry.role === 'assistant' && typeof entry.stopReason === 'string' && entry.stopReason
          ? entry.stopReason
          : undefined;
      // at이 없던 시절의 엔트리는 기록 시각으로 대신한다 (턴이 끝날 때 한꺼번에
      // 적혔으므로 사용자 메시지는 몇 분 늦게 보일 수 있다)
      const at = typeof entry.at === 'string' ? entry.at : entry.timestamp;
      const readAt =
        entry.role === 'user' ? (typeof entry.readAt === 'string' ? entry.readAt : at) : undefined;
      const automatic = entry.role === 'user' && entry.automatic === true;
      const agentReport = automatic
        ? sanitizeAgentReport(entry.agentReport, sessionPath, sessionId)
        : undefined;
      const message = {
        ...(agentReport ? { agentReport } : {}),
        at,
        ...(automatic ? { automatic: true } : {}),
        content: String(entry.content ?? ''),
        ...(images.length ? { images } : {}),
        ...(entry.interjected ? { interjected: true } : {}),
        ...(readAt ? { readAt } : {}),
        ...(reasoning ? { reasoning } : {}),
        role: entry.role,
        ...(stopReason ? { stopReason } : {}),
        ...(toolCalls?.length ? { toolCalls } : {}),
      };
      if (entry.turnState !== 'failed') messages.push(message);
      if (entry.turnState === 'retried') continue;
      // 자동 알림은 사용자 말풍선이 아니다. 실려 온 보고는 그것을 낳은 spawn_agent
      // 행에 붙인다 — 실행 중에 행이 done으로 바뀌고 자식 행이 중첩되던 모양 그대로
      if (automatic) {
        if (agentReport) attachAgentReport(rows, agentReport);
        continue;
      }
      // 도구를 호출한 라운드의 빈 텍스트는 실행 중 UI와 동일하게 행을 만들지 않음.
      // 추론 요약이 있으면 본문이 비어도 행을 만든다 — 실행 중에도 그렇게 보였다
      if (message.content || reasoning || !toolCalls?.length) {
        rows.push({
          at,
          content: message.content,
          ...(images.length ? { images } : {}),
          ...(readAt ? { readAt } : {}),
          ...(reasoning ? { reasoning } : {}),
          role: message.role,
        });
      }
      rows.push(...toolRowsOf(toolCalls ?? []));
      continue;
    }

    if (entry.type === 'row' && isTranscriptRole(entry.role)) {
      rows.push({
        at: entry.timestamp,
        content: String(entry.content ?? ''),
        ...(entry.errorKind ? { errorKind: String(entry.errorKind) } : {}),
        ...(entry.errorDetail ? { errorDetail: String(entry.errorDetail) } : {}),
        ...(entry.role === 'compact' && entry.compactRow ? { compact: entry.compactRow } : {}),
        ...(entry.role === 'stop' && entry.stop ? { stop: entry.stop } : {}),
        id: entry.rowId,
        role: entry.role,
      });
      continue;
    }

    if (entry.type === 'model' && isModelRole(entry.role)) {
      messages.push({
        content: String(entry.content ?? ''),
        role: entry.role,
      });
    }
  }

  return {
    // 접힌 수가 이력보다 크면(파일이 손상됐거나 손으로 편집됨) 접은 적 없는 것으로 본다
    ...(compaction && compaction.foldedCount <= messages.length ? { compaction } : {}),
    config,
    lastTranscriptUuid,
    messages,
    mode,
    projectPath: resolve(projectPath),
    usage,
    // 전부 복원한다. 예전엔 마지막 80행만 남겨서 긴 대화를 다시 열면 앞부분이
    // 사라졌다 — 사용자는 첫 프롬프트부터 다시 볼 수 있기를 바란다
    rows,
    sessionId,
    sessionPath,
  };
}

export function listSessions(projectPath = process.cwd()): SessionSummary[] {
  const projectDir = getProjectSessionsDir(projectPath);
  if (!existsSync(projectDir)) return [];

  return readdirSync(projectDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXTENSION))
    .map(entry => summarizeSessionFile(join(projectDir, entry.name), projectPath))
    .filter((summary): summary is SessionSummary => summary !== undefined)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// 모든 프로젝트의 세션 조회 (사이드바 프로젝트 그룹·필터용).
// 프로젝트 경로는 디렉터리 이름(비가역 변환)이 아니라 transcript 엔트리의 cwd에서 복원함
export function listAllSessions(): SessionSummary[] {
  const sessionsRoot = join(getNewbieHome(), SESSION_DIR);
  if (!existsSync(sessionsRoot)) return [];

  const summaries: SessionSummary[] = [];
  for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectDir = join(sessionsRoot, dir.name);
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(TRANSCRIPT_EXTENSION)) continue;
      const summary = summarizeSessionFile(join(projectDir, entry.name), null);
      if (summary) summaries.push(summary);
    }
  }

  return summaries.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// 세션 표시 이름 설정. name 엔트리를 append하고 목록 조회 시 마지막 것을 사용함
export function renameSession(
  sessionId: string,
  name: string,
  projectPath = process.cwd(),
): void {
  const sessionPath = getSessionPath(sessionId, projectPath);
  if (!existsSync(sessionPath)) {
    throw new Error(`세션을 찾을 수 없습니다: ${sessionId}`);
  }

  const entry: TranscriptEntry = {
    content: name.trim(),
    cwd: resolve(projectPath),
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
    type: 'name',
    uuid: randomUUID(),
  };
  appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`, 'utf8');
  updateMetaFile(sessionPath, entry);
}

/**
 * 지울 세션 id의 모양. id는 randomUUID로 만들어 영숫자와 하이픈뿐이다. 화면에서 온
 * 값을 그대로 경로에 붙여 재귀 삭제하므로, ..나 경로 구분자가 섞이면 세션 폴더 밖을 지운다
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function deleteSession(sessionId: string, projectPath = process.cwd()): void {
  if (!SESSION_ID_PATTERN.test(String(sessionId ?? ''))) {
    throw new Error(`올바르지 않은 세션 id입니다: ${sessionId}`);
  }
  const sessionPath = getSessionPath(sessionId, projectPath);
  if (!existsSync(sessionPath)) {
    throw new Error(`세션을 찾을 수 없습니다: ${sessionId}`);
  }
  unlinkSync(sessionPath);
  rmSync(metaPathOf(sessionPath), { force: true });
  // 남겨두면 참조 없는 이미지 파일만 계속 쌓인다
  rmSync(join(getProjectSessionsDir(projectPath), `${sessionId}${IMAGE_DIR_SUFFIX}`), {
    recursive: true,
    force: true,
  });
  // 이 대화의 임시 파일도 함께 지운다. 이 세션 몫(tmp/<세션ID>)만 지운다
  rmSync(agentTmpDir(sessionId, projectPath), { recursive: true, force: true });
}

export function recordSessionRow(session: Session, row: SessionRow): void {
  appendTranscriptEntry(session, {
    content: String(row.content ?? ''),
    // 오류 행의 분류·상세도 함께 남긴다. 이게 없으면 대화를 다시 열었을 때
    // 제목만 남고 조치 버튼과 원문이 사라진다
    ...(row.errorKind ? { errorKind: row.errorKind } : {}),
    ...(row.errorDetail ? { errorDetail: row.errorDetail } : {}),
    // 압축 줄과 멈춤 안내도 다시 열었을 때 같은 모양으로 그려지도록 상태째 남긴다
    ...(row.compact ? { compactRow: row.compact } : {}),
    ...(row.stop ? { stop: row.stop } : {}),
    role: row.role,
    rowId: row.id,
    type: 'row',
  });
}

export function recordSessionMessages(
  session: Session,
  messages: SessionModelMessage[],
  turnState?: TranscriptEntry['turnState'],
): void {
  for (const message of messages) {
    // 첨부 이미지는 base64로 수 MB가 되기 때문에 transcript 본문에 그대로 넣으면
    // 세션 목록을 훑을 때마다 그 덩어리까지 파싱하게 된다. 파일로 빼고 이름만 남긴다
    const imageRefs = message.images?.length
      ? saveSessionImages(session, message.images)
      : [];

    // 도구가 돌려준 이미지도 같은 이유로 파일로 뺀다. 스크린샷은 턴마다 쌓여서
    // 첨부 이미지보다 빨리 늘어난다
    const toolCalls = message.toolCalls?.map(call => detachToolCallImages(session, call));

    const agentReport = message.agentReport
      ? {
          ...message.agentReport,
          children: message.agentReport.children.map(call => detachToolCallImages(session, call)),
        }
      : undefined;

    appendTranscriptEntry(session, {
      ...(agentReport ? { agentReport } : {}),
      ...(message.at ? { at: message.at } : {}),
      ...(message.automatic ? { automatic: true } : {}),
      content: String(message.content ?? ''),
      ...(imageRefs.length ? { imageRefs } : {}),
      ...(message.interjected ? { interjected: true } : {}),
      ...(message.readAt ? { readAt: message.readAt } : {}),
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(message.stopReason ? { stopReason: message.stopReason } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(turnState ? { turnState } : {}),
      role: message.role,
      type: 'message',
    });
  }
}

/** 도구 호출(과 서브에이전트의 자식 호출)의 이미지를 파일로 빼고 이름만 남긴다 */
function detachToolCallImages(session: Session, call: SessionToolCall): SessionToolCall {
  const children = call.children?.map(child => detachToolCallImages(session, child));
  return {
    ...call,
    ...(children ? { children } : {}),
    ...(call.images?.length
      ? { imageRefs: saveSessionImages(session, call.images), images: undefined }
      : {}),
  };
}

/**
 * 도구 호출을 화면 행으로. 서브에이전트의 자식 호출은 부모 행의 id를 parentId로
 * 달고 바로 뒤에 온다 — 실행 중 UI가 이벤트를 받아 만드는 것과 같은 모양이다
 */
function toolRowsOf(calls: SessionToolCall[], parentId?: string): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const call of calls) {
    const id = `tool-${call.id}`;
    rows.push({
      content: toolRowTitle(call),
      id,
      // 세션을 다시 열어도 도구가 찍은 화면이 남아 있어야 한다
      ...(call.images?.length ? { images: call.images } : {}),
      input: call.input,
      name: call.name,
      ...(parentId ? { parentId } : {}),
      result: call.result,
      role: 'tool',
      target: toolRowTarget(call),
      toolStatus: call.blocked ? 'blocked' : call.ok ? 'done' : 'error',
    });
    if (call.children?.length) rows.push(...toolRowsOf(call.children, id));
  }
  return rows;
}

/**
 * 나중에 도착한 보조 에이전트 보고를 그 spawn_agent 행에 붙인다. 행이 없으면
 * (/clear 뒤거나 파일이 손상됨) 붙일 데가 없으니 버린다
 */
function attachAgentReport(rows: SessionRow[], report: SessionAgentReport): void {
  const id = `tool-${report.callId}`;
  const row = rows.find(candidate => candidate.id === id && candidate.role === 'tool');
  if (!row) return;
  row.result = report.text;
  row.toolStatus = report.ok ? 'done' : 'error';
  rows.push(...toolRowsOf(report.children, id));
}

const IMAGE_DIR_SUFFIX = '-images';
const DATA_URL = /^data:(image\/([a-z0-9+.-]+));base64,(.+)$/i;

function getSessionImageDir(session: Session): string {
  return join(
    getProjectSessionsDir(session.projectPath ?? process.cwd()),
    `${session.sessionId}${IMAGE_DIR_SUFFIX}`,
  );
}

/** data URL을 파일로 저장하고 파일 이름 목록을 반환. 실패한 항목은 건너뜀 */
function saveSessionImages(session: Session, images: string[]): string[] {
  if (session.mock) return [];

  const dir = getSessionImageDir(session);
  const names: string[] = [];
  for (const image of images) {
    const match = DATA_URL.exec(String(image ?? ''));
    if (!match) continue;
    const name = `${randomUUID()}.${match[2].toLowerCase()}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.from(match[3], 'base64'));
      names.push(name);
    } catch {
      // 이미지 저장 실패가 대화 기록을 막지는 않음
    }
  }
  return names;
}

/** 저장된 이미지 파일을 다시 data URL로 (화면 복원용) */
function loadSessionImages(
  sessionPath: string,
  sessionId: string,
  names: string[] | undefined,
): string[] {
  if (!names?.length) return [];

  const dir = join(dirname(sessionPath), `${sessionId}${IMAGE_DIR_SUFFIX}`);
  const images: string[] = [];
  for (const name of names) {
    // 파일 이름만 허용해 경로 탈출을 막음
    if (typeof name !== 'string' || name !== basename(name)) continue;
    try {
      const buffer = readFileSync(join(dir, name));
      const ext = extname(name).slice(1).toLowerCase() || 'png';
      images.push(`data:image/${ext};base64,${buffer.toString('base64')}`);
    } catch {
      // 지워졌거나 읽을 수 없는 이미지는 건너뜀
    }
  }
  return images;
}

export function recordSessionClear(session: Session): void {
  appendTranscriptEntry(session, { type: 'clear' });
}

/** 파일에서 읽은 usage 중 숫자로 온 것만 살린다 */
function sanitizeUsage(value: unknown): SessionUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const input = Number(record.input);
  const output = Number(record.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;

  const cached = Number(record.cached);
  return {
    ...(Number.isFinite(cached) ? { cached } : {}),
    input,
    output,
  };
}

/** 턴이 끝날 때 실측 사용량을 남긴다 (컨텍스트 게이지 복원용) */
export function recordSessionUsage(session: Session, usage: SessionUsage): void {
  appendTranscriptEntry(session, { type: 'usage', usage });
}

function sanitizeCompaction(value: unknown): SessionCompaction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const foldedCount = Number(record.foldedCount);
  if (!Number.isInteger(foldedCount) || foldedCount <= 0) return undefined;
  const prompts = Array.isArray(record.prompts)
    ? record.prompts.filter((item): item is string => typeof item === 'string')
    : [];
  return { foldedCount, prompts, summary: typeof record.summary === 'string' ? record.summary : '' };
}

/**
 * 이력을 접은 자리를 남긴다. 다음 턴과 앱 재시작 뒤에도 같은 자리에서 이어가고
 * 다시 접지 않는다. 메시지 엔트리 뒤에 적으므로 foldedCount는 그 시점 이력 기준이다
 */
export function recordSessionCompaction(session: Session, compaction: SessionCompaction): void {
  appendTranscriptEntry(session, { compaction, type: 'compact' });
}

/**
 * 이 세션이 어느 탭의 대화인지 남긴다.
 *
 * 사이드바가 탭별로 목록을 나누려면 파일만 보고 알 수 있어야 한다. 세션이
 * 만들어질 때가 아니라 첫 메시지를 보낼 때 적는다 — 탭만 눌러보고 아무것도
 * 안 쓴 세션은 파일 자체가 안 생겨야 목록에 빈 대화가 쌓이지 않는다.
 */
export function recordSessionMode(session: Session, mode: TabMode): void {
  appendTranscriptEntry(session, { mode, type: 'mode' });
}

/** 세션에서 파일에 남길 설정만 추린다 (기록·변경 감지 양쪽이 같은 모양을 쓴다) */
export function sessionConfigOf(session: Session): SessionConfig {
  return {
    model: session.model,
    permissionMode: session.permissionMode,
    provider: session.provider,
    reasoningEffort: session.reasoningEffort,
  };
}

/**
 * 이 대화의 설정(제공자·모델·추론 강도·권한 모드)을 남긴다.
 *
 * mode와 같은 이유로 첫 메시지 이후에만 적는다 — 모델만 골라보고 닫은 빈 대화가
 * 파일로 남으면 안 된다. 호출 측(controller)이 그 시점을 안다.
 */
export function recordSessionConfig(session: Session): void {
  appendTranscriptEntry(session, { config: sessionConfigOf(session), type: 'config' });
}

/**
 * 파일에서 읽은 설정 중 쓸 수 있는 것만 살린다. 제공자 이름은 여기서 검증하지
 * 않는다 — 목록(PROVIDERS)이 config.ts에 있어 끌어오면 순환 import가 되므로,
 * 복원하는 쪽이 normalizeProvider로 확인한다.
 */
function sanitizeConfig(value: unknown): SessionConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!provider || !model) return undefined;

  const permissionMode =
    typeof record.permissionMode === 'string'
      ? normalizePermissionMode(record.permissionMode)
      : undefined;
  return {
    model,
    ...(permissionMode ? { permissionMode } : {}),
    provider,
    ...(isReasoningEffort(record.reasoningEffort) ? { reasoningEffort: record.reasoningEffort } : {}),
  };
}

export function applyLoadedSession(session: Session, loaded: LoadedSession): void {
  session.sessionId = loaded.sessionId;
  session.sessionPath = loaded.sessionPath;
  session.projectPath = loaded.projectPath;
  session.lastTranscriptUuid = loaded.lastTranscriptUuid;
  session.messages = loaded.messages.map(message => ({ ...message }));
  session.compaction = loaded.compaction;
  session.initialRows = loaded.rows.map(row => ({ ...row }));
  // 설정 기록이 없는 예전 세션은 지금 값(.env 기본값)을 그대로 쓴다
  if (loaded.config) {
    session.provider = loaded.config.provider;
    session.model = loaded.config.model;
    if (loaded.config.reasoningEffort) session.reasoningEffort = loaded.config.reasoningEffort;
    if (loaded.config.permissionMode) session.permissionMode = loaded.config.permissionMode;
  }
}

export function formatSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return '저장된 세션이 없습니다.';

  return [
    '저장된 세션',
    ...sessions.map(session => {
      const label = session.sessionId.slice(0, 8);
      const modified = formatDateTime(session.modified);
      const prompt = session.firstPrompt || '(내용 없음)';
      return `${label}  ${modified}  ${prompt}`;
    }),
    '',
    '/resume <세션 ID> 로 이어서 시작할 수 있습니다.',
  ].join('\n');
}

type TranscriptEntryInput = Partial<Omit<TranscriptEntry, 'type'>> &
  Pick<TranscriptEntry, 'type'>;

function appendTranscriptEntry(session: Session, partial: TranscriptEntryInput): void {
  // mock(검증) 세션은 디스크에 남기지 않음 — 스모크·테스트 대화가 세션 목록에 쌓이는 것 방지
  if (session.mock) return;
  const entry: TranscriptEntry = {
    cwd: session.projectPath ?? resolve(process.cwd()),
    parentUuid: session.lastTranscriptUuid ?? null,
    sessionId: session.sessionId,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    ...partial,
  };

  mkdirSync(getProjectSessionsDir(entry.cwd), { recursive: true });
  appendFileSync(session.sessionPath, `${JSON.stringify(entry)}\n`, 'utf8');
  updateMetaFile(session.sessionPath, entry);
  session.lastTranscriptUuid = entry.uuid;
}

// 사이드바 목록용 요약. 세션마다 transcript 옆의 <세션ID>.meta.json에 둔다.
//
// 목록은 턴 종료·이름 변경·삭제마다 다시 만든다. 예전에는 그때마다 모든 프로젝트의
// 모든 transcript를 줄 단위로 JSON 파싱했다 — 수정 시각·크기로 캐시했지만 앱을 켤
// 때와 파일이 바뀔 때는 다시 읽었고, 첨부 이미지가 본문에 들어 있던 예전 세션은
// 파일 하나가 수십 MB다. 이제 기록할 때마다 요약만 갱신해 두고 목록은 요약 파일만
// 읽는다. 대화 내용은 그 세션을 열 때(loadSession)만 읽는다.
const META_SUFFIX = '.meta.json';
const META_VERSION = 1;

type SessionFacts = {
  entryCwd: string;
  firstPrompt: string;
  /** /clear 뒤 첫 엔트리 시각. 생성 시각으로 쓴다 */
  firstTimestamp: string;
  lastTimestamp: string;
  mode: TabMode;
  name: string;
};

function emptyFacts(): SessionFacts {
  // mode 엔트리를 안 쓰던 시절의 세션은 전부 코딩 대화다
  return { entryCwd: '', firstPrompt: '', firstTimestamp: '', lastTimestamp: '', mode: 'agent', name: '' };
}

/**
 * 엔트리 하나를 요약에 반영한다. 파일 전체로 만들 때와 기록할 때 같은 규칙을 쓴다.
 *
 * 생성·수정 시각은 파일 stat(birthtime/mtime) 대신 엔트리 timestamp로 산출한다.
 * birthtime은 파일 복사 시 리셋되고, 두 값이 우연히 같은 순서가 되어 정렬이
 * 무의미해지는 문제가 있었음. firstPrompt와 같은 정책으로 clear 시 리셋한다.
 */
function applyEntryToFacts(facts: SessionFacts, entry: TranscriptEntry): void {
  if (!facts.entryCwd && entry.cwd) facts.entryCwd = entry.cwd;
  if (entry.timestamp) facts.lastTimestamp = entry.timestamp;

  if (entry.type === 'mode') {
    if (entry.mode === 'chat' || entry.mode === 'agent') facts.mode = entry.mode;
    return;
  }

  if (entry.type === 'clear') {
    facts.firstPrompt = '';
    facts.firstTimestamp = '';
    return;
  }

  if (!facts.firstTimestamp && entry.timestamp) facts.firstTimestamp = entry.timestamp;

  if (entry.type === 'name') {
    facts.name = String(entry.content ?? '').trim();
    return;
  }

  if (
    (entry.type === 'message' || entry.type === 'model') &&
    entry.role === 'user' &&
    !facts.firstPrompt
  ) {
    facts.firstPrompt = stripMarkdownSyntax(String(entry.content ?? ''));
  }
}

function metaPathOf(sessionPath: string): string {
  return `${sessionPath.slice(0, -TRANSCRIPT_EXTENSION.length)}${META_SUFFIX}`;
}

function readMetaFile(sessionPath: string): SessionFacts | undefined {
  try {
    const raw = JSON.parse(readFileSync(metaPathOf(sessionPath), 'utf8'));
    if (raw?.version !== META_VERSION) return undefined;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    return {
      entryCwd: text(raw.entryCwd),
      firstPrompt: text(raw.firstPrompt),
      firstTimestamp: text(raw.firstTimestamp),
      lastTimestamp: text(raw.lastTimestamp),
      mode: raw.mode === 'chat' ? 'chat' : 'agent',
      name: text(raw.name),
    };
  } catch {
    return undefined;
  }
}

function writeMetaFile(sessionPath: string, facts: SessionFacts): void {
  const path = metaPathOf(sessionPath);
  // 목록이 반쯤 쓴 파일을 읽지 않게 임시 파일에 쓰고 바꿔 끼운다
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ version: META_VERSION, ...facts }), 'utf8');
    renameSync(temp, path);
  } catch {
    // 요약은 transcript에서 언제든 다시 만들 수 있다. 기록 자체를 막지 않는다
    rmSync(temp, { force: true });
  }
}

/** transcript 전체를 읽어 요약을 만든다. 요약 파일이 없는 예전 세션에 한 번만 쓰인다 */
function rebuildFacts(sessionPath: string): SessionFacts | undefined {
  const facts = emptyFacts();
  for (const entry of readTranscriptEntries(sessionPath)) applyEntryToFacts(facts, entry);
  if (!facts.lastTimestamp) {
    // 시각이 없던 아주 예전 엔트리뿐이면 파일 수정 시각으로 대신한다
    try {
      facts.lastTimestamp = statSync(sessionPath).mtime.toISOString();
    } catch {
      return undefined;
    }
  }
  return facts;
}

function loadFacts(sessionPath: string): SessionFacts | undefined {
  const stored = readMetaFile(sessionPath);
  if (stored) return stored;
  const rebuilt = rebuildFacts(sessionPath);
  if (rebuilt) writeMetaFile(sessionPath, rebuilt);
  return rebuilt;
}

/** 방금 기록한 엔트리를 요약에 반영한다. 요약이 없으면 전체로 만든다 (방금 것도 포함된다) */
function updateMetaFile(sessionPath: string, entry: TranscriptEntry): void {
  const stored = readMetaFile(sessionPath);
  if (!stored) {
    const rebuilt = rebuildFacts(sessionPath);
    if (rebuilt) writeMetaFile(sessionPath, rebuilt);
    return;
  }
  applyEntryToFacts(stored, entry);
  writeMetaFile(sessionPath, stored);
}

// projectPath에 null을 주면 transcript 엔트리의 cwd에서 프로젝트 경로를 복원함
function summarizeSessionFile(
  sessionPath: string,
  projectPath: string | null,
): SessionSummary | undefined {
  const sessionId = sessionIdFromPath(sessionPath);
  if (!sessionId) return undefined;

  const facts = loadFacts(sessionPath);
  if (!facts) return undefined;

  const resolvedProjectPath = projectPath ?? facts.entryCwd;
  if (!resolvedProjectPath) return undefined;

  return {
    created: new Date(facts.firstTimestamp || facts.lastTimestamp),
    firstPrompt: truncate(facts.firstPrompt, 80),
    mode: facts.mode,
    modified: new Date(facts.lastTimestamp),
    name: facts.name,
    projectPath: resolve(resolvedProjectPath),
    sessionId,
    sessionPath,
  };
}

/**
 * 사이드바 제목 폴백(firstPrompt)용 마크다운 서식 제거.
 *
 * 첫 메시지가 마크다운 문서 붙여넣기면 "# 제목 ## 1. 용어 - **AUC**..." 같은
 * 서식 기호가 제목으로 노출됐다. 표시용이므로 가볍게만 벗긴다 —
 * "C#"처럼 단어 끝의 #은 보존하고, 단어 앞의 헤딩·강조·목록 기호만 지운다.
 */
export function stripMarkdownSyntax(text: string): string {
  return String(text ?? '')
    .replace(/```[^\s`]*/g, ' ')
    .replace(/(^|\s)#+(?=\s|$)/g, '$1')
    .replace(/(^|\s)[-*+]\s+/g, '$1')
    .replace(/\*\*|__|[`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readTranscriptEntries(sessionPath: string): TranscriptEntry[] {
  try {
    return readFileSync(sessionPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseTranscriptLine)
      .filter(isTranscriptEntry);
  } catch {
    return [];
  }
}

function parseTranscriptLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function resolveSessionId(identifier: string, projectPath: string): string | undefined {
  const trimmed = identifier.trim();
  if (!trimmed) return undefined;

  const sessions = listSessions(projectPath);
  const exact = sessions.find(session => session.sessionId === trimmed);
  if (exact) return exact.sessionId;

  const matches = sessions.filter(session => session.sessionId.startsWith(trimmed));
  if (matches.length === 1) return matches[0].sessionId;
  if (matches.length > 1) {
    throw new Error(`여러 세션이 일치합니다: ${trimmed}`);
  }

  return undefined;
}

function getSessionPath(sessionId: string, projectPath: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}${TRANSCRIPT_EXTENSION}`);
}

function getProjectSessionsDir(projectPath: string): string {
  const root = join(getNewbieHome(), SESSION_DIR);
  const dirName = sanitizeProjectPath(projectPath);

  // 이전 이름 규칙으로 만들어진 디렉터리가 있으면 새 이름으로 옮겨 기존 세션을
  // 계속 찾을 수 있게 한다 (한 번만 일어남)
  const legacyDir = join(root, legacyProjectDirName(projectPath));
  const currentDir = join(root, dirName);
  if (legacyDir !== currentDir && existsSync(legacyDir) && !existsSync(currentDir)) {
    try {
      mkdirSync(root, { recursive: true });
      renameSync(legacyDir, currentDir);
    } catch {
      // 이동 실패 시에도 새 경로로 계속 진행 (기존 세션은 사이드바 전체 목록에서 보임)
    }
  }

  return currentDir;
}

// 경로에서 쓸 수 없는 문자를 -로 바꾸면 서로 다른 프로젝트가 같은 이름이 된다
// (C:\a\b 와 C:\a-b). 짧은 해시를 붙여 구분한다
function sanitizeProjectPath(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${legacyProjectDirName(projectPath) || 'project'}-${digest}`;
}

function legacyProjectDirName(projectPath: string): string {
  return normalizeProjectPath(projectPath)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeProjectPath(projectPath: string): string {
  return resolve(projectPath).replace(/^[A-Z]:/, match => match.toLowerCase());
}

function sessionIdFromPath(sessionPath: string): string | undefined {
  const name = sessionPath.split(/[\\/]/).at(-1);
  return name?.endsWith(TRANSCRIPT_EXTENSION)
    ? name.slice(0, -TRANSCRIPT_EXTENSION.length)
    : undefined;
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.uuid === 'string' &&
    typeof entry.sessionId === 'string' &&
    typeof entry.timestamp === 'string' &&
    typeof entry.type === 'string' &&
    ['clear', 'compact', 'config', 'message', 'mode', 'model', 'name', 'row', 'usage'].includes(
      entry.type,
    )
  );
}

// 예전 세션 파일에 남은 행 중 지금 모르는 역할(없어진 기능이 쓰던 역할 등)은 여기서 걸러져 복원하지 않고 건너뛴다
function isTranscriptRole(value: unknown): value is SessionTranscriptRole {
  return (
    typeof value === 'string' &&
    ['assistant', 'compact', 'error', 'stop', 'system', 'user'].includes(value)
  );
}

function isModelRole(value: unknown): value is 'assistant' | 'user' {
  return value === 'assistant' || value === 'user';
}

// 파일에서 읽은 toolCalls 항목 중 필수 필드가 온전한 것만 복원함.
// 이미지는 imageRefs(파일 이름)로 저장돼 있어 여기서 다시 data URL로 되살린다.
// imageRefs가 없던 시절의 세션은 그대로 이미지 없이 복원된다
function sanitizeToolCalls(
  value: unknown,
  sessionPath: string,
  sessionId: string,
): SessionToolCall[] {
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[])
    .filter(call => call && typeof call === 'object')
    .filter(call => typeof call.id === 'string' && typeof call.name === 'string')
    .map(call => {
      const images = loadSessionImages(
        sessionPath,
        sessionId,
        Array.isArray(call.imageRefs) ? (call.imageRefs as string[]) : undefined,
      );
      // 서브에이전트의 자식 호출도 같은 규칙으로 되살린다
      const children = Array.isArray(call.children)
        ? sanitizeToolCalls(call.children, sessionPath, sessionId)
        : [];
      return {
        ...(call.blocked === true ? { blocked: true } : {}),
        ...(children.length ? { children } : {}),
        id: String(call.id),
        ...(images.length ? { images } : {}),
        input:
          call.input && typeof call.input === 'object'
            ? (call.input as Record<string, unknown>)
            : {},
        name: String(call.name),
        ok: call.ok !== false,
        result: String(call.result ?? ''),
      };
    });
}

function sanitizeAgentReport(
  value: unknown,
  sessionPath: string,
  sessionId: string,
): SessionAgentReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const report = value as Record<string, unknown>;
  if (typeof report.callId !== 'string') return undefined;
  return {
    callId: report.callId,
    children: sanitizeToolCalls(report.children, sessionPath, sessionId),
    ok: report.ok !== false,
    text: String(report.text ?? ''),
  };
}

function formatDateTime(value: Date): string {
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, '0');
  const dd = String(value.getDate()).padStart(2, '0');
  const hh = String(value.getHours()).padStart(2, '0');
  const min = String(value.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
