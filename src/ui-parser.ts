/**
 * Self-contained stdout parser for OpenCode JSONL output.
 * Zero external imports — required by the Paperclip adapter plugin UI parser contract.
 */

type TranscriptEntry =
  | { kind: "stdout"; ts: string; text: string }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string };

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // Try to parse as JSONL event from opencode run --format json
  try {
    const event = JSON.parse(trimmed);
    const type = typeof event.type === "string" ? event.type : "";
    const part = typeof event.part === "object" && event.part !== null ? event.part : {};

    if (type === "text" && typeof part.text === "string" && part.text.trim()) {
      return [{ kind: "stdout", ts, text: part.text.trim() }];
    }

    // Skip non-display event types
    if (type === "step_start" || type === "step_finish" || type === "tool_use") {
      return [];
    }
  } catch {
    // Not JSON — treat as raw stdout
  }

  return [{ kind: "stdout", ts, text: trimmed }];
}
