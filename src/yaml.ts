/**
 * Minimal YAML parser for chi workflow files. Supports the subset needed by
 * `chi workflow {list, show, run}` — see `.che/workflows/*.yml`:
 *
 *   - top-level keys with scalar values (string, int, bool, null)
 *   - nested maps via two-space indentation
 *   - list of scalars  (`- value` lines)
 *   - list of maps     (`- key: value` blocks, continued by indented `key: value`)
 *   - quoted strings ('...' and "...")
 *   - inline list `[a, b, c]`  (used for short args arrays, no nesting)
 *
 * Out of scope: anchors / aliases, tags, multi-line scalars (`|`, `>`),
 * tabs (rejected — same as PyYAML), multiple documents.
 *
 * The parser exists so chi keeps the zero-runtime-deps constraint (ADR-003)
 * — replacing the python/PyYAML helper that che-cli uses.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

export class YamlError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`${message} (line ${line})`);
  }
}

interface RawLine {
  no: number;
  indent: number;
  text: string;
}

export function parseYaml(src: string): YamlValue {
  const raw = src.replace(/\r\n/g, "\n").split("\n");
  const lines: RawLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const original = raw[i] ?? "";
    if (original.includes("\t")) {
      throw new YamlError("tabs are not allowed in YAML indentation", i + 1);
    }
    const stripped = stripComment(original);
    if (stripped.trim() === "") continue;
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ no: i + 1, indent, text: stripped.trimEnd() });
  }
  if (lines.length === 0) return null;

  const [value, next] = parseNode(lines, 0, 0);
  if (next !== lines.length) {
    throw new YamlError(`unexpected content after document`, lines[next]!.no);
  }
  return value;
}

/** Strip an unquoted `#` comment from a line. Quoted hashes are preserved. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      const before = line[i - 1];
      if (before === undefined || /\s/.test(before)) return line.slice(0, i);
    }
  }
  return line;
}

function parseNode(
  lines: RawLine[],
  start: number,
  parentIndent: number,
): [YamlValue, number] {
  if (start >= lines.length) return [null, start];
  const first = lines[start]!;
  const myIndent = first.indent;

  if (first.text.trimStart().startsWith("- ")) {
    return parseList(lines, start, myIndent);
  }
  if (first.text.trimStart() === "-") {
    return parseList(lines, start, myIndent);
  }
  if (parentIndent > myIndent) {
    return [null, start];
  }
  return parseMap(lines, start, myIndent);
}

function parseMap(
  lines: RawLine[],
  start: number,
  blockIndent: number,
): [Record<string, YamlValue>, number] {
  const out: Record<string, YamlValue> = {};
  let i = start;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.indent < blockIndent) break;
    if (ln.indent > blockIndent) {
      throw new YamlError(`unexpected indentation`, ln.no);
    }
    const trimmed = ln.text.trimStart();
    if (trimmed.startsWith("- ")) {
      throw new YamlError(`unexpected list item in map`, ln.no);
    }
    const colon = findMapColon(trimmed);
    if (colon < 0) {
      throw new YamlError(`expected 'key: value'`, ln.no);
    }
    const key = trimmed.slice(0, colon).trim();
    const restRaw = trimmed.slice(colon + 1);
    const rest = restRaw.replace(/^\s+/, "");
    if (rest.length === 0) {
      // Block child on the next line.
      const next = i + 1;
      if (next < lines.length && lines[next]!.indent > blockIndent) {
        const [child, nextIdx] = parseNode(lines, next, blockIndent + 1);
        out[key] = child;
        i = nextIdx;
      } else {
        out[key] = null;
        i = next;
      }
    } else {
      out[key] = parseScalar(rest, ln.no);
      i += 1;
    }
  }
  return [out, i];
}

function parseList(
  lines: RawLine[],
  start: number,
  blockIndent: number,
): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.indent < blockIndent) break;
    if (ln.indent > blockIndent) {
      throw new YamlError(`unexpected indentation in list`, ln.no);
    }
    const trimmed = ln.text.trimStart();
    if (!trimmed.startsWith("-")) break;

    const after = trimmed.length === 1 ? "" : trimmed.slice(1).replace(/^\s+/, "");
    if (after === "") {
      const next = i + 1;
      if (next < lines.length && lines[next]!.indent > blockIndent) {
        const [child, nextIdx] = parseNode(lines, next, blockIndent + 1);
        out.push(child);
        i = nextIdx;
      } else {
        out.push(null);
        i = next;
      }
    } else {
      // Inline value or first key of a mapping item ("- key: value").
      const colon = findMapColon(after);
      if (colon < 0) {
        out.push(parseScalar(after, ln.no));
        i += 1;
        continue;
      }
      // Mapping item. Build a virtual block where the first kv lives at the
      // same indent as subsequent siblings — i.e. (blockIndent + 2).
      const childIndent = blockIndent + 2;
      const synthetic: RawLine = { no: ln.no, indent: childIndent, text: " ".repeat(childIndent) + after };
      const block: RawLine[] = [synthetic];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= childIndent) {
        const cand = lines[j]!;
        if (cand.indent === blockIndent && cand.text.trimStart().startsWith("-")) break;
        block.push(cand);
        j += 1;
      }
      const [mapVal] = parseMap(block, 0, childIndent);
      out.push(mapVal);
      i = j;
    }
  }
  return [out, i];
}

/** Find the first ': ' (or trailing ':') outside quoted strings. */
function findMapColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      const next = s[i + 1];
      if (next === undefined || next === " " || next === "\t" || i === s.length - 1) {
        return i;
      }
    }
  }
  return -1;
}

function parseScalar(raw: string, lineNo: number): YamlValue {
  const v = raw.trim();
  if (v === "" || v === "~" || v.toLowerCase() === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[") && v.endsWith("]")) {
    return parseInlineList(v.slice(1, -1), lineNo);
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return unescapeDoubleQuoted(v.slice(1, -1));
  }
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\(.)/g, (_, ch) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return ch;
    }
  });
}

function parseInlineList(body: string, lineNo: number): YamlValue[] {
  const items: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let buf = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if ((ch === "[" || ch === "{") && !inSingle && !inDouble) depth += 1;
    else if ((ch === "]" || ch === "}") && !inSingle && !inDouble) depth -= 1;
    else if (ch === "," && depth === 0 && !inSingle && !inDouble) {
      items.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== "") items.push(buf);
  return items.map((s) => parseScalar(s, lineNo));
}

/** Walk `.a.b[0].c` style paths through a parsed YAML doc. */
export function getPath(doc: YamlValue, expr: string): YamlValue {
  const tokens: Array<{ key?: string; idx?: number }> = [];
  const re = /\.([A-Za-z_][\w]*)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    if (m[1] !== undefined) tokens.push({ key: m[1] });
    else if (m[2] !== undefined) tokens.push({ idx: Number.parseInt(m[2], 10) });
  }
  let cur: YamlValue = doc;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return null;
    if (t.key !== undefined) {
      if (typeof cur !== "object" || Array.isArray(cur)) return null;
      cur = (cur as Record<string, YamlValue>)[t.key] ?? null;
    } else if (t.idx !== undefined) {
      if (!Array.isArray(cur)) return null;
      cur = cur[t.idx] ?? null;
    }
  }
  return cur;
}

export function lengthOf(v: YamlValue): number {
  return Array.isArray(v) ? v.length : 0;
}
