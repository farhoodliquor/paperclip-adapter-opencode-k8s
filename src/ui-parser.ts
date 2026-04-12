/**
 * Self-contained stdout parser for OpenCode JSONL output.
 * Zero external imports — required by the Paperclip adapter plugin UI parser contract.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseStdoutLine } from "./cli/format-event.js";

export { parseStdoutLine };
