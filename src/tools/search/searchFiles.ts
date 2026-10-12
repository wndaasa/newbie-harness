import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { approvalConfirm, registerTool } from '../registry.ts';
import { getWorkdir } from '../../agent/workdir.ts';
import { sensitiveReadPathReason } from '../sensitivePaths.ts';

/*
 * 패키징된 앱에서 rgPath는 app.asar 안을 가리킨다. asar 안의 파일은 fs로는
 * 읽히지만 spawn은 못 한다 — 프로세스 생성은 fs 패치를 거치지 않고 OS로 바로
 * 내려가 asar를 모르기 때문이다(existsSync는 true인데 spawn은 ENOENT로 죽는다).
 * electron-builder가 asarUnpack으로 실제 rg.exe를 풀어 두는 app.asar.unpacked
 * 쪽으로 경로만 돌린다. 개발 실행이나 CLI에는 app.asar가 없어 그대로 통과한다.
 */
const rgExecutable = rgPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

const SEARCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;
// 결과가 수천 건이어도 rg가 다 쏟기 전에 잘라내도록 파일당 매치 수를 제한
const MAX_MATCHES_PER_FILE = 10;

export type SearchResult = {
  /** 상한을 넘어 버린 stdout 글자 수 */
  dropped: number;
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

/**
 * ripgrep을 실행함. query가 있으면 내용 검색(-n 줄 번호 포함),
 * 없으면 --files로 glob에 맞는 파일 목록만 반환함.
 * .gitignore·숨김 파일은 ripgrep 기본 동작대로 제외됨.
 */
export async function searchFilesTool(
  query: string | undefined,
  glob: string | undefined,
  dirPath: string,
): Promise<SearchResult> {
  if (!query?.trim() && !glob?.trim()) {
    throw new Error('query(내용 검색어) 또는 glob(파일명 패턴) 중 하나는 필요합니다.');
  }

  const abs = resolve(getWorkdir(), dirPath);
  if (!existsSync(abs)) {
    throw new Error(`경로를 찾을 수 없습니다: ${dirPath}`);
  }
  // 파일 하나도 받는다. 모델은 "이 파일 안에서 register를 찾자"며 path에 파일을
  // 넣는데, 디렉터리만 받으면 "디렉터리가 아닙니다"로 끝나고 모델은 read_file로
  // 파일 전체를 읽거나 폴더+glob으로 다시 시도하는 라운드를 더 쓴다. rg는
  // 파일을 직접 받아도 잘 검색한다
  const stat = statSync(abs);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`디렉터리나 파일이 아닙니다: ${dirPath}`);
  }

  const args: string[] = [];
  if (query?.trim()) {
    args.push(
      // 파일 하나를 검색하면 rg는 파일명을 생략한다. 결과 형식("절대경로:줄번호:내용")을
      // 지켜야 모델이 read_file의 offset으로 이어 읽을 수 있으므로 항상 붙인다
      '--with-filename',
      '--line-number',
      '--no-heading',
      '--smart-case',
      '--max-count', String(MAX_MATCHES_PER_FILE),
      '--max-columns', '300',
      '--max-filesize', '1M',
    );
    if (glob?.trim()) args.push('--glob', glob.trim());
    args.push('--regexp', query.trim());
  } else {
    args.push('--files', '--glob', glob!.trim());
  }
  args.push(abs);

  return await new Promise((resolveResult, reject) => {
    const proc = spawn(rgExecutable, args, {
      // 파일을 검색할 때 cwd가 파일이면 posix_spawn이 ENOTDIR로 죽는다
      cwd: stat.isDirectory() ? abs : dirname(abs),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let dropped = 0;
    let timedOut = false;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    // 결과는 어차피 MAX_OUTPUT_CHARS로 잘린다. 매치가 수십만 줄이어도 메모리에
    // 다 쌓지 않도록 그 이상은 길이만 센다 (truncate가 생략 분량을 알린다)
    proc.stdout.on('data', (chunk: string) => {
      const room = Math.max(0, MAX_OUTPUT_CHARS + 1 - stdout.length);
      stdout += chunk.slice(0, room);
      dropped += Math.max(0, chunk.length - room);
    });
    proc.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, SEARCH_TIMEOUT_MS);

    proc.on('error', err => {
      clearTimeout(killTimer);
      reject(err);
    });
    proc.on('close', exitCode => {
      clearTimeout(killTimer);
      resolveResult({ dropped, exitCode: exitCode ?? -1, stderr, stdout, timedOut });
    });
  });
}

function truncate(value: string, maxLength: number, dropped = 0): string {
  if (value.length <= maxLength && dropped === 0) return value;
  const omitted = Math.max(0, value.length - maxLength) + dropped;
  return `${value.slice(0, maxLength)}\n...(출력이 길어 ${omitted}자 생략됨)`;
}

registerTool({
  name: 'search_files',
  // read_file과 같은 기준. path에 .env나 ~/.ssh를 주면 rg가 숨김 파일 규칙과
  // 무관하게 그 내용을 결과로 돌려주므로, 읽기 게이트를 우회하는 길이 된다
  approvalGate: ({ path }) => {
    const reason = sensitiveReadPathReason(path);
    return reason ? approvalConfirm(reason) : null;
  },
  description:
    '파일 **내용**을 정규식으로 검색합니다 (ripgrep). 결과는 "절대경로:줄번호:내용" 형태라, 찾은 자리를 read_file의 offset으로 바로 이어 읽을 수 있습니다. glob으로 파일 이름 패턴만 찾을 수도 있고(예: *.ts, **/config.*), 둘을 함께 쓰면 glob에 맞는 파일 안에서만 query를 검색합니다. .gitignore에 등록된 파일과 숨김 파일은 제외됩니다.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '파일 내용에서 찾을 텍스트 또는 정규식 (생략 가능)' },
      glob: { type: 'string', description: '파일 이름 패턴, 예: *.ts (생략 가능)' },
      path: { type: 'string', description: '검색을 시작할 디렉터리, 또는 검색할 파일 하나 (생략하면 현재 작업 디렉터리)' },
    },
    required: [],
  },
  async execute({ query, glob, path }) {
    const result = await searchFilesTool(query, glob, path || '.');

    if (result.timedOut) {
      return '검색이 30초를 초과해 중단되었습니다. 더 좁은 경로나 구체적인 패턴으로 다시 시도하세요.';
    }
    // ripgrep 종료 코드: 0=매치 있음, 1=매치 없음, 2=오류
    if (result.exitCode === 1) {
      // "패턴 없음"을 "존재하지 않음"으로 단정하지 않도록 재조사를 유도
      return '이 패턴과 일치하는 결과가 없습니다. 이것은 검색한 패턴이 없다는 뜻일 뿐이므로, 다른 키워드·정규식·glob으로 다시 검색하거나 관련 파일을 read_file로 직접 읽어 확인한 뒤 결론을 내리세요.';
    }
    // 일부 파일을 읽지 못해도(권한 등) 매치가 있으면 결과는 살림
    if (result.exitCode !== 0 && !result.stdout.trim()) {
      throw new Error(`검색 실패: ${result.stderr.trim() || `종료 코드 ${result.exitCode}`}`);
    }
    return truncate(result.stdout.trimEnd(), MAX_OUTPUT_CHARS, result.dropped);
  },
});
