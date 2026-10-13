# Contributing

newbie-harness에 버그를 제보하거나 코드를 보태는 방법을 정리합니다.

## 1. 버그 제보와 제안

[Issues](https://github.com/wndaasa/newbie-harness/issues)에 올려 주세요. 버그 제보에 아래 내용이 있으면 원인을 빨리 찾을 수 있습니다.

- 앱 버전: 설정창 왼쪽 아래에 표시됩니다. 소스에서 실행했다면 커밋 해시를 적어 주세요.
- Windows 버전
- 쓰던 제공자와 모델 (예: Ollama `gemma4:e4b`)
- 재현 순서, 기대한 동작, 실제 동작
- 오류 메시지나 화면

올리기 전에 로그와 화면에 API 키나 개인 정보가 들어 있지 않은지 확인해 주세요.

## 2. 기여 흐름

```text
fork -> dev 기준으로 브랜치 생성 -> 작업과 로컬 검증 -> 푸시 -> dev 대상 PR
```

- `dev`: 다음 릴리스를 준비하는 기본 브랜치입니다. PR은 `dev`로 보냅니다.
- `main`: 릴리스된 안정 버전입니다.

동작을 크게 바꾸는 작업은 먼저 이슈로 방향을 맞춘 뒤 시작하면 좋습니다.

### 2-1. 브랜치 이름

`<type>/<short-title>` 형식으로 짓습니다.

| Type | 용도 |
| --- | --- |
| `feature` | 새 기능 추가 |
| `fix` | 버그 수정 |
| `refactor` | 동작 변경 없는 구조 개선 |
| `docs` | 문서 수정 |
| `chore` | 빌드, 설정, 의존성, 기타 관리 작업 |
| `test` | 테스트 추가 또는 수정 |

예시: `fix/ctrl-c-exit`, `docs/contributing-guide`

## 3. 작업 규칙

- 한 PR은 한 가지 문제만 다룹니다.
- 관련 없는 리팩터링이나 정리는 같은 PR에 섞지 않습니다.
- API 키, 토큰, 개인 설정 파일은 커밋하지 않습니다.
- Windows에서 `bun run start`로 앱이 뜨는지 확인합니다.
- 런타임은 Electron(Node)이고, Bun은 패키지 매니저와 스크립트 러너로만 씁니다. 코어 코드에 Bun 전용 API(`Bun.*`, `bun:*`)를 쓰지 않습니다.

## 4. 새 기능 배치 기준

새 기능은 사용자에게 보이는 명령어와 실제 기능 로직을 분리해서 추가합니다.

- Slash command는 `src/commands/builtins/<name>.ts`에 만들고 `src/commands/registry.ts`에 등록합니다.
- 명령 파일에는 입력 파싱, 호출 순서, 사용자에게 보여줄 응답만 둡니다.
- 실제 기능 로직은 `src/<domain>/` 아래에 둡니다. 예: `src/memory/`, `src/tools/`, `src/mcp/`.
- 모델 제공자별 API 포맷 변환은 `src/providers/` 안에 둡니다.
- Electron 창 관리·IPC·컨트롤러는 `app/main/`, 화면 표시와 React 상태는 `app/renderer/` 안에 둡니다.
- 색상, 폭 계산 같은 공용 텍스트 유틸은 `src/ui/` 안에 둡니다.

예를 들어 `/memory` 명령을 추가한다면 명령 진입점은 `src/commands/builtins/memory.ts`에 두고, `memory.md` 읽기와 정리는 `src/memory/`에 둡니다. 모델이 호출할 수 있는 도구 기능을 추가한다면 slash command와 별개로 `src/tools/`에 도구 정의, 실행, 결과 타입을 모읍니다.

기능이 커질 때도 `app/main/controller.ts`에 도메인 로직을 직접 넣지 않습니다. 컨트롤러는 IPC와 화면 이벤트를 연결하고, 세부 동작은 command, domain, provider 모듈로 보냅니다.

## 5. 로컬 검증

푸시하기 전에 변경 내용과 관련된 검증을 실행합니다.

```powershell
bun run typecheck   # 타입 검사
bun run test        # 회귀 테스트
bun run smoke       # 헤드리스 코어 스모크 (mock 에이전트 루프)
bun run app:smoke   # 앱 빌드 + 헤드리스 UI 왕복 스모크
bun run start       # Electron 앱 실행 (수동 확인)
```

모든 명령을 항상 실행할 필요는 없지만, 작업 성격에 맞는 검증은 반드시 수행합니다. 검증할 수 없는 경우에는 이유를 PR에 남깁니다.

## 6. PR 체크리스트

- [ ] 무엇을 왜 바꿨는지 설명했습니다.
- [ ] 관련 이슈가 있으면 `Closes #<issue-number>`로 연결했습니다.
- [ ] 실행한 검증과 결과를 적었습니다.
- [ ] 불필요한 파일이나 개인 설정이 들어가지 않았습니다.
- [ ] 대상 브랜치가 `dev`입니다.

## 7. Windows: Electron 실행 파일 문제

Electron npm 패키지에는 실행 파일(`electron.exe`)이 들어 있지 않습니다. `bun install`이 끝날 때 `package.json`의 `postinstall`이 운영체제에 맞는 실행 파일을 내려받는데, 이 단계가 실패하면 `bun run start`에서 아래 오류가 납니다.

```text
Error: Electron uninstall
```

`node_modules/electron/path.txt`가 없으면 이 경우입니다. 아래 명령으로 직접 내려받을 수 있고, Node.js 22.12 이상이 필요합니다.

```powershell
node node_modules/electron/install.js
```

## 8. 릴리스 (메인테이너)

`dev`에서 `package.json`의 `version`과 `src/config.ts`의 `APP_VERSION`을 올린 커밋(`chore: x.y.z`)을 푸시한 뒤 같은 버전의 태그를 푸시합니다. `.github/workflows/release.yml`이 태그를 받아 Windows 설치 파일을 만들어 GitHub Release에 올리고, 설치본의 업데이터가 그 Release를 봅니다. 태그와 `package.json` 버전이 다르면 워크플로가 실패합니다.

앱 화면의 버전은 `package.json`에서 읽고, `APP_VERSION`은 MCP 서버에 알리는 클라이언트 버전과 User-Agent에 쓰입니다.

버전 기준은 아래를 따릅니다.

- `patch`: 버그 수정, 문서 보완, 작은 UI 수정
- `minor`: 기능 추가, provider 추가, 세션 저장 같은 새 기능
- `major`: 기존 사용법이 깨지는 큰 변경

릴리스 워크플로는 테스트를 돌리지 않으므로, 태그를 푸시하기 전에 `dev`에서 직접 검증합니다.

```powershell
bun run typecheck
bun run test
bun run smoke
```

태그를 만들고 푸시합니다.

```powershell
git tag v1.0.1
git push origin v1.0.1
```

릴리스한 뒤에는 `dev`를 `main`에 머지해 안정 버전을 맞춥니다.
