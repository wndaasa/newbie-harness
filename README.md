# newbie-harness

LLM과 대화하는 Electron 데스크탑 채팅 앱 Newbie입니다. 파일 읽기와 쓰기, 코드 검색, 명령 실행, git, 웹 검색, MCP 도구를 갖춘 에이전트 루프 위에 세션 간 메모리를 얹었습니다.

## 준비

Bun 1.3 이상이 필요합니다. 런타임은 Electron(Node)이고, Bun은 패키지 매니저·스크립트 러너로 사용합니다.

```powershell
bun install
Copy-Item .env.example .env
```

`.env`에서 사용할 제공자와 API 키를 설정합니다. Ollama, LM Studio, llama.cpp, vLLM 같은 로컬 서버를 쓰면 API 키 없이 실행할 수 있습니다.

설치 후 실행 시 `Error: Electron uninstall`이 나면 Electron 바이너리가 내려받히지 않은 것입니다. 아래 명령으로 직접 내려받습니다(자세한 내용은 `CONTRIBUTING.md` 6장).

```powershell
node node_modules/electron/install.js
```

## 실행

```powershell
bun run start        # Electron 앱 실행 (개발 모드)
```

API 키 없이 UI만 확인하려면 mock 모드를 사용합니다.

```powershell
$env:NEWBIE_MOCK = '1'; bun run start
```

기타 스크립트:

```powershell
bun run app:build    # 프로덕션 빌드 (out/)
bun run typecheck    # 타입 검사
bun run smoke        # 헤드리스 코어 스모크 (mock 에이전트 루프)
bun run app:smoke    # 앱 빌드 + 헤드리스 UI 왕복 스모크
```

## 지원 제공자

| 제공자 | 기본 모델 | 환경 변수 |
|---|---|---|
| OpenAI (기본값) | `gpt-5.5` | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` |
| Anthropic | `claude-sonnet-5` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Ollama | `gemma4:e4b` | `OLLAMA_HOST`, `OLLAMA_MODEL` |
| LM Studio | 설정 필요 (`LM_STUDIO_MODEL`) | `LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`, `LM_STUDIO_API_KEY` |
| llama.cpp | `qwen3-8b` (llama-server의 `--alias` 값) | `LLAMACPP_BASE_URL`, `LLAMACPP_MODEL`, `LLAMACPP_API_KEY` |
| vLLM | 설정 필요 (`--served-model-name` 값) | `VLLM_BASE_URL`, `VLLM_MODEL`, `VLLM_API_KEY` |

시작 제공자는 `NEWBIE_PROVIDER`로 지정하고, 실행 중에는 설정창의 제공자 탭이나 `/provider`, `/model` 명령으로 전환합니다.

## 에이전트 도구

모델이 대화 중 직접 호출하는 도구입니다.

| 도구 | 설명 |
|---|---|
| `read_file`, `list_files`, `get_file_info` | 파일과 디렉터리 읽기, 정보 조회 |
| `parse_document` | HWP, HWPX, PDF, XLSX, DOCX 문서를 마크다운으로 변환 (스캔 페이지와 문서 안 이미지는 OCR) |
| `create_file`, `edit_file`, `delete_file` | 파일 생성, 수정, 삭제 (JS/TS는 저장 전 구문 검사) |
| `search_files` | ripgrep 기반 코드 검색 |
| `run_command` | 셸 명령 실행 (180초 제한) |
| `start_process`, `read_process`, `stop_process` | 개발 서버처럼 끝나지 않는 명령을 백그라운드로 실행, 출력 확인, 종료 |
| `run_git` | 읽기 전용 git 명령 (log, diff, blame 등) |
| `worktree_add`, `worktree_list`, `worktree_remove` | git worktree 관리 |
| `capture_page` | HTML 파일이나 URL을 열어 스크린샷으로 확인 |
| `web_search`, `web_fetch` | Tavily 웹 검색, 웹 페이지 가져오기 (`TAVILY_API_KEY` 필요) |
| `spawn_agent` | 조사 작업을 보조 에이전트에 위임 |
| `search_tools`, `load_tools` | 지연 로드 도구와 MCP 서버 도구를 찾아 목록에 적재 |

도구 실행은 권한 모드에 따라 승인 요청을 거칩니다. MCP 서버는 `~/.newbie/mcp.json`에 등록하고 `/mcp`로 연결 상태를 봅니다.

## 권한 모드

| 모드 | 동작 |
|---|---|
| `auto` 자동 (기본) | 작업 폴더 안의 읽기와 쓰기는 자동 실행. 셸 명령은 허용목록 안이면 자동, 밖이면 LLM 분류기가 판정하며 되돌릴 수 없는 명령도 분류기가 맥락을 보고 정함. 작업 폴더 밖 쓰기도 분류기가 판정하고, 자격 증명 파일을 읽거나 쓰거나 지우는 도구 호출은 묻지 않고 막고 사유를 모델에게 알림 |
| `acceptEdits` 편집 수락 | 파일 읽기와 쓰기 자동 허용, 셸 실행은 승인 요청 |
| `ask` 권한 요청 | 읽기만 자동, 쓰기와 셸 실행은 승인 요청 |

`/mode <이름>` 명령이나 입력창 아래 권한 칩으로 전환합니다.

## 대화 중 명령어

| 명령어 | 설명 |
|---|---|
| `/help` | 도움말 |
| `/clear` | 현재 세션의 대화 기록 비우기 |
| `/compact` | 지금까지의 대화를 요약으로 접어 컨텍스트 비우기 |
| `/distill` | 최근 대화 로그를 메모리로 정리 (`--days <N>`, 기본 7일) |
| `/remember` | 내용을 지금 바로 메모리에 저장 |
| `/recall` | 저장된 기억 목록 확인, 키워드 검색 |
| `/checkin` | 오늘 기분을 기록하고 확인 질문에 답하기 |
| `/reflect` | 쌓인 체크인 데이터로 기분 패턴 되비추기 |
| `/sessions` | 저장된 세션 목록 |
| `/resume [session-id]` | 저장된 세션 불러오기 (`/continue`는 별칭) |
| `/provider [name]` | 제공자 확인, 변경 |
| `/model [name]` | 모델 확인, 변경 |
| `/mode [이름]` | 권한 모드 확인, 변경 |
| `/mcp` | MCP 서버 연결 상태 확인 |
| `/exit` | 종료 |

입력창에서 `/`를 입력하면 명령어 추천이 표시되고 `Tab`으로 자동완성됩니다.

## 메모리

대화는 `~/.newbie/memory/logs/`에 자동 기록되고, `/distill`이 로그를 user / feedback / project / reference 타입의 메모리 파일로 정리합니다. 다음 세션 시작 시 MEMORY.md 인덱스와 관련 메모리가 시스템 프롬프트에 주입됩니다.

대화 로그에는 입력한 내용과 `/checkin` 기분 기록이 그대로 남고, 기억 정리 때 설정한 LLM 제공자로 전송됩니다. API 키 형식의 문자열은 기록 전에 가립니다. 기록을 원하지 않으면 아래 `NEWBIE_DISABLE_LOGGING`을 설정합니다.

사용자가 직접 쓰는 파일과 생성되는 데이터는 소유권이 다르므로 디렉터리를 나눕니다. `~/.newbie/Newbie.md`(전역 지시)와 `~/.newbie/policy.md`(무엇을 유지·요약·제거할지 정하는 메모리 정책)는 사용자 소유이고, `~/.newbie/memory/` 아래는 전부 `/distill`이 생성·갱신합니다.

- `NEWBIE_NO_MEMORY=1` — 메모리 리콜 비활성화
- `NEWBIE_DISABLE_LOGGING=1` — 대화 로그 기록 비활성화
- `NEWBIE_HOME` — 메모리 데이터 저장 위치 변경 (기본 `~/.newbie`)

## 프로젝트 구조

```text
app/main/            Electron 메인 프로세스: 창 관리, controller.ts(턴 실행, 세션, 승인), pet.ts(데스크탑 펫, bun run pet:start), updater.ts
app/preload/         contextBridge로 렌더러에 고정 IPC 채널만 노출
app/renderer/        React 채팅 UI, pet.html(데스크탑 펫 창)
src/config.ts        환경 변수, 세션 생성, 시스템 프롬프트
src/agent/           에이전트 루프, 권한 모드, 셸 명령 분류기, 이력 압축
src/commands/        슬래시 명령어 레지스트리
src/providers/       Anthropic, OpenAI, Ollama, LM Studio, llama.cpp, vLLM, mock
src/tools/           에이전트 도구 (파일, 검색, 명령, git, 웹, 화면 캡처, 보조 에이전트, worktree)
src/mcp/             MCP 클라이언트, OAuth, 도구 브리지
src/memory/          대화 로그 기록, /distill 기억 정리, 리콜
src/session/         세션 저장과 복원, 자동 제목
src/settings/        사용자 설정
src/websearch/       Tavily 웹 검색
src/utils/           OCR, PDF 렌더, 오류 분류, Windows 프로세스 수명
src/ui/              도구 라벨, 색상, 폭 계산 유틸
src/cli/             스모크용 단일 턴 실행
scripts/smoke.ts     헤드리스 코어 스모크
```

## 라이선스

MIT. `LICENSE` 파일을 참고하세요.
