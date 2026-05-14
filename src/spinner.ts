/**
 * Braille spinner shown while a long-running task is in flight. Writes to
 * stderr so stdout stays capture-friendly. Silently no-ops when stderr is not
 * a TTY (CI, pipes, redirects).
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  stop: () => void;
}

export function startSpinner(message: string): Spinner {
  if (!process.stderr.isTTY) {
    return { stop: () => {} };
  }
  let i = 0;
  process.stderr.write("\x1b[?25l"); // hide cursor
  const timer = setInterval(() => {
    const frame = FRAMES[i % FRAMES.length]!;
    process.stderr.write(`\r\x1b[36m${frame}\x1b[0m ${message}`);
    i += 1;
  }, 80);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stderr.write("\r\x1b[K\x1b[?25h"); // clear line, show cursor
  };

  // Make sure Ctrl-C / process exit doesn't leave the cursor hidden.
  const cleanup = (): void => stop();
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("exit", cleanup);

  return { stop };
}

/** Run the supplied async work while showing the spinner. */
export async function withSpinner<T>(message: string, work: () => Promise<T>): Promise<T> {
  const sp = startSpinner(message);
  try {
    return await work();
  } finally {
    sp.stop();
  }
}
