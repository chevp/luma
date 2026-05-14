import { createInterface } from "node:readline";
/**
 * Present a single-key choice menu. In TTY mode the user presses one key
 * (no Enter required). In non-TTY mode falls back to readline.
 *
 * Restores terminal state on Ctrl-C (raw mode off, cursor visible).
 */
export function singleKeyMenu(prompt, keys) {
    const stdin = process.stdin;
    const lowerKeys = keys.map((k) => k.toLowerCase());
    // Non-TTY fallback: line-based input
    if (!stdin.isTTY) {
        return new Promise((resolve) => {
            const rl = createInterface({ input: stdin, output: process.stdout });
            rl.question(prompt, (answer) => {
                rl.close();
                const ch = (answer || "").trim().toLowerCase().charAt(0);
                resolve(lowerKeys.includes(ch) ? ch : "q");
            });
        });
    }
    process.stdout.write(prompt);
    return new Promise((resolve) => {
        const wasRaw = stdin.isRaw;
        const cleanup = () => {
            stdin.setRawMode(wasRaw ?? false);
            stdin.pause();
            stdin.removeListener("data", onData);
        };
        const onExit = () => {
            cleanup();
            // Restore cursor visibility
            process.stdout.write("\x1b[?25h");
            process.exit(130);
        };
        const onData = (buf) => {
            const ch = buf.toString("utf8");
            // Ctrl-C
            if (ch === "\x03") {
                onExit();
                return;
            }
            const key = ch.toLowerCase().charAt(0);
            if (lowerKeys.includes(key)) {
                process.stdout.write(`${key}\n`);
                cleanup();
                process.removeListener("SIGINT", onExit);
                resolve(key);
            }
            // Ignore unrecognized keys
        };
        process.on("SIGINT", onExit);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
    });
}
//# sourceMappingURL=menu.js.map