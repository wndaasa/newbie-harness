// MCP 서버가 알려준 도구를 Newbie 도구 레지스트리 형식으로 옮긴다.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  ApprovalDecision,
  ToolDef,
  ToolInput,
  ToolKind,
  ToolParameters,
} from '../tools/registry.ts';
import { approvalClassify, approvalConfirm } from '../tools/registry.ts';

/** 프로바이더가 받는 도구 이름 길이 상한 (Anthropic 기준) */
const MAX_TOOL_NAME = 64;
const NAME_PREFIX = 'mcp';
const MAX_RESULT_CHARS = 30_000;

/** 서버가 알려주는 도구. SDK 스키마 중 여기서 쓰는 필드만 추림 */
export type McpToolInfo = {
  annotations?: {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
    title?: string;
  };
  description?: string;
  inputSchema?: unknown;
  name: string;
  title?: string;
};

/**
 * 도구 이름을 mcp__<서버>__<도구>로 만든다.
 *
 * 자체 도구와 이름이 겹치지 않게 하고, 어느 서버에서 온 도구인지 UI와 승인
 * 화면에서 바로 보이게 하기 위함이다. 길이 상한을 넘으면 도구 이름 쪽을 줄인다.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const server = sanitizeNamePart(serverName);
  const prefix = `${NAME_PREFIX}__${server}__`;
  const tool = sanitizeNamePart(toolName).slice(0, Math.max(1, MAX_TOOL_NAME - prefix.length));
  return `${prefix}${tool}`;
}

/**
 * 승인 정책용 종류 판정.
 *
 * MCP 도구는 외부 서비스를 바꿀 수 있고 서버가 무엇을 하는지 우리가 알 수 없다.
 * readOnlyHint로 읽기 전용임이 확인된 것만 자동 허용 대상(read)으로 두고,
 * 힌트가 없거나 false면 실행 전 승인을 받도록 execute로 본다.
 */
export function mcpToolKind(tool: McpToolInfo): ToolKind {
  return tool.annotations?.readOnlyHint === true ? 'read' : 'execute';
}

/**
 * MCP 도구의 승인 판정.
 *
 * kind만으로는 자동 모드를 막지 못한다. 자동 모드가 기본값이 되기 전에는
 * execute라는 표시만으로 승인 창이 떴지만, 이제는 게이트가 confirm으로 올린
 * 것만 올라온다. 게이트가 없으면 서버가 무엇을 하는지 모르는 채로 전부 자동
 * 실행된다 — 문서를 지우든 메시지를 보내든.
 *
 * 그래서 readOnlyHint: true인 도구만 그냥 통과시킨다. destructiveHint: false는
 * "되돌릴 수 있다"는 뜻일 뿐 외부에 쓰지 않는다는 뜻이 아니다 — 페이지를 만들거나
 * 메시지를 보내는 도구도 그렇게 표시될 수 있으므로 분류기가 요청과 맞는지 본다.
 * 힌트가 없으면 MCP 명세상 destructiveHint의 기본값이 true라 confirm으로 둔다.
 */
export function mcpApprovalGate(serverName: string, tool: McpToolInfo) {
  return (): ApprovalDecision => {
    const annotations = tool.annotations ?? {};
    if (annotations.readOnlyHint === true) return null;

    const label = tool.title ?? tool.name;
    if (annotations.destructiveHint === false) {
      return approvalClassify(
        `${serverName} 서버의 '${label}'을(를) 실행합니다. 외부 서비스에 쓸 수 있습니다 (서버는 되돌릴 수 있다고 표시).`,
      );
    }

    return approvalConfirm(
      `${serverName} 서버의 '${label}'을(를) 실행합니다. 외부 서비스를 바꿀 수 있습니다.`,
    );
  };
}

/** 서버가 준 JSON Schema를 그대로 쓰되, object 스키마 형태만 보장한다 */
export function mcpToolParameters(schema: unknown): ToolParameters {
  const record =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : {};
  const properties =
    record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? (record.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = Array.isArray(record.required)
    ? record.required.filter((item): item is string => typeof item === 'string')
    : [];

  return { properties, required, type: 'object' };
}

/**
 * tools/call 결과에서 이미지 블록을 data URL로 뽑아낸다.
 *
 * 브라우저 조작 계열 MCP 서버는 스크린샷을 이 블록으로 돌려준다. 텍스트로만
 * 펴면 모델이 화면을 볼 수 없으므로 따로 건져 도구 결과에 싣는다.
 */
export function extractToolResultImages(result: unknown): string[] {
  const record =
    result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  if (!Array.isArray(record.content)) return [];

  const images: string[] = [];
  for (const block of record.content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type !== 'image') continue;
    if (typeof item.data !== 'string' || typeof item.mimeType !== 'string') continue;
    if (!item.mimeType.startsWith('image/')) continue;
    images.push(`data:${item.mimeType};base64,${item.data}`);
  }
  return images;
}

/** tools/call 결과의 content 블록을 도구 결과 텍스트로 폅니다 */
export function flattenToolResult(result: unknown): string {
  const record =
    result && typeof result === 'object' ? (result as Record<string, unknown>) : {};

  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item.type === 'image') {
        // 이미지는 extractToolResultImages가 따로 싣는다. 텍스트 쪽에는 자리만 남겨
        // 모델이 결과에 그림이 딸려 왔다는 걸 알게 한다
        parts.push('[이미지]');
      } else if (item.type === 'resource_link' && typeof item.uri === 'string') {
        parts.push(`[리소스] ${item.uri}`);
      } else if (item.type === 'resource') {
        const resource = item.resource as Record<string, unknown> | undefined;
        // 텍스트 리소스는 본문을, 바이너리는 위치만 남긴다
        parts.push(
          typeof resource?.text === 'string'
            ? String(resource.text)
            : `[리소스] ${String(resource?.uri ?? '')}`,
        );
      } else if (typeof item.type === 'string') {
        parts.push(`[${item.type}]`);
      }
    }
  }

  // 텍스트 블록 없이 structuredContent만 주는 서버가 있어 그대로 직렬화한다
  if (parts.length === 0 && record.structuredContent !== undefined) {
    parts.push(JSON.stringify(record.structuredContent, null, 2));
  }

  const text = parts.join('\n').trim();
  if (!text) return '(결과 없음)';
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n...(결과가 길어 ${text.length - MAX_RESULT_CHARS}자 생략됨)`
    : text;
}

export function isToolResultError(result: unknown): boolean {
  return Boolean(
    result && typeof result === 'object' && (result as Record<string, unknown>).isError === true,
  );
}

export function buildMcpToolDef(
  serverName: string,
  client: Client,
  tool: McpToolInfo,
): ToolDef {
  const label = tool.title ?? tool.annotations?.title ?? tool.name;
  return {
    description: [
      `[MCP: ${serverName}] ${label}`,
      tool.description?.trim() || '설명이 제공되지 않은 도구입니다.',
    ].join('\n'),
    async execute(input: ToolInput) {
      const result = await client.callTool({
        arguments: input,
        name: tool.name,
      });
      const text = flattenToolResult(result);
      // 서버가 isError로 표시한 실패는 루프가 실패로 다루도록 예외로 올린다
      if (isToolResultError(result)) throw new Error(text);
      return { images: extractToolResultImages(result), text };
    },
    approvalGate: mcpApprovalGate(serverName, tool),
    kind: mcpToolKind(tool),
    name: mcpToolName(serverName, tool.name),
    parameters: mcpToolParameters(tool.inputSchema),
    source: serverName,
  };
}

function sanitizeNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}
