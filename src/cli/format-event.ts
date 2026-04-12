import type { TranscriptEntry } from "@paperclipai/adapter-utils";

type JsonEvent = {
  type: string;
  part?: Record<string, unknown>;
  sessionID?: string;
};

function safeJsonParse(text: string): JsonEvent | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as JsonEvent;
    }
    return null;
  } catch {
    return null;
  }
}

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

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  return fallback;
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
 * Format an OpenCode JSONL event for terminal display.
 * Returns formatted string or empty string to skip display.
 */
export function formatEvent(line: string, debug: boolean): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  const event = safeJsonParse(trimmed);
  if (!event) {
    // Non-JSON lines print as-is
    return trimmed;
  }

  const type = asString(event.type, "");
  const part = asRecord(event.part ?? {});

  switch (type) {
    case "step_start": {
      const sessionId = asString(event.sessionID, "");
      if (debug) {
        return `[step_start]${sessionId ? ` session=${sessionId}` : ""}`;
      }
      return ""; // Skip step_start in normal mode
    }

    case "text": {
      const text = asString(part.text, "").trim();
      if (text) {
        return text;
      }
      return "";
    }

    case "tool_use": {
      const toolType = asString(part.type, "");
      const state = asRecord(part.state ?? {});
      const status = asString(state.status, "");
      const toolName = asString(part.tool, "");
      const description = asString(state.description, "");

      if (debug) {
        const output = asString(state.output ?? "", "");
        const error = asString(state.error, "");
        let result = `[tool:${toolName}] ${status}`;
        if (description) result += ` - ${description}`;
        if (output) result += `\n  → ${output.substring(0, 200)}`;
        if (error) result += `\n  ✗ ${error}`;
        return result;
      }

      if (status === "error") {
        const err = asString(state.error, "").trim();
        if (err) return `⚠ ${err}`;
      }
      return ""; // Skip tool calls in normal mode unless error
    }

    case "step_finish": {
      const reason = asString(part.reason, "");
      const message = asString(part.message, "").trim();
      const tokens = asRecord(part.tokens ?? {});
      const totalTokens = asNumber(tokens.total, 0);
      const cost = asNumber(part.cost, 0);

      let result = message || `[step_finish] ${reason}`;
      if (debug || totalTokens > 0 || cost > 0) {
        const parts: string[] = [];
        if (totalTokens > 0) parts.push(`tokens=${totalTokens}`);
        if (cost > 0) parts.push(`cost$${cost.toFixed(4)}`);
        if (parts.length > 0) result += ` (${parts.join(", ")})`;
      }
      return result;
    }

    case "error": {
      const text = errorText(event).trim();
      if (text) return `✗ ${text}`;
      return "";
    }

    case "assistant": {
      // Nested assistant message content
      const content = part.message ?? part;
      const contentRecord = asRecord(content);
      if (contentRecord.content) {
        const contentArr = Array.isArray(contentRecord.content)
          ? contentRecord.content
          : [contentRecord.content];
        for (const item of contentArr) {
          const itemRecord = asRecord(item);
          if (itemRecord.type === "text" && typeof itemRecord.text === "string") {
            return itemRecord.text.trim();
          }
        }
      }
      return "";
    }

    default:
      return debug ? `[${type}]` : "";
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
