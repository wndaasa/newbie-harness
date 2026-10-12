import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { runProviderText } from '../providers/index.ts';
import {
  getInsightsBaseDir,
  getLogsBaseDir,
  getMemoryBaseDir,
  getMemoryIndexPath,
  getPolicyPath,
} from './paths.ts';
import { appendPendingQuestions, type NewQuestion } from './questions.ts';
import { parseFrontmatter, scanTopicFiles } from './scan.ts';
import { isValidSlug, resolveInside } from './slug.ts';
import type { MemoryType, QuestionKind } from './types.ts';
import type { Session } from '../session/types.ts';

export type TopicEntry = {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  source: 'confirmed' | 'inferred';
};

type InsightEntry = {
  name: string;
  description: string;
  body: string;
};

export type DistillResult = {
  summary: string;
  topicsWritten: number;
  insightsWritten: number;
  questionsQueued: number;
};

const FACTUAL_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
const QUESTION_KINDS: QuestionKind[] = [
  'stale-memory',
  'topic-confirm',
  'pattern-why',
];
const MAX_QUESTIONS_PER_DREAM = 3;

const DISTILL_SYSTEM_PROMPT = `당신은 대화 로그 분석 전문가입니다.
주어진 대화 로그를 분석하여 사용자에 대한 유용한 정보를 JSON으로 반환하세요.

memories 타입 (factual — 로그에서 직접 확인되는 사실):
- user: 사용자 역할, 목표, 지식 수준, 선호 방식
- feedback: 작업 방식 피드백 — 해야 할 것·하지 말아야 할 것
- project: 진행 중인 작업, 결정 사항, 데드라인
- reference: 외부 시스템 포인터 (대시보드, 이슈 트래커 등)

insights (추론 — 여러 로그에 걸쳐 관찰된 반복 패턴, 사용자 상태, 프로젝트 흐름):
- 근거가 두 번 이상 관찰될 때만 만드세요.
- 사실이 아닌 해석임이 드러나게 관찰 근거를 본문에 함께 적으세요.

questions (사용자 확인 질문, 최대 3개):
- stale-memory: 오래 갱신되지 않은 topic을 제거할지, 요약해 보관할지 확인
- topic-confirm: 새로 만들거나 갱신한 topic의 분류·맥락이 사용자 생각과 맞는지 확인
- pattern-why: 반복해서 나타나는 내용이 왜 반복되는지 질문
- 확인할 것이 없으면 빈 배열을 반환하세요. 억지로 만들지 마세요.
- 질문은 사용자에게 직접 묻는 자연스러운 한국어 한 문장으로 쓰세요.

규칙:
- 의미 있는 패턴이 있을 때만 항목을 만드세요. 없으면 빈 배열을 반환하세요.
- 사용자 메모리 정책이 주어지면 무엇을 유지·요약·제거할지 판단에 최우선으로 반영하세요.

memories에 저장하면 안 되는 것 (제외 대상):
- 작업 디렉터리, 파일 경로, OS, 현재 날짜/시간처럼 세션·환경마다 달라지는 정보. 이런 값은 매 실행 시 다시 계산되므로 기억할 필요가 없고, 오래되면 오히려 틀린 정보가 된다.
- 코드에서 그대로 확인 가능한 내용(파일 구조, 함수 목록, 라이브러리 버전 등).
- 이번 대화에서만 의미 있는 일회성 작업 상태.

추측 금지 (memories 기준):
- 로그에 명시적으로 드러나지 않은 내용을 만들어내지 마세요. 사용자가 직접 말했거나 대화 흐름에서 명확히 확인되는 것만 기록하세요.
- 확실한 근거가 없으면 항목 자체를 만들지 마세요. "아마도", "~인 듯" 같은 추측을 사실처럼 적지 마세요 — 그런 내용은 memories가 아니라 insights로 분류하세요.
- 각 memories 항목의 "source"에 근거 수준을 표시하세요: 사용자가 명시적으로 말하거나 확정한 사실은 "confirmed", 대화 맥락에서 모델이 유추한 내용은 "inferred". (insights는 정의상 항상 추론이므로 source를 따로 표시하지 않습니다.)

정정 처리:
- 로그 안에서 사용자가 이전 발언을 스스로 정정한 경우("아니 그게 아니라", "정정할게" 등), 정정된 최신 내용만 반영하고 이전의 잘못된 내용은 버리세요.

기존 topic 파일이 주어지면 병합 규칙:
- 같은 주제는 기존 name(slug)을 그대로 사용해 갱신하세요.
- 기존 본문에서 여전히 유효한 내용은 보존하고 새 맥락을 병합한 전체 본문을 반환하세요. 단순 대체가 아니라 누적 갱신입니다. 단, 새 로그에서 정정된 내용은 기존 본문보다 우선합니다.
- 새 로그와 무관하고 갱신할 내용이 없는 topic은 반환하지 마세요.

JSON only (다른 텍스트 없이):
{"memories":[{"name":"kebab-case-slug","description":"한 줄 설명 (50자 이내)","type":"user|feedback|project|reference","body":"항목 내용 (한국어, 3-5줄)","source":"confirmed|inferred"}],"insights":[{"name":"kebab-case-slug","description":"한 줄 설명 (50자 이내)","body":"관찰된 패턴과 근거 (한국어, 3-5줄)"}],"questions":[{"kind":"stale-memory|topic-confirm|pattern-why","text":"사용자에게 물을 질문","relatedTopic":"관련 topic slug 또는 빈 문자열"}]}`;

const DISTILLED_MARKER = '<!-- distilled -->';

// 사용자가 직전 발언을 스스로 정정하는 패턴. 감지되면 다음 /distill을 기다리지 않고
// 그 자리에서 바로 재정제해 잘못된 내용이 메모리에 남는 기간을 최소화한다.
const CORRECTION_RE = /아니\s*(그게|저게|그거)?\s*아니|정정할게|정정합니다|틀렸|다시 말하면|아 잘못/;

export function isCorrectionMessage(text: string): boolean {
  return CORRECTION_RE.test(text);
}

// 마지막 distilled 마커 이후의 내용만 미정제로 취급한다.
// 정제 후 같은 날 대화가 이어져 마커 뒤에 로그가 append되면 그 부분은 다시 정제 대상이 된다.
function unprocessedPart(content: string): string {
  const idx = content.lastIndexOf(DISTILLED_MARKER);
  return idx === -1 ? content : content.slice(idx + DISTILLED_MARKER.length);
}

function collectRecentLogPaths(days: number): string[] {
  const logsBase = getLogsBaseDir();
  const today = new Date();
  const paths: string[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const yyyy = date.getFullYear().toString();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const logPath = join(logsBase, yyyy, mm, `${yyyy}-${mm}-${dd}.md`);
    if (existsSync(logPath)) paths.push(logPath);
  }

  return paths;
}

// logs/ 하위의 모든 일별 로그 .md 파일을 재귀적으로 수집
function listAllLogPaths(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(p);
    }
  };
  walk(getLogsBaseDir());
  return out.sort();
}

// 마지막 마커 이후에 분석할 내용이 남은 로그 파일인지
function isUnprocessedLog(path: string): boolean {
  try {
    const content = readFileSync(path, 'utf8');
    const filtered = unprocessedPart(content)
      .split('\n')
      .filter(filterLogLine)
      .join('\n')
      .trim();
    return filtered.length > 0;
  } catch {
    return false;
  }
}

// 자동 정리 트리거 판단용: 누적된 미정리 로그 파일 수
export function countUnprocessedLogFiles(): number {
  return listAllLogPaths().filter(isUnprocessedLog).length;
}

// [코드] 플레이스홀더만 있는 줄, 극단적으로 짧거나 반복되는 어시스턴트 응답 제거
function filterLogLine(line: string): boolean {
  if (!line.startsWith('- ')) return true;
  // assistant 행이 [코드] 덩어리만 있으면 제외
  const body = line.replace(/^- \d{2}:\d{2} \w+: /, '');
  if (/^(\[코드\]\s*)+…?$/.test(body)) return false;
  // 10자 미만 내용은 노이즈
  if (body.trim().length < 10) return false;
  return true;
}

// 미정제 내용과, 실제로 내용을 제공한 파일 목록을 함께 반환.
// 마커는 내용을 제공한 파일에만 찍어 마커 중복 누적을 막는다.
function readUnprocessedLogs(paths: string[]): {
  content: string;
  contributedPaths: string[];
} {
  const parts: string[] = [];
  const contributedPaths: string[] = [];
  for (const p of paths) {
    try {
      const content = readFileSync(p, 'utf8');
      const filtered = unprocessedPart(content)
        .split('\n')
        .filter(filterLogLine)
        .join('\n')
        .trim();
      if (filtered) {
        parts.push(filtered);
        contributedPaths.push(p);
      }
    } catch {
      // 읽기 실패 무시
    }
  }
  return { content: parts.join('\n\n'), contributedPaths };
}

// 기존 topic 본문을 LLM 병합 입력으로 직렬화. 토큰 폭증 방지를 위해 topic당 줄 수 제한.
const MAX_EXISTING_TOPIC_LINES = 60;

function formatExistingTopics(): string {
  const topics = scanTopicFiles(getMemoryBaseDir());
  if (topics.length === 0) return '';

  return topics
    .map(t => {
      const body = t.body
        .split(/\r?\n/)
        .slice(0, MAX_EXISTING_TOPIC_LINES)
        .join('\n')
        .trim();
      const meta = [
        `type: ${t.frontmatter.type ?? ''}`,
        `description: ${t.frontmatter.description ?? ''}`,
      ].join(' | ');
      return `### ${t.slug}\n${meta}\n${body}`;
    })
    .join('\n\n');
}

type DistillOutput = {
  memories: TopicEntry[];
  insights: InsightEntry[];
  questions: NewQuestion[];
};

const EMPTY_OUTPUT: DistillOutput = { memories: [], insights: [], questions: [] };

function parseDistillOutput(llmOutput: string): DistillOutput {
  const jsonMatch = llmOutput.match(/\{[\s\S]*"memories"[\s\S]*\}/);
  if (!jsonMatch) return EMPTY_OUTPUT;

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const memories = (Array.isArray(parsed.memories) ? parsed.memories : [])
      .filter(
        (m: TopicEntry) =>
          isValidSlug(m.name) && m.description && m.body && FACTUAL_TYPES.includes(m.type),
      )
      // source가 없거나 값이 이상하면 안전하게 inferred로 취급 (근거 불명을 확정으로 오인하지 않도록)
      .map((m: TopicEntry) => ({
        ...m,
        source: m.source === 'confirmed' ? 'confirmed' : 'inferred',
      }));

    const insights = (Array.isArray(parsed.insights) ? parsed.insights : []).filter(
      (i: InsightEntry) => isValidSlug(i.name) && i.description && i.body,
    );

    const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .filter(
        (q: NewQuestion) =>
          q.text && QUESTION_KINDS.includes(q.kind as QuestionKind),
      )
      .slice(0, MAX_QUESTIONS_PER_DREAM);

    return { memories, insights, questions };
  } catch {
    return EMPTY_OUTPUT;
  }
}

function todayStamp(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

export function writeTopicFile(entry: TopicEntry, baseDir: string): void {
  mkdirSync(baseDir, { recursive: true });
  const filePath = resolveInside(baseDir, `${entry.name}.md`);
  const today = todayStamp();

  // 갱신 시 최초 생성일은 보존. source는 이번 판단을 기본으로 하되,
  // 한 번 confirmed로 확인된 사실은 이후 inferred 판단으로 다시 낮추지 않음
  let created = today;
  let source = entry.source;
  if (existsSync(filePath)) {
    try {
      const { frontmatter } = parseFrontmatter(readFileSync(filePath, 'utf8'));
      if (frontmatter.created) created = frontmatter.created;
      if (frontmatter.source === 'confirmed') source = 'confirmed';
    } catch {
      // 기존 파일 파싱 실패 시 새 파일로 취급
    }
  }

  const content = [
    '---',
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    `created: ${created}`,
    `updated: ${today}`,
    `source: ${source}`,
    '---',
    '',
    entry.body.trim(),
    '',
  ].join('\n');
  writeFileSync(filePath, content, 'utf8');
}

export type IndexItem = {
  name: string;
  description: string;
  link: string; // 인덱스 기준 상대 경로 예: name.md, insights/name.md
};

export function updateMemoryIndex(items: IndexItem[], indexPath: string): void {
  const existing = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8')
    : '';

  // 기존 항목을 링크 경로(확장자 제외) 키로 맵에 저장
  const indexMap = new Map<string, string>();
  for (const line of existing.split('\n')) {
    const slugMatch = line.match(/\(([^)]+)\.md\)/);
    if (slugMatch) indexMap.set(slugMatch[1], line);
  }

  // 새 항목으로 덮어쓰기 또는 추가
  for (const item of items) {
    indexMap.set(
      item.link.replace(/\.md$/, ''),
      `- [${item.name}](${item.link}) — ${item.description}`,
    );
  }

  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, [...indexMap.values()].join('\n') + '\n', 'utf8');
}

function markDistilled(paths: string[]): void {
  for (const p of paths) {
    try {
      appendFileSync(p, '\n<!-- distilled -->\n', 'utf8');
    } catch {
      // 마커 추가 실패는 무시
    }
  }
}

// /distill 수동 호출: 최근 N일 로그를 정리
export async function distillLogs(
  session: Session,
  days: number = 7,
): Promise<DistillResult> {
  return distillFromPaths(session, collectRecentLogPaths(days));
}

// 자동 호출: 누적된 미정제 로그 전체를 정제 (일수 제한 없음)
export async function distillUnprocessedLogs(session: Session): Promise<DistillResult> {
  return distillFromPaths(session, listAllLogPaths());
}

// 사용자 메모리 정책. 없으면 빈 문자열 — 정책은 사용자가 직접 편집하는 파일이다.
const MAX_POLICY_LINES = 80;

function readPolicy(): string {
  const policyPath = getPolicyPath();
  if (!existsSync(policyPath)) return '';

  try {
    return readFileSync(policyPath, 'utf8')
      .split(/\r?\n/)
      .slice(0, MAX_POLICY_LINES)
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

function emptyResult(summary: string): DistillResult {
  return { summary, topicsWritten: 0, insightsWritten: 0, questionsQueued: 0 };
}

async function distillFromPaths(
  session: Session,
  logPaths: string[],
): Promise<DistillResult> {
  if (logPaths.length === 0) {
    return emptyResult('처리할 로그 파일이 없습니다.');
  }

  const { content: logsContent, contributedPaths } =
    readUnprocessedLogs(logPaths);
  if (!logsContent.trim()) {
    return emptyResult('모든 로그가 이미 처리됐거나 내용이 없습니다.');
  }

  const indexPath = getMemoryIndexPath();
  const existingIndex = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8').trim()
    : '';

  const policy = readPolicy();
  const existingTopics = formatExistingTopics();
  const userMessage = [
    policy ? `사용자 메모리 정책:\n${policy}\n\n` : '',
    existingIndex ? `기존 메모리 인덱스:\n${existingIndex}\n\n` : '',
    existingTopics ? `기존 topic 파일:\n${existingTopics}\n\n` : '',
    `대화 로그:\n${logsContent}`,
  ].join('');

  const llmOutput = await runProviderText(session, {
    messages: [{ role: 'user', content: userMessage }],
    systemPrompt: DISTILL_SYSTEM_PROMPT,
    maxTokens: 2048,
  });

  // mock 모드는 LLM 호출 없이 조기 반환
  if (!llmOutput) {
    return emptyResult('mock 모드에서는 /distill을 건너뜁니다.');
  }

  const { memories, insights, questions } = parseDistillOutput(llmOutput);
  const baseDir = getMemoryBaseDir();
  const insightsDir = getInsightsBaseDir();

  for (const entry of memories) {
    writeTopicFile(entry, baseDir);
  }
  for (const insight of insights) {
    // insight는 정의상 항상 추론된 패턴 — 사용자가 직접 확정한 사실이 아니므로 source는 고정
    writeTopicFile({ ...insight, type: 'insight', source: 'inferred' }, insightsDir);
  }

  const questionsQueued =
    questions.length > 0 ? appendPendingQuestions(questions) : 0;

  if (memories.length + insights.length > 0) {
    updateMemoryIndex(
      [
        ...memories.map(e => ({
          name: e.name,
          description: e.description,
          link: `${e.name}.md`,
        })),
        ...insights.map(i => ({
          name: i.name,
          description: i.description,
          link: `insights/${i.name}.md`,
        })),
      ],
      indexPath,
    );
  }

  // 로그 소비가 끝났으므로 체크포인트를 찍는다 (Kafka 오프셋 커밋과 같은 규칙):
  // 기준은 "무엇을 저장했는가"가 아니라 "이 로그를 분석했는가"다. 빈 결과도
  // 유효한 분석 결과이며, 다시 분석해도 같은 결과가 나온다. 저장 중 예외로
  // 빠져나간 경우에만 마커가 남지 않아 다음 시작에 재시도된다(at-least-once).
  markDistilled(contributedPaths);

  if (memories.length + insights.length + questionsQueued === 0) {
    return emptyResult('분석했지만 저장할 메모리 패턴이 발견되지 않았습니다.');
  }

  const typeCount = memories.reduce(
    (acc: Record<string, number>, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const typeSummary = Object.entries(typeCount)
    .map(([type, count]) => `${type} ${count}개`)
    .join(', ');

  const summaryParts = [
    memories.length > 0 ? `topic ${memories.length}개(${typeSummary})` : '',
    insights.length > 0 ? `insight ${insights.length}개` : '',
    questionsQueued > 0 ? `확인 질문 ${questionsQueued}개 큐 저장` : '',
  ].filter(Boolean);

  const indexNote =
    memories.length + insights.length > 0 ? ' MEMORY.md 갱신됨.' : '';

  return {
    summary: `메모리 정제 완료. ${summaryParts.join(', ')}.${indexNote}`,
    topicsWritten: memories.length,
    insightsWritten: insights.length,
    questionsQueued,
  };
}
