import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'kordoc';
import { approvalConfirm, registerTool } from '../registry.ts';
import { getWorkdir } from '../../agent/workdir.ts';
import { sensitiveReadPathReason } from '../sensitivePaths.ts';
import {
  BINARY_SCAN_BYTES,
  DEFAULT_READ_CHARS,
  DEFAULT_READ_LINES,
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  PDF_INLINE_PAGE_LIMIT,
} from './limits.ts';
import { DEFAULT_SEARCH_MATCHES, buildConvertedDocument, renderDocument } from './documentView.ts';
import type { ConvertedDocument } from './documentView.ts';
import { ocrEmbeddedImage, tesseractOcr } from '../../utils/ocr.ts';
import { getPDFPageCount, renderPDFPageToPng } from '../../utils/pdfPageRender.ts';

export type FileEntry = {
  isDirectory: boolean;
  modified: string;
  name: string;
  path: string;
  size: number;
};

export type FileReadResult = {
  content: string;
  encoding: string;
  lines: number;
  path: string;
  size: number;
};

export type FileInfoResult = {
  extension: string;
  isDirectory: boolean;
  isFile: boolean;
  modified: string;
  name: string;
  path: string;
  size: number;
};

// edit_file이 "수정 전 원본 읽기"를 강제할 수 있도록, 이번 세션에서
// 읽거나 생성한 파일의 절대 경로를 기록함. Windows는 대소문자 무시.
const readFileLog = new Set<string>();

function toReadLogKey(absPath: string): string {
  return process.platform === 'win32' ? absPath.toLowerCase() : absPath;
}

export function markFileRead(absPath: string): void {
  readFileLog.add(toReadLogKey(absPath));
}

export function wasFileRead(absPath: string): boolean {
  return readFileLog.has(toReadLogKey(absPath));
}

/**
 * 경로를 못 찾았을 때 무엇을 어떻게 찾았는지 그대로 알려 준다.
 *
 * 예전에는 "파일을 찾을 수 없습니다: app/Detail.java"만 돌려줬다. 어느
 * 폴더를 기준으로 풀었는지가 없으니, 모델은 자기가 엉뚱한 데를 찾았다는 걸
 * 알 방법이 없어 같은 상대경로로 계속 다시 시도한다. 실제로 겪은 증상이다 —
 * 직전 턴에 절대경로로 잘 읽던 파일을, 목록에서 이름만 받아 상대경로로
 * 바꿔 부르는 순간부터 "없는 파일"이 됐다.
 */
function pathErrorDetail(input: string, abs: string, code?: string): string {
  const parts = [`${code ? `${code} — ` : ''}입력: ${input}`, `찾은 위치: ${abs}`];
  if (!isAbsolute(input)) {
    parts.push(`기준 폴더: ${getWorkdir()} (상대경로는 이 폴더에서 풉니다 — 다른 폴더의 파일이라면 절대경로로 주세요)`);
  }
  return parts.join('\n');
}

/** 파일 내용을 읽어 반환함. 바이너리·1MB 초과 파일은 에러 던짐 */
export function readFileTool(filePath: string): FileReadResult {
  const abs = resolve(getWorkdir(), filePath);

  // existsSync는 참·거짓만 준다. 권한 문제(EACCES)나 경로 중간이 파일인 경우
  // (ENOTDIR)까지 "없음"으로 뭉개지므로, 실제 오류 코드를 그대로 살린다
  let stat;
  try {
    stat = statSync(abs);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const label = code === 'ENOENT' ? '파일을 찾을 수 없습니다' : '파일에 접근할 수 없습니다';
    throw new Error(`${label}\n${pathErrorDetail(filePath, abs, code)}`);
  }

  if (!stat.isFile()) {
    throw new Error(`파일이 아닙니다 (디렉터리일 수 있습니다)\n${pathErrorDetail(filePath, abs)}`);
  }

  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `파일이 너무 큽니다 (${stat.size}바이트, 최대 1MB): ${abs}`,
    );
  }

  let raw;
  try {
    raw = readFileSync(abs);
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new Error(`파일을 읽지 못했습니다\n${pathErrorDetail(filePath, abs, code)}`);
  }
  if (isBinaryBuffer(raw)) {
    throw new Error(`바이너리 파일은 읽을 수 없습니다: ${abs}`);
  }

  const content = raw.toString('utf8');
  markFileRead(abs);
  return {
    content,
    encoding: 'utf8',
    lines: content.split('\n').length,
    path: abs,
    size: stat.size,
  };
}

/** 디렉터리 안의 파일·폴더 목록을 반환함. 디렉터리 size는 0으로 고정 */
export function listFilesTool(dirPath: string): FileEntry[] {
  const abs = resolve(getWorkdir(), dirPath);

  let stat;
  try {
    stat = statSync(abs);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const label = code === 'ENOENT' ? '경로를 찾을 수 없습니다' : '경로에 접근할 수 없습니다';
    throw new Error(`${label}\n${pathErrorDetail(dirPath, abs, code)}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`디렉터리가 아닙니다\n${pathErrorDetail(dirPath, abs)}`);
  }

  return readdirSync(abs, { withFileTypes: true }).map(entry => {
    const entryPath = join(abs, entry.name);
    const entryStat = statSync(entryPath);
    return {
      isDirectory: entry.isDirectory(),
      modified: entryStat.mtime.toISOString(),
      name: entry.name,
      path: entryPath,
      size: entry.isDirectory() ? 0 : entryStat.size,
    };
  });
}

/** 파일·디렉터리의 이름, 크기, 수정일 등 메타데이터를 반환함 */
export function getFileInfoTool(filePath: string): FileInfoResult {
  const abs = resolve(getWorkdir(), filePath);

  if (!existsSync(abs)) {
    throw new Error(`경로를 찾을 수 없습니다: ${filePath}`);
  }

  const stat = statSync(abs);
  return {
    extension: extname(abs),
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    modified: stat.mtime.toISOString(),
    name: basename(abs),
    path: abs,
    size: stat.size,
  };
}

function isBinaryBuffer(buf: Buffer): boolean {
  const checkLength = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < checkLength; i++) {
    const byte = buf[i];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) return true;
  }
  return false;
}

// ── 레지스트리 등록 ─────────────────────────────────────────────────────────
// 이 파일을 import하는 순간 아래 도구들(read_file, list_files, get_file_info,
// parse_document)이 자동으로 registry에 올라감.
// 새 도구 추가 시 아래처럼 registerTool 블록 하나만 추가하면 됨.

/**
 * 본문 각 줄 앞에 1부터 시작하는 줄 번호를 붙인다.
 *
 * 번호가 없으면 모델이 아는 건 "총 443줄" 같은 총계뿐이고, 어떤 함수가 몇 번째
 * 줄인지는 본문의 개행을 직접 세는 수밖에 없다. 그건 신뢰할 수 없는 작업이라,
 * 근거로 줄 번호를 요구하면 그럴듯한 숫자를 지어낸다(실측: 387번 줄의 함수를
 * 405라고 답함). 여기서 번호를 붙여 주면 인용이 검증 가능해진다.
 */
function withLineNumbers(text: string, startLine: number): string {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

registerTool({
  name: 'read_file',
  kind: 'read',
  // 채팅 탭에서도 첨부한 문서를 읽어야 한다. 채팅은 읽기만, 코딩은 쓰기까지 —
  // Cursor·Copilot의 Ask 모드와 같은 선. 쓰기·셸 도구는 여전히 코딩 전용
  chat: true,
  // 자격증명은 자동 모드에서도 승인을 받는다. 읽는 순간 모델 컨텍스트와 세션
  // 기록에 남고, 인젝션된 지시가 web_fetch로 이어붙이면 그대로 빠져나간다.
  // 링크가 가리키는 실제 파일까지 본다 (sensitiveReadPathReason)
  approvalGate: ({ path }) => {
    const reason = sensitiveReadPathReason(path);
    return reason ? approvalConfirm(reason) : null;
  },
  description:
    `지정한 경로의 파일 내용을 읽습니다. 한 번에 최대 ${DEFAULT_READ_LINES}줄까지 돌려주며, 더 있으면 결과에 이어 읽는 방법이 적힙니다. 긴 파일은 offset(시작 줄, 1부터)과 limit(줄 수)으로 필요한 부분만 읽으세요. 본문은 각 줄 앞에 "줄번호<탭>"이 붙어 나옵니다 — 파일의 실제 내용이 아니라 인용용 표시이니, 코드를 인용하거나 수정할 때는 번호와 탭을 빼고 다루세요.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '읽을 파일의 경로' },
      offset: { type: 'number', description: '읽기 시작할 줄 번호 (1부터, 생략 시 처음부터)' },
      limit: { type: 'number', description: `읽을 줄 수 (생략 시 ${DEFAULT_READ_LINES}줄)` },
    },
    required: ['path'],
  },
  execute({ path, offset, limit }) {
    const result = readFileTool(path);
    const startLine = Math.max(1, Math.floor(Number(offset)) || 1);
    const lineCount = Math.floor(Number(limit)) || 0;

    const allLines = result.content.split('\n');
    // limit를 주지 않아도 상한을 건다. 예전에는 파일 전체를 돌려줬는데, 그러면
    // 몇 번 읽는 것만으로 컨텍스트가 차서 턴이 통째로 죽는다 (limits.ts 주석)
    const requested = lineCount > 0 ? lineCount : DEFAULT_READ_LINES;
    let endLine = Math.min(allLines.length, startLine + requested - 1);
    let sliced = allLines.slice(startLine - 1, endLine).join('\n');

    // 줄 수로만 막으면 한 줄이 아주 긴 파일(번들·최소화된 JS)이 그대로 들어온다
    if (sliced.length > DEFAULT_READ_CHARS) {
      let chars = 0;
      let line = startLine;
      while (line <= endLine && chars + allLines[line - 1].length + 1 <= DEFAULT_READ_CHARS) {
        chars += allLines[line - 1].length + 1;
        line += 1;
      }
      endLine = Math.max(startLine, line - 1);
      sliced = allLines.slice(startLine - 1, endLine).join('\n');
    }

    // 줄 하나가 상한보다 긴 경우(번들 파일은 전체가 한 줄인 일이 흔하다) 위
    // 반복은 아무것도 못 덜어낸다. 글자 단위로 한 번 더 자른다
    let cutMidLine = false;
    if (sliced.length > DEFAULT_READ_CHARS) {
      sliced = sliced.slice(0, DEFAULT_READ_CHARS);
      cutMidLine = true;
    }

    const truncated = cutMidLine || endLine < allLines.length;
    return [
      `파일: ${result.path}`,
      `줄 범위: ${startLine}-${endLine} / 총 ${result.lines}줄`,
      // 잘렸다는 것과 이어 읽는 법을 함께 준다. 조용히 자르면 모델은 파일이
      // 거기서 끝난 줄 알고 잘못된 판단을 한다
      ...(truncated
        ? [
            cutMidLine
              ? `(한 줄이 너무 길어 ${DEFAULT_READ_CHARS}자에서 잘랐습니다)`
              : `(뒷부분 생략됨 — 이어 읽으려면 offset=${endLine + 1} 로 다시 호출하세요)`,
          ]
        : []),
      '---',
      withLineNumbers(sliced, startLine),
    ].join('\n');
  },
});

registerTool({
  name: 'list_files',
  kind: 'read',
  description: '디렉터리 안의 파일과 폴더 목록을 반환합니다.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '목록을 볼 디렉터리 경로' },
    },
    required: ['path'],
  },
  execute({ path }) {
    const entries = listFilesTool(path);
    const base = resolve(getWorkdir(), String(path ?? '.'));
    // 기준 경로를 함께 준다. 이름만 돌려주면 모델이 그 앞을 스스로 이어 붙여야
    // 하는데, 공백·한글이 든 긴 경로에서 앞부분을 흘리면 상대경로가 되어 작업
    // 폴더 기준으로 풀린다 — "직전에 읽던 파일이 갑자기 없다"의 원인이었다
    const header = [
      `기준 경로: ${base}`,
      '(read_file·search_files에는 이 경로를 앞에 붙인 전체 경로를 주세요)',
    ];
    if (entries.length === 0) return [...header, '(빈 디렉터리)'].join('\n');

    // node_modules 한 번이면 수천 줄이 들어온다 — 읽기와 같은 이유로 막는다
    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    const lines = shown.map(
      e => `${e.isDirectory ? '[DIR] ' : '[FILE]'} ${e.name} (${e.size}바이트)`,
    );
    if (entries.length > shown.length) {
      lines.push(`… 외 ${entries.length - shown.length}개 (search_files로 좁혀 찾으세요)`);
    }
    return [...header, '---', ...lines].join('\n');
  },
});

registerTool({
  name: 'get_file_info',
  kind: 'read',
  // 드물게 쓰고 run_command로도 되는 도구라 매 요청의 목록에 싣지 않는다. 시그니처는
  // 지연 도구 안내에 실린다 (prompt.ts). 대체가 없는 도구는 목록에 둔다 — 작은 모델은
  // 목록에 없는 도구를 시그니처만 보고는 부르지 않는 것이 실측됐다
  deferred: true,
  description: '파일 또는 디렉터리의 크기, 수정일 등 메타데이터를 반환합니다.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '정보를 볼 경로' },
    },
    required: ['path'],
  },
  execute({ path }) {
    const info = getFileInfoTool(path);
    return [
      `이름: ${info.name}`,
      `경로: ${info.path}`,
      `종류: ${info.isDirectory ? '디렉터리' : '파일'}`,
      `확장자: ${info.extension || '없음'}`,
      `크기: ${info.size}바이트`,
      `수정일: ${info.modified}`,
    ].join('\n');
  },
});

/*
 * 변환 결과 캐시. 긴 문서는 개요를 본 뒤 찾기와 범위 읽기로 같은 문서를 여러 번
 * 부르는데, 그때마다 변환하면 1만 행 엑셀도 몇 초씩 걸린다 (OCR이 붙는 문서는 더
 * 길다). 파일이 바뀌면(수정 시각, 크기) 다시 변환한다
 */
const MAX_CACHED_DOCUMENTS = 4;
const documentCache = new Map<string, ConvertedDocument>();

async function convertDocument(abs: string, pages: string | undefined): Promise<ConvertedDocument> {
  const stat = statSync(abs);
  const key = [abs, stat.mtimeMs, stat.size, pages ?? ''].join('\n');
  const cached = documentCache.get(key);
  if (cached) {
    // 방금 쓴 것을 뒤로 보낸다. 넘치면 가장 오래 쓰지 않은 것부터 지운다
    documentCache.delete(key);
    documentCache.set(key, cached);
    return cached;
  }

  // parse()는 파일 경로를 직접 받을 수 있음. ocr은 이미지 기반(스캔) PDF 페이지에서만 호출됨
  const result = await parse(abs, { ocr: tesseractOcr, pages });

  if (!result.success) {
    const failure = result as { error: string; code?: string };
    throw new Error(`문서 파싱 실패 [${failure.code ?? 'UNKNOWN'}]: ${failure.error}`);
  }

  const imageTexts: string[] = [];

  // 텍스트 레이어가 있는 페이지 안에 박힌 개별 이미지(DOCX/HWPX/XLSX 등)는 kordoc의
  // ocr 훅을 타지 않으므로 여기서 직접 OCR을 돌려 마크다운 뒤에 덧붙임
  for (const image of result.images ?? []) {
    const text = await ocrEmbeddedImage(image.data);
    if (text) imageTexts.push(`### 이미지: ${image.filename}\n\n${text}`);
  }

  // PDF는 이미지가 result.images로 추출되지 않고 SKIPPED_IMAGE 경고만 남는다.
  // pdfjs-dist는 이미지 XObject를 실제 렌더링 시점에만 디코딩하므로, 해당 페이지
  // 전체를 렌더링해 OCR로 보완함 (이미 추출된 본문과 일부 겹칠 수 있음)
  if (result.fileType === 'pdf') {
    const skippedImagePages = [...new Set(
      (result.warnings ?? [])
        .filter(w => w.code === 'SKIPPED_IMAGE' && w.page != null)
        .map(w => w.page as number),
    )];
    for (const pageNumber of skippedImagePages) {
      const png = await renderPDFPageToPng(abs, pageNumber);
      const text = await ocrEmbeddedImage(png);
      if (text) imageTexts.push(`### ${pageNumber}페이지 이미지 OCR (보충)\n\n${text}`);
    }
  }

  const markdown = imageTexts.length
    ? `${result.markdown}\n\n---\n\n## 문서 내 이미지 OCR 결과\n\n${imageTexts.join('\n\n')}`
    : result.markdown;
  const converted = buildConvertedDocument({
    fileType: result.fileType,
    markdown,
    outline: result.outline,
    warnings: result.warnings,
  });
  documentCache.set(key, converted);
  if (documentCache.size > MAX_CACHED_DOCUMENTS) {
    documentCache.delete(documentCache.keys().next().value as string);
  }
  return converted;
}

// HWP·HWPX·PDF·XLSX·DOCX 등 바이너리 문서를 마크다운 텍스트로 변환
// read_file이 텍스트 파일 전용이라 바이너리 문서는 이 도구로 처리
registerTool({
  name: 'parse_document',
  kind: 'read',
  // read_file과 같은 이유로 채팅 탭에서도 쓴다 — 첨부는 hwp·xlsx 같은 문서가 대부분이다
  chat: true,
  // 자격증명은 자동 모드에서도 승인을 받는다. 읽는 순간 모델 컨텍스트와 세션
  // 기록에 남고, 인젝션된 지시가 web_fetch로 이어붙이면 그대로 빠져나간다.
  // 링크가 가리키는 실제 파일까지 본다 (sensitiveReadPathReason)
  approvalGate: ({ path }) => {
    const reason = sensitiveReadPathReason(path);
    return reason ? approvalConfirm(reason) : null;
  },
  description:
    'HWP, HWPX, PDF, XLSX, XLS, DOCX 문서를 마크다운으로 변환해 읽습니다. PDF나 한글 문서 같은 바이너리 파일은 반드시 이 도구를 쓰세요. 짧은 문서는 전체를 돌려주고, 긴 문서는 전체 대신 개요(구조와 문서 곳곳에서 뽑은 표본 줄)를 돌려줍니다. 개요로 어떤 문서인지 파악한 뒤 pattern으로 필요한 줄을 찾거나 offset과 limit으로 필요한 범위만 읽으세요. 긴 문서를 처음부터 끝까지 넘겨 읽지 마세요. 찾기와 범위 읽기 결과는 각 줄 앞에 "줄번호<탭>"이 붙습니다.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '변환할 파일 경로 (HWP/HWPX/PDF/XLSX/XLS/DOCX)' },
      pages: { type: 'string', description: '변환할 페이지 범위 (예: "1-3", "1,3,5-7"). 생략하면 전체. PDF는 정확한 페이지 단위, HWP/HWPX는 섹션 단위 근사치, XLSX는 시트 번호' },
      pattern: { type: 'string', description: '찾을 말. 그 말이 든 줄만 줄 번호와 함께 돌려줍니다. 대소문자는 가리지 않고, 여러 말은 |로 잇습니다 (정규식은 아님). 표 안의 줄이면 그 표의 머리글도 함께 보여 줍니다' },
      offset: { type: 'number', description: '읽기 시작할 줄 번호 (변환 결과 기준, 1부터). pattern과 함께 주면 이 줄부터 찾습니다' },
      limit: { type: 'number', description: `읽을 줄 수 (생략 시 ${DEFAULT_READ_LINES}줄). pattern과 함께 주면 돌려줄 일치 줄 수 (생략 시 ${DEFAULT_SEARCH_MATCHES}줄)` },
    },
    required: ['path'],
  },
  async execute({ path, pages, pattern, offset, limit }) {
    const abs = resolve(getWorkdir(), path);
    if (!existsSync(abs)) throw new Error(`파일을 찾을 수 없습니다: ${path}`);

    // pages 없이 페이지 수 많은 PDF를 통째로 파싱/OCR하는 것을 방지 (렌더링 없이
    // 페이지 수만 저렴하게 확인)
    if (!pages && extname(abs).toLowerCase() === '.pdf') {
      const pageCount = await getPDFPageCount(abs);
      if (pageCount > PDF_INLINE_PAGE_LIMIT) {
        throw new Error(
          `이 PDF는 ${pageCount}페이지로 한 번에 읽기엔 많습니다. pages 파라미터로 범위를 나눠 요청하세요 (예: "1-10").`,
        );
      }
    }

    const converted = await convertDocument(abs, pages);
    return renderDocument(converted, { limit, offset, path: abs, pattern });
  },
});
