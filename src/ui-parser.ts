/**
 * Self-contained stdout parser for OpenCode JSONL output.
 * Zero external imports — required by the Paperclip adapter plugin UI parser contract.
 */

type TranscriptEntry =
  | { kind: "stdout"; ts: string; text: string }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string };

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
