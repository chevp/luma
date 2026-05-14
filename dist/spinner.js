/**
 * Braille spinner shown while a long-running task is in flight. Writes to
 * stderr so stdout stays capture-friendly. Silently no-ops when stderr is not
 * a TTY (CI, pipes, redirects).
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function startSpinner(message) {
    if (!process.stderr.isTTY) {
        return { stop: () => { } };
    }
    let i = 0;
    process.stderr.write("\x1b[?25l"); // hide cursor
    const timer = setInterval(() => {
        const frame = FRAMES[i % FRAMES.length];
        process.stderr.write(`\r\x1b[36m${frame}\x1b[0m ${message}`);
        i += 1;
    }, 80);
    let stopped = false;
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        clearInterval(timer);
        process.stderr.write("\r\x1b[K\x1b[?25h"); // clear line, show cursor
    };
    // Make sure Ctrl-C / process exit doesn't leave the cursor hidden.
    const cleanup = () => stop();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("exit", cleanup);
    return { stop };
}
/** Run the supplied async work while showing the spinner. */
export async function withSpinner(message, work) {
    const sp = startSpinner(message);
    try {
        return await work();
    }
    finally {
        sp.stop();
    }
}
//# sourceMappingURL=spinner.js.map