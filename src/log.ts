const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { red: c("31"), green: c("32"), yellow: c("33"), dim: c("2"), bold: c("1"), cyan: c("36") };

export interface Logger {
  step(title: string): void;
  info(msg: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  detail(msg: string): void;
}

export function consoleLogger(verbose: boolean): Logger {
  return {
    step: (t) => console.log("\n" + color.bold(`━━ ${t} ━━`)),
    info: (m) => console.log(m),
    ok: (m) => console.log(color.green("✓ " + m)),
    warn: (m) => console.log(color.yellow("! " + m)),
    error: (m) => console.error(color.red("✗ " + m)),
    detail: (m) => {
      if (verbose) console.log(color.dim(m));
    },
  };
}

export function silentLogger(lines: string[] = []): Logger & { lines: string[] } {
  const push = (p: string) => (m: string) => lines.push(p + m);
  return { lines, step: push("STEP "), info: push(""), ok: push("OK "), warn: push("WARN "), error: push("ERR "), detail: push("  ") };
}
