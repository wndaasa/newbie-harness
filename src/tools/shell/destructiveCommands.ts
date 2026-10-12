// run_command가 받은 명령에서 되돌릴 수 없는 작업을 찾아 승인 사유로 올린다.
//
// 이건 보안 경계가 아니다. 셸 문법은 얼마든지 우회할 수 있고(변수 치환, 인코딩,
// 스크립트 파일로 우회), 여기서 막으려 들면 우회 가능한 제약으로 능력만 좁히는
// 결과가 된다. 목적은 다르다 — 승인 창에 "무엇이 왜 위험한지"를 띄워서 사용자가
// 명령 문자열을 직접 해독하지 않고도 판단하게 하는 것이다.
//
// 그래서 판정 결과는 차단이 아니라 사유 문자열이다. 예전에는 이 사유가 붙으면
// 권한 모드와 무관하게(auto 포함) 무조건 사람에게 확인을 받았는데, 이제는 다른
// 목록 밖 명령과 같은 classify로 낮췄다 — 자동 모드에서는 LLM 분류기가 맥락을
// 보고 정하고, 다른 모드에서는 여전히 승인 창이 뜬다. "무엇이 왜 위험한지"를
// 분류기와 승인 창 양쪽에 보여주는 역할은 그대로다.

type Rule = {
  /** 명령에서 찾을 패턴 (대소문자 무시) */
  pattern: RegExp;
  /** 승인 창에 보여줄 사유 */
  reason: string;
};

// Windows는 PowerShell, 그 외는 sh로 실행되므로 양쪽 표기를 함께 본다.
const RULES: Rule[] = [
  {
    pattern: /\brm\s+(-\S*\s+)*-\S*[rf]/i,
    reason: '파일·디렉터리를 재귀적으로 삭제합니다 (되돌릴 수 없음)',
  },
  {
    pattern: /\bremove-item\b[^|;]*-(recurse|force)\b/i,
    reason: '파일·디렉터리를 재귀적으로 삭제합니다 (되돌릴 수 없음)',
  },
  {
    pattern: /\b(rd|rmdir)\s+\/s|\bdel\s+(\/\S+\s+)*\/[sq]\b/i,
    reason: '디렉터리 전체를 삭제합니다 (되돌릴 수 없음)',
  },
  {
    // format은 단어 자체가 흔해서(코드 포매팅 등) 드라이브 문자나 /fs: 를 요구한다
    pattern: /\bmkfs\S*\s|\bdiskpart\b|\bformat\s+([a-z]:|\/fs)/i,
    reason: '디스크를 포맷하거나 파티션을 조작합니다 (되돌릴 수 없음)',
  },
  {
    pattern: /\bdd\b[^|;]*\bof=/i,
    reason: '장치나 파일에 저수준으로 덮어씁니다 (되돌릴 수 없음)',
  },
  {
    pattern: /\bdrop\s+(database|schema|table)\b|\btruncate\s+table\b/i,
    reason: '데이터베이스의 테이블이나 스키마를 삭제합니다 (되돌릴 수 없음)',
  },
  {
    pattern: /\bgit\s+push\b[^|;]*(--force(?!-with-lease)|\s-f\b)/i,
    reason: '원격 이력을 강제로 덮어씁니다 (다른 사람의 커밋이 사라질 수 있음)',
  },
  {
    pattern: /\bgit\s+reset\b[^|;]*--hard\b/i,
    reason: '커밋되지 않은 변경을 모두 버립니다 (되돌릴 수 없음)',
  },
  {
    pattern: /\bgit\s+clean\b[^|;]*-\S*[fdx]/i,
    reason: '추적되지 않는 파일을 삭제합니다 (되돌릴 수 없음)',
  },
  {
    pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^|;]*\|[^|;]*\b(sh|bash|zsh|iex|invoke-expression)\b/i,
    reason: '내려받은 스크립트를 그대로 실행합니다 (내용을 확인할 수 없음)',
  },
  {
    pattern: /\b(iex|invoke-expression)\b/i,
    reason: '문자열을 코드로 실행합니다 (내용을 확인할 수 없음)',
  },
  {
    pattern: /\bchmod\b[^|;]*\b777\b|\bicacls\b[^|;]*\/grant\b[^|;]*\b(everyone|모두)\b/i,
    reason: '파일 권한을 광범위하게 개방합니다',
  },
  {
    pattern: /\bsudo\b|\bstart-process\b[^|;]*-verb\s+runas\b/i,
    reason: '관리자 권한으로 실행합니다',
  },
];

/**
 * 이 명령이 승인을 요구하는 사유. 해당 없으면 null.
 *
 * 여러 규칙에 걸리면 먼저 걸린 사유 하나만 돌려준다 — 승인 창은 사용자가 한눈에
 * 읽고 결정하는 자리라, 사유를 늘어놓는 것보다 가장 먼저 걸린 것을 보여주는 편이
 * 낫다.
 *
 * 사유에 명령 문자열을 넣지 않는다. 승인 창이 라벨과 상세에서 명령을 이미
 * 보여주므로, 여기까지 붙이면 같은 문자열이 세 번 쌓여 정작 읽어야 할 이유가
 * 묻힌다.
 */
export function destructiveCommandReason(command: string): string | null {
  const text = String(command ?? '').trim();
  if (!text) return null;

  return RULES.find(entry => entry.pattern.test(text))?.reason ?? null;
}

/** 삭제 명령의 머리. 셸·cmd·PowerShell 표기를 함께 본다 (ri는 Remove-Item 별칭) */
const DELETE_HEADS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri']);

/** 상위 폴더로 나가거나 범위를 알 수 없는 대상: 글롭, 변수·홈 치환, UNC, 그리고 .git */
const UNSAFE_ABSOLUTE_DELETE_TARGET =
  /(^|[\\/])\.\.([\\/]|$)|[*?$%~`]|\\\\|(^|[\\/])\.git([\\/]|$)/i;

/**
 * 삭제 대상 경로들. 절대 경로도 허용하되 글롭·변수·상위 폴더·.git은 거른다.
 * 호출자가 각 경로를 에이전트가 만든 파일인지 대조하는 용도 (shell/runCommand.ts)
 *
 * 예전엔 작업 폴더 안의 상대 경로만 지우는 삭제(workdirLocalDeleteTargets)를
 * 따로 가려서 confirm 대신 classify로 낮췄다. destructiveCommandReason이 이제
 * (아래) confirm 대신 classify를 주므로 그 구분이 필요 없어져 하나로 합쳤다.
 */
export function absoluteDeleteTargets(command: string): string[] | null {
  const text = String(command ?? '').trim();
  if (!text) return null;

  const targets: string[] = [];
  // 단일 &도 나눈다. sh·cmd에서는 그 뒤가 별도 명령이라, 묶어 두면 그 명령의
  // 이름과 인자가 삭제 대상 토큰으로 섞여 든다
  for (const segment of text.split(/\|\||&&|[|;\n&]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const head = (tokens[0].split(/[/\\]/).pop() ?? '')
      .replace(/\.(exe|cmd|bat|ps1)$/i, '')
      .toLowerCase();
    if (!DELETE_HEADS.has(head)) return null;

    let found = 0;
    for (const raw of tokens.slice(1)) {
      // 플래그: rm -rf, del /s /q, Remove-Item -Recurse. sh의 절대 경로(/tmp/x)를
      // 플래그로 오인하지 않도록 /s, /q 같은 한 글자만 플래그로 본다
      if (/^-|^\/[a-z]$/i.test(raw)) continue;
      const target = raw.replace(/^["']|["']$/g, '').replace(/^\.[\\/]/, '');
      if (!target || target === '.' || UNSAFE_ABSOLUTE_DELETE_TARGET.test(target)) return null;
      targets.push(target);
      found += 1;
    }
    if (found === 0) return null;
  }
  return targets;
}
