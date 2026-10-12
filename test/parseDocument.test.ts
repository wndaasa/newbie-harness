// 문서 변환(parse_document) 회귀 테스트.
//
// 예전에는 변환 결과를 통째로 돌려줬다. 1만 행 용어 사전 엑셀 하나가 80만 토큰으로
// 262K 창의 세 배였고, 직전 라운드라 압축도 축약도 건드리지 못해 턴이 멈췄다. 이어서
// 하면 모델은 같은 문서를 또 통째로 변환했다. 여기서 고정하는 것은 "긴 문서는 개요부터
// 주고, 찾기와 범위 읽기로 필요한 부분만 가져가게 한다"이다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markdownToHwpx } from 'kordoc';
import { dispatchTool } from '../src/tools/registry.ts';
import { DEFAULT_READ_CHARS } from '../src/tools/read/limits.ts';
import { buildConvertedDocument, renderDocument } from '../src/tools/read/documentView.ts';
import '../src/tools/read/readFile.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newbie-doc-'));
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

async function parseDoc(args: Record<string, unknown>): Promise<string> {
  return (await dispatchTool('parse_document', args as never)).text;
}

/** 머리말, 용어 표, 부록으로 된 한글 문서 */
async function writeGlossary(rows: number, name = 'glossary.hwpx'): Promise<string> {
  const markdown = ['# 용어 사전', '', '이 문서는 공통 표준 용어를 정리한 것입니다.', '', '| 번호 | 용어 | 설명 |', '| --- | --- | --- |'];
  for (let i = 1; i <= rows; i += 1) markdown.push(`| ${i} | 용어${i} | 설명 ${i} |`);
  markdown.push('', '## 부록', '', '끝.');
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(await markdownToHwpx(markdown.join('\n'))));
  return path;
}

/** 결과의 '---' 아래 본문 줄 */
function bodyLines(output: string): string[] {
  return output.split('\n---\n')[1]?.split('\n') ?? [];
}

describe('parse_document', () => {
  test('긴 문서는 전체 대신 구조와 곳곳의 표본으로 된 개요를 돌려준다', async () => {
    const path = await writeGlossary(1_500);

    const output = await parseDoc({ path });

    expect(output).toContain('개요');
    expect(output).toContain('## 구조');
    expect(output).toContain('[표, ');
    expect(output).toContain('| 번호 | 용어 | 설명 |');
    // 어떻게 필요한 부분만 가져가는지 알려 준다
    expect(output).toContain('pattern');
    expect(output).toContain('offset');
    expect(output.length).toBeLessThan(DEFAULT_READ_CHARS);
    // 1,500행 가운데 표본만 보인다. 문서 끝(마지막 행 근처)까지 훑는다
    const rows = output.split('\n').filter(line => /\| \d+ \| 용어\d+ \|/.test(line));
    expect(rows.length).toBeLessThan(60);
    expect(output).toContain('끝.');
  });

  test('찾기는 그 말이 든 줄만, 표 안이면 머리글을 붙여 돌려준다', async () => {
    const path = await writeGlossary(1_500);

    const output = await parseDoc({ path, pattern: '용어777|용어1234' });

    expect(output).toContain('일치 2줄');
    const body = bodyLines(output);
    expect(body.some(line => line.endsWith('| 번호 | 용어 | 설명 |'))).toBe(true);
    expect(body.some(line => line.includes('| 777 | 용어777 |'))).toBe(true);
    expect(body.some(line => line.includes('| 1234 | 용어1234 |'))).toBe(true);
    expect(output).not.toContain('용어778');
    // 머리글은 같은 표에 한 번만 붙는다
    expect(body.filter(line => line.endsWith('| 번호 | 용어 | 설명 |')).length).toBe(1);
  });

  test('찾을 말이 없으면 그렇다고 하고 다른 표현을 권한다', async () => {
    const path = await writeGlossary(1_500);

    const output = await parseDoc({ path, pattern: '없는용어' });

    expect(output).toContain('일치하는 줄이 없습니다');
  });

  test('범위 읽기는 그 범위만 줄 번호와 함께 돌려주고, 표 본문이면 머리글을 붙인다', async () => {
    const path = await writeGlossary(1_500);

    const output = await parseDoc({ path, offset: 600, limit: 3 });

    expect(output).toContain('줄 범위: 600-602');
    expect(output).toContain('(이 범위가 들어 있는 표의 머리글)');
    expect(output).toContain('| 번호 | 용어 | 설명 |');
    expect(bodyLines(output).map(line => line.split('\t')[0].trim())).toEqual(['600', '601', '602']);
    // 요청한 범위를 다 줬으면 "다음은 offset=..."을 붙이지 않는다. 차례로 끝까지 넘겨 읽게 된다
    expect(output).not.toContain('offset=');
  });

  test('짧은 문서는 그대로 전체를 돌려준다', async () => {
    const path = await writeGlossary(5, 'small.hwpx');

    const output = await parseDoc({ path });

    expect(output).toContain('| 5 | 용어5 | 설명 5 |');
    expect(output).not.toContain('개요');
  });

  test('같은 문서는 다시 변환하지 않되, 파일이 바뀌면 다시 변환한다', async () => {
    const path = await writeGlossary(1_500);
    expect(await parseDoc({ path, pattern: '용어1499' })).toContain('일치 1줄');

    await writeGlossary(1_000);

    expect(await parseDoc({ path, pattern: '용어1499' })).toContain('일치하는 줄이 없습니다');
  });
});

describe('변환 결과 보이기', () => {
  function table(rows: number): string {
    const lines = ['## 시트1', '', '| 번호 | 용어 |', '| --- | --- |'];
    for (let i = 1; i <= rows; i += 1) lines.push(`| ${i} | 용어${i} |`);
    return lines.join('\n');
  }

  test('엑셀 시트가 변환기의 행 상한에 닿으면 뒷부분이 빠졌을 수 있다고 알린다', () => {
    // kordoc은 XLSX 시트를 머리글 포함 1만 행에서 경고 없이 자른다. 모르면 모델은
    // 찾는 용어가 문서에 없다고 결론 낸다
    const capped = buildConvertedDocument({ fileType: 'xlsx', markdown: table(9_999) });

    expect(capped.notes).toHaveLength(1);
    expect(capped.notes[0]).toContain('행 상한(10000행)');
    expect(renderDocument(capped, { path: 'dict.xlsx' })).toContain('[주의]');
    expect(renderDocument(capped, { path: 'dict.xlsx', pattern: '없는용어' })).toContain('[주의]');

    expect(buildConvertedDocument({ fileType: 'xlsx', markdown: table(9_998) }).notes).toEqual([]);
    expect(buildConvertedDocument({ fileType: 'hwpx', markdown: table(9_999) }).notes).toEqual([]);
  });

  test('변환기가 건너뛴 표가 있으면 알린다', () => {
    const doc = buildConvertedDocument({
      fileType: 'hwp',
      markdown: '본문',
      warnings: [{ code: 'TRUNCATED_TABLE', message: '테이블 크기 초과 (5000x300)' }],
    });

    expect(renderDocument(doc, { path: 'a.hwp' })).toContain('[주의] 변환기가 표 하나를 건너뛰었습니다');
  });

  test('제목이 # 없이 변환된 문서는 변환기가 준 제목으로 구조를 보인다', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 500; i += 1) {
      if (i === 10) lines.push('1. 사업 개요');
      else if (i === 300) lines.push('1.1 추진 배경');
      else lines.push(`${i}번째 문단입니다.`);
    }
    const doc = buildConvertedDocument({
      fileType: 'hwp',
      markdown: lines.join('\n'),
      outline: [
        { level: 1, text: '1. 사업 개요' },
        { level: 2, text: '1.1 추진 배경' },
      ],
    });

    const output = renderDocument(doc, { path: 'rfp.hwp' });

    expect(output).toContain(' 10\t# 1. 사업 개요');
    expect(output).toContain('300\t## 1.1 추진 배경');
  });

  test('표본은 무작위가 아니라 문서 끝까지 고르게 뽑는다', () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `줄 ${i + 1}`);
    const doc = buildConvertedDocument({ fileType: 'docx', markdown: lines.join('\n') });

    const output = renderDocument(doc, { path: 'a.docx' });
    const sampled = output
      .split('## 표본')[1]
      .split('\n')
      .map(line => Number(/^\s*(\d+)\t/.exec(line)?.[1]))
      .filter(Number.isFinite);

    expect(Math.max(...sampled)).toBeGreaterThanOrEqual(4_990);
    expect(sampled.some(n => n > 2_000 && n < 3_500)).toBe(true);
    // 같은 문서는 늘 같은 개요
    expect(renderDocument(doc, { path: 'a.docx' })).toBe(output);
  });

  test('한 번에 주는 분량은 글자 수 상한을 넘지 않는다', () => {
    const doc = buildConvertedDocument({
      fileType: 'docx',
      markdown: Array.from({ length: 1_000 }, () => '가'.repeat(500)).join('\n'),
    });

    const range = renderDocument(doc, { offset: 1, limit: 400, path: 'a.docx' });
    const found = renderDocument(doc, { path: 'a.docx', pattern: '가', limit: 1_000 });

    expect(range.length).toBeLessThan(DEFAULT_READ_CHARS + 500);
    // 요청한 범위를 다 못 줬으면 이어 읽는 법을 적는다
    expect(range).toContain('offset=');
    expect(found.length).toBeLessThan(DEFAULT_READ_CHARS + 500);
    expect(found).toContain('일치 1000줄 중');
  });
});
