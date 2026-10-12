// 도구 권한 회귀 테스트.
//
// 권한 모드가 kind만 보고 read를 무조건 허용하던 시절에는, 파일 읽기와
// web_fetch가 어떤 모드에서도 승인 없이 실행됐다. read_file('.env') →
// web_fetch(외부)로 자격증명이 프롬프트 한 번 없이 빠져나가는 경로가 성립했다.
// kind와 승인 필요 여부가 별개 축으로 유지되는지 고정한다.

import { describe, expect, test } from 'bun:test';
import { decideToolPermission, defaultPermissionMode } from '../src/agent/permissions.ts';
import { sensitivePathReason } from '../src/tools/sensitivePaths.ts';
import {
  approvalConfirm,
  approvalNotice,
  getToolApprovalDecision,
  getToolApprovalReason,
  getToolKind,
} from '../src/tools/registry.ts';

// 도구는 import 부수 효과로 레지스트리에 등록된다
import '../src/tools/read/readFile.ts';
import '../src/tools/write/writeFile.ts';
import '../src/tools/git/git.ts';
import '../src/tools/web/webFetch.ts';
import '../src/tools/shell/runCommand.ts';
import '../src/tools/search/searchFiles.ts';

describe('자격증명 경로 판정', () => {
  const sensitive = [
    '.env',
    '.env.local',
    '.env.production',
    '~/.ssh/id_rsa',
    'C:/Users/x/.aws/credentials',
    'server.pem',
    'keystore.p12',
    '.npmrc',
    '.git-credentials',
    '.netrc',
  ];
  for (const path of sensitive) {
    test(`민감: ${path}`, () => {
      expect(sensitivePathReason(path)).not.toBeNull();
    });
  }

  const ordinary = [
    'src/config.ts',
    'README.md',
    'package.json',
    // 견본 파일은 보통 커밋되는 것이라 승인 대상이 아니다
    '.env.example',
    '.env.sample',
  ];
  for (const path of ordinary) {
    test(`일반: ${path}`, () => {
      expect(sensitivePathReason(path)).toBeNull();
    });
  }
});

describe('권한 결정', () => {
  const notice = approvalNotice('임시 파일 삭제');
  const confirm = approvalConfirm('자격증명 파일');

  test('일반 읽기는 자동 허용', () => {
    expect(decideToolPermission('acceptEdits', 'read', null)).toBe('allow');
  });

  test('읽기여도 승인 사유가 있으면 승인을 받는다', () => {
    expect(decideToolPermission('acceptEdits', 'read', confirm)).toBe('ask');
  });

  test('권한 요청 모드에서도 마찬가지', () => {
    expect(decideToolPermission('ask', 'read', confirm)).toBe('ask');
  });

  test('편집 수락 모드에서 일반 쓰기는 자동 허용', () => {
    expect(decideToolPermission('acceptEdits', 'write', null)).toBe('allow');
  });

  test('쓰기여도 승인 사유가 있으면 승인을 받는다', () => {
    expect(decideToolPermission('acceptEdits', 'write', notice)).toBe('ask');
  });

  test('셸 실행은 편집 수락 모드에서 승인을 받는다', () => {
    expect(decideToolPermission('acceptEdits', 'execute', null)).toBe('ask');
  });
});

describe('자동 모드와 승인 등급', () => {
  // 자동 모드가 코딩 탭 기본값이 되면서 "직접 고른 사람만 쓰는 모드"라는 전제가
  // 사라졌다. 되돌릴 수 없는 작업만 자동 모드를 뚫고 올라오는지 양방향으로 고정한다.

  test('confirm은 자동 모드에서 묻지 않고 막힌다', () => {
    // 자리를 비우려고 켜는 모드라 승인 창을 띄워도 볼 사람이 없다.
    // 모델에게 사유를 알려 다른 방법을 찾게 하는 쪽으로 간다
    expect(decideToolPermission('auto', 'read', approvalConfirm('자격증명 파일'))).toBe('deny');
    expect(decideToolPermission('auto', 'execute', approvalConfirm('강제 푸시'))).toBe('deny');
  });

  test('같은 작업도 낮은 모드에서는 승인 창으로 간다', () => {
    // 자동 모드의 탈출구는 모드 전환이다. 여기서 ask가 나오지 않으면
    // 사용자가 파괴적 작업을 승인할 방법이 아예 없어진다
    expect(decideToolPermission('ask', 'execute', approvalConfirm('강제 푸시'))).toBe('ask');
    expect(decideToolPermission('acceptEdits', 'execute', approvalConfirm('강제 푸시'))).toBe('ask');
  });

  test('notice는 자동 모드를 통과한다', () => {
    // 여기서 막으면 임시 파일 정리마다 창이 떠서 무인 실행이 불가능해진다
    expect(decideToolPermission('auto', 'write', approvalNotice('파일 삭제'))).toBe('allow');
  });

  test('사유가 없으면 자동 모드는 전부 통과한다', () => {
    expect(decideToolPermission('auto', 'execute', null)).toBe('allow');
  });

  test('코딩 탭 기본값은 자동', () => {
    expect(defaultPermissionMode('agent')).toBe('auto');
  });
});

describe('도구 등록 상태', () => {
  test.each(['read_file', 'list_files', 'get_file_info', 'parse_document'])(
    '%s 은 kind가 read로 명시돼 있다',
    (name: string) => {
      expect(getToolKind(name)).toBe('read');
    },
  );

  test('run_command는 execute', () => {
    expect(getToolKind('run_command')).toBe('execute');
  });

  test('read_file(.env)는 승인 대상', () => {
    expect(getToolApprovalReason('read_file', { path: '.env' })).not.toBeNull();
  });

  test('read_file(일반 파일)은 그대로 실행', () => {
    expect(getToolApprovalReason('read_file', { path: 'src/config.ts' })).toBeNull();
  });

  test('parse_document도 같은 기준을 쓴다', () => {
    expect(getToolApprovalReason('parse_document', { path: '~/.ssh/id_rsa' })).not.toBeNull();
  });

  test('read_file(.env)는 자동 모드에서도 승인을 받는다', () => {
    expect(getToolApprovalDecision('read_file', { path: '.env' })?.severity).toBe('confirm');
  });

  // 에이전트가 만들지 않은 파일은 자리와 무관하게 분류기가 사용자의 요청을 보고 정한다
  test('에이전트가 만들지 않은 파일의 삭제는 분류기 판정 대상이다', () => {
    expect(getToolApprovalDecision('delete_file', { path: 'notes.md' })?.severity).toBe('classify');
    expect(getToolApprovalDecision('delete_file', { path: '../../notes.md' })?.severity).toBe('classify');
  });

  test('에이전트가 직접 만든 파일은 작업 폴더 밖이라도 자동 모드가 통과시키고 확장자도 안 가린다', async () => {
    const { createFileTool, deleteFileTool } = await import('../src/tools/write/writeFile.ts');
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'newbie-created-'));
    const script = join(dir, 'tmp_edit.ps1');
    try {
      // 만들기 전에는 에이전트가 만든 파일이 아니라 분류기 판정 대상이다
      expect(getToolApprovalDecision('delete_file', { path: script })?.severity).toBe('classify');
      createFileTool(script, 'Write-Host hi');
      // 만든 뒤에는 되돌릴 사용자 자료가 없으므로 사유만 남기고 통과한다
      expect(getToolApprovalDecision('delete_file', { path: script })?.severity).toBe('notice');
      deleteFileTool(script);
      expect(existsSync(script)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('run_command로 직접 만든 파일을 지우는 것도 작업 폴더 밖이라도 통과한다', async () => {
    const { createFileTool } = await import('../src/tools/write/writeFile.ts');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'newbie-created-'));
    const script = join(dir, 'tmp_edit.ps1');
    const other = join(dir, 'user.ps1');
    try {
      createFileTool(script, 'Write-Host hi');
      expect(getToolApprovalDecision('run_command', { command: `Remove-Item "${script}"` })?.severity).toBe('notice');
      expect(getToolApprovalDecision('run_command', { command: `rm -rf ${script}` })?.severity).toBe('notice');
      // 안 만든 파일이 하나라도 섞이면 원래대로 분류기 판정 대상이다
      expect(getToolApprovalDecision('run_command', { command: `rm -rf ${script} ${other}` })?.severity).toBe('classify');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // create_file 말고는 누가 만들었는지 정확히 알 수 없다. 임시 파일은 위치로 가린다
  test('임시 폴더 안의 파일은 확인 없이 지우고, 작업 폴더의 다른 곳은 분류기가 판정한다', async () => {
    const { agentTmpDir, agentWorkspaceDir } = await import('../src/tools/agentWorkspace.ts');
    const { join } = await import('node:path');
    const tmp = agentTmpDir('session-1');
    const made = join(tmp, 'verify_xlsx.py');
    expect(getToolApprovalDecision('delete_file', { path: made })?.severity).toBe('notice');
    expect(getToolApprovalDecision('run_command', { command: `Remove-Item -Recurse -Force "${tmp}"` })?.severity).toBe('notice');
    // 남길 산출물 폴더와 임시 폴더 전체는 대상이 아니다
    const doc = join(agentWorkspaceDir(), 'docs', 'report.md');
    expect(getToolApprovalDecision('delete_file', { path: doc })?.severity).toBe('classify');
    expect(getToolApprovalDecision('run_command', { command: `rm -rf ${join(agentWorkspaceDir(), 'tmp')}` })?.severity).toBe('classify');
  });

  test('자격증명 삭제는 자동 모드에서도 승인을 받는다', () => {
    expect(getToolApprovalDecision('delete_file', { path: '.env' })?.severity).toBe('confirm');
  });

  test('run_command는 되돌릴 수 없는 명령에 사유를 붙인다', () => {
    const reason = getToolApprovalReason('run_command', { command: 'git reset --hard HEAD~3' });
    expect(reason).toContain('되돌릴 수 없음');
  });

  test('run_command는 평범한 명령에 사유를 붙이지 않는다', () => {
    // 사유가 아무 명령에나 붙으면 승인 창의 신호가 죽는다
    expect(getToolApprovalReason('run_command', { command: 'bun run test' })).toBeNull();
  });
});

describe('파일 쓰기 경로 판정', () => {
  // create_file·edit_file은 kind가 write라 자동 모드에서 그냥 실행된다. 경로를
  // 보지 않으면 ~/.bashrc나 .git/hooks에 써 넣는 것으로 다음 셸·git 실행 때
  // 코드가 돈다
  const decide = (tool: string, path: string) => getToolApprovalDecision(tool, { path });

  test('작업 폴더 안은 사유 없이 쓴다', () => {
    expect(decide('create_file', 'src/new-file.ts')).toBeNull();
    expect(decide('create_file', '.newbie/docs/report.md')).toBeNull();
    expect(decide('edit_file', 'src/config.ts')).toBeNull();
  });

  test('작업 폴더 밖은 분류기가 판정한다', () => {
    expect(decide('create_file', '../outside.txt')?.severity).toBe('classify');
    // ~는 실행할 때 홈으로 풀린다. 판정도 같은 방식으로 풀어야 한다
    expect(decide('create_file', '~/notes.txt')?.severity).toBe('classify');
    expect(decide('edit_file', '../../x.ts')?.severity).toBe('classify');
  });

  test('실행 경로·자격증명·앱 설정은 자동 모드에서도 사람에게 묻는다', async () => {
    const { join } = await import('node:path');
    const { getNewbieHome } = await import('../src/memory/globalNewbie.ts');
    for (const path of [
      '~/.bashrc',
      '~/.zshrc',
      'Documents/PowerShell/Microsoft.PowerShell_profile.ps1',
      '.git/hooks/pre-commit',
      '.git/config',
      '.env',
      '~/.ssh/authorized_keys',
      'C:/Users/x/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/run.bat',
      join(getNewbieHome(), 'mcp.json'),
      join(getNewbieHome(), 'credentials.enc'),
    ]) {
      expect(decide('create_file', path)?.severity).toBe('confirm');
      expect(decide('edit_file', path)?.severity).toBe('confirm');
    }
  });

  test('delete_file 판정도 실행과 같은 방식으로 ~를 푼다', async () => {
    const { homedir } = await import('node:os');
    // 예전에는 판정이 <작업 폴더>/~/notes.md로, 실행은 홈 아래 파일로 풀었다
    const reason = getToolApprovalReason('delete_file', { path: '~/notes.md' }) ?? '';
    expect(reason).toContain('작업 폴더 밖');
    expect(reason).toContain(homedir());
  });
});

describe('검색 경로 판정', () => {
  // search_files에 자격증명 경로를 주면 rg가 숨김 파일 규칙과 무관하게 내용을 돌려준다
  test('자격증명 경로는 read_file과 같이 승인을 받는다', () => {
    expect(getToolApprovalDecision('search_files', { path: '.env', query: 'KEY' })?.severity).toBe('confirm');
    expect(getToolApprovalDecision('search_files', { path: '~/.ssh', query: 'BEGIN' })?.severity).toBe('confirm');
    expect(getToolApprovalDecision('search_files', { path: 'C:/Users/x/.aws', query: 'x' })?.severity).toBe('confirm');
  });

  test('평범한 검색은 그대로 실행한다', () => {
    expect(getToolApprovalDecision('search_files', { path: 'src', query: 'registerTool' })).toBeNull();
    expect(getToolApprovalDecision('search_files', { query: 'registerTool' })).toBeNull();
  });
});

describe('심볼릭 링크 읽기', () => {
  test('평범한 이름의 링크가 자격증명 폴더를 가리키면 승인을 받는다', async () => {
    const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'newbie-link-'));
    try {
      const secretDir = join(dir, '.ssh');
      mkdirSync(secretDir);
      writeFileSync(join(secretDir, 'notes.txt'), 'secret');
      // 디렉터리 정션은 Windows에서도 관리자 권한 없이 만들 수 있다 (파일 링크는 권한이 필요)
      const link = join(dir, 'docs');
      symlinkSync(secretDir, link, 'junction');

      const path = join(link, 'notes.txt');
      expect(getToolApprovalDecision('read_file', { path })?.severity).toBe('confirm');
      expect(getToolApprovalDecision('search_files', { path: link, query: 'x' })?.severity).toBe('confirm');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('없는 경로는 이름만으로 판정한다', () => {
    expect(getToolApprovalDecision('read_file', { path: 'no-such-dir/plain.txt' })).toBeNull();
  });
});
