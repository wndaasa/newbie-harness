// 자동 모드에서 승인 없이 실행해도 되는 셸 명령 판정.
//
// ── 왜 허용목록인가
// 거부목록(위험한 형태를 찾아 사유를 붙이는 방식)은 빠뜨린 항목이 곧 무방비다.
// 승인 창이 매번 뜨던 시절에는 그것으로 충분했다 — 사람이 어차피 명령을 보고
// 결정했다. 자동 모드가 코딩 탭 기본값이 되면서 목록에 없는 형태가 사람을
// 거치지 않고 그냥 실행되는 문제가 생겨, 이 방향 판정만큼은
// gitReadOnlyCommands.ts와 같은 방식으로 뒤집는다 — 안전이 확인된 것만 자동으로
// 통과시키고 나머지는 분류기(자동 모드) 또는 사용자(다른 모드)에게 맡긴다.
//
// ── 이것도 보안 경계는 아니다
// 목록에 있는 `bun run <script>`나 `node <file>`은 결국 저장소 안의 임의 코드를
// 실행한다. 에이전트는 그 파일을 직접 쓸 수도 있으므로, 마음먹은 우회를 막지는
// 못한다. 노리는 것은 다른 쪽이다 — 모르는 바이너리, 네트워크로 나가는 명령,
// 자격증명을 건드리는 명령, 기존 파일을 덮어쓰는 명령이 조용히 실행되지 않게
// 하는 것. destructiveCommands.ts는 재귀 삭제·강제 푸시 같은 형태만 따로 잡고
// 덮어쓰기(cp, Set-Content, > 리다이렉트)는 보지 않으므로 그건 여기서 가린다.
//
// ── 목록을 좁게 잡는다
// 필요한 명령이 거부되면 승인 창이 한 번 뜰 뿐이고, 그때 근거를 확인하고 추가하면
// 된다. 반대로 잘못 넣은 항목은 조용히 실행된다. 비용이 비대칭이라 좁은 쪽으로
// 기운다. curl·wget·Invoke-WebRequest가 빠진 것은 의도적이다 — 데이터를 바깥으로
// 보내는 경로라 사람 손을 거치게 한다. 예외는 요청 주소가 전부 사설망(루프백,
// 10.x, 172.16-31.x, 192.168.x)일 때뿐이다 — 그건 사용자의 개발서버지 바깥이
// 아니다 (privateRequestReason).

import { isAbsolute, join, relative, resolve } from 'node:path';
import { sensitivePathReason } from '../sensitivePaths.ts';
import { agentWorkspaceDir } from '../agentWorkspace.ts';
import { getWorkdir } from '../../agent/workdir.ts';
import { GIT_READ_ONLY_COMMANDS, validateGitArgs } from '../git/gitReadOnlyCommands.ts';

/**
 * 서브커맨드 자리에 오는 버전 확인 플래그. `bun --version`처럼 런타임이 설치돼
 * 있는지 보는 명령은 아무것도 실행하지 않으므로, 서브커맨드 목록과 무관하게
 * 통과시킨다. 이게 막히면 모델은 새 프로젝트를 만들기 전 런타임 확인을 건너뛴다.
 */
const VERSION_FLAGS = new Set(['--version', '-v', 'version']);

/** 서브커맨드까지 봐야 하는 명령. 값에 없는 서브커맨드면 승인을 받는다 */
const SUBCOMMAND_ALLOWLIST: Record<string, Set<string>> = {
  // install·add는 npm 레지스트리의 postinstall 스크립트를 실행하고, publish는
  // 바깥으로 내보낸다. x(bunx)도 레지스트리에서 받은 패키지를 바로 실행하므로
  // 같은 이유로 뺀다. 저장소에 이미 있는 스크립트를 돌리는 것만 통과시킨다.
  // git은 옵션까지 봐야 해서 따로 판정한다 (gitReason)
  bun: new Set(['run', 'test']),
  npm: new Set(['run', 'run-script', 'test']),
  pnpm: new Set(['run', 'test']),
  yarn: new Set(['run', 'test']),
};

/** 서브커맨드를 보지 않고 이름만으로 통과시키는 명령 */
const COMMAND_ALLOWLIST = new Set([
  // 프로젝트 도구 — 저장소 안의 코드를 돌린다. 자기 검증 루프가 쓰는 경로다.
  // bunx·deno는 원격 패키지·URL의 코드를 바로 실행할 수 있어 넣지 않는다
  'node',
  'tsc',
  'tsx',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  'biome',

  // 읽기 — 셸에서 확인만 하는 것들
  'basename',
  'cat',
  // 구간마다 따로 검사하므로 cd는 그 구간의 위치만 바꾼다. 뒤에 오는 명령은 원래
  // 규칙대로 본다. 없으면 "cd x && bun test"처럼 안전한 명령까지 분류기를 타서
  // 턴당 상한을 소진했다
  'cd',
  'date',
  'dirname',
  'du',
  'echo',
  'file',
  'grep',
  'head',
  'jq',
  'ls',
  'pwd',
  'rg',
  'sort',
  'stat',
  'tail',
  'tree',
  'uniq',
  'wc',
  'where',
  'which',

  // 파일·폴더를 만들고 옮기는 쓰기.
  //
  // 새로 만드는 것(mkdir, touch, New-Item)은 create_file처럼 그냥 통과시킨다.
  // 기존 파일을 덮어쓸 수 있는 것(cp, mv, Set-Content 등)은 이름이 목록에
  // 있어도 대상이 에이전트 작업 폴더(.newbie) 안일 때만 통과시킨다 —
  // edit_file은 읽은 파일만 고치고 create_file은 덮어쓰지 않는데, 셸로는
  // 그 확인 없이 덮어쓸 수 있다 (writeReason).
  'cp',
  'mkdir',
  'mv',
  'printf',
  'touch',

  // PowerShell 표기 (Windows에서는 셸이 pwsh라 위 이름이 아예 안 쓰인다).
  // 읽기·쓰기·파이프라인 정리를 함께 넣는다 — 하나만 빠져도 구획 하나 때문에
  // 명령 전체가 승인 대상이 된다
  'add-content',
  'compare-object',
  'convertfrom-json',
  'convertto-json',
  'copy-item',
  'foreach-object',
  'format-list',
  'format-table',
  'get-childitem',
  'get-command',
  'get-content',
  'get-date',
  'get-item',
  'get-location',
  'get-member',
  'group-object',
  'join-path',
  'md',
  'measure-object',
  'move-item',
  'new-item',
  'out-file',
  'out-null',
  'out-string',
  'rename-item',
  'resolve-path',
  'select-object',
  'select-string',
  'set-content',
  'sort-object',
  'split-path',
  'test-path',
  'where-object',
  'write-host',
  'write-output',
]);

/**
 * HTTP 클라이언트. 허용목록에는 없지만, 요청 주소가 전부 사설망이면 통과시킨다.
 *
 * 분류기 프롬프트에 "사설망은 사용자 인프라"라고 적어 두었는데도, 사고를 끈
 * 소형 모델이 "192.168.1.x는 외부 주소"라며 개발서버로의 curl을 막은 일이
 * 있었다. 프롬프트는 확률이고 주소 대역은 사실이라 이쪽은 코드로 판정한다.
 */
const HTTP_CLIENTS = new Set(['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm']);

/**
 * 응답을 파일로 쓰거나(-o, -O, -OutFile, -P), 요청 주소를 파일에서 읽거나(-K, -i),
 * 프록시를 거치는(-x, -Proxy) 플래그. 무엇을 어디에 쓰는지, 실제로 어디로
 * 나가는지 명령 문자열만으로는 알 수 없으므로 분류기에 넘긴다.
 *
 * curl·wget의 첫 정규식은 -sSo처럼 뭉친 짧은 플래그 안의 o·O까지 잡는다 — 두
 * 도구에서 o·O는 출력 플래그뿐이다. PowerShell은 -Method·-Body처럼 한 대시 뒤에
 * 긴 이름이 오므로 같은 정규식을 쓸 수 없어 이름을 명시한다
 */
const HTTP_UNVERIFIABLE_FLAGS: Record<string, RegExp[]> = {
  curl: [
    /^-[A-Za-z]*[oO][A-Za-z]*$/,
    /^--(output|remote-name|remote-name-all|output-dir|config|proxy)(=|$)/,
    /^-(K|x)$/,
  ],
  // -i는 주소 목록 파일 (curl의 -i는 응답 헤더 표시라 무해)
  wget: [
    /^-[A-Za-z]*[oO][A-Za-z]*$/,
    /^--(output-document|output-file|directory-prefix|input-file|config)(=|$)/,
    /^-(P|i)$/,
  ],
  powershell: [/^-(OutFile|Proxy)$/i],
};

function httpUnverifiableFlags(head: string): RegExp[] {
  return HTTP_UNVERIFIABLE_FLAGS[head] ?? HTTP_UNVERIFIABLE_FLAGS.powershell;
}

/** 스킴 없이 적은 주소 (`curl 192.168.1.10:8080/x`, `localhost:8080`) */
const BARE_HOST = /^(\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::\d+)?(?:\/\S*)?$/i;

/** 사용자 자신의 네트워크로 볼 수 있는 호스트: 루프백과 RFC 1918 대역만 */
function isOwnNetworkHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return true;
  const parts = name.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * HTTP 클라이언트 구간이 사설망 밖으로 나갈 수 있으면 사유를, 사설망 안에서만
 * 도는 것이 분명하면 null을 반환한다.
 *
 * 주소는 구간 전체에서 찾는다 — 인자로 넘기는 JSON 본문에 외부 URL이 섞여 있어도
 * 걸리는데, 그쪽으로 기울어도 분류기가 한 번 더 볼 뿐이라 괜찮다. 주소를 하나도
 * 못 읽으면(변수, 파일 목록) 확인이 안 된 것이므로 역시 분류기로 보낸다
 */
function privateRequestReason(head: string, segment: string): string | null {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const flags = httpUnverifiableFlags(head);
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (flags.some(flag => flag.test(token))) {
      return `${head}가 파일이나 프록시를 거치는 플래그(${token})를 씁니다.`;
    }
  }

  const hosts: string[] = [];
  for (const match of segment.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
    try {
      hosts.push(new URL(match[0]).hostname);
    } catch {
      return `${head}의 요청 주소를 읽을 수 없습니다: ${match[0]}`;
    }
  }
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, '');
    const bare = BARE_HOST.exec(token);
    if (bare) hosts.push(bare[1]);
  }
  if (hosts.length === 0) return `${head}의 요청 주소를 읽을 수 없습니다.`;

  const outside = hosts.find(host => !isOwnNetworkHost(host));
  return outside ? `${head}가 사설망 밖 주소로 요청합니다: ${outside}` : null;
}

/**
 * 이름은 목록에 있어도 코드를 실행하거나 파일을 쓰게 만드는 플래그.
 *
 * 저장소 안의 파일을 돌리는 것(node script.js)과 달리 인라인 코드나 외부 명령은
 * 이 판정이 볼 수 없는 곳에서 실행되므로 분류기에 넘긴다.
 */
const NODE_INLINE_CODE = /^(-e|-p|-pe|--eval|--print)(=|$)/;
const PACKAGE_MANAGER_CONFIG = /^--(script-shell|node-options|userconfig|globalconfig)(=|$)/;
const UNSAFE_FLAGS: Record<string, RegExp> = {
  node: NODE_INLINE_CODE,
  tsx: NODE_INLINE_CODE,
  // --pre·--hostname-bin은 검색하면서 임의 명령을 실행한다
  rg: /^--(pre|pre-glob|hostname-bin)(=|$)/,
  // --compress-program은 임의 명령을 실행하고, -o는 결과로 파일을 덮어쓴다
  sort: /^--(compress-program|output)(=|$)|^-[A-Za-z]*o/,
  tree: /^-o$/,
  // 스크립트를 돌릴 셸·노드 옵션·설정 파일을 바꿔 다른 명령을 실행하게 할 수 있다
  bun: PACKAGE_MANAGER_CONFIG,
  npm: PACKAGE_MANAGER_CONFIG,
  pnpm: PACKAGE_MANAGER_CONFIG,
  yarn: PACKAGE_MANAGER_CONFIG,
};

/**
 * 명령 앞에 붙여도 되는 환경 변수 (`CI=1 bun test`).
 * GIT_EXTERNAL_DIFF·NODE_OPTIONS·LD_PRELOAD처럼 목록에 있는 명령이 다른 코드를
 * 실행하게 만드는 변수가 많아, 흔하고 무해한 것만 통과시킨다
 */
const SAFE_ENV_PREFIX = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|DEBUG|TZ|LANG|LC_[A-Z]+|PORT|HOST)$/;

// 환경 변수를 통째로 찍으면 API 키가 그대로 모델 컨텍스트에 올라간다.
// sensitivePathReason은 파일 경로만 보기 때문에 여기서 따로 잡는다
const ENV_DUMP = /^(env|printenv|set|get-variable)$/;

/**
 * PowerShell의 Env: 드라이브 접근. 나열(`dir env:`)뿐 아니라 `$` 없이 값 하나를
 * 읽는 형태(`Get-Content env:OPENAI_API_KEY`)도 잡는다. `$env:PATH` 같은 변수
 * 참조는 SECRET_VAR가 이름을 보고 판정한다
 */
const ENV_DRIVE = /(?<![$\w{])env:/i;

/** Linux에서 프로세스 환경 변수를 파일로 읽는 경로 */
const PROC_ENVIRON = /\/proc\/[^\s/]+\/environ\b/i;

/**
 * 이름만으로 비밀값이 분명한 변수 참조.
 *
 * `echo`는 목록에 있어서 `echo $OPENAI_API_KEY`가 그냥 통과한다. 변수 확장까지
 * 따라갈 수는 없으니, 이름이 노골적인 것만 걷어낸다. $PATH 같은 평범한 변수는
 * 걸리지 않는다.
 */
const SECRET_VAR = /\$(\{|env:)?[A-Za-z_][A-Za-z0-9_]*(key|token|secret|password|credential)/i;

/** 안을 들여다볼 수 없어 판정을 포기해야 하는 문법 */
const OPAQUE = [
  { pattern: /\$\(/, label: '명령 치환' },
  { pattern: /`/, label: '백틱 치환' },
  { pattern: /<\(/, label: '프로세스 치환' },
  // 문자열을 코드로 실행하거나 다른 프로세스로 넘기는 PowerShell 명령. 목록에도
  // 없지만, 괄호나 스크립트 블록 안에 숨으면 머리 이름 검사가 보지 못한다
  {
    pattern: /\b(iex|invoke-expression|start-process|saps|invoke-command|icm|invoke-item)\b/i,
    label: '간접 실행 명령',
  },
];

/**
 * 따옴표 밖에서만 찾는 PowerShell·sh 문법. 괄호식 `(Get-Content x)`, 정적 호출
 * `[IO.File]::WriteAllText(...)`, 스크립트 블록 `ForEach-Object { ... }`은 머리
 * 이름이 목록에 있어도 안에서 무엇이든 실행할 수 있다
 */
const SEGMENT_OPAQUE = [
  { pattern: /[(){}]/, label: '괄호식이나 스크립트 블록' },
  { pattern: /\]::/, label: '.NET 정적 호출' },
];

type Segment = { redirects: string[]; tokens: string[] };

/**
 * 따옴표 밖의 연결자(|, ||, &&, ;, &, 줄바꿈)로 구획을 나누고, 구획마다 토큰과
 * 출력 리다이렉트 대상을 모은다. 따옴표 짝이 맞지 않으면 null.
 *
 * 단일 &도 구분자다 — sh에서는 백그라운드 실행, cmd에서는 순차 실행이고
 * PowerShell에서는 호출 연산자라 그 뒤가 별도 명령이다. 정규식으로 나누던 때는
 * 이걸 놓쳐 `ls & curl ...`의 뒤쪽이 검사 없이 지나갔다. 2>&1 같은 파일 설명자
 * 복제는 구분자도 쓰기도 아니다.
 */
function parseSegments(command: string): Segment[] | null {
  const result: Segment[] = [];
  let tokens: string[] = [];
  let redirects: string[] = [];
  let current = '';
  let quote: string | null = null;
  let redirectNext = false;

  const pushToken = () => {
    if (!current) return;
    if (redirectNext) redirects.push(current);
    else tokens.push(current);
    current = '';
    redirectNext = false;
  };
  const endSegment = () => {
    pushToken();
    // 대상 없이 끝난 리다이렉트도 확인할 수 없는 쓰기로 본다
    if (redirectNext) redirects.push('');
    redirectNext = false;
    if (tokens.length > 0 || redirects.length > 0) result.push({ redirects, tokens });
    tokens = [];
    redirects = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      endSegment();
      continue;
    }
    if (ch === '|') {
      endSegment();
      if (command[i + 1] === '|') i += 1;
      continue;
    }
    if (ch === '&') {
      // &>, &>>: stdout과 stderr를 함께 파일로
      if (command[i + 1] === '>') {
        pushToken();
        i += command[i + 2] === '>' ? 2 : 1;
        redirectNext = true;
        continue;
      }
      endSegment();
      if (command[i + 1] === '&') i += 1;
      continue;
    }
    if (ch === '>') {
      // 앞에 붙은 숫자·*는 파일 설명자 지정이다 (2>, *>)
      if (/^(\d+|\*)$/.test(current)) current = '';
      else pushToken();
      if (command[i + 1] === '>') i += 1;
      if (command[i + 1] === '&') {
        i += 1;
        // >&1, 2>&1은 다른 설명자로 돌릴 뿐이다. 숫자 없는 >&는 bash에서 파일 리다이렉트다
        if (/[\d-]/.test(command[i + 1] ?? '')) {
          while (/[\d-]/.test(command[i + 1] ?? '')) i += 1;
          continue;
        }
      }
      redirectNext = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    current += ch;
  }

  if (quote) return null;
  endSegment();
  return result;
}

/** 토큰 양 끝의 따옴표 */
function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, '');
}

/** 따옴표 안의 내용을 비운 형태. 문자열 속 괄호·꺾쇠를 문법으로 오인하지 않게 한다 */
function stripQuoted(token: string): string {
  return token.replace(/"[^"]*"|'[^']*'/g, '""');
}

/** 실행 파일 이름. 경로·확장자를 벗기고 소문자로 */
function normalizeHead(token: string): string {
  const base = unquote(token).split(/[/\\]/).pop() ?? '';
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * git은 run_git과 같은 읽기 전용 목록(gitReadOnlyCommands.ts)으로 판정한다.
 * commit·branch·tag·add는 저장소를 바꾸고, fetch는 --upload-pack으로 임의 명령을
 * 실행할 수 있다. 옵션까지 허용목록으로 봐야 --output(파일 덮어쓰기)이나
 * -c(설정 주입) 같은 형태가 걸린다
 */
function gitReason(args: string[]): string | null {
  const sub = (args[0] ?? '').toLowerCase();
  if (VERSION_FLAGS.has(sub)) return null;
  if (!Object.hasOwn(GIT_READ_ONLY_COMMANDS, sub)) {
    return `git ${sub || '(서브커맨드 없음)'}는 자동 실행 목록에 없습니다.`;
  }
  const rejection = validateGitArgs(sub, args.slice(1));
  return rejection ? `git ${sub}: ${rejection}` : null;
}

/** 출력을 버리는 대상 */
function isNullDevice(target: string): boolean {
  return /^(\/dev\/null|\$null|nul)$/i.test(unquote(target));
}

/**
 * 경로가 root 안(root 자신 포함)으로 확실히 풀리는가. 변수·홈·글롭이 섞였거나,
 * 앞 구획의 cd로 기준 폴더가 바뀐 뒤의 상대 경로는 어디로 갈지 알 수 없어 거짓
 */
function resolvesInside(root: string, raw: string, cwdChanged: boolean): boolean {
  const path = raw.replace(/["']/g, '');
  if (!path || /[$%*?~`]/.test(path)) return false;
  if (cwdChanged && !isAbsolute(path)) return false;
  const inside = relative(root, resolve(getWorkdir(), path));
  return !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * 값을 받지 않는 플래그. 여기 없는 `-이름`은 다음 토큰을 값으로 가져간다고 본다.
 * PowerShell은 이름을 줄여 쓸 수 있으므로(-Fo = -Force) 접두사로 맞춘다
 */
const SWITCH_FLAGS = [
  '-append', '-asbytestream', '-confirm', '-container', '-debug', '-force',
  '-noclobber', '-nonewline', '-passthru', '-recurse', '-verbose', '-whatif',
];

type ParsedArgs = { named: [string, string][]; positional: string[] };

/**
 * 인자를 이름 붙은 값과 위치 인자로 나눈다. Windows에서는 cp·mv도 Copy-Item·
 * Move-Item의 별칭이라 sh와 PowerShell 표기를 한 규칙으로 읽는다.
 * -rf 같은 sh의 짧은 플래그 묶음은 값을 받지 않는다고 본다 — 받는다고 보면
 * `cp a -rf 대상`에서 진짜 대상을 플래그 값으로 삼켜 엉뚱한 경로를 검사한다
 */
function parseArgs(args: string[]): ParsedArgs {
  const named: [string, string][] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = unquote(args[i]);
    if (arg.startsWith('--')) {
      const [name, ...value] = arg.split('=');
      named.push([name.toLowerCase(), value.join('=')]);
      continue;
    }
    if (/^-[A-Za-z]/.test(arg)) {
      const colon = arg.indexOf(':');
      const name = (colon > 0 ? arg.slice(0, colon) : arg).toLowerCase();
      if (colon > 0) {
        named.push([name, arg.slice(colon + 1)]);
      } else if (
        SWITCH_FLAGS.some(flag => flag.startsWith(name)) ||
        (/^-[a-z]+$/.test(arg) && name !== '-t' && arg.length <= 4)
      ) {
        named.push([name, '']);
      } else {
        named.push([name, args[i + 1] ?? '']);
        i += 1;
      }
      continue;
    }
    positional.push(args[i]);
  }
  return { named, positional };
}

/** 이름 붙은 값. full의 접두사(최소 minLength 글자)로 줄여 쓴 것도 받는다 */
function namedValue(parsed: ParsedArgs, names: string[], minLength = 3): string | undefined {
  return parsed.named.find(([name]) =>
    names.some(full => name === full || (name.length >= minLength && full.startsWith(name))),
  )?.[1];
}

/** 기존 파일을 덮어쓸 수 있는 명령과 그 대상 경로 */
const COPY_HEADS = new Set(['cp', 'mv', 'copy-item', 'move-item']);
const CONTENT_HEADS = new Set(['set-content', 'add-content', 'out-file']);

function writeTarget(head: string, args: string[]): string | undefined {
  const parsed = parseArgs(args);
  if (COPY_HEADS.has(head)) {
    return (
      namedValue(parsed, ['-destination', '--target-directory', '-t']) ?? parsed.positional.at(-1)
    );
  }
  return namedValue(parsed, ['-path', '-literalpath', '-filepath', '-pspath', '-lp']) ??
    parsed.positional[0];
}

/**
 * New-Item은 새로 만들기만 하면 create_file과 같지만, -Force는 기존 파일을 비우고
 * -Value는 내용을 쓰며 링크 형식은 다른 곳(자격증명 등)을 가리키게 만든다
 */
function newItemReason(args: string[], cwdChanged: boolean): string | null {
  // 형식 이름은 어느 자리에 오든 찾는다 — -it처럼 줄여 쓴 플래그를 값 없는
  // 스위치로 읽으면 namedValue로는 놓친다
  const link = args.map(unquote).find(arg => /^(symboliclink|hardlink|junction)$/i.test(arg));
  if (link) return `New-Item으로 링크(${link})를 만듭니다.`;

  const parsed = parseArgs(args);
  const type = (namedValue(parsed, ['-itemtype', '-type'], 2) ?? 'file').toLowerCase();
  const dir = namedValue(parsed, ['-path']) ?? parsed.positional[0] ?? '.';
  const name = namedValue(parsed, ['-name']);
  const target = name ? join(unquote(dir), unquote(name)) : dir;
  const force = parsed.named.some(([flag]) => flag.length >= 2 && '-force'.startsWith(flag));
  if (force && type !== 'directory' && !resolvesInside(agentWorkspaceDir(), target, cwdChanged)) {
    return `New-Item -Force는 기존 파일을 비우고 다시 만듭니다 (대상: ${target}).`;
  }
  const value = namedValue(parsed, ['-value']) !== undefined;
  if (value && !resolvesInside(getWorkdir(), target, cwdChanged)) {
    return `작업 폴더 밖에 파일을 씁니다: ${target}`;
  }
  return null;
}

/** 덮어쓰기 판정. 대상이 에이전트 작업 폴더(.newbie) 안이면 되돌릴 사용자 자료가 없다 */
function writeReason(head: string, args: string[], cwdChanged: boolean): string | null {
  if (head === 'new-item') return newItemReason(args, cwdChanged);
  if (!COPY_HEADS.has(head) && !CONTENT_HEADS.has(head)) return null;

  const target = writeTarget(head, args);
  if (target && resolvesInside(agentWorkspaceDir(), target, cwdChanged)) return null;
  return `기존 파일을 덮어쓸 수 있는 명령입니다 (대상: ${target ? unquote(target) : '확인 불가'}).`;
}

/** 한 구획의 판정. 통과하면 null */
function segmentReason({ redirects, tokens }: Segment, cwdChanged: boolean): string | null {
  const stripped = tokens.map(stripQuoted).join(' ');
  for (const { pattern, label } of SEGMENT_OPAQUE) {
    if (pattern.test(stripped)) return `${label}이 있어 무엇이 실행될지 확인할 수 없습니다.`;
  }

  for (const target of redirects) {
    if (isNullDevice(target) || resolvesInside(agentWorkspaceDir(), target, cwdChanged)) continue;
    return `출력을 파일로 씁니다 (기존 파일을 덮어쓸 수 있음): ${unquote(target) || '(대상 없음)'}`;
  }

  // sh의 `FOO=bar cmd` 접두사
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    const name = tokens[index].split('=')[0];
    if (!SAFE_ENV_PREFIX.test(name)) {
      return `${name} 환경 변수를 바꿔 실행합니다 (실행되는 코드가 달라질 수 있음).`;
    }
    index += 1;
  }

  const head = normalizeHead(tokens[index] ?? '');
  const args = tokens.slice(index + 1);
  if (!head) return '실행할 명령을 읽을 수 없습니다.';

  if (ENV_DUMP.test(head)) {
    return '환경 변수를 출력합니다 (API 키가 그대로 노출될 수 있음).';
  }

  if (head === 'git') return gitReason(args.map(arg => arg.replace(/["']/g, '')));

  if (HTTP_CLIENTS.has(head)) return privateRequestReason(head, tokens.join(' '));

  const allowedSubs = SUBCOMMAND_ALLOWLIST[head];
  if (allowedSubs) {
    const sub = unquote(args[0] ?? '').toLowerCase();
    if (!allowedSubs.has(sub) && !VERSION_FLAGS.has(sub)) {
      return `${head} ${sub || '(서브커맨드 없음)'}는 자동 실행 목록에 없습니다.`;
    }
  } else if (!COMMAND_ALLOWLIST.has(head)) {
    return `${head}는 자동 실행이 확인된 명령이 아닙니다.`;
  }

  const unsafe = UNSAFE_FLAGS[head];
  const flag = unsafe ? args.map(unquote).find(arg => unsafe.test(arg)) : undefined;
  if (flag) return `${head}의 ${flag} 옵션은 다른 명령을 실행하거나 파일을 씁니다.`;

  // jq는 env·$ENV로 환경 변수 전체를 읽을 수 있다
  if (head === 'jq' && /\$ENV\b|\benv\b/.test(args.join(' '))) {
    return '환경 변수를 출력합니다 (API 키가 그대로 노출될 수 있음).';
  }
  // uniq의 두 번째 위치 인자는 출력 파일이다
  if (head === 'uniq' && args.filter(arg => !arg.startsWith('-')).length >= 2) {
    return 'uniq의 두 번째 인자는 출력 파일이라 기존 파일을 덮어쓸 수 있습니다.';
  }

  return writeReason(head, args, cwdChanged);
}

/**
 * 명령이 자격증명 파일을 건드리는가.
 *
 * `cat`·`cp`는 허용목록에 있어 `cat .env`가 그냥 통과하던 비대칭을 없앤다.
 * 경로처럼 생긴 토큰만 본다 — 맨 단어까지 검사하면 평범한 인자가 자꾸 걸려
 * 신호가 죽는다.
 */
function credentialCommandReason(command: string): string | null {
  const tokens = String(command ?? '').split(/[\s;|&<>]+/).filter(Boolean);

  for (const token of tokens) {
    const cleaned = token.replace(/^["']|["']$/g, '');
    if (!/[./\\~]/.test(cleaned)) continue;
    // 코드 조각은 경로가 아니다. run_command에는 PowerShell 스크립트가 원본
    // 소스 코드를 문자열로 담아 오기도 한다 — "if (e.key === 'Enter')"가
    // 공백으로 쪼개지면 토큰 "(e.key"가 남고, extname이 이걸 확장자 .key로
    // 읽어 개인키 파일로 오인해 막은 실제 사례가 있다. 속성 접근·비교식에
    // 흔한 이 문자들이 있으면 경로 후보에서 뺀다
    if (/[(){}=]/.test(cleaned)) continue;
    const reason = sensitivePathReason(cleaned);
    if (reason) return reason;
  }
  return null;
}

/**
 * 자동 모드에서 승인 없이 실행하기에는 확인이 안 된 명령인가.
 * 승인이 필요하면 사유를, 통과시켜도 되면 null을 반환한다.
 */
export function unverifiedCommandReason(command: string): string | null {
  const text = String(command ?? '').trim();
  if (!text) return null;

  for (const { pattern, label } of OPAQUE) {
    if (pattern.test(text)) {
      return `${label}이 있어 무엇이 실행될지 확인할 수 없습니다.`;
    }
  }

  // sh에서 \"는 따옴표가 아니라 글자다. 구획을 나눌 때 이걸 따옴표로 읽으면
  // `echo \"; rm x; echo \"`의 가운데가 문자열 안으로 숨는다
  if (/\\["']/.test(text)) {
    return '이스케이프된 따옴표가 있어 명령의 경계를 확인할 수 없습니다.';
  }

  if (ENV_DRIVE.test(text) || SECRET_VAR.test(text) || PROC_ENVIRON.test(text)) {
    return '환경 변수의 비밀값을 읽습니다 (API 키가 그대로 노출될 수 있음).';
  }

  // cat·cp는 위 허용목록에 있어 아래 구간별 검사를 그냥 통과한다. .env나 개인키
  // 파일이 인자로 오면 그걸로 허용목록을 뚫는 셈이라 여기서 먼저 가려낸다.
  // 예전엔 이 판정이 곧 confirm(자동 모드에서도 사람에게 확인)이었는데, 명령에
  // 섞인 코드 조각까지 경로로 읽어 "if (e.key === ...)"의 "(e.key"를 개인키
  // 파일로 오인하는 등 오탐이 반복됐다. 이제는 분류기가 맥락을 보고 정하도록
  // 이 목록 밖 명령과 같은 classify로 낮춘다
  const credential = credentialCommandReason(text);
  if (credential) return credential;

  const parts = parseSegments(text);
  if (!parts) return '따옴표 짝이 맞지 않아 명령의 경계를 확인할 수 없습니다.';

  // cd 뒤의 상대 경로는 작업 폴더 기준으로 풀 수 없다 (resolvesInside)
  let cwdChanged = false;
  for (const part of parts) {
    const reason = segmentReason(part, cwdChanged);
    if (reason) return reason;
    if (normalizeHead(part.tokens[0] ?? '') === 'cd') cwdChanged = true;
  }

  return null;
}
