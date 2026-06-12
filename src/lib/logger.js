// Zero-dependency leveled logger. Emits one human-readable line per event, with
// optional structured fields, and knows how to serialize Errors (including the
// status/body/path props that split.js enriches onto them). Designed so the same
// code is readable in a local terminal and plain-text in the Replit console.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold() {
  const name = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[name] ?? LEVELS.info;
}

// Color only when attached to a TTY; pipes/Replit get plain text.
const useColor = !!process.stdout.isTTY;
const COLORS = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

function paint(level, text) {
  return useColor ? `${COLORS[level] || ""}${text}${RESET}` : text;
}

// Token *type* prefix only (e.g. "sat.", "pat.") — never the secret itself. Use
// this everywhere a token would otherwise be logged.
export function tokenType(t) {
  if (!t) return "(unset)";
  return `${String(t).split(".")[0]}.`;
}

// Flatten an Error into a plain object that keeps the stack and any enriched
// props. This is the core of the logging upgrade: status, body and the request
// method/path that split.js attaches are what's needed to diagnose the 401.
export function serializeError(err) {
  if (!(err instanceof Error)) return err;
  const out = {
    message: err.message,
    stack: err.stack,
  };
  for (const key of ["status", "body", "method", "path", "headers", "code"]) {
    if (err[key] !== undefined) out[key] = err[key];
  }
  return out;
}

// Replace any value that is an Error with its serialized form, recursively over
// the top-level fields object.
function normalizeFields(fields) {
  if (!fields || typeof fields !== "object") return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < currentThreshold()) return;
  const time = new Date().toISOString();
  const line = paint(level, `${time} ${level.toUpperCase().padEnd(5)} ${msg}`);
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(line + "\n");

  const normalized = normalizeFields(fields);
  if (normalized && Object.keys(normalized).length > 0) {
    // Pretty multi-line JSON so stacks stay readable in the terminal.
    stream.write(JSON.stringify(normalized, null, 2) + "\n");
  }
}

export const log = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
};
