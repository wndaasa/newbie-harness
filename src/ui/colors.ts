export function createColors({
  noColor,
  output,
}: {
  noColor: boolean;
  output: { isTTY?: boolean };
}) {
  const colorsEnabled = !noColor && !process.env.NO_COLOR && output.isTTY;

  function color(text: string, code: string): string {
    return colorsEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  return {
    cyan: (text: string) => color(text, '36'),
    green: (text: string) => color(text, '32'),
    magenta: (text: string) => color(text, '35'),
    orange: (text: string) => color(text, '38;5;208'),
    red: (text: string) => color(text, '31'),
    dim: (text: string) => color(text, '2'),
    bold: (text: string) => color(text, '1'),
  };
}
