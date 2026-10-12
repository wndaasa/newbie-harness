// 헤드리스 코어 스모크: mock 세션으로 에이전트 루프 왕복을 확인함.
// 앱 UI까지 포함한 검증은 `bun run app:smoke`를 사용.
import { stdout as output } from 'node:process';
import { runOnce } from '../src/cli/once.ts';
import { assertProviderReady, createSession, loadDotEnv } from '../src/config.ts';
import { createColors } from '../src/ui/colors.ts';

loadDotEnv();

const session = createSession({ mock: true });
assertProviderReady(session);

const c = createColors({ noColor: false, output });
await runOnce({ args: { once: '안녕하세요' }, c, output, session });
