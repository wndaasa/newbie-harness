import { useEffect } from 'react';

/**
 * 어두운 전체 화면 오버레이가 떠 있는 동안 OS 창 버튼(titleBarOverlay) 색을
 * 오버레이 배경에 맞추고, 언마운트 시 기본색으로 복원함.
 *
 * 전체 화면을 어둡게 덮는 컴포넌트는 반드시 이 훅을 호출할 것 —
 * OS 버튼 영역은 CSS 위에 떠 있어 오버레이가 덮지 못하고 흰색으로 남는다.
 * color에는 "오버레이 반투명 색 × 앱 배경"을 합성한 결과색을 지정한다.
 */
export function useTitlebarShade(color: string, symbolColor: string) {
  useEffect(() => {
    window.newbie.setTitlebarShade({ color, symbolColor });
    return () => window.newbie.setTitlebarShade(null);
  }, [color, symbolColor]);
}
