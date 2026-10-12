import type { ProviderOutput } from './types.ts';

// ── 공통 타입 ─────────────────────────────────────────────────────────────────

export type ToolCallResult = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * 인자 JSON이 중간에 잘려(응답 토큰 한도 등) 파싱하지 못했음.
   *
   * 예전에는 이런 호출을 조용히 버렸다. 그러면 모델이 긴 파일을 create_file 인자로
   * 만들다 잘렸을 때, 루프엔 텍스트만 남고 도구 호출이 사라져 "생성하겠습니다"만
   * 반복하는 정체가 됐다 — 모델은 자기 호출이 버려진 줄도 몰랐다. 버리지 않고
   * 표시만 해서, 루프가 "잘렸으니 나눠서 다시 하라"고 알려주게 한다.
   */
  truncated?: boolean;
};

export type StreamUsage = {
  inputTokens: number;
  /**
   * 입력 토큰 중 캐시에서 읽은 몫.
   *
   * 도구 정의와 시스템 프롬프트는 라운드마다 똑같이 다시 나가므로 캐시가 걸리면
   * 대부분이 여기로 잡힌다. 캐시가 깨지고 있는지 눈으로 확인하려고 따로 둔다.
   */
  cachedInputTokens?: number;
  outputTokens: number;
};

export type StreamResult = {
  text: string;
  toolCalls: ToolCallResult[];
  /** 프로바이더가 응답에 포함한 실측 토큰 수. 스트림에 없으면 undefined */
  usage?: StreamUsage;
  /**
   * 추론 요약 (OpenAI Responses의 reasoning summary). 원시 사고 과정이 아니라
   * 모델 쪽에서 만든 요약이고, 짧은 추론에서는 비어 올 수 있다. 화면 표시용이며
   * 프로바이더에 되돌려 보내지 않는다
   */
  reasoning?: string;
  /**
   * 프로바이더가 알려준 종료 사유. 정규화: 'stop' | 'length' | 'tool_calls' |
   * 'content_filter', 그 밖은 원문. 턴이 왜 거기서 끝났는지(특히 길이 상한에
   * 잘렸는지)를 세션에 남겨 나중에 볼 수 있게 한다
   */
  stopReason?: string;
};

/** Anthropic stop_reason을 OpenAI finish_reason 어휘로 맞춘다 */
function normalizeAnthropicStop(reason: string): string {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return reason;
}

// 스트림 청크 파싱 실패로 턴 전체가 죽지 않게 함. 프로바이더가 보낸 한 조각이
// 깨졌다고 해서 이미 받은 텍스트·도구 호출까지 버릴 이유는 없다.
function parseChunk(raw: string): any | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ── 도구 호출 지원 스트림 리더 ────────────────────────────────────────────────
//
// Anthropic SSE 포맷:
//   content_block_start  → type=tool_use 이면 새 tool call 시작
//   content_block_delta  → text_delta | input_json_delta
//   content_block_stop   → tool call 확정 (input JSON 파싱)
//   message_start        → usage.input_tokens (캐시 토큰 포함)
//   message_delta        → usage.output_tokens (누적값)
//
// OpenAI/LMStudio SSE 포맷:
//   delta.content           → 텍스트 청크
//   delta.reasoning_content → 추론 청크 (본문보다 먼저 온다). vLLM은 같은 것을
//                             delta.reasoning으로 보내므로 두 이름을 모두 받는다. llama.cpp를
//                             --reasoning-format deepseek 으로 띄웠을 때 생각이
//                             본문과 분리돼 이 필드로 온다. 분리하지 않으면
//                             <think> 태그가 그대로 본문에 섞여 화면과 이력을 더럽힌다
//   delta.tool_calls[]      → 도구 호출 청크 (index로 누산)
//   usage                   → stream_options.include_usage 켰을 때 마지막 청크에 포함
//
// OpenAI Responses SSE 포맷 (각 data의 type 필드로 구분):
//   response.output_text.delta             → 텍스트 청크 (delta)
//   response.output_item.added             → item.type=function_call 이면 새 도구 호출 (call_id, name)
//   response.function_call_arguments.delta → 인자 JSON 청크 (output_index로 누산)
//   response.function_call_arguments.done  → 인자 전체 (arguments)
//   response.output_item.done              → 항목 확정 (added를 놓쳤을 때의 보강용)
//   response.reasoning_summary_part.added  → 추론 요약의 새 단락 (둘째부터 빈 줄로 구분)
//   response.reasoning_summary_text.delta  → 추론 요약 청크 (delta) — 본문보다 먼저 온다
//   response.completed / .incomplete       → response.usage (input_tokens·output_tokens·cached_tokens)
//   response.failed / error                → 오류
//
// Ollama JSON-lines 포맷:
//   message.content      → 텍스트 청크
//   message.tool_calls   → done=true 일 때 최종 도구 호출 배열
//   prompt_eval_count/eval_count → done=true 메시지의 실측 토큰 수

export async function readAnthropicStream(
  body: ReadableStream<Uint8Array> | null,
  output: ProviderOutput,
): Promise<StreamResult> {
  if (!body) throw new Error('응답 스트림이 비어 있습니다.');

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let text = '';

  // index → 누산 중인 tool_use 블록
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  const toolCalls: ToolCallResult[] = [];
  let usage: StreamUsage | undefined;
  let stopReason: string | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const rawEvent of events) {
      const dataLines = rawEvent
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue;
        const ev = parseChunk(data);
        if (!ev) continue;

        if (ev.type === 'error') {
          throw new Error(ev.error?.message ?? '알 수 없는 Anthropic 오류');
        }

        if (ev.type === 'message_start' && ev.message?.usage) {
          const u = ev.message.usage;
          usage = {
            cachedInputTokens: u.cache_read_input_tokens ?? 0,
            inputTokens:
              (u.input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0),
            outputTokens: u.output_tokens ?? 0,
          };
        }

        if (ev.type === 'message_delta' && ev.usage) {
          usage = {
            cachedInputTokens: usage?.cachedInputTokens,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: ev.usage.output_tokens ?? usage?.outputTokens ?? 0,
          };
        }
        if (ev.type === 'message_delta' && typeof ev.delta?.stop_reason === 'string') {
          stopReason = normalizeAnthropicStop(ev.delta.stop_reason);
        }

        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          blocks.set(ev.index, {
            id: ev.content_block.id,
            name: ev.content_block.name,
            json: '',
          });
        }

        if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') {
            text += ev.delta.text;
            output.write(ev.delta.text);
          } else if (ev.delta?.type === 'input_json_delta') {
            const block = blocks.get(ev.index);
            if (block) block.json += ev.delta.partial_json;
          }
        }

        if (ev.type === 'content_block_stop') {
          const block = blocks.get(ev.index);
          if (block) {
            // 누적된 input JSON이 잘려도 버리지 않는다. 파싱되면 그대로, 안 되면
            // truncated로 표시해 루프가 "잘렸으니 나눠서 다시 하라"고 알려주게 한다
            const input = parseChunk(block.json || '{}');
            toolCalls.push(
              input !== undefined
                ? { id: block.id, name: block.name, input }
                : { id: block.id, name: block.name, input: {}, truncated: true },
            );
            blocks.delete(ev.index);
          }
        }
      }
    }
  }

  return { text, toolCalls, usage, ...(stopReason ? { stopReason } : {}) };
}

export async function readOpenAIStream(
  body: ReadableStream<Uint8Array> | null,
  output: ProviderOutput,
): Promise<StreamResult> {
  if (!body) throw new Error('응답 스트림이 비어 있습니다.');

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage: StreamUsage | undefined;
  let stopReason: string | undefined;

  // index → 누산 중인 tool call
  const tcMap = new Map<number, { id: string; name: string; args: string }>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const rawEvent of events) {
      const dataLines = rawEvent
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue;
        const ev = parseChunk(data);
        if (!ev) continue;

        if (ev.error) throw new Error(ev.error.message ?? '알 수 없는 OpenAI 오류');

        // usage 청크는 choices가 비어 있으므로 delta 검사보다 먼저 처리해야 함
        if (ev.usage) {
          usage = {
            cachedInputTokens: ev.usage.prompt_tokens_details?.cached_tokens ?? 0,
            inputTokens: ev.usage.prompt_tokens ?? 0,
            outputTokens: ev.usage.completion_tokens ?? 0,
          };
        }

        // 종료 사유 청크는 delta가 비어 있을 수 있어 delta 검사보다 먼저 본다
        const finish = ev.choices?.[0]?.finish_reason;
        if (typeof finish === 'string' && finish) stopReason = finish;

        const delta = ev.choices?.[0]?.delta;
        if (!delta) continue;

        // 추론 청크는 본문보다 먼저 오므로 먼저 처리한다. 받는 쪽이 없으면
        // (writeReasoning 미구현 출력) 조용히 버려진다 — ProviderOutput 계약대로다
        //
        // 두 이름을 모두 받는 이유: llama.cpp(--reasoning-format deepseek)는
        // reasoning_content로 보내는데 vLLM 0.28(--reasoning-parser)은 reasoning으로
        // 보낸다. 하나만 보면 다른 쪽에서는 생각이 통째로 사라진다 — 오류는 나지
        // 않고 "생각" 블록만 비어서 알아채기 어렵다
        const reasoningChunk = delta.reasoning_content ?? delta.reasoning;
        if (reasoningChunk) {
          reasoning += reasoningChunk;
          output.writeReasoning?.(reasoningChunk);
        }

        if (delta.content) {
          text += delta.content;
          output.write(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcMap.has(tc.index)) {
              tcMap.set(tc.index, { id: '', name: '', args: '' });
            }
            const entry = tcMap.get(tc.index)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      }
    }
  }

  // 인자 JSON이 잘려도 버리지 않는다. 파싱되면 그대로 쓰고, 안 되면 truncated로
  // 표시해 루프가 모델에게 "잘렸으니 나눠서 다시 하라"고 알려줄 수 있게 한다.
  // 버리면 도구 호출이 통째로 사라져 모델이 정체에 빠진다.
  const toolCalls: ToolCallResult[] = [...tcMap.values()].map(tc => {
    const parsed = parseChunk(tc.args || '{}');
    if (parsed !== undefined) return { id: tc.id, name: tc.name, input: parsed };
    return { id: tc.id, name: tc.name, input: {}, truncated: true };
  });

  return {
    text,
    toolCalls,
    usage,
    ...(reasoning ? { reasoning } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

export async function readOpenAIResponsesStream(
  body: ReadableStream<Uint8Array> | null,
  output: ProviderOutput,
): Promise<StreamResult> {
  if (!body) throw new Error('응답 스트림이 비어 있습니다.');

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage: StreamUsage | undefined;
  let stopReason: string | undefined;

  // output_index → 누산 중인 function_call. id 자리에는 call_id를 둔다 —
  // 세션 이력과 function_call_output이 이 값으로 짝을 맞춘다
  const tcMap = new Map<number, { id: string; name: string; args: string }>();
  const entryFor = (index: number) => {
    if (!tcMap.has(index)) tcMap.set(index, { id: '', name: '', args: '' });
    return tcMap.get(index)!;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const rawEvent of events) {
      const dataLines = rawEvent
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue;
        const ev = parseChunk(data);
        if (!ev) continue;

        switch (ev.type) {
          case 'error':
            throw new Error(ev.error?.message ?? ev.message ?? '알 수 없는 OpenAI 오류');
          case 'response.failed':
            throw new Error(ev.response?.error?.message ?? '알 수 없는 OpenAI 오류');
          case 'response.output_text.delta':
            if (typeof ev.delta === 'string' && ev.delta) {
              text += ev.delta;
              output.write(ev.delta);
            }
            break;
          case 'response.reasoning_summary_part.added':
            // 둘째 단락부터는 빈 줄로 띄운다. 안 그러면 단락이 한 덩어리로 붙는다
            if (reasoning) {
              reasoning += '\n\n';
              output.writeReasoning?.('\n\n');
            }
            break;
          case 'response.reasoning_summary_text.delta':
            if (typeof ev.delta === 'string' && ev.delta) {
              reasoning += ev.delta;
              output.writeReasoning?.(ev.delta);
            }
            break;
          case 'response.output_item.added':
          case 'response.output_item.done': {
            const item = ev.item;
            if (item?.type !== 'function_call') break;
            const entry = entryFor(ev.output_index);
            if (item.call_id) entry.id = item.call_id;
            if (item.name) entry.name = item.name;
            // done은 인자 전체를 들고 온다. delta를 놓쳤어도 여기서 맞춘다
            if (ev.type === 'response.output_item.done' && typeof item.arguments === 'string') {
              entry.args = item.arguments;
            }
            break;
          }
          case 'response.function_call_arguments.delta':
            if (typeof ev.delta === 'string') entryFor(ev.output_index).args += ev.delta;
            break;
          case 'response.function_call_arguments.done':
            if (typeof ev.arguments === 'string') entryFor(ev.output_index).args = ev.arguments;
            break;
          case 'response.completed':
          case 'response.incomplete': {
            if (ev.type === 'response.completed') {
              stopReason = 'stop';
            } else {
              const why = ev.response?.incomplete_details?.reason;
              stopReason =
                why === 'max_output_tokens'
                  ? 'length'
                  : why === 'content_filter'
                    ? 'content_filter'
                    : String(why ?? 'incomplete');
            }
            const u = ev.response?.usage;
            if (u) {
              usage = {
                cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
              };
            }
            break;
          }
          default:
            break;
        }
      }
    }
  }

  // chat 리더와 같은 이유로, 잘린 인자는 버리지 않고 truncated로 표시한다
  const toolCalls: ToolCallResult[] = [...tcMap.values()].map(tc => {
    const parsed = parseChunk(tc.args || '{}');
    if (parsed !== undefined) return { id: tc.id, name: tc.name, input: parsed };
    return { id: tc.id, name: tc.name, input: {}, truncated: true };
  });

  return {
    text,
    toolCalls,
    usage,
    ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

export async function readOllamaStream(
  body: ReadableStream<Uint8Array> | null,
  output: ProviderOutput,
): Promise<StreamResult> {
  if (!body) throw new Error('응답 스트림이 비어 있습니다.');

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let text = '';
  const toolCalls: ToolCallResult[] = [];
  let usage: StreamUsage | undefined;
  let stopReason: string | undefined;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const ev = parseChunk(trimmed);
    if (!ev) return;
    if (ev.error) throw new Error(ev.error);

    if (ev.done && typeof ev.prompt_eval_count === 'number') {
      usage = {
        inputTokens: ev.prompt_eval_count,
        outputTokens: ev.eval_count ?? 0,
      };
    }
    if (ev.done && typeof ev.done_reason === 'string') stopReason = ev.done_reason;

    const content = ev.message?.content ?? '';
    if (content) {
      text += content;
      output.write(content);
    }

    // Ollama는 done=true 메시지에 tool_calls를 포함시킴
    if (ev.message?.tool_calls) {
      for (const tc of ev.message.tool_calls) {
        toolCalls.push({
          id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: tc.function.name,
          input: tc.function.arguments,
        });
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  }
  if (buffer.trim()) processLine(buffer.trim());

  return { text, toolCalls, usage, ...(stopReason ? { stopReason } : {}) };
}
