import { describe, it, expect, beforeEach } from "vitest";
import { eventDedupKey, LogLineDedupFilter } from "./log-dedup.js";

describe("eventDedupKey", () => {
  it("returns null for object with no type field", () => {
    expect(eventDedupKey({ sessionID: "ses_1" })).toBeNull();
  });

  it("returns null for object with empty type", () => {
    expect(eventDedupKey({ type: "" })).toBeNull();
  });

  it("returns null for unknown event type", () => {
    expect(eventDedupKey({ type: "unknown_type", sessionID: "ses_1" })).toBeNull();
  });

  it("returns type:sessionId:partId when all three present", () => {
    const event = { type: "text", sessionID: "ses_1", part: { id: "part_abc" } };
    expect(eventDedupKey(event)).toBe("text:ses_1:part_abc");
  });

  it("returns type:sessionId when partId absent", () => {
    const event = { type: "text", sessionID: "ses_1", part: {} };
    expect(eventDedupKey(event)).toBe("text:ses_1");
  });

  it("returns null when both sessionId and partId absent", () => {
    const event = { type: "text", part: {} };
    expect(eventDedupKey(event)).toBeNull();
  });

  it("returns null when part has no id and sessionID missing", () => {
    const event = { type: "tool_use" };
    expect(eventDedupKey(event)).toBeNull();
  });

  it("handles tool_use type", () => {
    const event = { type: "tool_use", sessionID: "ses_1", part: { id: "tool_1" } };
    expect(eventDedupKey(event)).toBe("tool_use:ses_1:tool_1");
  });

  it("handles step_finish type", () => {
    const event = { type: "step_finish", sessionID: "ses_2", part: { id: "step_1" } };
    expect(eventDedupKey(event)).toBe("step_finish:ses_2:step_1");
  });

  it("handles step_start type", () => {
    const event = { type: "step_start", sessionID: "ses_3" };
    expect(eventDedupKey(event)).toBe("step_start:ses_3");
  });

  it("handles thinking type", () => {
    const event = { type: "thinking", sessionID: "ses_4", part: { id: "think_1" } };
    expect(eventDedupKey(event)).toBe("thinking:ses_4:think_1");
  });

  it("handles assistant type", () => {
    const event = { type: "assistant", sessionID: "ses_5" };
    expect(eventDedupKey(event)).toBe("assistant:ses_5");
  });

  it("handles user type", () => {
    const event = { type: "user", sessionID: "ses_6" };
    expect(eventDedupKey(event)).toBe("user:ses_6");
  });

  it("returns null for error type (not in dedup switch)", () => {
    const event = { type: "error", sessionID: "ses_7" };
    expect(eventDedupKey(event)).toBeNull();
  });

  it("uses part.id string even when nested in non-object context", () => {
    const event = { type: "text", sessionID: "ses_1", part: { id: "part_x" } };
    expect(eventDedupKey(event)).toBe("text:ses_1:part_x");
  });
});

describe("LogLineDedupFilter", () => {
  let dedup: LogLineDedupFilter;

  beforeEach(() => {
    dedup = new LogLineDedupFilter();
  });

  describe("filter()", () => {
    it("returns empty string for empty chunk", () => {
      expect(dedup.filter("")).toBe("");
    });

    it("passes through non-JSON lines", () => {
      const chunk = "[paperclip] Pod running: pod-abc\n";
      expect(dedup.filter(chunk)).toBe(chunk);
    });

    it("passes a JSON event on first occurrence", () => {
      const event = { type: "text", sessionID: "ses_1" };
      const line = JSON.stringify(event) + "\n";
      expect(dedup.filter(line)).toBe(line);
    });

    it("drops a duplicate JSON event on second occurrence", () => {
      const event = { type: "text", sessionID: "ses_1" };
      const line = JSON.stringify(event) + "\n";
      dedup.filter(line); // first — passes
      expect(dedup.filter(line)).toBe(""); // second — dropped
    });

    it("passes a JSON event without a dedup key on every occurrence", () => {
      // Events with unknown type have no structural key — fall back to raw content hash
      const event = { type: "error", sessionID: "ses_1", error: "unique1" };
      const line = JSON.stringify(event) + "\n";
      dedup.filter(line);
      // Same raw content would be deduped (raw: key), but different error content passes
      const event2 = { type: "error", sessionID: "ses_1", error: "unique2" };
      const line2 = JSON.stringify(event2) + "\n";
      expect(dedup.filter(line2)).toBe(line2);
    });

    it("deduplicates same raw non-dedup-keyed line twice", () => {
      const event = { type: "error", message: "same" };
      const line = JSON.stringify(event) + "\n";
      dedup.filter(line);
      expect(dedup.filter(line)).toBe(""); // same raw content deduplicated via raw: key
    });

    it("buffers incomplete trailing content without emitting", () => {
      // No trailing newline → chunk is buffered
      const partial = '{"type":"text","sessionID":"ses_1"}';
      expect(dedup.filter(partial)).toBe("");
    });

    it("emits buffered content when completed by next chunk", () => {
      const partial = '{"type":"text","sessionID":"ses_1"}';
      dedup.filter(partial); // buffered
      const completion = "\n"; // completes the line
      const result = dedup.filter(completion);
      expect(result).toBe('{"type":"text","sessionID":"ses_1"}\n');
    });

    it("handles multiple lines in a single chunk", () => {
      const line1 = '{"type":"text","sessionID":"ses_1"}\n';
      const line2 = '[paperclip] some status\n';
      const chunk = line1 + line2;
      const result = dedup.filter(chunk);
      expect(result).toBe(chunk);
    });

    it("deduplicates within a multi-line chunk", () => {
      const line = '{"type":"text","sessionID":"ses_1"}\n';
      const chunk = line + line; // same line twice in one chunk
      const result = dedup.filter(chunk);
      expect(result).toBe(line); // only once
    });

    it("passes blank lines through unchanged", () => {
      expect(dedup.filter("\n")).toBe("\n");
    });

    it("passes whitespace-only lines through unchanged", () => {
      expect(dedup.filter("   \n")).toBe("   \n");
    });

    it("deduplicates events keyed by type:sessionId across chunks", () => {
      const event = { type: "step_start", sessionID: "ses_1" };
      const line = JSON.stringify(event) + "\n";
      dedup.filter(line);
      // second occurrence in a later chunk
      expect(dedup.filter(line)).toBe("");
    });

    it("allows distinct events with different sessionIds to pass", () => {
      const line1 = JSON.stringify({ type: "text", sessionID: "ses_1" }) + "\n";
      const line2 = JSON.stringify({ type: "text", sessionID: "ses_2" }) + "\n";
      dedup.filter(line1);
      expect(dedup.filter(line2)).toBe(line2);
    });

    it("allows distinct events with different partIds to pass", () => {
      const line1 = JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { id: "t1" } }) + "\n";
      const line2 = JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { id: "t2" } }) + "\n";
      dedup.filter(line1);
      expect(dedup.filter(line2)).toBe(line2);
    });
  });

  describe("flush()", () => {
    it("returns empty string when buffer is empty", () => {
      expect(dedup.flush()).toBe("");
    });

    it("returns and clears buffered incomplete line", () => {
      const partial = '{"type":"text","sessionID":"ses_1"}';
      dedup.filter(partial);
      expect(dedup.flush()).toBe(partial);
    });

    it("returns empty string on subsequent flush after buffer cleared", () => {
      const partial = '{"type":"text","sessionID":"ses_1"}';
      dedup.filter(partial);
      dedup.flush();
      expect(dedup.flush()).toBe(""); // buffer already cleared
    });

    it("does not emit duplicate content on flush", () => {
      const line = '{"type":"text","sessionID":"ses_1"}\n';
      dedup.filter(line); // first emission
      const partial = '{"type":"text","sessionID":"ses_1"}'; // no trailing newline
      dedup.filter(partial);
      expect(dedup.flush()).toBe(""); // same key already seen — suppressed
    });
  });
});
