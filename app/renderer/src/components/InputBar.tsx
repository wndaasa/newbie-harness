import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalRequest, CommandEntry } from '../types.ts';
import { ImageLightbox } from './ImageLightbox.tsx';
import { IconClose, IconSend, IconStop } from './Icon.tsx';

const MAX_VISIBLE_SUGGESTIONS = 5;

export function InputBar({
  approval,
  busy,
  commands,
  files,
  images,
  mode,
  onPasteFiles,
  onRemoveFile,
  onRemoveImage,
  onSubmit,
  statusLine,
  toolbarLeft,
  toolbarRight,
}: {
  approval: ApprovalRequest | null;
  busy: boolean;
  commands: CommandEntry[];
  /** 첨부 대기 중인 문서의 절대 경로 — 상태는 App이 소유 */
  files: string[];
  /** 첨부 대기 중인 이미지 (data URL) — 상태는 App이 소유 */
  images: string[];
  mode: string;
  onPasteFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onRemoveImage: (index: number) => void;
  onSubmit: (text: string) => void;
  /**
   * 상자 아래 상태 줄 (코딩 탭: 권한·모델·노력·컨텍스트). 채팅 탭은 이 줄 없이
   * 상자 안 도구 줄만 쓴다 — 세션 상태가 적어 상자 안이 더 단정하다
   */
  statusLine?: React.ReactNode;
  /** 입력창 안 도구 줄 왼쪽 (첨부) */
  toolbarLeft?: React.ReactNode;
  /** 같은 줄 오른쪽 (채팅 탭의 모델 칩). 전송 버튼은 이 뒤에 붙는다 */
  toolbarRight?: React.ReactNode;
}) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const draftBeforeHistory = useRef('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const suggestions = useMemo(
    () => getSuggestions(commands, input).slice(0, MAX_VISIBLE_SUGGESTIONS),
    [commands, input],
  );

  // 입력이 바뀌어 제안 목록이 달라지면 선택을 맨 위로 되돌림
  useEffect(() => {
    setSelectedIndex(0);
  }, [input]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    function resize() {
      if (!textarea) return;
      textarea.style.height = '0px';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
    // 화면 분할로 칸이 막 새로 생기는 순간엔 react-resizable-panels가 그 칸의
    // 실제 크기를 아직 확정하기 전이라, 바로 재면 max-height(45vh) 쪽 값을
    // 잘못 측정해 버린다(빈 칸인데 45vh로 잰 값이 인라인에 박혀 버려지지도
    // 못하고 남는다 — input이 그 뒤로 안 바뀌면 effect가 다시 안 도니까).
    // 다음 프레임으로 미뤄서 레이아웃이 확정된 뒤에 잰다
    const raf = requestAnimationFrame(resize);
    return () => cancelAnimationFrame(raf);
  }, [input]);

  // disabled로 잃은 포커스 복구 + 창이 다시 활성화될 때 입력창에 포커스
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy, approval]);

  useEffect(() => {
    function onWindowFocus() {
      inputRef.current?.focus();
    }
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, []);

  function submit() {
    const text = input.trim();
    setInput('');
    setHistoryIndex(-1);
    if (!text && images.length === 0 && files.length === 0) return;
    if (text) setHistory(previous => [...previous, text]);
    onSubmit(text);
  }

  function onPaste(event: React.ClipboardEvent) {
    const files = [...event.clipboardData.items]
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    event.preventDefault();
    onPasteFiles(files);
  }

  function complete(entry: CommandEntry) {
    setInput(entry.completion ?? entry.command);
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      if (suggestions.length > 0) {
        complete(suggestions[selectedIndex] ?? suggestions[0]);
      }
      return;
    }

    if (event.key === 'Enter') {
      if (event.shiftKey) return;
      event.preventDefault();
      // 제안이 떠 있고 입력이 아직 완성 전이면 Enter는 선택 항목을 완성함
      if (suggestions.length > 0) {
        const entry = suggestions[selectedIndex] ?? suggestions[0];
        if ((entry.completion ?? entry.command) !== input) {
          complete(entry);
          return;
        }
      }
      submit();
      return;
    }

    // 제안 목록이 보이는 동안 ↑/↓는 목록 선택 이동 (히스토리 탐색보다 우선)
    if (event.key === 'ArrowUp') {
      if (suggestions.length > 0) {
        event.preventDefault();
        setSelectedIndex(previous => (previous - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (history.length === 0 || input.includes('\n')) return;
      event.preventDefault();
      if (historyIndex === -1) draftBeforeHistory.current = input;
      const nextIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex]);
      return;
    }

    if (event.key === 'ArrowDown') {
      if (suggestions.length > 0) {
        event.preventDefault();
        setSelectedIndex(previous => (previous + 1) % suggestions.length);
        return;
      }
      if (historyIndex === -1 || input.includes('\n')) return;
      event.preventDefault();
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(-1);
        setInput(draftBeforeHistory.current);
      } else {
        setHistoryIndex(nextIndex);
        setInput(history[nextIndex]);
      }
    }
  }

  return (
    <div className="input-area">
      {suggestions.length > 0 && !approval && (
        <div className="suggestions">
          {suggestions.map((entry, index) => (
            <button
              className={index === selectedIndex ? 'suggestion selected' : 'suggestion'}
              key={entry.command}
              onClick={() => complete(entry)}
              onMouseEnter={() => setSelectedIndex(index)}
              type="button"
            >
              <span className="suggestion-command">{entry.command}</span>
              <span className="suggestion-description">{entry.description}</span>
            </button>
          ))}
        </div>
      )}

      {approval ? (
        <div className="approval-bar">
          <span className="approval-label">{approval.label}</span>
          <div className="approval-actions">
            <button onClick={() => window.newbie.approve(true)} type="button">
              허용 (y)
            </button>
            <button
              className="deny"
              onClick={() => window.newbie.approve(false)}
              type="button"
            >
              거부 (n)
            </button>
          </div>
        </div>
      ) : (
        <>
          {files.length > 0 && (
            <div className="attach-files">
              {files.map((path, index) => (
                <span className="attach-file" key={path} title={path}>
                  <span className="attach-file-name">{path.split(/[/\\]/).pop()}</span>
                  <button
                    aria-label="첨부 제거"
                    className="attach-file-remove"
                    onClick={() => onRemoveFile(index)}
                    type="button"
                  >
                    <IconClose size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="attach-previews">
              {images.map((image, index) => (
                <span className="attach-preview" key={index}>
                  <img
                    alt={`첨부 이미지 ${index + 1}`}
                    onClick={() => setZoomImage(image)}
                    src={image}
                  />
                  <button
                    aria-label="첨부 제거"
                    className="attach-remove"
                    onClick={() => onRemoveImage(index)}
                    type="button"
                  >
                    <IconClose size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="input-bar">
            {/*
              처리 중에도 입력을 막지 않는다. 보낸 메시지는 줄을 서서 다음 라운드에
              모델에게 전달된다 — 작업 도중 방향을 바꾸거나 정보를 보탤 수 있다
            */}
            <textarea
              autoFocus
              onChange={event => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={
                busy
                  ? '작업 중 — 보내면 다음 라운드에 전달됩니다'
                  : '메시지를 입력하세요 (/로 명령어, 이미지 붙여넣기 가능)'
              }
              ref={inputRef}
              rows={1}
              value={input}
            />
            {/*
              입력과 직접 관련된 것(첨부·전송)만 상자 안에 둔다. 세션 상태 칩은
              탭에 따라 statusLine(코딩) 또는 toolbarRight(채팅)로 들어온다.
            */}
            <div className="input-toolbar">
              <span className="input-toolbar-left">{toolbarLeft}</span>
              <span className="input-toolbar-right">
                {toolbarRight}
            {/* 처리 중에는 같은 자리를 중단 버튼으로 바꿔, 응답이 멈춰도
                사용자가 턴을 끊고 빠져나올 수 있게 함 */}
            {busy ? (
              <button
                aria-label="중단"
                className="send-button stop-button"
                onClick={() => window.newbie.cancel()}
                title="요청 중단 (Esc)"
                type="button"
              >
                <IconStop size={17} />
              </button>
            ) : (
              <button
                aria-label="전송"
                className="send-button"
                disabled={!input.trim() && images.length === 0}
                onClick={submit}
                type="button"
              >
                <IconSend onFill size={18} />
              </button>
            )}
              </span>
            </div>
          </div>
          {statusLine && <div className="input-status">{statusLine}</div>}
        </>
      )}
      {zoomImage && <ImageLightbox onClose={() => setZoomImage(null)} src={zoomImage} />}
    </div>
  );
}

function getSuggestions(commands: CommandEntry[], input: string): CommandEntry[] {
  if (!input.startsWith('/')) return [];
  const query = normalizeForSearch(input);
  if (!query) return commands;
  return commands.filter(entry => normalizeForSearch(entry.command).startsWith(query));
}

function normalizeForSearch(value: string) {
  return value.replace(/^\/+/, '').replace(/\s+/g, ' ').trimStart().toLowerCase();
}
