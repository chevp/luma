const isTTY = process.stdout.isTTY === true;

const wrap = (open: string, close: string) =>
  (s: string) => (isTTY ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  green: wrap("32", "39"),
  red: wrap("31", "39"),
  yellow: wrap("33", "39"),
  cyan: wrap("36", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  gray: wrap("90", "39"),
};

export const sym = {
  ok: c.green("✓"),
  warn: c.yellow("!"),
  err: c.red("✗"),
  info: c.blue("→"),
  arrow: c.cyan("→"),
  bullet: c.dim("•"),
};

export function section(title: string): void {
  process.stdout.write(`\n${c.bold(title)}\n`);
}

export function kv(key: string, value: string): void {
  const padded = key.padEnd(18);
  process.stdout.write(`  ${c.dim(padded)} ${value}\n`);
}

export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}
