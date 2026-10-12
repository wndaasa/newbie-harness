import type { ApprovalDecision, ToolKind } from '../tools/registry.ts';
import type { TabMode } from '../session/types.ts';

// 권한 모드: 도구 종류(kind)별로 자동 허용할지, 사용자 승인을 받을지 결정함
//   acceptEdits(편집 수락): 읽기·쓰기 자동 허용, 셸 실행만 승인 요청
//   ask(권한 요청):        읽기만 자동 허용, 쓰기·셸 실행은 승인 요청
//   auto(자동):            게이트가 confirm으로 올린 것만 승인 요청 (코딩 탭 기본값)
export type PermissionMode = 'acceptEdits' | 'ask' | 'auto';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * 탭별 기본 권한 모드.
 *
 * 코딩 탭은 자동이 기본이다. 되돌릴 수 없는 작업은 게이트가 confirm으로 올려
 * 자동 모드에서도 승인을 받으므로, 나머지를 매번 확인시키는 것은 이득 없이
 * 흐름만 끊는다.
 *
 * 채팅 탭도 같은 값을 쓴다. 별도 분기를 두지 않는 이유는 registry의 usableInMode가
 * 채팅에서 파일·셸 도구를 아예 목록에서 빼기 때문이다 — 자동으로 실행될 파괴적
 * 도구가 애초에 없어서, 여기서 모드를 낮춰도 달라지는 동작이 없다. 값이 갈려야 할
 * 이유가 생기면 이 함수만 고치면 된다.
 */
export function defaultPermissionMode(_tab: TabMode): PermissionMode {
  return DEFAULT_PERMISSION_MODE;
}

// 모드 선택 메뉴에 보여줄 순서. 왼쪽일수록 확인이 잦다
export const PERMISSION_MODES: PermissionMode[] = ['acceptEdits', 'ask', 'auto'];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  acceptEdits: '편집 수락',
  ask: '권한 요청',
  auto: '자동',
};

/**
 * 도구 실행 허용 여부.
 *
 * kind(도구가 하는 일)와 승인 판정(이번 입력이 위험한지)은 별개 축이다. 읽기
 * 도구라도 대상이 자격증명 파일이거나 사설망 주소면 승인을 받아야 하므로,
 * kind보다 게이트 판정을 먼저 본다.
 *
 * confirm 등급을 만나면 모드에 따라 갈린다.
 *
 *   auto:            deny — 묻지 않고 막고, 사유를 모델에게 알린다
 *   acceptEdits/ask: ask  — 사용자에게 승인 창을 띄운다
 *
 * classify 등급(허용목록 밖 셸 명령 등, 위험 단정은 아님)은 자동 모드에서만
 * 갈린다 — LLM 분류기가 판정하도록 classify를 돌려주고, 실제 호출은 루프가
 * 한다. 다른 모드에서는 confirm과 같이 승인 창이다.
 *
 * 자동 모드에서 승인 창을 띄우지 않는 이유는 그 모드를 켜는 목적이 자리를
 * 비우는 것이기 때문이다. 창을 띄워봐야 볼 사람이 없고, 턴은 거기서 멈춘다.
 * 대신 모델에게 왜 막혔는지 알려서 다른 방법을 찾게 하고, 정말 그 작업이
 * 필요하면 사용자에게 설명하고 멈추게 한다.
 *
 * 승인이라는 탈출구는 모드 쪽에 남겨 둔다 — 사용자가 '권한 요청'으로 바꾸면
 * 같은 작업에 승인 창이 뜬다. 자동 모드 안에서 예외를 만들지 않는 편이,
 * 무엇이 자동으로 실행되는지에 대한 약속을 지키기 쉽다.
 */
export function decideToolPermission(
  mode: PermissionMode,
  kind: ToolKind,
  approval?: ApprovalDecision,
): 'allow' | 'ask' | 'classify' | 'deny' {
  if (approval?.severity === 'confirm') return mode === 'auto' ? 'deny' : 'ask';
  if (approval?.severity === 'classify' && mode === 'auto') return 'classify';
  if (mode === 'auto') return 'allow';
  if (approval) return 'ask';
  if (kind === 'read') return 'allow';
  if (mode === 'acceptEdits' && kind === 'write') return 'allow';
  return 'ask';
}

// /mode 인자 파싱: 영문 약어와 한국어 표기를 모두 허용
export function normalizePermissionMode(value: string): PermissionMode | undefined {
  const normalized = value.trim().toLowerCase();
  if (['accept', 'acceptedits', 'edit', '편집', '편집 수락', '편집수락'].includes(normalized)) {
    return 'acceptEdits';
  }
  if (['ask', 'default', '권한', '권한 요청', '권한요청'].includes(normalized)) {
    return 'ask';
  }
  if (['auto', '자동'].includes(normalized)) {
    return 'auto';
  }
  return undefined;
}
