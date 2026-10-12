import { withoutStoredSecrets } from '../../utils/secretEnv.ts';

/**
 * 에이전트가 띄우는 프로세스의 환경변수.
 *
 * 키보드가 없는 자리라 입력을 기다리는 명령은 타임아웃까지 그냥 멈춘다 — psql이
 * 숨겨진 콘솔에서 비밀번호를 기다리며 180초를 채운 실사고가 있었다. 도구가
 * 환경변수로 끌 수 있는 프롬프트는 여기서 끈다. stdin은 이미 닫혀 있으므로
 * stdin을 읽는 프롬프트는 EOF로 끝나지만, git 자격증명 프롬프트처럼 터미널을
 * 직접 여는 것은 따로 꺼야 한다.
 *
 * 앱이 저장해 둔 제공자 API 키는 넘기지 않는다 (withoutStoredSecrets).
 */
export function nonInteractiveEnv(): NodeJS.ProcessEnv {
  return {
    ...withoutStoredSecrets(),
    // 자격증명 프롬프트 대신 즉시 실패 (fatal: could not read Username).
    // GIT_SSH_COMMAND로 ssh까지 BatchMode로 묶고 싶지만, 그 변수는 저장소의
    // core.sshCommand보다 우선해 배포 키 설정을 덮어쓰므로 넣지 않는다
    GIT_TERMINAL_PROMPT: '0',
  };
}
