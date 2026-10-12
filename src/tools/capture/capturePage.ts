// 웹 페이지를 실제로 렌더링해서 화면을 찍는다.
//
// 에이전트가 만든 화면이 의도대로 나왔는지 확인하려면 눈이 있어야 한다. HTML을
// 텍스트로 읽는 것으론 레이아웃이 깨졌는지 알 수 없다.
//
// Electron이 이미 Chromium을 들고 있으므로 브라우저를 새로 붙이지 않고 화면 밖
// 창을 하나 띄워 capturePage로 찍는다. Electron 밖(테스트·스모크)에서는 electron
// 모듈이 없으므로 import를 실행 시점으로 미룬다.

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { approvalConfirm, registerTool } from '../registry.ts';
import { getWorkdir } from '../../agent/workdir.ts';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MAX_DIMENSION = 4000;
const LOAD_TIMEOUT_MS = 20_000;
/** 로드 완료 후 추가로 기다리는 시간. 폰트·이미지·초기 애니메이션이 앉을 시간 */
const SETTLE_MS = 400;
const MAX_CONSOLE_ERRORS = 10;
const MAX_CONSOLE_MESSAGE_CHARS = 300;

export type CapturePageOptions = {
  height?: number;
  /**
   * 열어볼 로컬 HTML 파일. 개발 서버가 없는 정적 파일을 확인할 때 쓴다.
   *
   * 이걸 안 받던 시절에는, 모델이 index.html을 만들어 놓고도 띄울 서버가 없어
   * 확인을 건너뛰고 "만들었습니다"로 끝냈다. 실제 앱에서 그 장면을 봤다.
   */
  path?: string;
  url?: string;
  width?: number;
};

function clampDimension(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.round(number), MAX_DIMENSION);
}

/** 루프백 주소인지. 개발 중인 화면을 확인하는 정상 경로라 승인 없이 통과시킨다 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/** 작업 폴더 밖의 파일인지. 밖이면 승인을 받는다 */
export function localPathApprovalReason(path: unknown): string | null {
  const text = String(path ?? '').trim();
  if (!text) return null;

  const abs = isAbsolute(text) ? text : resolve(getWorkdir(), text);
  const inside = relative(getWorkdir(), abs);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return `작업 폴더 밖의 파일을 엽니다: ${abs}`;
  }
  return null;
}

/**
 * 승인 사유 판정.
 *
 * 이 도구는 페이지의 스크립트를 실제로 실행한다. 자기가 만든 화면을 확인하는
 * 용도(루프백)는 그냥 통과시키고, 바깥 주소를 열 때만 승인을 받는다. web_fetch가
 * 루프백을 막는 것과 방향이 반대인데, 그쪽은 페이지 텍스트가 그대로 모델
 * 컨텍스트로 들어오는 자동 실행 도구라 기준이 다르다.
 */
export function capturePageApprovalReason(url: unknown): string | null {
  const text = String(url ?? '').trim();
  if (!text) return null;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null; // 형식 오류는 실행 시점에 알린다
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `http/https가 아닌 주소를 엽니다: ${text}`;
  }
  if (!isLoopbackUrl(text)) {
    return `외부 페이지를 열어 화면을 찍습니다: ${text}`;
  }
  return null;
}

export async function capturePage({
  height,
  path,
  url,
  width,
}: CapturePageOptions): Promise<{ consoleErrors: string[]; image: string; title: string }> {
  const target = String(url ?? '').trim();
  const localPath = String(path ?? '').trim();

  if (!target && !localPath) {
    throw new Error('url 또는 path 중 하나는 있어야 합니다.');
  }

  let file = '';
  if (localPath) {
    file = isAbsolute(localPath) ? localPath : resolve(getWorkdir(), localPath);
    if (!existsSync(file)) throw new Error(`파일을 찾을 수 없습니다: ${file}`);
  } else {
    const parsed = new URL(target); // 형식이 틀리면 여기서 예외
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`http 또는 https 주소만 열 수 있습니다: ${target}`);
    }
  }

  // Electron 밖에서는 이 도구를 쓸 수 없다 (bun test·smoke 경로)
  let electron: typeof import('electron');
  try {
    electron = await import('electron');
  } catch {
    throw new Error('화면 캡처는 앱(Electron)에서만 쓸 수 있습니다.');
  }
  if (!electron.BrowserWindow) {
    throw new Error('화면 캡처는 앱(Electron)에서만 쓸 수 있습니다.');
  }

  const window = new electron.BrowserWindow({
    height: clampDimension(height, DEFAULT_HEIGHT),
    show: false,
    webPreferences: {
      // 페이지 스크립트가 우리 쪽 권한을 물려받지 않도록 격리한다
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: clampDimension(width, DEFAULT_WIDTH),
  });

  // 페이지가 콘솔에 남긴 오류. 스크린샷만 보면 "빈 화면"의 원인을 알 수 없다 —
  // 번들 404, 런타임 예외, CORS 거부는 전부 콘솔에만 찍힌다. 리스너는 load 전에
  // 걸어야 초기 스크립트 오류까지 잡힌다
  const consoleErrors: string[] = [];
  // 첫 인자(details)에 level·message·sourceId가 들어 있다. 뒤따르는 위치 인자들은
  // 같은 값의 옛 형태라 쓰지 않는다
  window.webContents.on('console-message', details => {
    if (details.level !== 'error') return;
    if (consoleErrors.length >= MAX_CONSOLE_ERRORS) return;
    const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : '';
    consoleErrors.push(`${details.message.slice(0, MAX_CONSOLE_MESSAGE_CHARS)}${where}`);
  });

  try {
    await withTimeout(
      file ? window.loadFile(file) : window.loadURL(target),
      LOAD_TIMEOUT_MS,
      `페이지를 여는 데 실패했습니다: ${file || target}`,
    );
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

    const image = await window.webContents.capturePage();
    return {
      consoleErrors,
      image: `data:image/png;base64,${image.toPNG().toString('base64')}`,
      title: window.webContents.getTitle(),
    };
  } finally {
    // 창을 남기면 프로세스가 계속 뜬 채로 쌓인다
    if (!window.isDestroyed()) window.destroy();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

registerTool({
  name: 'capture_page',
  kind: 'read',
  // 이 도구는 페이지의 스크립트를 실제로 실행한다. 바깥 주소를 열거나 작업 폴더
  // 밖 파일을 여는 것은 자동 모드에서도 승인을 받는다
  approvalGate: ({ path, url }) => {
    const reason = path ? localPathApprovalReason(path) : capturePageApprovalReason(url);
    return reason ? approvalConfirm(reason) : null;
  },
  description:
    '웹 페이지나 HTML 파일을 실제로 렌더링해서 화면을 이미지로 돌려줍니다. 만든 화면이 의도대로 보이는지 직접 확인할 때 쓰세요. 개발 서버가 있으면 start_process로 띄운 뒤 url로, 그냥 HTML 파일이면 path로 바로 열면 됩니다. 외부 주소나 작업 폴더 밖의 파일은 승인을 받습니다.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '열어볼 주소 (예: http://localhost:5173)' },
      path: { type: 'string', description: '열어볼 HTML 파일 경로 (예: demo/index.html)' },
      width: { type: 'string', description: '가로 픽셀 (기본 1280)' },
      height: { type: 'string', description: '세로 픽셀 (기본 800)' },
    },
    required: [],
  },
  async execute({ height, path, url, width }) {
    const { consoleErrors, image, title } = await capturePage({ height, path, url, width });
    return {
      images: [image],
      text: [
        `화면을 찍었습니다: ${path || url}`,
        title ? `제목: ${title}` : '',
        consoleErrors.length
          ? `콘솔 오류 ${consoleErrors.length}건:\n${consoleErrors.map(line => `- ${line}`).join('\n')}`
          : '콘솔 오류 없음',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});
