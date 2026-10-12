// 앱 스모크 검증 하니스.
//
// 프로덕션 진입점(index.ts)에 두면 executeJavaScript 호출과 파일 쓰기가
// 배포 번들에 그대로 들어가므로, NEWBIE_APP_SMOKE=1일 때만 동적으로 불러온다.
import { errorMessage } from '../../src/utils/errors.ts';
import { writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

export function attachSmokeHarness(win: BrowserWindow, quit: () => void) {
  // 렌더러 로드 → 입력 제출 → 에이전트 응답 DOM 반영까지 왕복 확인
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[renderer] ${message}`);
  });
  win.webContents.on('did-finish-load', async () => {
    const evaluate = (code: string) => win.webContents.executeJavaScript(code);
    try {
      console.log(
        '[smoke] bridge:',
        await evaluate(`typeof window.newbie`),
        'root:',
        await evaluate(`document.getElementById('root')?.innerHTML.slice(0, 80)`),
      );
      await waitFor(() => evaluate(`!!document.querySelector('.input-bar textarea')`));
      await evaluate(`window.newbie.submit('안녕하세요')`);
      await waitFor(() =>
        evaluate(
          `document.querySelectorAll('.row-assistant').length > 0 && !document.querySelector('.status-line')`,
        ),
      );
      const reply = await evaluate(
        `document.querySelector('.row-assistant-body')?.textContent ?? ''`,
      );
      if (!String(reply).includes('모의 응답')) {
        throw new Error(`예상과 다른 응답 — ${reply}`);
      }
      // 슬래시 커맨드 라우팅도 왕복 확인
      await evaluate(`window.newbie.submit('/help')`);
      await waitFor(() =>
        evaluate(
          `[...document.querySelectorAll('.row-system')].some(el => el.textContent.includes('사용 가능한 명령어'))`,
        ),
      );
      // 도구 호출 → 그룹 요약 UI 왕복 확인 (mock의 [도구] 트리거)
      await evaluate(`window.newbie.submit('[도구] 파일 정보 확인')`);
      await waitFor(() =>
        evaluate(
          `!!document.querySelector('.tool-group') && !document.querySelector('.status-line')`,
        ),
      );
      // 마크다운 렌더링 + 코드 하이라이트 왕복 확인 (mock의 [마크다운] 트리거)
      await evaluate(`window.newbie.submit('[마크다운] 렌더링 확인')`);
      await waitFor(() =>
        evaluate(
          `!!document.querySelector('.row-assistant .md .code-block .hljs-attr') && !document.querySelector('.status-line')`,
        ),
      );
      // 권한 칩 클릭 → 미니 메뉴가 열리는지 확인.
      // 코딩 탭의 권한 칩은 상자 아래 상태 줄(.input-status-left)에 flat 형태로
      // 렌더돼 클래스가 status-flat이다 (StatusMenus.tsx의 PermissionChip).
      // 셀렉터가 어긋나면 ?.click()이 조용히 넘어가 메뉴 대기에서 시간 초과로 실패한다.
      await evaluate(`document.querySelector('.input-status-left .status-flat')?.click()`);
      await waitFor(() => evaluate(`!!document.querySelector('.chip-menu')`));
      // UI 확인용 스크린샷 (경로가 지정된 경우에만). 도구 그룹을 펼치고
      // 첫 항목 상세까지 연 상태로 찍음. 숨김 창은 페인트가 갱신되지
      // 않아 캡처 직전에만 창을 띄움.
      if (process.env.NEWBIE_APP_SHOT) {
        await evaluate(`document.querySelector('.chip-menu-overlay')?.click()`);
        // 목록 도구의 [FILE]/[DIR] 정리 표시까지 화면에 담음
        await evaluate(`window.newbie.submit('[목록] 파일 목록 확인')`);
        await waitFor(() =>
          evaluate(
            `document.querySelectorAll('.tool-group').length >= 2 && !document.querySelector('.status-line')`,
          ),
        );
        await evaluate(`[...document.querySelectorAll('.tool-summary')].at(-1)?.click()`);
        await waitFor(() => evaluate(`!!document.querySelector('.tool-item')`));
        await evaluate(`[...document.querySelectorAll('.tool-item-head')].at(-1)?.click()`);
        await waitFor(() => evaluate(`!!document.querySelector('.tool-item-detail')`));
        // 명령 실행 상세("$ 명령" 표시)까지 담음 — 승인 요청은 자동 허용
        await evaluate(`window.newbie.submit('[명령] 명령 실행 확인')`);
        await waitFor(() => evaluate(`!!document.querySelector('.approval-line')`));
        await evaluate(`window.newbie.approve(true)`);
        await waitFor(() =>
          evaluate(
            `document.querySelectorAll('.tool-group').length >= 3 && !document.querySelector('.status-line')`,
          ),
        );
        await evaluate(`[...document.querySelectorAll('.tool-summary')].at(-1)?.click()`);
        await evaluate(`[...document.querySelectorAll('.tool-item-head')].at(-1)?.click()`);
        await waitFor(() => evaluate(`!!document.querySelector('.tool-cmd')`));
        win.show();
        await new Promise(resolve => setTimeout(resolve, 700));
        const image = await win.webContents.capturePage();
        writeFileSync(process.env.NEWBIE_APP_SHOT, image.toPNG());
      }
      // 화면 분할 왕복 확인 — 기본 스모크와 분리(NEWBIE_APP_SPLIT일 때만).
      // 사이드바 세션을 드래그해 새 칸을 만들고, 두 칸이 각자 대화를 담는지 본다
      if (process.env.NEWBIE_APP_SPLIT) {
        await runSplitCheck(evaluate, win);
      }
      console.log('NEWBIE_APP_SMOKE_OK');
    } catch (error) {
      console.log(`NEWBIE_APP_SMOKE_FAIL: ${errorMessage(error)}`);
    }
    quit();
  });
}

// 화면 분할: 사이드바 세션을 끌어 새 칸을 만드는 흐름을 합성 드래그로 검증한다.
// 현재 대화(A)는 이미 메시지가 있어 사이드바에 있다. 새 대화(B)를 열어 포커스를
// B로 옮긴 뒤, 사이드바의 A를 칸 가장자리에 떨궈 두 번째 칸을 만든다
// executeJavaScript는 임의 값을 돌려주므로(문자열 신호·불리언 조건 혼용) any로 받는다
async function runSplitCheck(evaluate: (code: string) => Promise<any>, win: BrowserWindow) {
  // 새 대화(B)로 전환 — 사이드바 "새 대화" 버튼(App의 칸 갱신 경로를 탄다)
  await evaluate(`document.querySelector('.new-chat')?.click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.session-item').length >= 1`));
  // 첫 사이드바 세션(A)을 끌면 새 칸 자리(고스트 슬롯)가 떠야 한다
  const dragged = await evaluate(`(() => {
    const item = document.querySelector('.session-item');
    if (!item) return 'no-item';
    const dt = new DataTransfer();
    item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    return 'ok';
  })()`);
  if (dragged !== 'ok') throw new Error(`분할: 드래그할 세션 없음 (${dragged})`);
  await waitFor(() => evaluate(`!!document.querySelector('.pane-cell.ghost')`));
  // 고스트 슬롯에 드롭 → 새 칸 추가
  await evaluate(`(() => {
    const item = document.querySelector('.session-item');
    const ghost = document.querySelector('.pane-cell.ghost');
    const dt = new DataTransfer();
    // Sidebar의 onDragStart가 이 dt에 sessionId를 setData 한다. 같은 dt를
    // dragover·drop에 넘겨 드롭 대상이 getData로 읽게 한다
    item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    ghost.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    ghost.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  })()`);
  // 두 칸이 생기고 각 칸에 헤더가 붙어야 한다
  await waitFor(() => evaluate(`document.querySelectorAll('.pane-cell').length === 2`));
  await waitFor(() => evaluate(`document.querySelectorAll('.pane-header').length === 2`));
  // 칸 사이에 크기 조절 경계(gutter)가 있어야 한다
  await waitFor(() => evaluate(`!!document.querySelector('.pane-gutter')`));
  // 새 대화(저장 안 된 세션) 칸을 클릭해 포커스 전환. 파일이 없는 세션이라도
  // "세션을 찾을 수 없습니다" 경고 없이 포커스가 옮겨져야 한다
  await evaluate(`document.querySelectorAll('.pane-cell .chat-panel')[0]?.click()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const alerted = await evaluate(`!!document.querySelector('.alert-popup')`);
  if (alerted) {
    const alertText = await evaluate(`document.querySelector('.alert-popup-text')?.textContent ?? ''`);
    throw new Error(`분할: 칸 포커스 시 경고가 떴다 — ${alertText}`);
  }
  // 분할 화면 스크린샷 (경로 지정 시에만) — 눈으로 UI를 확인하는 용도
  if (process.env.NEWBIE_SPLIT_SHOT) {
    // 두 칸 각각에 대화 내용이 보이도록 두 번째 칸(방금 연 A)에 이미 메시지가 있음
    win.show();
    await new Promise(resolve => setTimeout(resolve, 700));
    const image = await win.webContents.capturePage();
    writeFileSync(process.env.NEWBIE_SPLIT_SHOT, image.toPNG());
  }
  // 칸을 하나 닫으면 다시 1칸 (헤더 사라짐)
  await evaluate(`document.querySelector('.pane-close')?.click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.pane-cell').length === 1`));
  await waitFor(() => evaluate(`document.querySelectorAll('.pane-header').length === 0`));

  // 탭 전환이 실제로 화면을 바꾸는지 — 채팅 탭을 누르면 포커스 칸이 새 채팅
  // 세션으로 묶여야 한다 (코딩 전용 권한칩 .input-status-left이 사라진다)
  await evaluate(
    `[...document.querySelectorAll('.sidebar-tab')].find(b => b.textContent.includes('채팅'))?.click()`,
  );
  await waitFor(() =>
    evaluate(
      `[...document.querySelectorAll('.sidebar-tab.active')].some(b => b.textContent.includes('채팅'))`,
    ),
  );
  await waitFor(() => evaluate(`!document.querySelector('.input-status-left')`));
  // 다시 코딩 탭으로 — 권한칩이 돌아온다
  await evaluate(
    `[...document.querySelectorAll('.sidebar-tab')].find(b => b.textContent.includes('코딩'))?.click()`,
  );
  await waitFor(() =>
    evaluate(
      `[...document.querySelectorAll('.sidebar-tab.active')].some(b => b.textContent.includes('코딩'))`,
    ),
  );
  await waitFor(() => evaluate(`!!document.querySelector('.input-status-left')`));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('스모크 대기 시간 초과');
}
