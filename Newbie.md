# Newbie 프로젝트 규칙

이 저장소에서 작업할 때 지켜야 하는 규칙입니다.

## 빌드·반영

- 이 앱은 Electron이고 실행 중인 앱은 `out/` 빌드본을 사용한다. **UI(app/) 또는 코어(src/) 코드를 수정한 뒤에는 `bun run app:build`를 실행해야 다음 실행 때 반영된다.** 수정만 하고 "완료"라고 말하지 말 것.
- 검증 명령: `bun run typecheck` (타입), `bun run smoke` (코어), `bun run app:build` (빌드).
- 패키지 매니저는 bun만 사용한다. npm/yarn 금지.

## 수정·되돌리기

- git의 미커밋 변경에는 다른 사람(또는 다른 세션)의 작업이 섞여 있을 수 있다. 되돌리기 요청을 받으면 **이 대화에서 네가 직접 수정한 부분만** 되돌린다. `git diff` 전체를 역적용하거나 `git checkout -- <파일>`로 파일을 통째로 되돌리지 말 것.
- edit_file이 "old_string 불일치"로 실패하면 read_file로 해당 부분을 다시 읽고, 줄바꿈·들여쓰기까지 파일에 있는 그대로 old_string을 지정해 재시도한다.

## 구조

- 명령 진입점은 `src/commands/builtins/`, 기능 로직은 `src/<도메인>/`, 프로바이더 포맷 변환은 `src/providers/`, UI는 `app/renderer/`.
- 스타일은 `app/renderer/src/styles.css` 하나에 모여 있고 CSS 변수(`--accent` 등)를 사용한다.
