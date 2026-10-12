export function padCell(text: string, width: number): string {
  const size = visibleLength(text);
  if (size >= width) return truncateVisible(text, width);
  return text + ' '.repeat(width - size);
}

export function visibleLength(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += charDisplayWidth(char);
  }
  return width;
}

export function truncateVisible(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (visibleLength(plain) <= width) return text;
  if (width <= 1) return plain.slice(0, width);

  let used = 0;
  let result = '';
  for (const char of plain) {
    const charWidth = charDisplayWidth(char);
    if (used + charWidth > width - 1) break;
    result += char;
    used += charWidth;
  }

  return result + '…';
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined) return 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (isCombiningMark(code)) return 0;
  if (isWideCharacter(code)) return 2;
  return 1;
}

function isCombiningMark(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isWideCharacter(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}
