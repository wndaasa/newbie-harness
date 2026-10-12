/** 파일 읽기 관련 제한값 상수 */
export const MAX_FILE_BYTES = 1_000_000;    // 1MB

/*
 * 한 번 읽을 때 돌려주는 기본 분량.
 *
 * 지금까지는 offset/limit를 주지 않으면 파일 전체(최대 1MB)를 돌려줬다. 1MB면
 * 25만 토큰이라 창이 20만인 모델도 한 번에 넘긴다. 실제로 파일 네 번 읽고
 * 27,000 토큰이 들어와 40,960짜리 창이 한 라운드 만에 찼다.
 *
 * 잘렸다는 사실과 이어 읽는 방법을 결과에 함께 적어, 모델이 필요하면 offset으로
 * 다음 조각을 가져가게 한다. 조용히 자르면 모델은 파일이 거기서 끝난 줄 안다.
 */
export const DEFAULT_READ_LINES = 400;
export const DEFAULT_READ_CHARS = 20_000;
/** 디렉터리 목록도 같은 이유로 상한을 둔다 (node_modules 한 번이면 수천 줄) */
export const MAX_LIST_ENTRIES = 300;
export const BINARY_SCAN_BYTES = 8_000;      // 바이너리 판별 시 검사할 앞부분 크기

// pages 파라미터 없이 이 페이지 수를 넘는 PDF를 통째로 읽으려 하면 거부하고
// pages 파라미터 사용을 안내함 (큰 문서를 실수로 전부 파싱/OCR하는 것을 방지)
export const PDF_INLINE_PAGE_LIMIT = 5;
