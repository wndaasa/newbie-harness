# newbie-harness

여러 LLM 제공자를 바꿔 가며 쓸 수 있는 Electron 데스크탑 에이전트 앱 **Newbie**입니다. 클라우드 모델(OpenAI, Anthropic)과 로컬 모델(Ollama, LM Studio, llama.cpp, vLLM)을 같은 화면에서 쓰고, 에이전트가 파일을 읽고 고치고 명령을 실행하며 작업합니다.

## 주요 기능

- **채팅 탭과 코딩 탭**: 채팅 탭은 웹 검색, MCP, 첨부 문서 읽기만 쓰는 가벼운 대화이고, 코딩 탭은 작업 폴더를 정해 파일 편집, 셸 명령, git까지 쓰는 에이전트 작업입니다
- **에이전트 도구**: 파일 읽기와 쓰기, 코드 검색, 셸 명령과 백그라운드 프로세스, git과 worktree, 웹 검색, 화면 캡처, 문서 파싱(HWP, PDF, XLSX, DOCX, OCR 포함), 보조 에이전트 위임
- **권한 모드**: 자동, 편집 수락, 권한 요청 세 가지. 자동 모드는 허용목록 밖의 셸 명령을 별도 LLM 분류기가 판정합니다
- **로컬 모델 대응**: 작은 컨텍스트 창을 위한 이력 압축, 프롬프트 캐시를 깨지 않는 요청 구성, 추론 강도와 샘플링 설정
- **화면 분할**: 세션을 최대 4칸까지 나란히 열어 동시에 작업합니다
- **세션 간 메모리**: 대화 로그를 메모리 파일로 정리해 다음 세션에 참고합니다
- **MCP**: stdio와 HTTP MCP 서버 연결, OAuth 인증, 필요할 때만 도구를 불러오는 지연 로딩
- **데스크탑 펫**: 바탕화면에 떠 있는 캐릭터 창. 기분 체크인과 확인 질문을 받습니다

## 지원 환경

- Windows x64용 설치 파일만 배포합니다
- 소스 실행은 Windows에서만 확인했고, macOS와 Linux에서는 확인하지 않았습니다
- 화면은 한국어만 지원합니다
- git 관련 도구(`run_git`, worktree)를 쓰려면 PATH에 git이 있어야 합니다

## 설치 (Windows)

[Releases](https://github.com/wndaasa/newbie-harness/releases/latest)에서 `Newbie-Setup-<버전>.exe`를 받아 실행합니다.

- 관리자 권한 없이 사용자별로 `%LOCALAPPDATA%\Programs\newbie-harness`에 설치되고, 바탕화면과 시작 메뉴에 바로가기가 생깁니다
- 설치 파일에 코드 서명이 없어 Windows SmartScreen 경고가 뜰 수 있습니다. 경고 창의 "추가 정보"를 누르고 "실행"을 고릅니다
- 처음 실행하면 설정창의 제공자 탭에서 쓸 제공자의 API 키나 로컬 서버 주소를 넣습니다
- 앱을 켤 때 새 버전을 확인하고, 있으면 사이드바 아래에 알립니다. 눌러서 받은 뒤 다시 시작하면 적용되고, 미루면 앱을 닫을 때 설치됩니다

## 소스에서 실행

Bun 1.3 이상과 Node.js 22.12 이상이 필요합니다. 런타임은 Electron(Node)이고, Bun은 패키지 매니저와 스크립트 러너로 씁니다. `bun install`이 끝나면 `postinstall`이 `node`로 Electron 실행 파일을 내려받습니다. 설치 파일 빌드는 Windows(NSIS)만 지원합니다.

```powershell
bun install
Copy-Item .env.example .env
```

`.env`에서 쓸 줄의 주석을 풀고 제공자와 API 키를 넣습니다. 앱을 실행한 뒤 설정창의 제공자 탭에서 입력해도 되는데, `.env`에 넣은 값이 설정창에 저장한 값보다 우선합니다. 로컬 서버(Ollama, LM Studio, llama.cpp, vLLM)를 쓰면 API 키 없이 실행할 수 있습니다.

`bun run start`에서 `Error: Electron uninstall`이 나면 Electron 실행 파일이 내려받히지 않은 것입니다. 아래 명령으로 직접 내려받습니다.

```powershell
node node_modules/electron/install.js
```

## 실행

```powershell
bun run start        # Electron 앱 실행 (개발 모드)
bun run pet:start    # 데스크탑 펫만 실행
```

API 키 없이 화면만 확인하려면 mock 모드를 씁니다.

```powershell
$env:NEWBIE_MOCK = '1'; bun run start
```

기타 스크립트:

```powershell
bun run app:build    # 프로덕션 빌드 (out/)
bun run app:dist     # Windows 설치 파일 빌드 (dist/)
bun run typecheck    # 타입 검사
bun run test         # 단위 테스트
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

새 대화의 기본 제공자와 모델은 설정창의 제공자 탭이나 `NEWBIE_PROVIDER`, 제공자별 `*_MODEL` 환경 변수로 정합니다. 지금 대화의 제공자와 모델은 `/provider`, `/model` 명령이나 코딩 탭의 모델 칩으로 바꿉니다.

설정창에서 입력한 API 키는 Electron safeStorage(Windows에서는 DPAPI)로 암호화해 `~/.newbie/credentials.enc`에 저장합니다. 화면에는 가린 값만 표시하고, 에이전트가 실행하는 셸 명령과 MCP 서버에는 넘기지 않습니다.

### 로컬 모델

- `run_model.sh`: llama-server로 GGUF 모델을 OpenAI 호환 API로 띄우는 스크립트입니다. 실측한 설정값과 이유를 주석에 적어 두었습니다
- `setup_win_vulkan.sh`: Windows용 llama.cpp Vulkan 빌드를 `tools/llama.cpp`에 설치합니다 (AMD 그래픽카드용)
- **Ollama 컨텍스트 창**: 요청마다 `num_ctx`를 함께 보내 앱이 아는 창 크기와 맞춥니다
  - 기본값은 32K이고, 모델 최대치가 더 작으면 그 값을 씁니다
  - Ollama 앱에서 정한 창 크기는 쓰지 않습니다
  - 다른 크기를 쓰려면 Modelfile에 `num_ctx`를 적은 모델을 만듭니다
  - 실제로 잡힌 크기는 `ollama ps`로 확인합니다
- **vLLM API 키**: 서버를 `--api-key`로 띄웠을 때만 넣습니다

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
| `web_search` | Tavily 웹 검색 (`TAVILY_API_KEY` 필요) |
| `web_fetch` | 웹 페이지 가져오기 |
| `spawn_agent` | 보조 에이전트에 일을 나눠 맡김. 조사 전용 `explore`와 파일 수정까지 하는 `general`이 있고, 동시에 최대 4개까지 돌아감 |
| `search_tools`, `load_tools` | 지연 로드 도구와 MCP 서버 도구를 찾아 목록에 적재 |

에이전트가 만든 임시 파일과 산출물은 작업 폴더의 `.newbie/` 아래에 둡니다. 이 폴더는 자동으로 git 제외 처리하지 않으므로 커밋할지는 직접 정합니다.

## 권한 모드

| 모드 | 동작 |
|---|---|
| `auto` 자동 (기본) | 작업 폴더 안의 읽기와 쓰기는 자동 실행. 셸 명령은 허용목록 안이면 자동, 밖이면 LLM 분류기가 판정하며 되돌릴 수 없는 명령도 분류기가 맥락을 보고 정함. 작업 폴더 밖 쓰기도 분류기가 판정하고, 자격 증명 파일을 읽거나 쓰거나 지우는 도구 호출은 묻지 않고 막고 사유를 모델에게 알림 |
| `acceptEdits` 편집 수락 | 파일 읽기와 쓰기 자동 허용, 셸 실행은 승인 요청 |
| `ask` 권한 요청 | 읽기만 자동, 쓰기와 셸 실행은 승인 요청 |

`/mode <이름>` 명령이나 코딩 탭 입력창 아래의 권한 칩으로 바꿉니다.

MCP 도구는 서버가 읽기 전용(`readOnlyHint: true`)으로 표시한 것만 승인 없이 실행합니다. 자동 모드에서 `destructiveHint: false`로 표시된 도구는 분류기가 판정하고, 나머지는 승인을 받습니다.

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
| `/resume [session-id]` | ID 없이 쓰면 저장된 세션 목록, ID를 주면 그 세션 불러오기 |
| `/continue` | 가장 최근 세션을 바로 이어서 시작 |
| `/provider [name]` | 제공자 확인, 변경 |
| `/model [name]` | 모델 확인, 변경 |
| `/mode [이름]` | 권한 모드 확인, 변경 |
| `/mcp` | MCP 서버 연결 상태 확인. `/mcp reconnect [서버]`는 다시 연결, `/mcp auth <서버>`는 인증 다시 받기 |
| `/exit` | 종료 |

입력창에서 `/`를 입력하면 명령어 추천이 표시되고 `Tab`으로 자동완성됩니다.

## MCP

MCP 서버는 `~/.newbie/mcp.json`에 등록합니다. 설정창의 MCP 탭에서 파일을 열 수 있고, 처음 열면 아래 예시로 만들어집니다.

```json
{
  "mcpServers": {
    "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" }
  }
}
```

stdio 서버는 `command`, `args`, `env`로 등록합니다. 켜 둔 서버는 앱을 켤 때 자동으로 연결되고, 연결 상태는 `/mcp`로 확인합니다. 설정을 고친 뒤 다시 연결하려면 `/mcp reconnect`를 씁니다.

## 메모리

대화는 `~/.newbie/memory/logs/`에 자동으로 기록되고, 아래 세 경우에 user / feedback / project / reference 타입의 메모리 파일로 정리됩니다.

1. 앱을 켤 때 아직 정리하지 않은 로그가 있으면 자동으로 정리
2. "정정할게", "틀렸"처럼 직전 내용을 고치는 말을 하면 바로 다시 정리
3. `/distill`을 직접 실행

정리된 메모리 중 `MEMORY.md` 인덱스와 최근에 갱신된 메모리 5개가 매 턴 시스템 프롬프트에 들어갑니다. 채팅 탭과 코딩 탭 모두 해당합니다.

대화 로그에는 입력한 내용, 답변의 앞뒤 일부, `/checkin`과 펫의 기분 기록이 남습니다. 입력은 300자까지 남기고 슬래시 명령은 남기지 않으며, 답변에서는 코드와 긴 URL을 뺍니다. 로그는 기억을 정리할 때 지금 쓰는 LLM 제공자로 전송됩니다. OpenAI, Anthropic, Tavily 키와 GitHub 토큰 형식의 문자열은 기록 전에 가립니다. 기록을 원하지 않으면 아래 `NEWBIE_DISABLE_LOGGING`을 설정합니다.

사용자가 직접 쓰는 파일과 앱이 만드는 데이터는 디렉터리를 나눕니다. `~/.newbie/Newbie.md`(전역 지시)와 `~/.newbie/policy.md`(무엇을 유지, 요약, 제거할지 정하는 메모리 정책)는 사용자가 쓰는 파일이고, `~/.newbie/memory/` 아래는 앱이 만들고 갱신합니다. 프로젝트 폴더에 `Newbie.md`를 두면 코딩 탭에서 그 프로젝트의 작업 규칙으로 함께 들어갑니다. 이 저장소 루트의 `Newbie.md`가 그 예로, 이 앱으로 이 저장소를 작업할 때 쓰는 규칙입니다.

- `NEWBIE_NO_MEMORY=1`: 메모리를 시스템 프롬프트에 넣지 않고, 앱을 켤 때 자동 정리도 하지 않음
- `NEWBIE_DISABLE_LOGGING=1`: 대화 로그 기록 끔
- `NEWBIE_DISABLE_NEWBIE_MD=1`: `Newbie.md` 지침을 넣지 않음
- `NEWBIE_HOME`: 앱 데이터 위치 변경 (기본 `~/.newbie`)
  - API 키, 세션, MCP 설정, 메모리, OCR 데이터가 모두 이 아래에 저장됨

## 외부로 나가는 데이터

- **LLM 제공자**: 대화 내용과 시스템 프롬프트를 지금 쓰는 제공자로 보냅니다
  - 시스템 프롬프트에는 설정창의 이름과 지침, `Newbie.md`, 메모리가 들어갑니다
  - 코딩 탭에서는 매 턴 작업 폴더 경로와 git 상태가 붙습니다
  - 로컬 제공자를 쓰면 지정한 서버로만 나갑니다
- **Tavily**: `web_search`를 쓸 때 검색어를 보냅니다
- **웹 페이지**: `web_fetch`가 요청한 주소에 직접 접속합니다
- **MCP 서버**: 켜 둔 서버에 앱을 켤 때 자동으로 연결합니다
- **GitHub Releases**: 설치본은 켤 때마다 새 버전을 확인합니다
- **OCR 언어 데이터**: 처음 OCR을 쓸 때 cdn.jsdelivr.net에서 한국어와 영어 데이터를 내려받아 `~/.newbie/ocr`에 둡니다

### 대화 외에 나가는 LLM 요청

아래 요청도 지금 쓰는 제공자로 나가므로 사용량에 포함됩니다.

- **분류기**: 자동 모드에서 허용목록 밖 셸 명령, 작업 폴더 밖 쓰기, 일부 MCP 도구를 판정할 때마다 한 번
  - 모델은 Anthropic이면 `claude-haiku-4-5-20251001`, OpenAI면 `gpt-5.6-luna`, 나머지 제공자는 대화 모델
  - `NEWBIE_CLASSIFIER_MODEL`로 바꿀 수 있음
- **자동 제목**: 새 대화의 첫 턴이 끝난 뒤 한 번
- **이력 압축**: 컨텍스트 창이 찼을 때와 `/compact`
- **기억 정리**: 앱을 켤 때, 정정했을 때, `/distill`
- **`/remember`**: 저장할 내용의 이름과 분류를 정할 때

## 프로젝트 구조

```text
app/main/            Electron 메인 프로세스: 창 관리, controller.ts(턴 실행, 세션, 승인), pet.ts(데스크탑 펫), updater.ts
app/preload/         contextBridge로 렌더러에 고정 IPC 채널만 노출
app/renderer/        React 채팅 UI, pet.html(데스크탑 펫 창)
src/config.ts        환경 변수, 세션 생성, 시스템 프롬프트
src/agent/           에이전트 루프, 권한 모드, 셸 명령 분류기, 이력 압축
src/commands/        슬래시 명령어 레지스트리
src/providers/       Anthropic, OpenAI, Ollama, LM Studio, llama.cpp, vLLM, mock, 오류 분류
src/tools/           에이전트 도구 (파일, 검색, 셸, git, 웹, 화면 캡처, 보조 에이전트, worktree)
src/mcp/             MCP 클라이언트, OAuth, 도구 브리지
src/memory/          대화 로그 기록, /distill 기억 정리, 리콜
src/session/         세션 저장과 복원, 자동 제목
src/settings/        사용자 설정
src/websearch/       Tavily 웹 검색
src/utils/           OCR, PDF 렌더, 자식 프로세스에 넘기지 않을 키 목록, Windows 프로세스 수명
src/ui/              도구 라벨, 색상, 폭 계산 유틸
src/cli/             스모크용 단일 턴 실행
scripts/smoke.ts     헤드리스 코어 스모크
test/                단위 테스트 (bun test)
```

## 라이선스

MIT. `LICENSE` 파일을 참고하세요.
