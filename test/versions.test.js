import assert from "node:assert/strict";
import test from "node:test";

import { ManualClock } from "../src/clock.js";
import { Service } from "../src/service.js";

const SEG_A = { segmentId: "seg-1", sourceText: "尕娃，莫走", translatedText: "Little lad, don't go", sourceContext: "第一幕 村口" };
const SEG_H = { segmentId: "seg-2", sourceText: "1997年闽宁村奠基", translatedText: "In 1997 Minning Village was founded", sourceContext: "第二幕 独白", historical: true };

function setup() {
  const service = new Service({ clock: new ManualClock("2026-10-01T00:00:00.000Z") });
  service.createDocument({ documentId: "doc-sub", productionId: "minning", materialKind: "subtitle" });
  return service;
}

test("首次提交创建草稿版本", () => {
  const service = setup();
  const result = service.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A], submittedBy: "translator-1" });
  assert.equal(result.state, "draft");
  assert.deepEqual(result.requiresReview, []);
  assert.equal(service.versionInfo("v-1").segments[0].sourceContext, "第一幕 村口");
});

test("涉及历史事实的首次提交需要史实顾问复核", () => {
  const service = setup();
  const result = service.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A, SEG_H], submittedBy: "translator-1" });
  assert.deepEqual(result.requiresReview, ["historian"]);
  assert.throws(() => service.lockVersion("v-1"), /史实顾问/);
  service.submitReview({ versionId: "v-1", reviewerId: "advisor-1", role: "historian", decision: "approved" });
  const locked = service.lockVersion("v-1");
  assert.equal(locked.state, "locked");
});

test("修订只能从已锁定版本派生", () => {
  const service = setup();
  service.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A], submittedBy: "translator-1" });
  assert.throws(
    () => service.submitVersion({ documentId: "doc-sub", versionId: "v-2", baseVersionId: "v-1", segments: [{ ...SEG_A, translatedText: "Little lad, stay" }], submittedBy: "translator-1" }),
    /已锁定版本派生/,
  );
  assert.throws(
    () => service.submitVersion({ documentId: "doc-sub", versionId: "v-2", segments: [{ ...SEG_A, translatedText: "Little lad, stay" }], submittedBy: "translator-1" }),
    /基础版本/,
  );
  service.lockVersion("v-1");
  const derived = service.submitVersion({ documentId: "doc-sub", versionId: "v-2", baseVersionId: "v-1", segments: [{ ...SEG_A, translatedText: "Little lad, stay" }], submittedBy: "translator-1" });
  assert.equal(derived.state, "draft");
});

test("同一译稿重复提交幂等返回", () => {
  const service = setup();
  const body = { documentId: "doc-sub", versionId: "v-1", segments: [SEG_A], submittedBy: "translator-1", submissionId: "sub-1" };
  const first = service.submitVersion(body);
  const again = service.submitVersion(body);
  assert.equal(again.versionId, first.versionId);
  assert.equal(again.replayed, true);
  assert.throws(
    () => service.submitVersion({ ...body, segments: [{ ...SEG_A, translatedText: "different" }] }),
    /提交编号已被其他内容使用/,
  );
});

test("内容相同：同源视为重复，不同来源合并", () => {
  const service = setup();
  service.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A], submittedBy: "translator-1", source: "stage-subtitles" });
  const duplicate = service.submitVersion({ documentId: "doc-sub", versionId: "v-2", segments: [SEG_A], submittedBy: "translator-1", source: "stage-subtitles" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.versionId, "v-1");
  const merged = service.submitVersion({ documentId: "doc-sub", versionId: "v-3", segments: [SEG_A], submittedBy: "translator-2", source: "program-booklet" });
  assert.equal(merged.merged, true);
  assert.equal(merged.versionId, "v-1");
  assert.equal(service.versionInfo("v-1").sources.length, 3);
});

test("历史事实改动需要史实顾问复核，普通措辞不需要", () => {
  const service = setup();
  service.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A, SEG_H], submittedBy: "translator-1" });
  service.submitReview({ versionId: "v-1", reviewerId: "advisor-1", role: "historian", decision: "approved" });
  service.lockVersion("v-1");

  // 普通措辞调整：不需要复核，可直接锁定发布，不应让整部剧停演
  const wording = service.submitVersion({ documentId: "doc-sub", versionId: "v-2", baseVersionId: "v-1", segments: [{ ...SEG_A, translatedText: "Little lad, stay" }, SEG_H], submittedBy: "translator-1" });
  assert.deepEqual(wording.requiresReview, []);
  assert.equal(service.lockVersion("v-2").state, "locked");

  // 亲历者补充史实：改动历史片段，需要复核
  const historical = service.submitVersion({ documentId: "doc-sub", versionId: "v-3", baseVersionId: "v-2", segments: [SEG_A, { ...SEG_H, translatedText: "In 1996 Minning Village was founded" }], submittedBy: "translator-1" });
  assert.deepEqual(historical.requiresReview, ["historian"]);
  assert.throws(() => service.lockVersion("v-3"), /史实顾问/);
  service.submitReview({ versionId: "v-3", reviewerId: "advisor-1", role: "historian", decision: "rejected", note: "年份应为1997" });
  assert.throws(() => service.lockVersion("v-3"), /史实顾问/);
  service.submitReview({ versionId: "v-3", reviewerId: "advisor-2", role: "historian", decision: "approved", note: "经核实为1996" });
  assert.equal(service.lockVersion("v-3").state, "locked");
});

test("阻断性争议未解决时不能锁定", () => {
  const service = setup();
  service.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A], submittedBy: "translator-1" });
  service.openDispute({ disputeId: "dis-1", versionId: "v-1", segmentId: "seg-1", issue: "方言译法不一致", blocking: true, by: "creator-1" });
  assert.throws(() => service.lockVersion("v-1"), /争议/);
  service.resolveDispute({ disputeId: "dis-1", decision: "采用术语决议的译法", by: "creator-1" });
  assert.equal(service.lockVersion("v-1").state, "locked");
});
