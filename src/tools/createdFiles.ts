// 이 프로세스에서 에이전트가 create_file로 만든 파일의 기록.
//
// 자기가 만든 임시 파일을 못 지우는 일이 있었다 — 작업 폴더 밖(~/.newbie 등)에
// 스크립트를 만들어 쓰고 지우려 하자 "작업 폴더 밖 삭제"로 자동 모드가 막고,
// 승인이 났어도 .ps1이라 delete_file의 확장자 제한에서 또 막혔다. 방금 만든
// 파일은 사용자 자료가 아니므로 어디에 있든, 확장자가 무엇이든 지워도 되돌릴
// 것이 없다. 앱을 다시 켜면 비워진다 — 그 뒤로는 평범한 파일과 같이 본다.
//
// write/writeFile.ts과 shell/runCommand.ts이 함께 쓴다. 도구 등록(registerTool) 부작용이
// 있는 모듈끼리 서로 import하지 않도록 따로 둔다.

const createdFileLog = new Set<string>();

function toKey(absPath: string): string {
  return process.platform === 'win32' ? absPath.toLowerCase() : absPath;
}

export function markFileCreatedByAgent(absPath: string): void {
  createdFileLog.add(toKey(absPath));
}

export function wasFileCreatedByAgent(absPath: string): boolean {
  return createdFileLog.has(toKey(absPath));
}
