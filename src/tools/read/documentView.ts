// 변환한 문서를 모델에게 보여 주는 방식 (parse_document).
//
// 예전에는 변환 결과를 통째로 돌려줬다. 1만 행짜리 용어 사전 엑셀은 138만 자,
// Qwen 기준 80만 토큰으로 262K 창의 세 배였다. 직전 라운드의 결과는 압축도 축약도
// 건드리지 않아 그 턴은 멈출 수밖에 없었고, 이어서 하면 모델은 문서가 크다는 것을
// 모른 채 같은 문서를 다시 통째로 변환해 또 멈췄다.
//
// 큰 문서는 처음부터 끝까지 읽는 것이 아니다. 몇 군데를 훑어 어떤 문서인지 파악한
// 뒤 필요한 부분만 찾아 읽는다. 그래서 짧은 문서만 전체를 돌려주고, 긴 문서는
// 개요(구조와 문서 곳곳에서 고르게 뽑은 표본 줄)를 먼저 돌려준다. 그 뒤는 찾기
// (pattern)와 범위 읽기(offset, limit)로 필요한 부분만 가져가게 한다.

import { DEFAULT_READ_CHARS, DEFAULT_READ_LINES } from './limits.ts';

/** 마크다운 표 하나가 차지하는 줄. start는 0부터, end는 표 다음 줄 */
type TableBlock = {
  end: number;
  /** 머리글과 구분선(| --- |) 두 줄이 있으면 2, 구분선이 없으면 0 */
  header: number;
  rows: number;
  start: number;
};

export type ConvertedDocument = {
  chars: number;
  fileType: string;
  lines: string[];
  /** 변환하며 내용이 빠졌을 수 있다는 알림. 모르면 모델은 빠진 내용을 문서에 없다고 결론 낸다 */
  notes: string[];
  /** 변환기가 준 제목 목록. HWP처럼 제목이 # 없이 변환되는 문서의 구조를 보일 때 쓴다 */
  outline: { level: number; text: string }[];
  tables: TableBlock[];
};

/*
 * kordoc은 시트의 행을 경고 없이 잘라낸다. XLSX는 1만 행, XLS는 10만 행이다 (머리글
 * 포함, kordoc 3.5 파서의 MAX_ROWS). 표가 이 수에 닿았으면 원본에는 행이 더 있을 수
 * 있다
 */
const SHEET_ROW_CAPS: Record<string, number> = { xls: 100_000, xlsx: 10_000 };

/** 개요의 표본: 첫머리 몇 줄과, 나머지 구간에 고르게 놓은 몇 군데 */
const OVERVIEW_HEAD_LINES = 20;
const OVERVIEW_SPOTS = 5;
const OVERVIEW_SPOT_LINES = 5;
/** 개요에서는 한 줄을 이만큼만 보인다. 무엇이 있는지 알아볼 정도면 된다 */
const OVERVIEW_LINE_CHARS = 200;
/** 개요의 구조 목록 상한. 표가 수십 개인 서식 문서도 있다 */
const OVERVIEW_STRUCTURE_ITEMS = 40;
/** 찾기가 한 번에 돌려주는 일치 줄 수. limit로 바꿀 수 있다 */
export const DEFAULT_SEARCH_MATCHES = 100;

export function buildConvertedDocument({
  fileType,
  markdown,
  outline = [],
  warnings = [],
}: {
  fileType: string;
  markdown: string;
  outline?: { level: number; text: string }[];
  warnings?: { code: string; message: string }[];
}): ConvertedDocument {
  const lines = markdown.split('\n');
  const tables = findTables(lines);
  const notes: string[] = [];
  const cap = SHEET_ROW_CAPS[fileType];
  for (const table of cap ? tables : []) {
    // 머리글 한 행을 더해 상한과 비교한다
    if (table.rows + 1 >= cap) {
      notes.push(
        `${table.start + 1}줄의 표가 변환기의 시트당 행 상한(${cap}행)에 닿았습니다. 원본에는 행이 더 있을 수 있고, 그 행은 이 변환 결과에 없습니다`,
      );
    }
  }
  for (const warning of warnings) {
    if (warning.code === 'TRUNCATED_TABLE') notes.push(`변환기가 표 하나를 건너뛰었습니다: ${warning.message}`);
  }
  return { chars: markdown.length, fileType, lines, notes, outline, tables };
}

/**
 * 변환한 문서를 요청에 맞게 보여 준다. pattern이 있으면 찾기, offset이나 limit가
 * 있으면 범위 읽기, 둘 다 없으면 짧은 문서는 전체를, 긴 문서는 개요를 돌려준다
 */
export function renderDocument(
  doc: ConvertedDocument,
  { limit, offset, path, pattern }: { limit?: unknown; offset?: unknown; path: string; pattern?: unknown },
): string {
  const from = Math.floor(Number(offset)) || 0;
  const count = Math.floor(Number(limit)) || 0;
  const query = String(pattern ?? '').trim();
  if (query) return searchDocument(doc, path, query, from, count);
  if (from > 0 || count > 0) return readRange(doc, path, from, count);
  if (doc.lines.length <= DEFAULT_READ_LINES && doc.chars <= DEFAULT_READ_CHARS) {
    return [...doc.notes.map(note => `[주의] ${note}`), doc.lines.join('\n')].join('\n');
  }
  return overview(doc, path);
}

function findTables(lines: string[]): TableBlock[] {
  const tables: TableBlock[] = [];
  let start = -1;
  for (let index = 0; index <= lines.length; index += 1) {
    const inTable = index < lines.length && lines[index].startsWith('|');
    if (inTable && start === -1) start = index;
    if (inTable || start === -1) continue;
    const header = index - start >= 2 && /^\|\s*:?-{3,}/.test(lines[start + 1]) ? 2 : 0;
    tables.push({ end: index, header, rows: index - start - header, start });
    start = -1;
  }
  return tables;
}

function tableAt(tables: TableBlock[], index: number): TableBlock | undefined {
  let low = 0;
  let high = tables.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const table = tables[mid];
    if (index < table.start) high = mid - 1;
    else if (index >= table.end) low = mid + 1;
    else return table;
  }
  return undefined;
}

/**
 * 표 본문 한가운데의 줄만 보면 각 칸이 무엇인지 모른다. 그 줄이 든 표의 머리글
 * 줄들(0부터 센 번호)을 돌려준다. 머리글 자체이거나 표 밖이면 빈 목록
 */
function headerLinesFor(table: TableBlock | undefined, index: number): number[] {
  if (!table || table.header === 0 || index < table.start + table.header) return [];
  return [table.start, table.start + 1];
}

/** read_file과 같은 "줄번호<탭>" 표시. 번호는 1부터 센다 */
function numbered(index: number, text: string, width: number): string {
  return `${String(index + 1).padStart(width, ' ')}\t${text}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function overview(doc: ConvertedDocument, path: string): string {
  const width = String(doc.lines.length).length;
  const structure = structureOf(doc);
  const shownStructure = structure.slice(0, OVERVIEW_STRUCTURE_ITEMS);

  const samples: string[] = [];
  let previous = -1;
  for (const index of sampleIndices(doc.lines)) {
    // 사이에 건너뛴 내용이 있으면 표시한다. 빈 줄만 건너뛴 것은 표시하지 않는다
    if (previous !== -1 && doc.lines.slice(previous + 1, index).some(line => line.trim())) samples.push('…');
    samples.push(numbered(index, clip(doc.lines[index], OVERVIEW_LINE_CHARS), width));
    previous = index;
  }

  return [
    `문서: ${path}`,
    `형식: ${doc.fileType.toUpperCase()}, 변환 결과 ${doc.lines.length}줄 ${doc.chars}자`,
    '길어서 전체 대신 개요를 보여 줍니다. 아래 구조와 표본으로 어떤 문서인지 파악한 뒤, 필요한 부분만 골라 읽으세요.',
    '- 찾기: pattern에 찾을 말을 주면 그 말이 든 줄만 줄 번호와 함께 돌려줍니다. 여러 말은 |로 잇습니다 (예: pattern="계약|기간")',
    `- 범위 읽기: offset(시작 줄)과 limit(줄 수)으로 그 부분만 읽습니다. 한 번에 최대 ${DEFAULT_READ_LINES}줄, ${DEFAULT_READ_CHARS}자`,
    '처음부터 끝까지 차례로 넘겨 읽지 마세요.',
    ...doc.notes.map(note => `[주의] ${note}`),
    '',
    '## 구조',
    ...(shownStructure.length
      ? shownStructure.map(item => numbered(item.index, clip(item.text, OVERVIEW_LINE_CHARS), width))
      : ['(제목이나 표를 찾지 못했습니다)']),
    ...(structure.length > shownStructure.length
      ? [`… 외 ${structure.length - shownStructure.length}개 (pattern으로 찾으세요)`]
      : []),
    '',
    '## 표본 (문서 곳곳에서 고르게 뽑은 줄, …은 건너뛴 곳)',
    ...samples,
  ].join('\n');
}

/** 제목과 표를 줄 순서대로 */
function structureOf(doc: ConvertedDocument): { index: number; text: string }[] {
  const items: { index: number; text: string }[] = [];
  doc.lines.forEach((line, index) => {
    if (/^#{1,6}\s/.test(line)) items.push({ index, text: line });
  });
  // HWP 등은 제목이 # 없이 변환된다. 변환기가 준 제목을 본문에서 차례로 찾아 줄을 잇는다
  if (items.length === 0) {
    let from = 0;
    for (const heading of doc.outline) {
      const text = heading.text.trim();
      if (!text) continue;
      let index = from;
      while (index < doc.lines.length && doc.lines[index].trim() !== text) index += 1;
      if (index >= doc.lines.length) continue;
      items.push({ index, text: `${'#'.repeat(Math.min(Math.max(heading.level, 1), 6))} ${text}` });
      from = index + 1;
    }
  }
  for (const table of doc.tables) {
    items.push({
      index: table.start,
      text: `[표, ${table.start + 1}-${table.end}줄, ${table.rows}행] ${doc.lines[table.start]}`,
    });
  }
  return items.sort((a, b) => a.index - b.index);
}

/**
 * 표본으로 보일 줄 (0부터). 무작위가 아니라 고르게 놓는다. 같은 문서는 늘 같은 개요가
 * 나오고, 문서의 끝까지 빠짐없이 훑는다. 빈 줄은 고르지 않는다
 */
function sampleIndices(lines: string[]): number[] {
  const picked = new Set<number>();
  // start부터 빈 줄이 아닌 줄을 count개 고르고, 고른 마지막 줄의 다음 자리를 돌려준다
  const take = (start: number, count: number) => {
    let index = start;
    for (let taken = 0; index < lines.length && taken < count; index += 1) {
      if (!lines[index].trim()) continue;
      picked.add(index);
      taken += 1;
    }
    return index;
  };
  const headEnd = take(0, OVERVIEW_HEAD_LINES);
  const span = lines.length - headEnd - OVERVIEW_SPOT_LINES;
  if (span > 0) {
    // 마지막 자리는 문서 끝의 몇 줄이다
    for (let spot = 1; spot <= OVERVIEW_SPOTS; spot += 1) {
      take(headEnd + Math.floor((span * spot) / OVERVIEW_SPOTS), OVERVIEW_SPOT_LINES);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

function readRange(doc: ConvertedDocument, path: string, offset: number, limit: number): string {
  const total = doc.lines.length;
  const startLine = Math.max(1, offset);
  if (startLine > total) return `문서: ${path}\n시작 줄 ${startLine}이 문서 끝(총 ${total}줄)을 넘습니다.`;
  const width = String(total).length;
  const requestedEnd = Math.min(total, startLine + (limit > 0 ? limit : DEFAULT_READ_LINES) - 1);

  // 줄 수로만 막으면 한 줄이 아주 긴 문서가 그대로 들어온다. 글자 수 상한에서 멈춘다
  let chars = 0;
  let line = startLine;
  while (line <= requestedEnd && chars + doc.lines[line - 1].length + 1 <= DEFAULT_READ_CHARS) {
    chars += doc.lines[line - 1].length + 1;
    line += 1;
  }
  // 첫 줄 하나가 상한보다 길면 그 줄을 글자 단위로 자른다
  const cutMidLine = line === startLine;
  const endLine = cutMidLine ? startLine : line - 1;
  const body = doc.lines
    .slice(startLine - 1, endLine)
    .map((text, i) => numbered(startLine - 1 + i, cutMidLine ? text.slice(0, DEFAULT_READ_CHARS) : text, width));
  const header = headerLinesFor(tableAt(doc.tables, startLine - 1), startLine - 1);

  return [
    `문서: ${path}`,
    `줄 범위: ${startLine}-${endLine} / 총 ${total}줄`,
    // 요청한 범위를 다 못 준 경우에만 이어 읽는 법을 적는다. 다 줬는데도 "다음은
    // offset=..."을 붙이면 문서를 차례로 끝까지 넘겨 읽으라는 말이 된다
    ...(cutMidLine
      ? [`(한 줄이 너무 길어 ${DEFAULT_READ_CHARS}자에서 잘랐습니다)`]
      : endLine < requestedEnd
        ? [`(한 번에 ${DEFAULT_READ_CHARS}자까지라 ${endLine}줄에서 멈췄습니다. 이어 읽으려면 offset=${endLine + 1})`]
        : []),
    ...(header.length
      ? ['(이 범위가 들어 있는 표의 머리글)', ...header.map(index => numbered(index, doc.lines[index], width))]
      : []),
    '---',
    ...body,
  ].join('\n');
}

function searchDocument(
  doc: ConvertedDocument,
  path: string,
  pattern: string,
  offset: number,
  limit: number,
): string {
  // 정규식은 받지 않는다. 앱의 메인 프로세스에서 도는데, 되돌이가 폭주하는 식 하나면
  // 수십만 줄 앞에서 앱이 멈춘다. 여러 말은 |로 잇는다
  const terms = pattern
    .split('|')
    .map(term => term.trim().toLowerCase())
    .filter(Boolean);
  const total = doc.lines.length;
  const width = String(total).length;
  const startLine = Math.max(1, offset);
  const matches: number[] = [];
  for (let index = startLine - 1; index < total; index += 1) {
    const line = doc.lines[index].toLowerCase();
    if (terms.some(term => line.includes(term))) matches.push(index);
  }

  const maxMatches = limit > 0 ? limit : DEFAULT_SEARCH_MATCHES;
  const body: string[] = [];
  let chars = 0;
  let shown = 0;
  // 머리글을 이미 보인 표. 같은 표의 줄이 이어지면 머리글을 다시 붙이지 않는다
  let headed: TableBlock | undefined;
  for (const index of matches) {
    if (shown >= maxMatches) break;
    const table = tableAt(doc.tables, index);
    const header = table && table !== headed ? headerLinesFor(table, index) : [];
    const lines = [
      ...(header.length && table
        ? [`(${table.start + 1}-${table.end}줄 표의 머리글)`, ...header.map(i => numbered(i, doc.lines[i], width))]
        : []),
      numbered(index, clip(doc.lines[index], DEFAULT_READ_CHARS), width),
    ];
    const size = lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (shown > 0 && chars + size > DEFAULT_READ_CHARS) break;
    body.push(...lines);
    chars += size;
    shown += 1;
    if (header.length) headed = table;
  }

  const summary =
    matches.length === 0
      ? '일치하는 줄이 없습니다. 띄어쓰기나 줄임말을 바꿔 다시 찾아보세요.'
      : shown < matches.length
        ? `일치 ${matches.length}줄 중 ${shown}줄을 보여 줍니다. 나머지는 offset=${matches[shown - 1] + 2}부터 다시 찾거나, 찾을 말을 좁히세요.`
        : `일치 ${matches.length}줄`;
  return [
    `문서: ${path}`,
    `찾기: "${pattern}" (대소문자 무시, ${startLine}줄부터, 총 ${total}줄)`,
    summary,
    ...doc.notes.map(note => `[주의] ${note}`),
    ...(body.length ? ['---', ...body] : []),
  ].join('\n');
}
