/**
 * 译本协作的纯策略函数：内容指纹、变更分级、条目差异。
 * 不依赖时钟或存储，便于单独测试。
 */
import crypto from "node:crypto";

export function normText(value) {
  return value == null ? "" : String(value).normalize("NFC").trim();
}

function entryKey(entry) {
  return normText(entry.segmentId) || normText(entry.sourceText);
}

function canonicalEntry(entry) {
  return [normText(entry.segmentId), normText(entry.sourceText), normText(entry.translatedText)];
}

/**
 * 内容指纹：与来源、提交顺序、提交人无关。
 * 同一材料下指纹相同即视为内容相同，用于重复提交识别与异源合并。
 */
export function fingerprint(materialId, entries) {
  const canonical = [
    "translation-v1",
    normText(materialId),
    [...entries].map(canonicalEntry).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ];
  return crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/**
 * 比较两个版本的条目。
 * 以 segmentId（缺失时用原文）作为对齐键。
 */
export function diffEntries(parentEntries = [], nextEntries = []) {
  const parentMap = new Map([...parentEntries].map((e) => [entryKey(e), e]));
  const nextMap = new Map([...nextEntries].map((e) => [entryKey(e), e]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, next] of nextMap) {
    const before = parentMap.get(key);
    if (!before) {
      added.push({ segmentId: next.segmentId || null, sourceText: next.sourceText, to: next.translatedText });
    } else if (normText(before.translatedText) !== normText(next.translatedText)) {
      changed.push({
        segmentId: next.segmentId || before.segmentId || null,
        sourceText: next.sourceText || before.sourceText,
        from: before.translatedText,
        to: next.translatedText,
      });
    }
  }
  for (const [key, before] of parentMap) {
    if (!nextMap.has(key)) {
      removed.push({ segmentId: before.segmentId || null, sourceText: before.sourceText, from: before.translatedText });
    }
  }

  return {
    added,
    removed,
    changed,
    changedSegmentIds: changed.map((c) => c.segmentId).filter(Boolean),
    isEmpty: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

/**
 * 判定一次修订属于史实改动还是普通措辞调整。
 * - 显式声明 historical，或
 * - 任一条目被标记为史实（segment.historical）且译文发生变化，
 * 即归为史实改动，需要史实顾问复核。
 */
export function classifyChange({ declared, diff, segmentsById = new Map() }) {
  if (declared === "historical_fact") return "historical_fact";
  const touchedHistorical = diff.changedSegmentIds.some((id) => segmentsById.get(id)?.historical === true);
  const addedHistorical = diff.added.some((a) => a.segmentId && segmentsById.get(a.segmentId)?.historical === true);
  return touchedHistorical || addedHistorical ? "historical_fact" : "wording";
}
