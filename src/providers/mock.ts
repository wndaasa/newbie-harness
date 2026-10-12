import { setTimeout as sleep } from 'node:timers/promises';
import type { StreamResult } from './streams.ts';
import type { ProviderContext } from './types.ts';

export async function runMockTurn(
  userText: string,
  turnCount: number,
  { output }: ProviderContext,
): Promise<StreamResult> {
  // 도구 흐름 테스트용: 사용자 입력에 [도구]가 있으면 첫 턴에서 read 도구를 호출함.
  // 도구 결과가 돌아온 다음 턴(마지막 메시지가 도구 결과)에서는 일반 텍스트로 마무리됨.
  if (String(userText).includes('[도구]')) {
    return {
      text: '',
      toolCalls: [
        { id: `mock-tool-${turnCount}`, name: 'get_file_info', input: { path: 'package.json' } },
      ],
    };
  }

  // 명령 실행 UI("$ 명령" 프롬프트 표시) 테스트용
  if (String(userText).includes('[명령]')) {
    return {
      text: '',
      toolCalls: [
        { id: `mock-cmd-${turnCount}`, name: 'run_command', input: { command: 'git status' } },
      ],
    };
  }

  // 목록 도구 UI([FILE]/[DIR] 정리 표시) 테스트용
  if (String(userText).includes('[목록]')) {
    return {
      text: '',
      toolCalls: [
        { id: `mock-list-${turnCount}`, name: 'list_files', input: { path: '.' } },
      ],
    };
  }

  // 채팅 영역 마크다운·코드 하이라이트 렌더링 테스트용
  if (String(userText).includes('[마크다운]')) {
    const sample = [
      '마크다운 렌더링 예시입니다.',
      '',
      '- `인라인 코드`와 **굵은 글씨**',
      '- 코드 블록 하이라이트:',
      '',
      '```json',
      '{',
      '  "name": "my_new_tool",',
      '  "description": "내가 만든 툴 설명",',
      '  "required": ["foo"]',
      '}',
      '```',
    ].join('\n');
    output.write(sample);
    return { text: sample, toolCalls: [] };
  }

  const text =
    `모의 응답입니다. 이번 세션의 ${turnCount}번째 메시지로 다음 내용을 보내셨습니다: "${userText}". ` +
    '대화 기록은 세션을 재개하면 이어집니다.';

  for (const char of text) {
    output.write(char);
    await sleep(8);
  }

  return { text, toolCalls: [] };
}
