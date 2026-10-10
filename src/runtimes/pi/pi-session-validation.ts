import { isJsonObject } from "../../protocol/json";
import type { JsonObject } from "../../protocol/json";

// Pi 0.99.2's v3 file entries. Extension data uses custom/custom_message;
// unknown types and roles are otherwise silently omitted from model context.
const ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "usage",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "context_edit",
  "label",
  "session_info",
]);

function validContent(value: unknown, role: string, allowString: boolean): boolean {
  if (typeof value === "string") return allowString;
  if (!Array.isArray(value)) return false;
  return value.every((block: unknown) => {
    if (!isJsonObject(block)) return false;
    switch (block["type"]) {
      case "text":
        return typeof block["text"] === "string";
      case "image":
        return (
          role !== "assistant" &&
          role !== "system" &&
          typeof block["data"] === "string" &&
          typeof block["mimeType"] === "string"
        );
      case "thinking":
        return role === "assistant" && typeof block["thinking"] === "string";
      case "toolCall":
        return (
          role === "assistant" &&
          typeof block["id"] === "string" &&
          typeof block["name"] === "string" &&
          isJsonObject(block["arguments"])
        );
      default:
        return false;
    }
  });
}

function validTokenCount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validMessage(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  switch (value["role"]) {
    case "system":
    case "user":
    case "custom":
      return validContent(value["content"], value["role"], true);
    case "assistant":
    case "toolResult":
      return validContent(value["content"], value["role"], false);
    case "bashExecution":
      return typeof value["command"] === "string" && typeof value["output"] === "string";
    case "branchSummary":
      return typeof value["summary"] === "string";
    case "compactionSummary":
      return typeof value["summary"] === "string" && validTokenCount(value["tokensBefore"]);
    default:
      return false;
  }
}

interface NativeEntry {
  readonly data: JsonObject;
  readonly parentId: string | null;
}

function ancestor(
  entries: ReadonlyMap<string, NativeEntry>,
  parentId: string | null,
  targetId: string,
): NativeEntry | undefined {
  let id = parentId;
  while (id !== null) {
    const entry = entries.get(id);
    if (id === targetId) return entry;
    id = entry?.parentId ?? null;
  }
  return undefined;
}

function validContextEdit(
  entry: JsonObject,
  parentId: string | null,
  entries: ReadonlyMap<string, NativeEntry>,
): boolean {
  if (typeof entry["targetId"] !== "string") return false;
  const target = ancestor(entries, parentId, entry["targetId"])?.data;
  if (target === undefined) return false;
  let role: string;
  if (target["type"] === "custom_message") role = "custom";
  else if (
    target["type"] === "message" &&
    isJsonObject(target["message"]) &&
    ["user", "assistant", "toolResult"].includes(String(target["message"]["role"]))
  ) {
    role = String(target["message"]["role"]);
  } else return false;
  const replacement = entry["replacement"];
  // Null is Pi's explicit removal operation; strings are normalized to text
  // blocks by Pi for assistant/toolResult targets.
  return (
    replacement === null ||
    (isJsonObject(replacement) && validContent(replacement["content"], role, true))
  );
}

export function readPiSessionHeader(content: string): { cwd: string } {
  const records = content.split("\n").filter((line) => line.trim().length > 0);
  const header: unknown = JSON.parse(records[0]!);
  if (
    !isJsonObject(header) ||
    header["type"] !== "session" ||
    header["version"] !== 3 ||
    typeof header["id"] !== "string" ||
    header["id"].length === 0 ||
    typeof header["timestamp"] !== "string" ||
    typeof header["cwd"] !== "string"
  ) {
    throw new Error("Pi restored session header is invalid.");
  }
  const entries = new Map<string, NativeEntry>();
  for (const line of records.slice(1)) {
    const entry: unknown = JSON.parse(line);
    // Native append-only trees permit branches and multiple roots, but every
    // parent must already exist. Reject index corruption before native restore
    // can silently replace its leaf, lose ancestors, or loop on a cycle.
    if (
      !isJsonObject(entry) ||
      typeof entry["type"] !== "string" ||
      !ENTRY_TYPES.has(entry["type"]) ||
      typeof entry["id"] !== "string" ||
      entry["id"].length === 0 ||
      entries.has(entry["id"]) ||
      typeof entry["timestamp"] !== "string" ||
      (entry["parentId"] !== null &&
        (typeof entry["parentId"] !== "string" || !entries.has(entry["parentId"])))
    ) {
      throw new Error("Pi restored session contains an invalid entry or parent chain.");
    }
    if (
      (entry["type"] === "message" && !validMessage(entry["message"])) ||
      (entry["type"] === "branch_summary" &&
        (typeof entry["summary"] !== "string" || typeof entry["fromId"] !== "string")) ||
      (entry["type"] === "custom_message" && !validContent(entry["content"], "custom", true)) ||
      (entry["type"] === "context_edit" && !validContextEdit(entry, entry["parentId"], entries))
    ) {
      throw new Error("Pi restored session contains invalid model context.");
    }
    if (
      entry["type"] === "compaction" &&
      (typeof entry["summary"] !== "string" ||
        !validTokenCount(entry["tokensBefore"]) ||
        typeof entry["firstKeptEntryId"] !== "string" ||
        (entry["firstKeptEntryId"] !== entry["id"] &&
          ancestor(entries, entry["parentId"], entry["firstKeptEntryId"]) === undefined))
    ) {
      // Self means summary-only; otherwise Pi retains an ancestor suffix.
      throw new Error("Pi restored session contains an invalid compaction or retained branch.");
    }
    entries.set(entry["id"], { data: entry, parentId: entry["parentId"] });
  }
  return { cwd: header["cwd"] };
}
