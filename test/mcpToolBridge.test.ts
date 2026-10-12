// MCP 도구 변환 회귀 테스트.
//
// MCP 도구는 서버가 이름·스키마·주석을 마음대로 정하고 우리 쪽 검증을 거치지 않는다.
// 프로바이더가 받는 도구 이름 규칙(문자·길이)을 벗어나면 턴 전체가 API 오류로 죽고,
// 승인 판정을 관대하게 잡으면 외부 서비스를 바꾸는 도구가 승인 없이 실행된다.
// 그 두 경계와, 결과 블록을 텍스트로 펴는 규칙을 고정한다.

import { describe, expect, test } from 'bun:test';
import { buildToolHint } from '../src/tools/prompt.ts';
import { registerTool, unregisterToolSource } from '../src/tools/registry.ts';
import {
  flattenToolResult,
  isToolResultError,
  mcpApprovalGate,
  mcpToolKind,
  mcpToolName,
  mcpToolParameters,
} from '../src/mcp/toolBridge.ts';

describe('도구 이름', () => {
  test('mcp__<서버>__<도구> 형태로 만든다', () => {
    expect(mcpToolName('notion', 'create-pages')).toBe('mcp__notion__create-pages');
  });

  test('허용되지 않는 문자는 _로 바꾼다', () => {
    expect(mcpToolName('notion', 'notion.create pages')).toBe('mcp__notion__notion_create_pages');
  });

  test('64자를 넘으면 도구 이름 쪽을 줄인다', () => {
    const name = mcpToolName('notion', 'a'.repeat(200));

    expect(name.length).toBe(64);
    expect(name.startsWith('mcp__notion__')).toBe(true);
  });

  test('이름이 전부 걸러져도 빈 이름을 만들지 않는다', () => {
    expect(mcpToolName('server', '!!!')).toBe('mcp__server__tool');
  });
});

describe('승인 판정', () => {
  test('readOnlyHint가 true일 때만 읽기로 본다', () => {
    expect(mcpToolKind({ annotations: { readOnlyHint: true }, name: 'search' })).toBe('read');
  });

  test('힌트가 없거나 false면 승인이 필요한 execute로 본다', () => {
    expect(mcpToolKind({ name: 'unknown' })).toBe('execute');
    expect(mcpToolKind({ annotations: { readOnlyHint: false }, name: 'create' })).toBe('execute');
    expect(mcpToolKind({ annotations: {}, name: 'create' })).toBe('execute');
  });
});

describe('입력 스키마', () => {
  test('서버 스키마의 properties·required를 그대로 옮긴다', () => {
    const parameters = mcpToolParameters({
      properties: { query: { type: 'string' } },
      required: ['query'],
      type: 'object',
    });

    expect(parameters).toEqual({
      properties: { query: { type: 'string' } },
      required: ['query'],
      type: 'object',
    });
  });

  test('스키마가 없거나 형식이 어긋나도 object 스키마를 만든다', () => {
    expect(mcpToolParameters(undefined)).toEqual({ properties: {}, required: [], type: 'object' });
    expect(mcpToolParameters('nope')).toEqual({ properties: {}, required: [], type: 'object' });
  });
});

describe('결과 변환', () => {
  test('텍스트 블록을 줄바꿈으로 잇는다', () => {
    expect(flattenToolResult({ content: [{ text: '첫 줄', type: 'text' }, { text: '둘째 줄', type: 'text' }] })).toBe(
      '첫 줄\n둘째 줄',
    );
  });

  test('텍스트가 아닌 블록은 종류만 남긴다', () => {
    // 이미지는 extractToolResultImages가 따로 싣고, 텍스트에는 자리만 남는다
    expect(flattenToolResult({ content: [{ data: '...', type: 'image' }] })).toBe('[이미지]');
    expect(flattenToolResult({ content: [{ type: 'audio', data: '...' }] })).toBe('[audio]');
    expect(flattenToolResult({ content: [{ type: 'resource_link', uri: 'notion://page/1' }] })).toBe(
      '[리소스] notion://page/1',
    );
  });

  test('텍스트 블록이 없으면 structuredContent를 직렬화한다', () => {
    expect(flattenToolResult({ content: [], structuredContent: { ok: true } })).toBe(
      JSON.stringify({ ok: true }, null, 2),
    );
  });

  test('내용이 전혀 없어도 빈 문자열을 반환하지 않는다', () => {
    expect(flattenToolResult({ content: [] })).toBe('(결과 없음)');
    expect(flattenToolResult(undefined)).toBe('(결과 없음)');
  });

  test('isError를 실패로 구분한다', () => {
    expect(isToolResultError({ content: [], isError: true })).toBe(true);
    expect(isToolResultError({ content: [] })).toBe(false);
  });
});

describe('MCP 승인 게이트', () => {
  // 자동 모드가 기본값이 되면서 kind만으로는 아무것도 막지 못하게 됐다.
  // 게이트가 없으면 서버가 무엇을 하는지 모르는 채로 전부 자동 실행된다.

  test('읽기 전용이면 통과시킨다', () => {
    const gate = mcpApprovalGate('notion', {
      annotations: { readOnlyHint: true },
      name: 'search',
    });
    expect(gate()).toBeNull();
  });

  test('힌트가 없으면 자동 모드에서도 승인을 받는다', () => {
    const gate = mcpApprovalGate('notion', { name: 'delete_page' });
    expect(gate()?.severity).toBe('confirm');
  });

  test('되돌릴 수 있다는 표시만으로는 통과시키지 않고 분류기에 넘긴다', () => {
    // destructiveHint: false는 외부에 쓰지 않는다는 뜻이 아니다. 페이지를 만들거나
    // 메시지를 보내는 도구도 이렇게 표시될 수 있다
    const gate = mcpApprovalGate('notion', {
      annotations: { destructiveHint: false },
      name: 'create_page',
    });
    expect(gate()?.severity).toBe('classify');
  });

  test('사유에 서버와 도구 이름이 함께 보인다', () => {
    const gate = mcpApprovalGate('notion', { name: 'delete_page' });
    expect(gate()?.reason).toContain('notion');
    expect(gate()?.reason).toContain('delete_page');
  });
});

describe('MCP 도구 안내', () => {
  test('시스템 프롬프트에는 이름만 싣고 설명은 되풀이하지 않는다', () => {
    // 설명은 tool definitions로 이미 나간다. 프롬프트에도 실으면 매 요청 두 번 나간다
    const description = '아주 긴 설명 '.repeat(50);
    registerTool({
      description,
      execute: () => '',
      name: 'mcp__hinttest__lookup',
      parameters: { properties: {}, type: 'object' },
      source: 'hinttest',
    });
    try {
      const hint = buildToolHint('coding');
      expect(hint).toContain('mcp__hinttest__lookup');
      expect(hint).not.toContain('아주 긴 설명');
    } finally {
      unregisterToolSource('hinttest');
    }
  });
});
