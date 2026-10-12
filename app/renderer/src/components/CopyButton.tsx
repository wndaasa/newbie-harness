import React, { useEffect, useState } from 'react';
import { IconCheck, IconCopy } from './Icon.tsx';

// 복사 버튼 (명령, 메시지, 코드 블록). 눌렀다는 피드백으로 잠깐 체크 표시로 바뀐다
export function CopyButton({
  className = 'term-copy',
  label = '명령 복사',
  size = 13,
  text,
}: {
  className?: string;
  label?: string;
  size?: number;
  text: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      aria-label={label}
      className={copied ? `${className} copied` : className}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      title={label}
      type="button"
    >
      {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
    </button>
  );
}
