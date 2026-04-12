/**
 * Self-contained stdout parser for OpenCode JSONL output.
 * Zero external imports — required by the Paperclip adapter plugin UI parser contract.
 */

type TranscriptEntry =
  | { kind: "stdout"; ts: string; text: string }
  | { kind: "stderr"; ts: string; text: string };

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  return fallback;
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = asRecord(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Parse a single stdout line into transcript entries for UI display.
 * This is the Paperclip UI parser contract.
 */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const event = safeJsonParse(trimmed);
  if (!event) {
    // Non-JSON — treat as raw text
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = asString(event.type, "");
  const part = asRecord(event.part ?? {});

  if (type === "text") {
    const text = asString(part.text, "").trim();
    if (text) return [{ kind: "stdout", ts, text }];
    return [];
  }

  if (type === "step_finish") {
    const text = asString(part.message, "").trim();
    if (text) return [{ kind: "stdout", ts, text }];
    return [];
  }

  // Skip non-display events (step_start, tool_use in normal mode)
  if (type === "step_start" || type === "tool_use") {
    return [];
  }

  if (type === "error") {
    const text = errorText(event).trim();
    if (text) return [{ kind: "stderr", ts, text }];
    return [];
  }

  return [];
}
