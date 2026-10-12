import React from 'react';

// CLI 시절 시작 카드에 쓰던 Newbie 마스코트 — 히어로 주인공
const NEWBIE_MASCOT_LINES = [
  '   ▗▄▄▄▄▄▖   ',
  '  ▐  o o  ▌  ',
  '  ▐   ▿   ▌  ',
  '   ▜▚___▞▛   ',
  '    /| |\\    ',
  '   /_| |_\\   ',
];

const START_CHIPS = [
  '이 프로젝트 구조를 설명해줘',
  '최근 변경사항 요약해줘',
  '/help',
];

// 채팅 탭에는 프로젝트를 건드리는 도구가 없다. 코딩 칩을 그대로 두면
// 눌러도 "그건 코딩 탭에서" 라는 답만 돌아온다
const CHAT_CHIPS = ['오늘 뭐 하면 좋을까?', '이 단어 뜻이 뭐야?', '요즘 뉴스 알려줘'];

// 시간대별 인사 (로컬 시간 기준)
function greetingForHour(hour: number): string {
  if (hour < 5) return '늦은 밤이네요';
  if (hour < 12) return '좋은 아침입니다!';
  if (hour < 18) return '좋은 오후예요';
  return '좋은 저녁이에요';
}

export function HomeHero({
  chat,
  hasSessions,
  notices,
  onSubmit,
}: {
  /** 채팅 탭인가. 시작 칩과 안내 문구가 달라진다 */
  chat: boolean;
  hasSessions: boolean;
  /** 시작 루틴(recall·distill)이 남긴 system 행 내용 — 히어로 아래에 작게 표시 */
  notices: string[];
  onSubmit: (text: string) => void;
}) {
  const greeting = greetingForHour(new Date().getHours());
  const subline = hasSessions
    ? '돌아오셨군요! 무엇이든 물어보세요'
    : '처음 오셨네요! 무엇이든 물어보세요';
  const chips = chat ? CHAT_CHIPS : START_CHIPS;

  return (
    <div className="home-hero">
      <pre className="home-hero-mascot">{NEWBIE_MASCOT_LINES.join('\n')}</pre>
      <h1 className="home-hero-greeting">{greeting}</h1>
      <p className="home-hero-subline">{subline}</p>
      <div className="home-hero-chips">
        {chips.map(chip => (
          <button
            className="home-hero-chip"
            key={chip}
            onClick={() => onSubmit(chip)}
            type="button"
          >
            {chip}
          </button>
        ))}
      </div>
      {notices.length > 0 && (
        <div className="home-hero-notices">
          {notices.map((notice, index) => (
            <pre className="home-hero-notice" key={index}>
              {notice}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}
