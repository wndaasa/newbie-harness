// run_git 허용목록 회귀 테스트.
//
// git grep -O(--open-files-in-pager)는 매칭 파일을 지정한 명령으로 열기 때문에
// 임의 실행이 된다. run_git은 kind가 read라 권한 모드와 무관하게 승인 없이
// 실행되므로, 이 구멍이 열리면 run_command의 승인 관문이 통째로 우회된다.
// 실제로 실행되던 것을 막은 사안이라 되살아나지 않게 고정한다.

import { describe, expect, test } from 'bun:test';
import { validateGitArgs } from '../src/tools/git/gitReadOnlyCommands.ts';

describe('거부해야 하는 인자', () => {
  const cases: [string, string[], string][] = [
    ['grep', ['-O/tmp/evil.sh', 'pattern'], '붙여 쓴 -O로 외부 명령 실행'],
    ['grep', ['-O', '/tmp/evil.sh', 'pattern'], '떼어 쓴 -O'],
    ['grep', ['--open-files-in-pager=/tmp/evil.sh', 'x'], '긴 이름 형태'],
    ['log', ['--ext-diff'], '외부 diff 실행'],
    ['log', ['--textconv'], '설정된 변환 명령 실행'],
    ['log', ['-c', 'core.pager=evil'], '설정 주입'],
    ['diff', ['--exec-path=/tmp'], 'git 실행 경로 변조'],
    ['diff', ['--config-env=x=Y'], '환경 변수 경유 설정 주입'],
    ['diff', ['--output=/tmp/pwned'], '파일 쓰기'],
    ['diff', ['-O/tmp/orderfile'], 'diff의 orderfile도 제외 대상'],
    ['status', ['--upload-pack=evil'], '원격 명령 지정'],
    ['reflog', ['expire', '--all'], '.git/logs를 수정하는 하위 명령'],
    ['reflog', ['delete'], '같은 이유'],
    ['log', ['--pretty=x', '--존재하지-않는-옵션'], '목록에 없는 옵션'],
    ['commit', ['-m', 'x'], '읽기 전용이 아닌 서브커맨드'],
    // 저장소와 무관한 두 파일을 비교해 내용을 보여준다. 읽기 게이트를 거치지 않는다
    ['diff', ['--no-index', '/dev/null', 'C:/Users/x/.ssh/id_rsa'], '--no-index로 임의 파일 읽기'],
    ['diff', ['/dev/null', '/home/x/.aws/credentials'], '작업 트리 밖 경로는 --no-index 없이도 같다'],
    ['diff', ['HEAD', '--', '../outside.txt'], '상위 폴더로 나가는 경로'],
    ['diff', ['~/.netrc', 'a.txt'], '홈 경로'],
  ];

  for (const [sub, args, why] of cases) {
    test(`git ${sub} ${args.join(' ')} — ${why}`, () => {
      expect(validateGitArgs(sub, args)).not.toBeNull();
    });
  }
});

describe('통과해야 하는 인자', () => {
  const cases: [string, string[]][] = [
    ['log', ['--oneline', '-10']],
    ['log', ['-5']],
    ['log', ['--oneline', '--graph', '--all']],
    ['log', ['--since', '2026-01-01', '--author', 'alice']],
    ['log', ['--stat', '-p']],
    ['log', ['-S', 'registerTool']],
    ['diff', ['HEAD~1', '--', 'src/']],
    ['diff', ['--stat', '--cached']],
    ['diff', ['--name-only']],
    // 범위 표기의 ..는 경로가 아니다
    ['diff', ['main..HEAD', '--stat']],
    ['show', ['HEAD', '--stat']],
    ['blame', ['-L', '10,20', 'src/config.ts']],
    ['status', ['--short']],
    ['status', ['-sb']],
    ['grep', ['-n', '--', 'registerTool']],
    ['grep', ['-i', '-n', 'foo']],
    ['grep', ['-A', '3', 'foo']],
    ['ls-files', ['--others', '--exclude-standard']],
    ['rev-parse', ['--abbrev-ref', 'HEAD']],
    ['rev-parse', ['--verify', '--quiet', 'main']],
    ['describe', ['--tags', '--always']],
    ['shortlog', ['-sn']],
    ['reflog', ['show', 'HEAD']],
    ['reflog', []],
  ];

  for (const [sub, args] of cases) {
    test(`git ${sub} ${args.join(' ')}`, () => {
      expect(validateGitArgs(sub, args)).toBeNull();
    });
  }
});

describe('값을 받는 옵션의 파싱', () => {
  // 값을 받는 옵션을 값 없는 것으로 잘못 알면, 검증기는 다음 토큰을 옵션으로
  // 보는데 git은 그것을 앞 옵션의 값으로 삼는다. 그 어긋남을 이용하면 검사를
  // 통과한 문자열이 git에서 다른 의미로 실행된다.
  test('-S 뒤의 --를 값으로 소비해도 그 뒤 옵션이 검사 없이 통과하지 않는다', () => {
    expect(validateGitArgs('diff', ['-S', '--', '--output=/tmp/pwned'])).not.toBeNull();
  });

  test('값이 -로 시작하면 거부한다', () => {
    expect(validateGitArgs('log', ['--author', '--exec-path=/tmp'])).not.toBeNull();
  });

  test('값이 빠지면 거부한다', () => {
    expect(validateGitArgs('log', ['--author'])).not.toBeNull();
  });

  test('숫자를 받는 옵션에 숫자가 아닌 값이 오면 거부한다', () => {
    expect(validateGitArgs('grep', ['-A', 'abc', 'foo'])).not.toBeNull();
  });

  test('값 없는 옵션에 =를 붙이면 거부한다', () => {
    expect(validateGitArgs('log', ['--oneline=x'])).not.toBeNull();
  });
});

describe('묶어 쓴 단문자 옵션', () => {
  test('값 없는 옵션끼리만 묶을 수 있다', () => {
    expect(validateGitArgs('status', ['-sb'])).toBeNull();
  });

  test('값을 받는 옵션이 섞이면 거부한다', () => {
    // git은 -L을 만나면 다음 토큰을 값으로 가져가므로 파싱이 어긋난다
    expect(validateGitArgs('blame', ['-wL', '1,5'])).not.toBeNull();
  });

  test('목록에 없는 문자가 섞이면 거부한다', () => {
    expect(validateGitArgs('status', ['-sZ'])).not.toBeNull();
  });
});
