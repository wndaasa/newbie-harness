// run_git이 허용하는 읽기 전용 서브커맨드와 옵션.
//
// ── 왜 허용목록인가
// git은 읽기처럼 보이는 서브커맨드에도 외부 명령을 실행시키는 옵션을 가지고
// 있다. 실제로 `git grep -O<명령>`(--open-files-in-pager)은 매칭된 파일을 그
// 명령으로 열기 때문에 임의 실행이 된다. 막을 옵션을 쫓아다니는 방식은 git이
// 옵션을 추가할 때마다 구멍이 생기므로, 안전이 확인된 것만 통과시킨다.
//
// ── 목록을 좁게 잡은 이유
// run_git의 호출자는 사람이 아니라 이 앱의 시스템 프롬프트를 따르는 모델이다.
// 프롬프트가 지시하는 용도는 "변경 이력·수정 내용·특정 줄이 바뀐 이유 조사"로
// 좁아서(config.ts의 SYSTEM_PROMPT, tools/prompt.ts) git의 전체 옵션을 덮을
// 이유가 없다. 목록이 작을수록 검토가 쉽고 잘못 넣을 여지도 준다. 필요한
// 옵션이 거부되면 그때 근거를 확인하고 추가하면 된다 — 거부 메시지가 모델에게
// 다른 방법을 안내한다.
//
// ── 제외 기준 (git 2.53 문서 기준으로 판단)
//   1. 외부 명령을 실행함      -O/--open-files-in-pager, --ext-diff, --textconv
//   2. 파일을 만들거나 덮어씀   --output
//   3. 설정·실행 경로를 바꿈    -c, --config-env, --exec-path
//   4. 네트워크로 나감         --upload-pack, --receive-pack
//   5. 저장소를 변경함         reflog expire/delete 같은 위치 인자
//
// 값을 받는 옵션은 종류를 함께 적는다. 이걸 틀리면 검증기가 본 것과 git이
// 실제로 실행하는 것이 달라진다 (validateGitArgs 주석 참고).

import { isAbsolute } from 'node:path';

/** 옵션이 받는 값의 종류 */
export type FlagArgType = 'none' | 'number' | 'string';

export type GitCommandConfig = {
  safeFlags: Record<string, FlagArgType>;
  /** 옵션이 아닌 위치 인자까지 봐야 하는 경우 (reflog 등) */
  isDangerous?: (args: string[]) => boolean;
};

const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/;

// 서브커맨드와 무관하게 항상 거부. git의 전역 옵션은 서브커맨드 앞에 와야
// 하므로 구조상 이미 걸리지만, 축약형까지 고려해 한 번 더 막는다.
const ALWAYS_DENIED = ['-c', '--config-env', '--exec-path', '--upload-pack', '--receive-pack'];

// ── 여러 서브커맨드가 공유하는 묶음 ──────────────────────────────────────────

/** 커밋을 몇 개까지, 어느 범위로 볼지 */
const COMMIT_RANGE: Record<string, FlagArgType> = {
  '--all': 'none',
  '--max-count': 'number',
  '--skip': 'number',
  '-n': 'number',
  '--since': 'string',
  '--until': 'string',
  '--before': 'string',
  '--after': 'string',
};

/** 커밋 목록의 표시 형태 */
const COMMIT_FORMAT: Record<string, FlagArgType> = {
  '--oneline': 'none',
  '--graph': 'none',
  '--decorate': 'none',
  '--no-decorate': 'none',
  '--abbrev-commit': 'none',
  '--date': 'string',
  '--pretty': 'string',
  '--format': 'string',
};

/** 누가·언제 만든 커밋인지로 거르기 */
const COMMIT_FILTER: Record<string, FlagArgType> = {
  '--author': 'string',
  '--committer': 'string',
  '--grep': 'string',
  '--merges': 'none',
  '--no-merges': 'none',
  '--first-parent': 'none',
  '--reverse': 'none',
  '--follow': 'none',
};

/** 변경량 요약 (내용 대신 통계만) */
const CHANGE_SUMMARY: Record<string, FlagArgType> = {
  '--stat': 'none',
  '--numstat': 'none',
  '--shortstat': 'none',
  '--name-only': 'none',
  '--name-status': 'none',
  '--summary': 'none',
};

/** 변경 내용 표시. --no-ext-diff는 외부 diff를 끄는 쪽이라 안전하다 */
const CHANGE_PATCH: Record<string, FlagArgType> = {
  '--patch': 'none',
  '-p': 'none',
  '--no-patch': 'none',
  '--no-ext-diff': 'none',
  '-s': 'none',
  '--unified': 'number',
  '-U': 'number',
  '--function-context': 'none',
  '--diff-filter': 'string',
};

/** 공백 차이 무시 */
const WHITESPACE: Record<string, FlagArgType> = {
  '--ignore-all-space': 'none',
  '--ignore-space-change': 'none',
  '--ignore-space-at-eol': 'none',
  '--ignore-blank-lines': 'none',
  '-w': 'none',
};

const COLOR: Record<string, FlagArgType> = {
  '--color': 'none',
  '--no-color': 'none',
};

// ── 서브커맨드별 허용 옵션 ──────────────────────────────────────────────────

export const GIT_READ_ONLY_COMMANDS: Record<string, GitCommandConfig> = {
  // 작업 트리 상태. 매 턴 환경 정보에도 --short로 들어간다
  status: {
    safeFlags: {
      ...COLOR,
      '--short': 'none',
      '-s': 'none',
      '--branch': 'none',
      '-b': 'none',
      '--porcelain': 'none',
      '--long': 'none',
      '--untracked-files': 'string',
      '-u': 'string',
      '--ignored': 'none',
      '--ahead-behind': 'none',
      '--no-ahead-behind': 'none',
      '--renames': 'none',
      '--no-renames': 'none',
    },
  },

  // 커밋 이력 조사. 가장 자주 쓰인다
  log: {
    safeFlags: {
      ...COMMIT_RANGE,
      ...COMMIT_FORMAT,
      ...COMMIT_FILTER,
      ...CHANGE_SUMMARY,
      ...CHANGE_PATCH,
      ...WHITESPACE,
      ...COLOR,
      '--topo-order': 'none',
      '--date-order': 'none',
      // 특정 문자열이 추가·삭제된 커밋 찾기. 반드시 값을 받는다
      '-S': 'string',
      '-G': 'string',
      '--pickaxe-regex': 'none',
    },
  },

  // 커밋 하나의 내용 보기
  show: {
    safeFlags: {
      ...COMMIT_FORMAT,
      ...CHANGE_SUMMARY,
      ...CHANGE_PATCH,
      ...WHITESPACE,
      ...COLOR,
      '--raw': 'none',
    },
  },

  // 변경 내용 비교.
  // 작업 트리 밖을 가리키는 경로를 받으면 git은 --no-index 없이도 두 파일 비교로
  // 바꿔 그 내용을 보여준다(git diff /dev/null ~/.ssh/id_rsa). 저장소 밖으로
  // 나가는 경로 모양은 위치 인자로 받지 않는다
  diff: {
    isDangerous(args) {
      return args.some(
        arg =>
          !arg.startsWith('-') &&
          (isAbsolute(arg) || arg.startsWith('~') || /(^|[\\/])\.\.([\\/]|$)/.test(arg)),
      );
    },
    safeFlags: {
      ...CHANGE_SUMMARY,
      ...CHANGE_PATCH,
      ...WHITESPACE,
      ...COLOR,
      '--cached': 'none',
      '--staged': 'none',
      // --no-index는 저장소와 무관한 임의의 두 경로를 비교해 내용을 보여준다.
      // 읽기 게이트(자격증명 경로 확인)를 거치지 않고 ~/.ssh 같은 파일을 읽는 길이라 넣지 않는다
      '--find-renames': 'none',
      '-M': 'none',
      '--find-copies': 'none',
      '-C': 'none',
      '--no-renames': 'none',
      '--abbrev': 'number',
      '--full-index': 'none',
      '--exit-code': 'none',
      '--quiet': 'none',
      '--relative': 'string',
      // -O(orderfile)는 파일을 읽어 표시 순서를 정하는 옵션이다. 굳이 필요하지
      // 않고 grep의 -O와 혼동될 여지가 있어 넣지 않는다
    },
  },

  // 특정 줄이 언제·왜 바뀌었는지. 프롬프트가 예시로 드는 용도
  blame: {
    safeFlags: {
      ...COLOR,
      '-L': 'string',
      '--porcelain': 'none',
      '--line-porcelain': 'none',
      '--show-name': 'none',
      '--show-number': 'none',
      '-n': 'none',
      '--show-email': 'none',
      '-e': 'none',
      '--date': 'string',
      '--abbrev': 'number',
      '-w': 'none',
      '-M': 'none',
      '-C': 'none',
      '-s': 'none',
      '-l': 'none',
    },
  },

  // 추적 중인 파일 내용 검색.
  // -O(--open-files-in-pager)는 외부 명령을 실행하므로 반드시 제외한다
  grep: {
    safeFlags: {
      ...COLOR,
      '-e': 'string',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-c': 'none',
      '--count': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '-L': 'none',
      '--files-without-match': 'none',
      '-h': 'none',
      '-H': 'none',
      '--full-name': 'none',
      '-o': 'none',
      '--only-matching': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '--and': 'none',
      '--or': 'none',
      '--not': 'none',
      '--max-depth': 'number',
      '--untracked': 'none',
      '--cached': 'none',
      '-q': 'none',
    },
  },

  // 추적 파일 목록. 소스 컨트롤 패널이 쓰는 조합과 같다
  'ls-files': {
    safeFlags: {
      '--cached': 'none',
      '-c': 'none',
      '--deleted': 'none',
      '-d': 'none',
      '--modified': 'none',
      '-m': 'none',
      '--others': 'none',
      '-o': 'none',
      '--ignored': 'none',
      '-i': 'none',
      '--stage': 'none',
      '-s': 'none',
      '--unmerged': 'none',
      '-u': 'none',
      '--directory': 'none',
      '--full-name': 'none',
      '--abbrev': 'number',
      '--exclude': 'string',
      '-x': 'string',
      '--exclude-standard': 'none',
      '--error-unmatch': 'none',
      '-z': 'none',
      '-t': 'none',
    },
  },

  // 리비전·저장소 경로 조회
  'rev-parse': {
    safeFlags: {
      '--verify': 'none',
      '--quiet': 'none',
      '-q': 'none',
      '--short': 'string',
      '--abbrev-ref': 'none',
      '--symbolic': 'none',
      '--symbolic-full-name': 'none',
      '--show-toplevel': 'none',
      '--show-prefix': 'none',
      '--show-cdup': 'none',
      '--git-dir': 'none',
      '--absolute-git-dir': 'none',
      '--is-inside-work-tree': 'none',
      '--is-inside-git-dir': 'none',
      '--is-bare-repository': 'none',
    },
  },

  // 가장 가까운 태그로 현재 위치 표현
  describe: {
    safeFlags: {
      '--tags': 'none',
      '--all': 'none',
      '--long': 'none',
      '--abbrev': 'number',
      '--always': 'none',
      '--contains': 'none',
      '--exact-match': 'none',
      '--match': 'string',
      '--exclude': 'string',
      '--dirty': 'none',
    },
  },

  // 작성자별 커밋 요약
  shortlog: {
    safeFlags: {
      '--all': 'none',
      '--since': 'string',
      '--until': 'string',
      '--numbered': 'none',
      '-n': 'none',
      '--summary': 'none',
      '-s': 'none',
      '--email': 'none',
      '-e': 'none',
      '--no-merges': 'none',
      '--author': 'string',
      '--format': 'string',
    },
  },

  // HEAD 이동 기록. expire·delete는 .git/logs를 수정하므로 아래에서 막는다
  reflog: {
    safeFlags: {
      ...COMMIT_RANGE,
      ...COMMIT_FORMAT,
    },
    isDangerous(args) {
      const WRITES = new Set(['expire', 'delete']);
      for (const token of args) {
        if (!token || token.startsWith('-')) continue;
        // 첫 위치 인자만 하위 명령이 될 수 있다. show나 ref 이름이면 안전
        return WRITES.has(token);
      }
      return false;
    },
  },
};

// ── 검증 ────────────────────────────────────────────────────────────────────

function isValidArgValue(value: string, argType: FlagArgType): boolean {
  if (argType === 'number') return /^\d+$/.test(value);
  return argType === 'string';
}

/**
 * 서브커맨드 뒤의 인자를 검사한다. 통과하면 null, 거부하면 사유를 반환한다.
 *
 * 값을 받는 옵션을 특히 조심해서 다룬다. 어떤 옵션이 값을 받는지 잘못 알면
 * 검증기는 다음 토큰을 옵션으로 보고 검사하는데 git은 그걸 앞 옵션의 값으로
 * 삼는다(또는 그 반대). 이 어긋남이 생기면 검사를 통과한 문자열이 git에서는
 * 다른 의미로 실행된다.
 */
export function validateGitArgs(subcommand: string, args: string[]): string | null {
  const config = GIT_READ_ONLY_COMMANDS[subcommand];
  if (!config) {
    return `run_git이 지원하지 않는 서브커맨드입니다: ${subcommand}`;
  }

  for (const token of args) {
    const name = token.split('=')[0];
    if (ALWAYS_DENIED.includes(name)) {
      return `${name} 옵션은 외부 명령 실행으로 이어질 수 있어 사용할 수 없습니다.`;
    }
  }

  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!token) {
      i += 1;
      continue;
    }

    // POSIX 관례상 -- 뒤는 경로·리비전이다. git도 이를 따른다
    if (token === '--') break;

    if (!(token.startsWith('-') && token.length > 1 && FLAG_PATTERN.test(token))) {
      i += 1;
      continue;
    }

    // --flag=value 형태. '='를 직접 쓴 경우와 값이 빈 경우를 구분해야
    // 다음 토큰을 값으로 잘못 가져가지 않는다
    const hasEquals = token.includes('=');
    const [flag, ...rest] = token.split('=');
    if (!flag) return `해석할 수 없는 옵션입니다: ${token}`;
    const inlineValue = rest.join('=');

    const argType = config.safeFlags[flag];

    if (!argType) {
      // git은 -<숫자>를 개수 지정의 축약으로 받는다 (log -5)
      if (/^-\d+$/.test(flag)) {
        i += 1;
        continue;
      }

      // -sb 처럼 단문자를 붙여 쓴 경우. 값을 받는 옵션이 섞이면 git이 다음
      // 토큰을 값으로 가져가므로, 전부 값 없는 옵션일 때만 허용한다
      if (!flag.startsWith('--') && flag.length > 2) {
        for (let j = 1; j < flag.length; j += 1) {
          const single = `-${flag[j]}`;
          const singleType = config.safeFlags[single];
          if (!singleType) return rejectFlag(subcommand, single);
          if (singleType !== 'none') {
            return `${single}은 값을 받는 옵션이라 ${flag}처럼 붙여 쓸 수 없습니다. 따로 지정하세요.`;
          }
        }
        i += 1;
        continue;
      }

      return rejectFlag(subcommand, flag);
    }

    if (argType === 'none') {
      if (hasEquals) return `${flag} 옵션은 값을 받지 않습니다.`;
      i += 1;
      continue;
    }

    let value: string;
    if (hasEquals) {
      value = inlineValue;
      i += 1;
    } else {
      const next = args[i + 1];
      const nextIsFlag =
        next !== undefined && next.startsWith('-') && next.length > 1 && FLAG_PATTERN.test(next);
      if (next === undefined || nextIsFlag) {
        return `${flag} 옵션에 필요한 값이 없습니다.`;
      }
      value = next;
      i += 2;
    }

    // 값이 -로 시작하면, 실제로는 값을 받지 않는 옵션이었을 때 그 뒤가
    // 검사 없이 옵션으로 실행될 수 있다
    if (value.startsWith('-')) {
      return `${flag} 옵션의 값은 -로 시작할 수 없습니다: ${value}`;
    }

    if (!isValidArgValue(value, argType)) {
      return `${flag} 옵션의 값이 올바르지 않습니다: ${value}`;
    }
  }

  if (config.isDangerous?.(args)) {
    return `run_git은 저장소를 변경하거나 저장소 밖을 읽는 ${subcommand} 인자를 실행할 수 없습니다.`;
  }

  return null;
}

function rejectFlag(subcommand: string, flag: string): string {
  return (
    `run_git은 읽기 전용으로 확인된 옵션만 허용합니다. git ${subcommand}에서 ${flag}는 목록에 없습니다. ` +
    '다른 옵션으로 같은 정보를 얻거나, 꼭 필요하면 run_command로 사용자 승인을 받아 실행하세요.'
  );
}
