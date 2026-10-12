import { resolve, sep } from 'node:path';

// topic slug는 LLM이 만들어 그대로 파일 이름이 된다. 정제 입력인 대화 로그에는
// web_fetch·read_file로 들어온 제3자 텍스트가 섞이므로 이름은 신뢰할 수 없다.
//
// RFC 1123 DNS 라벨과 같은 규칙(Kubernetes 리소스 이름 관례)을 쓴다 —
// 경로 구분자·상위 참조·공백·제어문자가 형식 단계에서 전부 배제된다.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSlug(name: unknown): name is string {
  return typeof name === 'string' && SLUG_RE.test(name);
}

// 심층 방어: 형식 검사를 통과해도 최종 경로가 기준 디렉터리 안인지 확인한다.
// path.join/normalize는 경로를 정리할 뿐 탈출을 막지 않으므로 resolve 후 봉쇄를 본다.
export function resolveInside(baseDir: string, fileName: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, fileName);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`경로가 메모리 디렉터리를 벗어납니다: ${fileName}`);
  }
  return target;
}
