/** 领域模型工具：常量、编号、规范化、内容哈希与差异计算。 */
import { createHash } from "node:crypto";

/** 物料类型：舞台字幕、导赏词、演员口述背景。 */
export const MATERIAL_KINDS = ["subtitle", "guide", "narration"];

/** 需要指定角色复核时的角色标识：史实顾问。 */
export const ROLE_HISTORIAN = "historian";

export const ROLE_LABELS = { [ROLE_HISTORIAN]: "史实顾问" };

let counter = 0;

/** 生成进程内唯一编号，携带前缀便于识别。 */
export function nextId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** 键序稳定的 JSON 序列化，用于内容哈希。 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** 任意可序列化值的 sha256 摘要。 */
export function hashOf(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function normalizeNote(note) {
  if (typeof note === "string") return { text: note.trim(), audience: null };
  return {
    text: String(note?.text ?? "").trim(),
    audience: note?.audience ? String(note.audience) : null,
  };
}

/**
 * 规范化台词片段：关联原始语境、术语决议、文化注释、适用受众与授权期限。
 * 只保留受管字段，保证同一内容得到同一哈希。
 */
export function normalizeSegment(segment) {
  if (!segment || typeof segment !== "object") throw new Error("台词片段必须是对象");
  const normalized = {
    segmentId: String(segment.segmentId ?? "").trim(),
    sourceText: String(segment.sourceText ?? "").trim(),
    translatedText: String(segment.translatedText ?? "").trim(),
    sourceContext: String(segment.sourceContext ?? "").trim(),
    termRefs: [...new Set((segment.termRefs ?? []).map(String))].sort(),
    culturalNotes: (segment.culturalNotes ?? []).map(normalizeNote).sort((a, b) => a.text.localeCompare(b.text)),
    audiences: [...new Set((segment.audiences ?? []).map(String))].sort(),
    license: segment.license
      ? { holder: String(segment.license.holder ?? ""), expiresAt: String(segment.license.expiresAt ?? "") }
      : null,
    historical: Boolean(segment.historical),
  };
  if (!normalized.segmentId) throw new Error("台词片段缺少 segmentId");
  if (!normalized.sourceText) throw new Error("台词片段缺少原文");
  return normalized;
}

/** 同一文档同一物料的内容指纹，用于重复提交识别与跨来源合并。 */
export function contentHashOf({ productionId, materialKind, segments }) {
  const normalized = segments
    .map(normalizeSegment)
    .sort((a, b) => a.segmentId.localeCompare(b.segmentId));
  return hashOf({ productionId, materialKind, segments: normalized });
}

/**
 * 比较两个版本的台词片段集合。
 * 返回 { added, removed, changed, unchanged }，changed 携带变更字段与前后内容。
 */
export function diffSegments(baseSegments, nextSegments) {
  const base = new Map((baseSegments ?? []).map((s) => [s.segmentId, s]));
  const next = new Map((nextSegments ?? []).map((s) => [s.segmentId, s]));
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;
  for (const [id, seg] of next) {
    const before = base.get(id);
    if (!before) {
      added.push(structuredClone(seg));
      continue;
    }
    const fields = Object.keys(seg).filter((key) => stableStringify(seg[key]) !== stableStringify(before[key]));
    if (fields.length > 0) {
      changed.push({ segmentId: id, fields, before: structuredClone(before), after: structuredClone(seg) });
    } else {
      unchanged += 1;
    }
  }
  for (const [id, seg] of base) {
    if (!next.has(id)) removed.push(structuredClone(seg));
  }
  return { added, removed, changed, unchanged };
}
