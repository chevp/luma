import { createInterface } from "node:readline";
/**
 * Read a single line from stdin. Returns null when there is no TTY (so callers
 * can treat the answer as the default in non-interactive contexts).
 *
 * Uses readline so terminal echo and line editing work on every platform
 * (Windows console included).
 */
export function readLine(question) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
/** [Y/n] confirmation. Default: yes. Returns true on accept. */
export async function confirmYesNo(question) {
    const ans = await readLine(question);
    if (ans === null)
        return true;
    const v = ans.trim().toLowerCase();
    return v !== "n" && v !== "no";
}
const CTRL_C = "";
const DEL = "";
const BACKSPACE = "\b";
/**
 * Read a secret (password) from stdin with masked echo.
 * Returns null when there is no TTY. Each keystroke is echoed as "*".
 * Backspace is supported. Ctrl-C aborts the process with code 130.
 */
export function readSecret(question) {
    const stdin = process.stdin;
    if (!stdin.isTTY || !process.stdout.isTTY) {
        return Promise.resolve(null);
    }
    process.stdout.write(question);
    return new Promise((resolve) => {
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let secret = "";
        const cleanup = () => {
            stdin.removeListener("data", onData);
            stdin.setRawMode(wasRaw);
            stdin.pause();
        };
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === CTRL_C) {
                    cleanup();
                    process.stdout.write("\n");
                    process.exit(130);
                }
                if (ch === "\r" || ch === "\n") {
                    cleanup();
                    process.stdout.write("\n");
                    resolve(secret);
                    return;
                }
                if (ch === DEL || ch === BACKSPACE) {
                    if (secret.length > 0) {
                        secret = secret.slice(0, -1);
                        process.stdout.write("\b \b");
                    }
                    continue;
                }
                secret += ch;
                process.stdout.write("*");
            }
        };
        stdin.on("data", onData);
    });
}
//# sourceMappingURL=prompt.js.map