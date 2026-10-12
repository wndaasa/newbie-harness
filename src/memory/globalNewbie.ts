import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GLOBAL_NEWBIE_FILE = 'Newbie.md';
// 매 턴 시스템 프롬프트에 그대로 실리므로 지침 파일 하나가 컨텍스트를 과하게 차지하지 않게 묶는다
const MAX_GLOBAL_NEWBIE_CHARS = 30_000;

export function getNewbieHome() {
  return process.env.NEWBIE_HOME || join(homedir(), '.newbie');
}

export function getGlobalNewbiePath() {
  return join(getNewbieHome(), GLOBAL_NEWBIE_FILE);
}

export function readGlobalNewbieInstructions() {
  if (isEnvTruthy(process.env.NEWBIE_DISABLE_NEWBIE_MD)) return '';
  return readInstructionsFile(getGlobalNewbiePath());
}

// 프로젝트 루트(현재 작업 디렉터리)의 Newbie.md — 프로젝트별 규칙·빌드 명령 등
export function getProjectNewbiePath() {
  return join(process.cwd(), GLOBAL_NEWBIE_FILE);
}

export function readProjectNewbieInstructions() {
  if (isEnvTruthy(process.env.NEWBIE_DISABLE_NEWBIE_MD)) return '';

  const projectPath = getProjectNewbiePath();
  // 홈 디렉터리에서 실행하면 전역 파일과 같은 파일일 수 있음 — 중복 주입 방지
  if (projectPath === getGlobalNewbiePath()) return '';
  return readInstructionsFile(projectPath);
}

function readInstructionsFile(filePath: string): string {
  if (!existsSync(filePath)) return '';

  try {
    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) return '';
    return content.length > MAX_GLOBAL_NEWBIE_CHARS
      ? `${content.slice(0, MAX_GLOBAL_NEWBIE_CHARS)}\n\n[Newbie.md truncated after ${MAX_GLOBAL_NEWBIE_CHARS} characters]`
      : content;
  } catch {
    return '';
  }
}

export function formatGlobalNewbieInstructions(content: string): string {
  const trimmed = String(content || '').trim();
  if (!trimmed) return '';

  // 절대 경로는 넣지 않는다. 매 턴 프롬프트에 OS 사용자 이름이 실려 나가기 때문이다
  return [
    '## 전역 Newbie.md',
    '사용자가 모든 작업에 공통으로 적어 둔 지침입니다. 관련 있는 작업에서 지키세요.',
    '',
    trimmed,
  ].join('\n');
}

export function formatProjectNewbieInstructions(content: string): string {
  const trimmed = String(content || '').trim();
  if (!trimmed) return '';

  return [
    '## 프로젝트 Newbie.md',
    '현재 작업 디렉터리의 프로젝트 지침입니다. 이 프로젝트 작업에서는 전역 Newbie.md보다 우선합니다.',
    '',
    trimmed,
  ].join('\n');
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
