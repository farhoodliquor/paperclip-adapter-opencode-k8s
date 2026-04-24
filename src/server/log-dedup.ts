/**
 * Line-level dedup filter for the K8s log stream.
 *
 * The K8s log follow stream can reconnect with an overlapping `sinceSeconds`
 * window (integer-second granularity + a safety buffer), which replays a few
 * seconds of recent output on every reconnect. Without dedup those replayed
 * lines appear as duplicate events in the streaming UI.
 *
 * The filter operates at the chunk → line level: chunks are split on `\n`,
 * incomplete trailing content is buffered until the next chunk, and each
 * complete line is emitted at most once. JSON-shaped OpenCode JSONL events
 * are keyed by (type + sessionID + part.id); non-JSON lines pass through
 * unchanged so genuinely-repeated status lines are not swallowed.
 */

type Parsed = Record<string, unknown>;

function asStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRec(value: unknown): Parsed | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Parsed;
}

/**
 * Build a stable dedup key for an OpenCode JSONL event. Returns `null` when
 * the event is not a recognized OpenCode event — those lines fall back to
 * raw-content hashing so non-JSON output (paperclip status lines, shell
 * output) is never deduped by identity.
 */
export function eventDedupKey(event: Parsed): string | null {
  const type = asStr(event.type);
  if (!type) return null;

  const sessionId = asStr(event.sessionID);
  const part = asRec(event.part);
  const partId = part ? asStr(part.id) : "";

  switch (type) {
    case "text":
    case "tool_use":
    case "step_finish":
    case "step_start":
    case "thinking":
    case "assistant":
    case "user":
      if (partId) return `${type}:${sessionId}:${partId}`;
      if (sessionId) return `${type}:${sessionId}`;
      return null;
    default:
      return null;
  }
}

/**
 * Stateful line-level dedup filter. Emits `filter(chunk)` output through
 * the caller — preserves original chunk formatting (including trailing
 * newlines) for lines that pass the dedup check.
 */
export class LogLineDedupFilter {
  private buffer = "";
  private readonly seenKeys = new Set<string>();

  /**
   * Process a chunk and return the subset that should be forwarded.
   * Incomplete trailing content (no terminating newline) is buffered and
   * emitted on the next chunk that completes the line (or on flush()).
   */
  filter(chunk: string): string {
    if (!chunk) return "";
    const combined = this.buffer + chunk;
    const endsWithNewline = combined.endsWith("\n");
    const parts = combined.split("\n");

    if (endsWithNewline) {
      parts.pop();
      this.buffer = "";
    } else {
      this.buffer = parts.pop() ?? "";
    }

    const out: string[] = [];
    for (const line of parts) {
      if (this.shouldEmit(line)) out.push(line);
    }
    if (out.length === 0) return "";
    return out.join("\n") + "\n";
  }

  /**
   * Flush any incomplete trailing content. Called when the stream ends
   * without a terminating newline so the final partial line isn't lost.
   */
  flush(): string {
    const pending = this.buffer;
    this.buffer = "";
    if (!pending) return "";
    return this.shouldEmit(pending) ? pending : "";
  }

  private shouldEmit(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;

    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return true;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return true;
    }

    const event = asRec(parsed);
    if (!event) return true;

    const structuralKey = eventDedupKey(event);
    const key = structuralKey ?? `raw:${trimmed}`;

    if (this.seenKeys.has(key)) return false;
    this.seenKeys.add(key);
    return true;
  }
}
