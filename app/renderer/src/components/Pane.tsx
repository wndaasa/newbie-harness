import React from 'react';
import { HomeHero } from './HomeHero.tsx';
import { IconPlus } from './Icon.tsx';
import { InputBar } from './InputBar.tsx';
import {
  ContextRing,
  EffortChip,
  ModelChip,
  PermissionChip,
} from './StatusMenus.tsx';
import { Transcript } from './Transcript.tsx';
import { WorkspaceChips } from './WorkspaceChips.tsx';
import type {
  AgentStatus,
  ApprovalRequest,
  GitDiffSummary,
  InitialState,
  ReasoningEffortEntry,
  TokenUsage,
  TranscriptRow,
  WorkspaceInfo,
} from '../types.ts';

/** 화면 분할의 칸 하나가 쥐는, 그 세션만의 상태 */
export type PaneState = {
  rows: TranscriptRow[];
  status: AgentStatus | null;
  approval: ApprovalRequest | null;
  busy: boolean;
  mode: string;
  permissionMode: string;
  turnTokens: number | null;
  sessionMeta: {
    model: string;
    provider: string;
    reasoningEffort: string | null;
    reasoningEfforts: ReasoningEffortEntry[];
  } | null;
  /** 컨텍스트 게이지 값 — 포커스된 칸만 실제 값을 받는다 (그 외 null) */
  tokens: TokenUsage | null;
  attachedImages: string[];
  /** 첨부 대기 중인 문서의 절대 경로 — 내용이 아니라 경로를 보내고 에이전트가 도구로 읽는다 */
  attachedFiles: string[];
};

const MAX_ATTACHED_IMAGES = 4;
/**
 * 파일 선택창의 기본 필터. 이미지는 그림째 모델에 들어가고, 나머지는 경로만
 * 넘어가 에이전트가 read_file·parse_document로 읽는다(parse_document가 다루는
 * 형식은 read/readFile.ts). 채팅 탭에도 읽기 도구는 있어 문서를 같이 받는다
 */
const ATTACH_ACCEPT = 'image/*,.hwp,.hwpx,.pdf,.xlsx,.xls,.docx,.txt,.md,.csv,.json';
/** 화면 분할: 세션을 칸으로 끌어다 놓을 때 dataTransfer에 싣는 형식 */
const DRAG_MIME = 'application/x-newbie-session';

/**
 * 화면 분할의 한 칸. 자기 세션의 대화·입력만 담당한다. 상태는 App이 sessionId로
 * 라우팅해 넘겨주고, 사용자 조작(입력·승인·칩)은 콜백으로 올려 보낸다. 칸이
 * 하나뿐일 때는 헤더 없이 예전과 똑같은 화면이 된다. 크기 조절·드롭은 바깥의
 * PaneGrid가 맡는다
 */
export function Pane({
  sessionName,
  state,
  initial,
  showHeader,
  workspace,
  diffSummary,
  notice,
  agentActiveId,
  onClose,
  onHeaderMouseDown,
  onSubmit,
  onAttachImages,
  onRemoveImage,
  onRemoveFile,
  onSetPermissionMode,
  onSetProvider,
  onSetModel,
  onSetReasoningEffort,
  onOpenAgent,
  onOpenSettings,
  onOpenProviderSettings,
  onOpenDiff,
  providerReady,
}: {
  sessionName: string;
  state: PaneState;
  initial: InitialState;
  showHeader: boolean;
  workspace: WorkspaceInfo | null;
  diffSummary: GitDiffSummary | null;
  notice: string;
  agentActiveId: string | null;
  onClose: () => void;
  /** 헤더를 눌러 칸 자리 바꾸기 시작 (마우스 추적 방식 — 네이티브 드래그 대신) */
  onHeaderMouseDown: (event: React.MouseEvent) => void;
  onSubmit: (text: string) => void;
  onAttachImages: (files: Iterable<File>) => void;
  onRemoveImage: (index: number) => void;
  onRemoveFile: (index: number) => void;
  onSetPermissionMode: (mode: string) => void;
  onSetProvider: (name: string) => void;
  onSetModel: (name: string) => void;
  onSetReasoningEffort: (value: string) => void;
  onOpenAgent: (id: string) => void;
  onOpenSettings: () => void;
  /** 홈 화면 연결 안내의 버튼: 설정창을 제공자 탭으로 연다 */
  onOpenProviderSettings: () => void;
  onOpenDiff: () => void;
  /** 지금 제공자로 대화할 수 있는가. false면 홈 화면에 연결 안내를 띄운다 */
  providerReady: boolean;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  // 이 칸의 성격은 자기 세션의 mode로 정한다 — 사이드바 탭(전역)이 아니다
  const paneTab = state.mode === 'chat' ? 'chat' : 'agent';
  const hasConversation = state.rows.some(row => row.role !== 'system');
  const atHome =
    state.rows.every(row => row.role === 'system') && !state.status && !state.approval;
  const chatLanding = paneTab === 'chat' && atHome;

  const permissionLabel =
    initial.permissionModes.find(entry => entry.value === state.permissionMode)?.label ??
    state.permissionMode;
  const model = state.sessionMeta?.model ?? initial.model;
  const provider = state.sessionMeta?.provider ?? initial.provider;
  const reasoningEffort = state.sessionMeta
    ? state.sessionMeta.reasoningEffort
    : initial.reasoningEffort;
  // 선택지는 main이 제공자·모델별로 정해 보낸다 (Anthropic은 Models API로 조회한 단계)
  const efforts = state.sessionMeta?.reasoningEfforts ?? initial.reasoningEfforts;

  return (
    <div className={`pane-inner${chatLanding ? ' chat-landing' : ''}`}>
      {showHeader && (
        <div
          className="pane-header"
          onMouseDown={event => {
            // 닫기 버튼 위에서 누른 거면 자리 바꾸기를 시작하지 않고 버튼 클릭으로 둔다
            if ((event.target as HTMLElement).closest('.pane-close')) return;
            onHeaderMouseDown(event);
          }}
        >
          <span className="pane-title" title={sessionName}>
            {sessionName}
          </span>
          <button aria-label="칸 닫기" className="pane-close" onClick={onClose} type="button">
            <svg fill="none" height="12" viewBox="0 0 12 12" width="12">
              <path
                d="M3 3l6 6M9 3l-6 6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.4"
              />
            </svg>
          </button>
        </div>
      )}

      <div className="chat-panel">
        {atHome ? (
          <HomeHero
            chat={paneTab === 'chat'}
            hasSessions
            notices={state.rows.map(row => row.content)}
            onOpenProviderSettings={onOpenProviderSettings}
            onSubmit={onSubmit}
            providerReady={providerReady}
          />
        ) : (
          <Transcript
            activeAgentId={agentActiveId}
            approval={state.approval}
            onOpenAgent={onOpenAgent}
            onOpenSettings={onOpenSettings}
            rows={state.rows.filter(row => !row.homeOnly)}
            status={state.status}
            turnTokens={state.turnTokens}
          />
        )}

        <div className="bottom-dock">
          {workspace && paneTab !== 'chat' && (
            <WorkspaceChips
              // 대화 전 첫 화면에는 폴더 고르기만 둔다. 변경량은 대화가 시작된 뒤에 보인다
              diffSummary={hasConversation ? diffSummary : null}
              folderLocked={hasConversation}
              onOpenDiff={onOpenDiff}
              workspace={workspace}
            />
          )}
          <InputBar
            approval={state.approval}
            busy={state.busy}
            commands={initial.commands}
            files={state.attachedFiles}
            images={state.attachedImages}
            mode={state.mode}
            onPasteFiles={onAttachImages}
            onRemoveFile={onRemoveFile}
            onRemoveImage={onRemoveImage}
            onSubmit={onSubmit}
            statusLine={
              paneTab !== 'chat' && (
                <>
                  <span className="input-status-left">
                    <PermissionChip
                      flat
                      label={permissionLabel}
                      modes={initial.permissionModes}
                      onSelect={onSetPermissionMode}
                      permissionMode={state.permissionMode}
                    />
                  </span>
                  <span className="input-status-right">
                    <ModelChip
                      model={model}
                      onSelectProvider={onSetProvider}
                      onSubmitModel={onSetModel}
                      provider={provider}
                      providers={initial.providers}
                    />
                    {reasoningEffort !== null && (
                      <EffortChip
                        effort={reasoningEffort}
                        efforts={efforts}
                        onSelect={onSetReasoningEffort}
                      />
                    )}
                    {state.tokens && <ContextRing tokens={state.tokens} />}
                  </span>
                </>
              )
            }
            toolbarLeft={
              <>
                <input
                  accept={ATTACH_ACCEPT}
                  hidden
                  multiple
                  onChange={event => {
                    onAttachImages(event.target.files ?? []);
                    event.target.value = '';
                  }}
                  ref={fileRef}
                  type="file"
                />
                <button
                  aria-label="파일 첨부"
                  className="attach-button"
                  disabled={state.busy}
                  onClick={() => fileRef.current?.click()}
                  title="파일 첨부 — 이미지는 붙여넣기도 가능, 문서(hwp·xlsx·pdf 등)는 경로가 전달됩니다"
                  type="button"
                >
                  <IconPlus size={15} />
                </button>
              </>
            }
            toolbarRight={
              paneTab === 'chat' && (
                <ModelChip
                  effort={reasoningEffort}
                  efforts={efforts}
                  model={model}
                  onSelectEffort={onSetReasoningEffort}
                  onSelectProvider={onSetProvider}
                  onSubmitModel={onSetModel}
                  provider={provider}
                  providers={initial.providers}
                />
              )
            }
          />
          {notice && <div className="input-notice">{notice}</div>}
        </div>
      </div>
    </div>
  );
}

export { DRAG_MIME, MAX_ATTACHED_IMAGES };
