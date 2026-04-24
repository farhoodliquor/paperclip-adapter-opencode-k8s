import { describe, it, expect } from "vitest";
import { parseStdoutLine } from "./ui-parser.js";

const TS = "2026-01-01T00:00:00.000Z";

describe("parseStdoutLine", () => {
  it("returns empty for blank lines", () => {
    expect(parseStdoutLine("", TS)).toEqual([]);
    expect(parseStdoutLine("   ", TS)).toEqual([]);
  });

  it("returns stdout kind for non-JSON input", () => {
    const entries = parseStdoutLine("plain text", TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("stdout");
  });

  it("maps text event to assistant kind", () => {
    const line = JSON.stringify({ type: "text", part: { text: "Hello" } });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("assistant");
    expect((entries[0] as { kind: "assistant"; text: string }).text).toBe("Hello");
  });

  it("maps standalone thinking event to thinking kind", () => {
    const line = JSON.stringify({ type: "thinking", part: { thinking: "My reasoning" } });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("thinking");
    expect((entries[0] as unknown as { text: string }).text).toBe("My reasoning");
  });

  it("maps thinking block inside assistant event to thinking kind", () => {
    const line = JSON.stringify({
      type: "assistant",
      part: {
        message: {
          content: [{ type: "thinking", thinking: "Inner reasoning" }],
        },
      },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("thinking");
    expect((entries[0] as unknown as { text: string }).text).toBe("Inner reasoning");
  });

  it("collects both text and thinking blocks from assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      part: {
        message: {
          content: [
            { type: "thinking", thinking: "Let me think" },
            { type: "text", text: "Here is my answer" },
          ],
        },
      },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("thinking");
    expect(entries[1].kind).toBe("assistant");
  });

  it("maps user event tool_result to tool_result kind", () => {
    const line = JSON.stringify({
      type: "user",
      part: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_abc",
              content: "File contents here",
            },
          ],
        },
      },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_result");
    const tr = entries[0] as { kind: "tool_result"; toolUseId: string; content: string; isError: boolean };
    expect(tr.toolUseId).toBe("tu_abc");
    expect(tr.content).toBe("File contents here");
    expect(tr.isError).toBe(false);
  });

  it("maps user event tool_result with array content", () => {
    const line = JSON.stringify({
      type: "user",
      part: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_xyz",
              content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }],
            },
          ],
        },
      },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_result");
    expect((entries[0] as { content: string }).content).toBe("part1part2");
  });

  it("returns empty for user event with no content", () => {
    const line = JSON.stringify({ type: "user", part: {} });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toEqual([]);
  });

  it("maps tool_use completed to tool_result kind", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "read_file", id: "tu_1", state: { status: "completed", output: "ok" } },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_result");
  });

  it("maps step_finish to result kind", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: { reason: "end_turn", tokens: { input: 10, output: 5, cache: { read: 0 } }, cost: 0.001 },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("result");
  });

  it("maps error event to stderr kind", () => {
    const line = JSON.stringify({ type: "error", error: { message: "Something broke" } });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("stderr");
  });

  it("ignores thinking event with empty text", () => {
    const line = JSON.stringify({ type: "thinking", part: { thinking: "  " } });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });
});
