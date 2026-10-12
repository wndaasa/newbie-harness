// 메인 프로세스 진입점. 한 실행 파일이 본앱과 펫 두 모드를 가진다.
//
// 정적 import로 두 모드를 모두 끌어오면 펫 프로세스가 에이전트·MCP·세션 코드를
// 전부 로드한다. 인자를 보고 필요한 쪽만 동적으로 불러온다.
import { PET_FLAG } from './petLauncher.ts';

if (process.argv.includes(PET_FLAG)) {
  void import('./pet.ts');
} else {
  void import('./index.ts');
}
