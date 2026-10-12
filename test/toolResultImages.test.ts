// 도구 결과 이미지 회귀 테스트.
//
// 도구는 오랫동안 문자열만 돌려줄 수 있었다. 그래서 스크린샷을 찍어도 모델에게
// 건넬 방법이 없었고, MCP 서버가 이미지 블록을 줘도 텍스트로 뭉개져 버려졌다.
// 이 경로가 다시 막히지 않도록 세 지점을 고정한다 — 도구 결과 정규화, MCP
// 이미지 블록 보존, 프로바이더별 확장.

import { describe, expect, test } from 'bun:test';
import { normalizeToolResult } from '../src/tools/registry.ts';
import { extractToolResultImages } from '../src/mcp/toolBridge.ts';
import { expandToolHistory } from '../src/providers/toolHistory.ts';
import type { SessionModelMessage } from '../src/session/storage.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

describe('도구 결과 정규화', () => {
  test('문자열을 돌려주는 기존 도구는 그대로 통과한다', () => {
    // 자체 도구 15종이 전부 이 경로다. 여기가 깨지면 전부 깨진다
    expect(normalizeToolResult('파일을 생성했습니다')).toEqual({
      images: [],
      text: '파일을 생성했습니다',
    });
  });

  test('이미지를 함께 돌려주면 실어 준다', () => {
    expect(normalizeToolResult({ images: [PNG], text: '화면을 찍었습니다' })).toEqual({
      images: [PNG],
      text: '화면을 찍었습니다',
    });
  });

  test('data URL이 아닌 값은 버린다', () => {
    const result = normalizeToolResult({
      images: ['https://example.com/a.png', 'not-an-image', PNG],
      text: '',
    });
    expect(result.images).toEqual([PNG]);
  });

  test('장수 상한을 넘기면 앞에서부터만 싣는다', () => {
    // 스크린샷은 턴마다 쌓여 컨텍스트를 빠르게 채운다
    const result = normalizeToolResult({ images: Array(10).fill(PNG), text: '' });
    expect(result.images).toHaveLength(4);
  });

  test('너무 큰 이미지는 버린다', () => {
    const huge = `data:image/png;base64,${'A'.repeat(10_000_001)}`;
    expect(normalizeToolResult({ images: [huge], text: '' }).images).toEqual([]);
  });
});

describe('MCP 이미지 블록 보존', () => {
  test('image 블록을 data URL로 건져 낸다', () => {
    const images = extractToolResultImages({
      content: [
        { text: '스크린샷을 찍었습니다', type: 'text' },
        { data: 'iVBORw0KGgo=', mimeType: 'image/png', type: 'image' },
      ],
    });
    expect(images).toEqual([PNG]);
  });

  test('이미지가 없으면 빈 배열', () => {
    expect(extractToolResultImages({ content: [{ text: '결과', type: 'text' }] })).toEqual([]);
    expect(extractToolResultImages(undefined)).toEqual([]);
  });

  test('mimeType이 없거나 이미지가 아니면 버린다', () => {
    const images = extractToolResultImages({
      content: [
        { data: 'AAA', type: 'image' },
        { data: 'AAA', mimeType: 'application/pdf', type: 'image' },
      ],
    });
    expect(images).toEqual([]);
  });
});

describe('프로바이더별 확장', () => {
  const withImage: SessionModelMessage[] = [
    {
      content: '',
      role: 'assistant',
      toolCalls: [
        {
          id: 'call-1',
          images: [PNG, JPEG],
          input: { url: 'http://localhost:5173' },
          name: 'browser_screenshot',
          ok: true,
          result: '스크린샷을 찍었습니다',
        },
      ],
    },
  ];

  test('Anthropic은 tool_result 안에 이미지 블록을 넣는다', () => {
    const expanded = expandToolHistory(withImage, 'anthropic') as any[];
    const toolResult = expanded[1].content[0];

    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.content[0]).toEqual({ text: '스크린샷을 찍었습니다', type: 'text' });
    expect(toolResult.content[1]).toEqual({
      source: { data: 'iVBORw0KGgo=', media_type: 'image/png', type: 'base64' },
      type: 'image',
    });
    expect(toolResult.content).toHaveLength(3);
  });

  test('OpenAI는 tool 메시지 뒤에 이미지를 실은 user 메시지를 붙인다', () => {
    // OpenAI의 tool 메시지는 이미지를 받지 못한다
    const expanded = expandToolHistory(withImage, 'openai') as any[];

    expect(expanded[1]).toEqual({
      content: '스크린샷을 찍었습니다',
      role: 'tool',
      tool_call_id: 'call-1',
    });
    expect(expanded[2]).toEqual({
      content: '[browser_screenshot 도구가 돌려준 이미지]',
      images: [PNG, JPEG],
      role: 'user',
    });
  });

  test('이미지가 없으면 예전과 같은 모양을 유지한다', () => {
    const plain: SessionModelMessage[] = [
      {
        content: '',
        role: 'assistant',
        toolCalls: [
          { id: 'call-1', input: { path: 'a.ts' }, name: 'read_file', ok: true, result: '내용' },
        ],
      },
    ];

    const anthropic = expandToolHistory(plain, 'anthropic') as any[];
    // 문자열 그대로여야 한다. 배열로 감싸면 기존 이력의 표현이 바뀐다
    expect(anthropic[1].content[0].content).toBe('내용');

    const openai = expandToolHistory(plain, 'openai') as any[];
    expect(openai).toHaveLength(2);
  });

  test('빈 이미지 배열도 이미지 없음으로 다룬다', () => {
    // images: [] 를 "있음"으로 보면 tool_result가 문자열에서 배열로 바뀌고,
    // OpenAI 쪽에는 빈 user 메시지가 하나 더 붙는다
    const empty: SessionModelMessage[] = [
      {
        content: '',
        role: 'assistant',
        toolCalls: [
          { id: 'call-1', images: [], input: {}, name: 'read_file', ok: true, result: '내용' },
        ],
      },
    ];

    expect((expandToolHistory(empty, 'anthropic') as any[])[1].content[0].content).toBe('내용');
    expect(expandToolHistory(empty, 'openai')).toHaveLength(2);
  });
});
