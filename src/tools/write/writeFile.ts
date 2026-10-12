import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { loadEsbuild } from './esbuildLoader.ts';
import { markFileRead, wasFileRead } from '../read/readFile.ts';
import { markFileCreatedByAgent, wasFileCreatedByAgent } from '../createdFiles.ts';
import { isInAgentTmp } from '../agentWorkspace.ts';
import { approvalClassify, approvalConfirm, approvalNotice, registerTool } from '../registry.ts';
import { getWorkdir } from '../../agent/workdir.ts';
import { sensitivePathReason, sensitiveWritePathReason } from '../sensitivePaths.ts';
import { errorMessage } from '../../utils/errors.ts';

// 생성은 텍스트 파일 전체 허용하되, 텍스트로 쓰면 깨지는 바이너리 포맷만 거부.
// 삭제는 확장자가 아니라 승인 단계(deleteApproval)에서 대상을 보고 가린다
const BINARY_CREATE_EXTENSIONS = new Set([
  '.7z', '.dll', '.doc', '.docx', '.exe', '.gif', '.gz', '.hwp', '.hwpx',
  '.ico', '.jpeg', '.jpg', '.pdf', '.png', '.ppt', '.pptx', '.tar', '.webp',
  '.xls', '.xlsx', '.zip',
]);
const MAX_WRITE_BYTES = 1_000_000;
const DESKTOP_ALIASES = new Set(['desktop', '바탕화면', '바탕 화면']);

const execFileAsync = promisify(execFile);

let cachedWindowsDesktopPath: string | null | undefined;

export type FileCreateResult = {
  bytes: number;
  path: string;
};

export type FileDeleteResult = {
  path: string;
};

export type FileEditResult = {
  bytes: number;
  path: string;
  syntaxChecked: boolean;
};

/**
 * 이중 이스케이프된 내용인지 판정.
 *
 * 모델이 도구 인자를 JSON으로 만들 때 이스케이프를 두 번 적용하면, 파싱 후에도
 * `\n`과 `\"`가 글자 그대로 남는다. 그대로 저장하면 파일 전체가 한 줄이 되고
 * 따옴표마다 역슬래시가 붙어 못 쓰는 파일이 된다.
 *
 * 조건을 좁게 잡아 오탐을 막는다 — 진짜 줄바꿈이 하나도 없고, 길고, `\n`이
 * 여러 번 나오는 경우만. 압축된 한 줄짜리 파일은 보통 이 길이에서 `\n`을
 * 두 번 이상 담지 않는다.
 */
export function isLikelyDoubleEscaped(content: string): boolean {
  const text = String(content ?? '');
  if (text.includes('\n')) return false;
  if (text.length < 200) return false;

  const literalNewlines = text.match(/\\n/g)?.length ?? 0;
  return literalNewlines >= 2;
}

/**
 * 이중 이스케이프된 내용을 되돌려서 저장 가능한 형태로 만든다.
 *
 * 예전에는 거부하고 모델에게 다시 보내게 했다. 그런데 이게 복구 불가능한
 * 무한루프를 만들었다 — 모델이 큰 코드 파일을 이스케이프 없이 다시 보내는 데
 * 반복 실패하면, 결국 도구 호출 자체를 포기하고 "만들겠습니다"라는 말만
 * 반복하는 상태로 무너졌다. 거부보다 되돌려 저장하는 편이 실제로 루프를 푼다.
 *
 * 되돌리기는 `isLikelyDoubleEscaped`가 참일 때만 한다 — 진짜 줄바꿈이 하나도
 * 없는, 명백히 깨진 내용에만 손대므로 정상 코드(`"a\nb"`)는 건드리지 않는다.
 * 한 번에 훑는 정규식이라 `\\`(역슬래시 이스케이프)도 왼쪽부터 두 글자씩
 * 소비해 올바르게 처리된다.
 */
export function repairDoubleEscaped(content: string): string {
  const text = String(content ?? '');
  if (!isLikelyDoubleEscaped(text)) return text;

  return text.replace(/\\(["\\/bfnrt])/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      default:
        return ch; // \" → " , \\ → \ , \/ → /
    }
  });
}

export function createFileTool(filePath: string, content: string): FileCreateResult {
  const abs = resolveWritePath(filePath);
  const extension = extname(abs).toLowerCase();
  if (BINARY_CREATE_EXTENSIONS.has(extension)) {
    throw new Error(`바이너리 포맷은 텍스트로 생성할 수 없습니다: ${extension}`);
  }

  // 이중 이스케이프된 내용은 거부하지 않고 되돌려서 저장한다 (무한루프 방지)
  const body = repairDoubleEscaped(content);

  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`파일 내용이 너무 큽니다 (최대 1MB): ${filePath}`);
  }

  if (existsSync(abs)) {
    throw new Error(`이미 존재하는 파일입니다: ${filePath}`);
  }

  // TS/JS는 깨진 코드가 저장되지 않도록 쓰기 전에 구문 검사 (edit_file과 동일 기준)
  const syntaxError = checkSyntax(abs, body);
  if (syntaxError) {
    throw new Error(`생성할 내용에 구문 오류가 있습니다. 고쳐서 다시 시도하세요:\n${syntaxError}`);
  }

  ensureParentDirectory(abs);
  writeFileSync(abs, body, 'utf8');
  markFileCreatedByAgent(abs);

  return { bytes, path: abs };
}

export function deleteFileTool(filePath: string): FileDeleteResult {
  const abs = resolveWritePath(filePath);

  if (!existsSync(abs)) {
    throw new Error(`파일을 찾을 수 없습니다: ${filePath}`);
  }

  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`파일이 아닙니다: ${filePath}`);
  }

  unlinkSync(abs);
  return { path: abs };
}

/**
 * 파일의 일부를 문자열 치환으로 수정함.
 * - read_file로 원본을 읽은 파일만 수정 가능 (내용을 모른 채 수정하는 것 방지)
 * - old_string은 파일에서 정확히 한 번만 일치해야 함
 * - TS/JS 파일은 구문 검사를 통과해야 저장됨 (실패 시 파일을 건드리지 않음)
 */
export function editFileTool(filePath: string, oldString: string, newString: string): FileEditResult {
  if (!filePath?.trim()) {
    throw new Error('파일 경로가 비어 있습니다.');
  }
  if (!oldString) {
    throw new Error('old_string이 비어 있습니다. 교체할 원본 텍스트를 지정하세요.');
  }

  // 이중 이스케이프된 내용은 거부하지 않고 되돌린다 (create_file과 동일)
  const newText = repairDoubleEscaped(newString);

  // create_file·delete_file과 같은 경로 처리를 거침 (UNC 차단, 바탕화면 별칭)
  const abs = resolveWritePath(filePath);

  if (!existsSync(abs)) {
    throw new Error(`파일을 찾을 수 없습니다: ${filePath}`);
  }

  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`파일이 아닙니다: ${filePath}`);
  }

  if (!wasFileRead(abs)) {
    throw new Error(`수정하기 전에 read_file로 원본을 먼저 읽어야 합니다: ${abs}`);
  }

  const original = readFileSync(abs, 'utf8');
  let occurrences = original.split(oldString).length - 1;
  let matchPattern: string | RegExp = oldString;
  let replacementText = newText;

  // Windows에서 만들어진 CRLF 파일을 대상으로, 모델이 LF만 든 old_string을 그대로
  // 보내는 일이 흔하다 — read_file은 \r을 그대로 돌려주지만 화면에 보이지 않아
  // 옮겨 적을 때 빠뜨린다. 정확히 일치하는 자리가 없으면 old_string의 개행을
  // \r?\n으로 보는 정규식으로 한 번 더 찾는다. 정규식으로 원본에서 직접 찾으므로
  // 파일에 CRLF와 LF가 섞여 있어도 그 자리에 실제로 있는 개행을 그대로 쓰고,
  // (앞서 검토했던 "전체를 LF로 맞춘 뒤 다시 CRLF로 되돌리는" 방식과 달리) 자리를
  // 잘못 찾거나 조용히 아무것도 안 바꾸는 일이 없다
  if (occurrences === 0 && oldString.includes('\n') && !oldString.includes('\r')) {
    const pattern = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n');
    const matches = original.match(new RegExp(pattern, 'g'));
    if (matches) {
      occurrences = matches.length;
      if (occurrences === 1) {
        matchPattern = new RegExp(pattern);
        // 그 자리에 실제로 있던 개행이 CRLF면 새로 넣는 내용도 맞춰 CRLF로 쓴다
        if (matches[0].includes('\r\n')) replacementText = newText.replace(/\n/g, '\r\n');
      }
    }
  }

  if (occurrences === 0) {
    throw new Error('old_string이 파일 내용과 일치하지 않습니다. read_file로 다시 확인하고 파일에 있는 그대로 지정하세요.');
  }
  if (occurrences > 1) {
    throw new Error(`old_string이 파일에서 ${occurrences}곳과 일치합니다. 주변 내용을 포함해 한 곳만 일치하도록 더 길게 지정하세요.`);
  }

  const next = original.replace(matchPattern, replacementText);
  const bytes = Buffer.byteLength(next, 'utf8');
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`수정 후 파일이 너무 큽니다 (최대 1MB): ${filePath}`);
  }

  // 쓰고 나서 검사하고 되돌리는 순서였으면, 그 사이에 프로세스가 죽을 때
  // 깨진 내용만 남는다. 검사를 통과한 뒤에 한 번만 쓴다
  const syntaxError = checkSyntax(abs, next);
  if (syntaxError) {
    throw new Error(`수정 결과에 구문 오류가 있어 파일을 그대로 두었습니다. 오류를 고쳐 다시 시도하세요:\n${syntaxError}`);
  }

  writeFileSync(abs, next, 'utf8');

  return {
    bytes,
    path: abs,
    syntaxChecked: extname(abs).toLowerCase() in SYNTAX_LOADERS,
  };
}

// TS/JS 계열만 esbuild로 구문 검사함 (타입 오류가 아닌 파싱 오류 검출)
const SYNTAX_LOADERS: Record<string, 'js' | 'jsx' | 'ts' | 'tsx'> = {
  '.cjs': 'js',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.mts': 'ts',
  '.ts': 'ts',
  '.tsx': 'tsx',
};

/** 검사기 장애 경고는 한 번만. esbuild 서비스는 한 번 죽으면 앱을 다시 켤 때까지 계속 실패한다 */
let syntaxCheckerWarned = false;

function checkSyntax(absPath: string, code: string): string | null {
  const loader = SYNTAX_LOADERS[extname(absPath).toLowerCase()];
  if (!loader) return null;

  try {
    loadEsbuild().transformSync(code, { loader });
    return null;
  } catch (error) {
    const buildErrors = (error as { errors?: { text?: string }[] })?.errors;
    if (Array.isArray(buildErrors) && buildErrors.length > 0) {
      return buildErrors.map(e => String(e?.text ?? e)).join('\n');
    }
    // 구문 오류 목록이 없으면 코드가 아니라 검사기가 실패한 것이다 (실행 파일을 못
    // 찾음, 서비스 종료). 구문 검사는 보조 장치지 저장 조건이 아니므로 건너뛴다 —
    // 막으면 멀쩡한 코드까지 앱을 다시 켤 때까지 저장이 안 된다
    if (!syntaxCheckerWarned) {
      syntaxCheckerWarned = true;
      console.warn(`[syntax-check] 검사기를 쓸 수 없어 구문 검사를 건너뜁니다: ${errorMessage(error)}`);
    }
    return null;
  }
}

// 경로 정규화 공통 처리: 홈(~)·바탕화면 별칭 확장, UNC 차단, 절대 경로 변환
function resolveWritePath(filePath: string): string {
  if (!filePath?.trim()) {
    throw new Error('파일 경로가 비어 있습니다.');
  }

  const expandedPath = expandHomePath(resolveDesktopPathAlias(filePath.trim()));
  if (expandedPath.startsWith('\\\\') || expandedPath.startsWith('//')) {
    throw new Error(`UNC 네트워크 경로는 처리할 수 없습니다: ${filePath}`);
  }

  return resolveWindowsDesktopGuess(resolve(getWorkdir(), expandedPath));
}

function expandHomePath(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return join(homedir(), filePath.slice(2));
  }
  return filePath;
}

function ensureParentDirectory(filePath: string): void {
  const parent = dirname(filePath);
  if (existsSync(parent)) {
    const stat = statSync(parent);
    if (!stat.isDirectory()) {
      throw new Error(`상위 경로가 디렉터리가 아닙니다: ${parent}`);
    }
    return;
  }

  mkdirSync(parent, { recursive: true });
}

function resolveDesktopPathAlias(filePath: string): string {
  const desktopPath = getWindowsDesktopPath();
  if (!desktopPath) return filePath;

  const [firstSegment, ...rest] = filePath.split(/[\\/]/);
  if (!DESKTOP_ALIASES.has(firstSegment.toLowerCase())) return filePath;

  return join(desktopPath, ...rest);
}

function resolveWindowsDesktopGuess(absPath: string): string {
  const desktopPath = getWindowsDesktopPath();
  if (!desktopPath) return absPath;

  const defaultDesktopPath = resolve(homedir(), 'Desktop');
  const rel = relative(defaultDesktopPath, absPath);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return join(desktopPath, rel);
  }

  return absPath;
}

/**
 * 바탕화면 경로 캐시를 미리 채움. 앱 시작 시 호출한다.
 *
 * 캐시가 비어 있으면 첫 파일 쓰기에서 powershell을 동기로 띄우느라(최대 5초)
 * 메인 스레드가 멈춘다. 시작 직후 비동기로 한 번 구해두면 그 지연이 사라진다.
 */
export async function warmWindowsDesktopPath(): Promise<void> {
  if (process.platform !== 'win32' || cachedWindowsDesktopPath !== undefined) return;

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)',
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const output = stdout.trim();
    if (output) cachedWindowsDesktopPath = output;
  } catch {
    // 실패하면 캐시를 비워 둔 채로 두고, 필요 시 기존 동기 경로가 처리함
  }
}

function getWindowsDesktopPath(): string | null {
  if (process.platform !== 'win32') return null;
  if (cachedWindowsDesktopPath !== undefined) return cachedWindowsDesktopPath;

  cachedWindowsDesktopPath = getWindowsDesktopPathFromKnownFolder();
  if (cachedWindowsDesktopPath) return cachedWindowsDesktopPath;

  cachedWindowsDesktopPath = getWindowsDesktopPathFromEnvironment();
  if (cachedWindowsDesktopPath) return cachedWindowsDesktopPath;

  cachedWindowsDesktopPath = null;
  return cachedWindowsDesktopPath;
}

function getWindowsDesktopPathFromKnownFolder(): string | null {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)',
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

function getWindowsDesktopPathFromEnvironment(): string | null {
  const candidates = [
    process.env.OneDrive,
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
    process.env.USERPROFILE,
    homedir(),
  ]
    .filter((base): base is string => Boolean(base))
    .map(base => join(base, 'Desktop'));

  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

/**
 * create_file·edit_file 승인 판정. 경로는 실행할 때와 같은 resolveWritePath로
 * 푼다 — 판정과 실행이 다르게 풀면(~, 바탕화면 별칭) 판정을 통과한 경로와 실제로
 * 쓰는 경로가 달라진다.
 *
 *   1. 자격증명·셸 시작 파일·.git·앱 설정: confirm. 써 넣는 순간 다음 실행 때
 *      코드가 돌거나 자격증명이 바뀐다 (sensitiveWritePathReason)
 *   2. 작업 폴더 밖: classify. 사용자가 그 위치를 말했는지 분류기가 본다
 *   3. 작업 폴더 안: 사유 없음. 에이전트 작업 폴더(.newbie)도 작업 폴더 안이다
 */
export function writeApproval(path: unknown) {
  let abs: string;
  try {
    abs = resolveWritePath(String(path ?? ''));
  } catch {
    // 빈 경로·UNC는 실행 단계에서 같은 오류로 거부된다
    return null;
  }

  const sensitive = sensitiveWritePathReason(abs);
  if (sensitive) return approvalConfirm(`${sensitive} (쓰려고 합니다)`);

  const inside = relative(getWorkdir(), abs);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return approvalClassify(`작업 폴더 밖에 씁니다: ${abs}`);
  }
  return null;
}

registerTool({
  name: 'create_file',
  kind: 'write',
  approvalGate: ({ path }) => writeApproval(path),
  description: '텍스트 파일을 생성합니다 (코드 파일 포함, PDF·이미지 등 바이너리 포맷 제외). TS/JS는 생성 전 구문 검사를 통과해야 합니다. 상대 경로는 현재 작업 디렉터리 기준이며, Windows의 Desktop/바탕화면 경로는 OS가 알려주는 실제 Desktop 폴더를 사용합니다. 기존 파일은 덮어쓰지 않습니다.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '생성할 텍스트 파일 경로' },
      content: { type: 'string', description: '파일에 쓸 UTF-8 텍스트 내용' },
    },
    required: ['path', 'content'],
  },
  execute({ path, content }) {
    const result = createFileTool(path, content ?? '');
    // 방금 생성한 파일은 내용을 이미 알고 있으므로 read_file 없이 바로 수정 가능
    markFileRead(result.path);
    return [
      `파일을 생성했습니다: ${result.path}`,
      `크기: ${result.bytes}바이트`,
    ].join('\n');
  },
});

registerTool({
  name: 'edit_file',
  kind: 'write',
  approvalGate: ({ path }) => writeApproval(path),
  description: '기존 파일의 일부를 수정합니다. 반드시 read_file로 원본을 먼저 읽은 뒤, 파일에 있는 그대로의 old_string을 new_string으로 교체하세요. old_string은 파일에서 정확히 한 번만 일치해야 하며, 필요한 최소 범위만 수정하세요. TS/JS 파일은 구문 검사를 통과해야 저장되며, 실패하면 파일이 그대로 유지됩니다.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '수정할 파일 경로' },
      old_string: { type: 'string', description: '교체할 원본 텍스트. 파일 내용과 정확히 일치해야 하고, 파일에서 한 번만 나타나야 함' },
      new_string: { type: 'string', description: '교체 후 텍스트' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute({ path, old_string, new_string }) {
    const result = editFileTool(path, old_string, new_string ?? '');
    return [
      `파일을 수정했습니다: ${result.path}`,
      `크기: ${result.bytes}바이트`,
      result.syntaxChecked ? '구문 검사: 통과' : '',
    ]
      .filter(Boolean)
      .join('\n');
  },
});

/**
 * 삭제 승인 판정.
 *
 * 예전에는 대상과 무관하게 사유를 붙였다. 그래서 자동 모드에서 임시 파일 하나
 * 지울 때마다 창이 떴고, 무인 실행이 불가능했다(이 이유로 판정 순서
 * 변경을 되돌렸다).
 *
 * 대상을 보고 등급을 나눈다.
 *   1. 자격증명 파일: confirm. 자동 모드에서도 사람 손을 거친다
 *   2. 에이전트가 만든 파일: notice. 되돌릴 사용자 자료가 없다. 이 프로세스에서
 *      create_file로 만든 파일(createdFiles.ts)과 임시 폴더 안의 파일(agentWorkspace.ts)
 *   3. 그 밖: classify. 자동 모드에서는 분류기가 사용자가 지우라고 했는지를 보고
 *      정하고, 다른 모드에서는 사람에게 묻는다
 *
 * 확장자는 보지 않는다. 예전의 .txt/.md/.pdf 허용목록은 에이전트가 run_command로
 * 만든 .py 같은 임시 파일을 승인과 무관하게 못 지우게 막았다. 누가 만들었는지를
 * 정확히 알 수 있는 것은 create_file뿐이라, 그 밖의 임시 파일은 위치로 가린다.
 */
export function deleteApproval(path: unknown) {
  const text = String(path ?? '').trim();
  if (!text) return approvalConfirm('삭제 대상 경로가 비어 있습니다.');

  // 실행(deleteFileTool)과 같은 방식으로 푼다. 따로 풀면 ~나 바탕화면 별칭이
  // 판정에서는 작업 폴더 안의 이름으로, 실행에서는 홈 아래 파일로 풀린다
  let abs: string;
  try {
    abs = resolveWritePath(text);
  } catch {
    return null;
  }

  const sensitive = sensitivePathReason(abs);
  if (sensitive) return approvalConfirm(`${sensitive} (삭제하려고 합니다)`);

  if (wasFileCreatedByAgent(abs) || isInAgentTmp(abs)) {
    return approvalNotice(`에이전트가 만든 파일을 삭제합니다: ${abs}`);
  }

  const inside = relative(getWorkdir(), abs);
  const where = inside.startsWith('..') || isAbsolute(inside) ? '작업 폴더 밖의 ' : '';
  return approvalClassify(`${where}에이전트가 만들지 않은 파일을 삭제합니다 (되돌릴 수 없음): ${abs}`);
}

registerTool({
  name: 'delete_file',
  kind: 'write',
  // 드물게 쓰고 run_command로도 되는 도구라 매 요청의 목록에 싣지 않는다. 시그니처는
  // 지연 도구 안내에 실린다 (prompt.ts). 대체가 없는 도구는 목록에 둔다 — 작은 모델은
  // 목록에 없는 도구를 시그니처만 보고는 부르지 않는 것이 실측됐다
  deferred: true,
  // 자격증명은 늘 확인, 에이전트가 만든 파일은 통과, 그 밖은 분류기 판정 (deleteApproval)
  approvalGate: ({ path }) => deleteApproval(path),
  description: '파일을 삭제합니다. 상대 경로는 현재 작업 디렉터리 기준이며, Windows의 Desktop/바탕화면 경로는 OS가 알려주는 실제 Desktop 폴더를 사용합니다. 디렉터리는 삭제하지 않습니다.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '삭제할 파일 경로' },
    },
    required: ['path'],
  },
  execute({ path }) {
    const result = deleteFileTool(path);
    return `파일을 삭제했습니다: ${result.path}`;
  },
});
