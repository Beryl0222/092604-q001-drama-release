import assert from "node:assert/strict";
import test from "node:test";

import { ManualClock } from "../src/clock.js";
import { Service } from "../src/service.js";

const SHOWTIME = "2026-10-07T20:00:00.000Z";
const SEG_A = {
  segmentId: "seg-1",
  sourceText: "尕娃，莫走",
  translatedText: "Little lad, don't go",
  sourceContext: "第一幕 村口",
  culturalNotes: [{ text: "尕娃为西北方言对小孩的昵称", audience: "adult" }],
  audiences: ["adult"],
};
const SEG_GENERAL = {
  segmentId: "seg-2",
  sourceText: "戈壁滩上种蘑菇",
  translatedText: "Growing mushrooms on the gobi",
  sourceContext: "第二幕 田间",
  license: { holder: "词曲版权方", expiresAt: "2026-10-07T12:00:00.000Z" },
};
const SEG_FAR_LICENSE = {
  segmentId: "seg-3",
  sourceText: "山海情长",
  translatedText: "Bonds between mountain and sea",
  sourceContext: "尾声",
  license: { holder: "舞美素材方", expiresAt: "2027-01-01T00:00:00.000Z" },
};

function setup() {
  const clock = new ManualClock("2026-10-01T00:00:00.000Z");
  const service = new Service({ clock });
  service.createDocument({ documentId: "doc-sub", productionId: "minning", materialKind: "subtitle" });
  service.createDocument({ documentId: "doc-guide", productionId: "minning", materialKind: "guide" });
  service.createSession({ sessionId: "s-1", productionId: "minning", showtimeAt: SHOWTIME });
  service.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A, SEG_GENERAL, SEG_FAR_LICENSE], submittedBy: "translator-1" });
  service.lockVersion("v-1");
  service.submitVersion({
    documentId: "doc-guide",
    versionId: "g-1",
    segments: [{ segmentId: "g-seg-1", sourceText: "闽宁镇导赏", translatedText: "Introduction to Minning Town", sourceContext: "节目册首页" }],
    submittedBy: "translator-2",
  });
  service.lockVersion("g-1");
  service.publishVersion({ versionId: "v-1", sessionIds: ["s-1"] });
  service.publishVersion({ versionId: "g-1", sessionIds: ["s-1"] });
  return { service, clock };
}

test("演出经理查询场次最终采用的字幕与导赏版本", () => {
  const { service } = setup();
  const final = service.sessionFinal("s-1");
  assert.equal(final.materials.subtitle.versionId, "v-1");
  assert.equal(final.materials.guide.versionId, "g-1");
  assert.equal(final.materials.narration, null);
  assert.equal(final.materials.subtitle.segments.length, 3);
});

test("按受众过滤台词片段与文化注释", () => {
  const { service } = setup();
  const adult = service.sessionFinal("s-1", { audience: "adult" });
  assert.deepEqual(adult.materials.subtitle.segments.map((s) => s.segmentId), ["seg-1", "seg-2", "seg-3"]);
  const student = service.sessionFinal("s-1", { audience: "student" });
  assert.deepEqual(student.materials.subtitle.segments.map((s) => s.segmentId), ["seg-2", "seg-3"]);
  assert.equal(student.materials.subtitle.segments[0].culturalNotes.length, 0);
});

test("每条争议如何解决可供查询", () => {
  const { service } = setup();
  service.openDispute({ disputeId: "dis-1", versionId: "v-1", segmentId: "seg-1", issue: "方言“尕娃”在字幕与节目册译法不同", by: "creator-1" });
  service.openDispute({ disputeId: "dis-2", versionId: "v-1", segmentId: "seg-2", issue: "蘑菇品种译名待确认", by: "translator-1" });
  service.resolveDispute({ disputeId: "dis-1", decision: "统一采用术语决议 term-1 的译法", rationale: "主创与翻译达成一致", by: "creator-1" });

  const disputes = service.disputesFor({ sessionId: "s-1" });
  assert.equal(disputes.length, 2);
  const resolved = disputes.find((d) => d.disputeId === "dis-1");
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.resolution.decision, "统一采用术语决议 term-1 的译法");
  const open = disputes.find((d) => d.disputeId === "dis-2");
  assert.equal(open.state, "open");
  assert.equal(open.resolution, null);
});

test("演出前将失效的授权可查", () => {
  const { service } = setup();
  const { expiring } = service.expiringLicenses("s-1");
  assert.equal(expiring.length, 1);
  assert.equal(expiring[0].segmentId, "seg-2");
  assert.equal(expiring[0].holder, "词曲版权方");
  assert.equal(expiring[0].expiredAlready, false);
});

test("回滚记录实际撤下的材料", () => {
  const { service } = setup();
  service.submitVersion({
    documentId: "doc-sub",
    versionId: "v-2",
    baseVersionId: "v-1",
    segments: [
      { ...SEG_A, translatedText: "Little lad, stay" },
      SEG_GENERAL,
      SEG_FAR_LICENSE,
      { segmentId: "seg-4", sourceText: "新加的台词", translatedText: "A newly added line", sourceContext: "尾声" },
    ],
    submittedBy: "translator-1",
  });
  service.lockVersion("v-2");
  service.publishVersion({ versionId: "v-2", sessionIds: ["s-1"] });
  assert.equal(service.sessionFinal("s-1").materials.subtitle.versionId, "v-2");

  const record = service.rollbackSession({ sessionId: "s-1", materialKind: "subtitle", toVersionId: "v-1", by: "manager-1" });
  assert.equal(record.fromVersionId, "v-2");
  assert.deepEqual(record.withdrawnMaterials.removed.map((s) => s.segmentId), ["seg-4"]);
  assert.deepEqual(record.withdrawnMaterials.replaced.map((r) => r.segmentId), ["seg-1"]);
  assert.equal(record.withdrawnMaterials.replaced[0].withdrawn.translatedText, "Little lad, stay");
  assert.equal(record.withdrawnMaterials.replaced[0].restored.translatedText, "Little lad, don't go");

  const details = service.rollbackDetails(record.rollbackId);
  assert.deepEqual(details, record);
  assert.equal(service.sessionFinal("s-1").materials.subtitle.versionId, "v-1");
});

test("冻结场次回滚需要 emergency 标记", () => {
  const { service, clock } = setup();
  service.submitVersion({
    documentId: "doc-sub",
    versionId: "v-2",
    baseVersionId: "v-1",
    segments: [SEG_A, { ...SEG_GENERAL, translatedText: "Farming mushrooms on the gobi" }, SEG_FAR_LICENSE],
    submittedBy: "translator-1",
  });
  service.lockVersion("v-2");
  service.publishVersion({ versionId: "v-2", sessionIds: ["s-1"] });
  clock.set("2026-10-07T19:30:00.000Z");
  assert.throws(() => service.rollbackSession({ sessionId: "s-1", materialKind: "subtitle", toVersionId: "v-1" }), /emergency/);
  const record = service.rollbackSession({ sessionId: "s-1", materialKind: "subtitle", toVersionId: "v-1", emergency: true });
  assert.equal(record.emergency, true);
});

test("术语决议一致性检查", () => {
  const { service } = setup();
  service.proposeTerm({ termId: "term-1", sourcePhrase: "尕娃", decidedTranslation: "little lad", rationale: "统一方言译法", by: "creator-1" });
  service.ratifyTerm("term-1", "creator-1");

  service.submitVersion({
    documentId: "doc-sub",
    versionId: "v-2",
    baseVersionId: "v-1",
    segments: [{ ...SEG_A, translatedText: "The little boy should not go" }, SEG_GENERAL, SEG_FAR_LICENSE],
    submittedBy: "translator-1",
  });
  const { violations } = service.termConsistency("v-2");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].termId, "term-1");
  const locked = service.lockVersion("v-2");
  assert.equal(locked.termViolations.length, 1);
});
