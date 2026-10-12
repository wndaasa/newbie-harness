# Contributing

이 문서는 Newbie 작업 규칙을 정리합니다. 목표는 이슈, 브랜치, PR만 봐도 작업 배경과 변경 내용을 알 수 있게 만드는 것입니다.

## 기본 흐름

```text
이슈 작성 -> 최신 origin/dev 기준 브랜치 생성 -> 작업/로컬 검증 -> 푸시 -> dev 대상 PR -> dev 머지 -> dev에서 버전 태그 -> main에 dev 머지
```

- `main`: 안정 버전입니다. 바로 clone해서 실행 가능한 상태를 유지합니다.
- `dev`: 다음 릴리스를 준비하는 통합 브랜치입니다.
- 이슈 브랜치: 하나의 이슈를 처리하는 작업 브랜치입니다.

기능 브랜치는 바로 `main`에 머지하지 않고 기본적으로 `dev` 대상 PR로 머지합니다.

## 1. 이슈 작성

코딩이 필요한 작업은 먼저 이슈를 만듭니다.

이슈에는 아래 내용을 포함합니다.

```md
## 작업 배경

왜 이 작업이 필요한지 적습니다.

## 작업 내용

무엇을 바꿀지 간단히 적습니다.

## 작업 목록

- [ ] 첫 번째 작업
- [ ] 두 번째 작업
- [ ] 검증

## 브랜치

`feature/session-save`

## 목표 날짜

YYYY-MM-DD
```

작업 중 범위가 커지면 새 이슈로 나눕니다. 한 이슈 안에서 관련 없는 작업을 같이 처리하지 않습니다.

## 2. 브랜치 생성

작업 전 최신 `origin/dev`를 기준으로 브랜치를 만듭니다.

```powershell
git fetch origin
git checkout dev
git pull origin dev
```

브랜치는 이슈 단위로 만듭니다.

```text
<type>/<short-title>
```

이슈가 있으면 끝에 `-#<issue-number>`를 붙여도 됩니다.

예시:

```text
feature/session-save
fix/ctrl-c-exit
refactor/split-provider-modules
docs/contributing-guide
chore/update-smoke-script
test/session-save
```

## 3. 브랜치 타입

브랜치 이름의 `/` 앞부분은 작업 유형을 나타냅니다.

| Type | 용도 |
| --- | --- |
| `feature` | 새 기능 추가 |
| `fix` | 버그 수정 |
| `refactor` | 동작 변경 없는 구조 개선 |
| `docs` | 문서 수정 |
| `chore` | 빌드, 설정, 의존성, 기타 관리 작업 |
| `test` | 테스트 추가 또는 수정 |
| `experiment` | 이슈화 전 실험 작업 |

타입을 임의로 새로 만들지 않습니다. 새 타입이 필요하면 먼저 이 문서에 추가합니다.

이슈 번호가 아직 없지만 먼저 실험해야 하는 경우에는 실험 브랜치를 사용할 수 있습니다.

```text
experiment/terminal-panel-layout
```

실험이 실제 작업으로 이어지면 이슈를 만들고 정식 브랜치로 옮깁니다.

## 4. 작업 규칙

- 한 브랜치는 한 이슈만 해결합니다.
- 이슈의 작업 목록을 기준으로 작업합니다.
- 관련 없는 리팩터링이나 정리는 같은 브랜치에서 처리하지 않습니다.
- 커밋 메시지는 작업 내용을 짧고 명확하게 씁니다.
- API 키, 토큰, 개인 설정 파일은 커밋하지 않습니다.
- Windows 환경을 기본으로 생각하고 `bun run start`(Electron 앱) 실행을 확인합니다.
- 런타임은 Electron(Node)이고, Bun은 패키지 매니저·스크립트 러너로 사용합니다. 코어 코드에 Bun 전용 API(`Bun.*`, `bun:*`)를 쓰지 않습니다.

## 5. 새 기능 배치 기준

새 기능은 사용자에게 보이는 명령어와 실제 기능 로직을 분리해서 추가합니다.

- Slash command는 `src/commands/builtins/<name>.ts`에 만들고 `src/commands/registry.ts`에 등록합니다.
- 명령 파일에는 입력 파싱, 호출 순서, 사용자에게 보여줄 응답만 둡니다.
- 실제 기능 로직은 `src/<domain>/` 아래에 둡니다. 예: `src/memory/`, `src/tools/`, `src/files/`.
- 모델 제공자별 API 포맷 변환은 `src/providers/` 안에 둡니다.
- Electron 창 관리·IPC·컨트롤러는 `app/main/`, 화면 표시와 React 상태는 `app/renderer/` 안에 둡니다.
- 색상, 폭 계산 같은 공용 텍스트 유틸은 `src/ui/` 안에 둡니다.

예를 들어 `/memory` 명령을 추가한다면 명령 진입점은 `src/commands/builtins/memory.ts`에 두고, `memory.md` 읽기와 정리는 `src/memory/`에 둡니다. 모델이 호출할 수 있는 도구 기능을 추가한다면 slash command와 별개로 `src/tools/`에 도구 정의, 실행, 결과 타입을 모읍니다.

기능이 커질 때도 `app/main/controller.ts`에 도메인 로직을 직접 넣지 않습니다. 컨트롤러는 IPC와 화면 이벤트를 연결하고, 세부 동작은 command, domain, provider 모듈로 보냅니다.

## 6. Windows: Electron 바이너리 관련 문제

Electron npm 패키지는 실행 파일(`electron.exe`)을 포함하지 않고, 설치 스크립트가 설치 시점에
운영체제에 맞는 바이너리를 내려받습니다. `bun install`만 실행했는데 `bun run start`에서 아래
오류가 나면 이 바이너리가 내려받히지 않은 것입니다.

```text
Error: Electron uninstall
```

`node_modules/electron/dist`에 `electron.exe`가 없으면 원인이 맞습니다. `package.json`에
`postinstall` 스크립트로 이 다운로드를 자동 실행하도록 되어 있지만, 그래도 재현되면 아래
명령으로 직접 내려받을 수 있습니다.

```powershell
node node_modules/electron/install.js
```

## 7. 로컬 검증

작업 완료 후 푸시하기 전에 변경 내용과 관련된 최소 검증을 수행합니다.

```powershell
bun run typecheck   # 타입 검사
bun run test        # 회귀 테스트
bun run smoke       # 헤드리스 코어 스모크 (mock 에이전트 루프)
bun run app:smoke   # 앱 빌드 + 헤드리스 UI 왕복 스모크
bun run start       # Electron 앱 실행 (수동 확인)
```

모든 명령을 항상 실행할 필요는 없지만, 작업 성격에 맞는 검증은 반드시 수행합니다. 검증할 수 없는 경우에는 이유를 PR이나 작업 기록에 남깁니다.

## 8. 푸시와 PR

로컬 검증이 끝나면 작업 브랜치를 푸시합니다.

```powershell
git push origin <branch-name>
```

PR 대상 브랜치는 기본적으로 `dev`입니다. 작업 브랜치를 `dev`에 직접 머지하지 않고 PR을 만들어 이력을 남깁니다.

관련 이슈가 있으면 PR 본문에 `Closes #<issue-number>`로 명시합니다.

PR을 올리기 전 아래를 확인합니다.

- [ ] 이슈 링크가 있습니다.
- [ ] 작업 배경과 변경 내용이 설명되어 있습니다.
- [ ] 이슈의 체크박스 작업 목록이 갱신되어 있습니다.
- [ ] 실행/검증 결과가 적혀 있습니다.
- [ ] 불필요한 파일이나 개인 설정이 포함되지 않았습니다.
- [ ] 대상 브랜치가 `dev`입니다.

## 9. 머지 규칙

작업 브랜치는 `dev` 대상 PR로 머지합니다.

```text
feature/* -> dev
fix/* -> dev
refactor/* -> dev
docs/* -> dev
chore/* -> dev
test/* -> dev
```

릴리스는 `dev`에서 태그로 만듭니다(10장). `main`은 안정 스냅샷으로, 릴리스 뒤 `dev`를 머지해 맞춥니다.

## 10. 릴리스와 태그

`dev`에서 `package.json`의 `version`을 올린 커밋(`chore: x.y.z`)을 푸시한 뒤 같은 버전의 태그를 푸시합니다. `.github/workflows/release.yml`이 태그를 받아 Windows 설치 파일을 만들어 GitHub Release에 올리고, 설치본의 업데이터가 그 Release를 봅니다. 태그와 `package.json` 버전이 다르면 워크플로가 실패합니다.

```text
v0.1.0
v0.2.0
v1.0.0
```

버전 기준은 아래를 따릅니다.

- `patch`: 버그 수정, 문서 보완, 작은 UI 수정
- `minor`: 기능 추가, provider 추가, 세션 저장 같은 새 기능
- `major`: 기존 사용법이 깨지는 큰 변경

릴리스 전에는 최소한 mock 실행이 정상인지 확인합니다.

```powershell
bun run smoke
```

버전을 올릴 때는 `package.json`과 앱에서 표시하는 버전 값을 함께 맞춥니다.

태그를 만들고 푸시합니다.

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## 예외

문서 오타, 주석 수정, 아주 작은 설정 변경은 이슈 없이 처리할 수 있습니다.

다만 아래 경우에는 작은 이슈라도 남깁니다.

- 변경 배경을 나중에 추적해야 하는 경우
- 팀원이 맥락을 이해하기 어려운 경우
- 코드 동작에 영향을 줄 수 있는 경우
- 릴리스 노트에 포함될 수 있는 경우
