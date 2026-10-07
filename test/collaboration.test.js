import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { diffEntries, fingerprint } from "../src/policy.js";
import { buildWorld, entry, lockVersion, seedWorld } from "./helpers.js";

function freshWorld() {
  return seedWorld(buildWorld());
}

test("同一译稿重复提交：不产生新版本，返回 duplicate", () => {
  const { c } = freshWorld();
  const entries = [entry("seg1", "A vineyard rose from the Gobi.")];
  const first = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "翻译组", entries, license: undefined,
  });
  const again = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "翻译组", entries: entries.map((e) => ({ ...e })),
  });
  assert.equal(again.outcome, "duplicate");
  assert.equal(again.versionId, first.versionId);
  assert.equal(c.listVersions("SUB").length, 1);
});

test("内容相同但来源不同：合并来源，仍不产生新版本", () => {
  const { c } = freshWorld();
  const entries = [entry("seg1", "A vineyard rose from the Gobi.")];
  const first = c.submitTranslation({ materialId: "SUB", submittedBy: "t1", source: "翻译组邮件", entries });
  const merged = c.submitTranslation({ materialId: "SUB", submittedBy: "t1", source: "字幕组回传", entries });
  assert.equal(merged.outcome, "merged");
  assert.equal(merged.versionId, first.versionId);
  const submission = c.store.list("submissions")[0];
  assert.deepEqual(submission.mergedSources, ["字幕组回传"]);
});

test("指纹忽略条目顺序", () => {
  const a = [entry("seg1", "X"), entry("seg2", "Y")];
  const b = [entry("seg2", "Y"), entry("seg1", "X")];
  assert.equal(fingerprint("SUB", a), fingerprint("SUB", b));
  assert.notEqual(fingerprint("SUB", a), fingerprint("PGM", a));
});

test("修订只能从已锁定版本派生", () => {
  const { c } = freshWorld();
  const v1 = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "s",
    entries: [entry("seg2", "Life has hope now.")],
    license: { holder: "A", expiresAt: "2026-12-31T00:00:00.000Z" },
  });
  // v1 仍是 draft，直接再提交一版应被拒绝
  assert.throws(
    () => c.submitTranslation({ materialId: "SUB", submittedBy: "t1", source: "s", entries: [entry("seg2", "There is hope ahead.")] }),
    (e) => e instanceof DomainError && /已锁定版本/.test(e.message),
  );
  c.lockVersion(v1.versionId, "u1");
  const v2 = c.submitTranslation({ materialId: "SUB", submittedBy: "t1", source: "s", entries: [entry("seg2", "There is hope ahead.")] });
  assert.equal(v2.revisionNo, 2);
  assert.equal(c.getVersion(v2.versionId).parentVersionId, v1.versionId);
});

test("普通措辞调整为 wording，无需顾问复核，不影响其他材料", () => {
  const { c } = freshWorld();
  lockVersion(c, { materialId: "SUB", entries: [entry("seg2", "Life has hope now.")] });
  lockVersion(c, { materialId: "PGM", entries: [{ segmentId: null, sourceText: "导赏原文", translatedText: "English program note" }] });
  const next = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "s",
    entries: [entry("seg2", "There is hope ahead.")],
  });
  const v = c.getVersion(next.versionId);
  assert.equal(v.changeKind, "wording");
  assert.equal(v.status, "draft");
  assert.equal(v.review.required, false);
  c.lockVersion(next.versionId, "u1"); // 主创直接锁定，不需要顾问
});

test("涉及史实片段的改动自动识别为 historical_fact，须顾问复核后才能锁定", () => {
  const { c } = freshWorld();
  lockVersion(c, {
    materialId: "SUB",
    entries: [entry("seg1", "A vineyard rose from the Gobi."), entry("seg2", "Life has hope.")],
  });
  const next = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "亲历者修订",
    entries: [entry("seg1", "We grew grapes on the Gobi resettlement land."), entry("seg2", "Life has hope.")],
  });
  const v = c.getVersion(next.versionId);
  assert.equal(v.changeKind, "historical_fact");
  assert.equal(v.status, "in_review");
  assert.throws(() => c.lockVersion(next.versionId, "u1"), (e) => e.code === "REVIEW_REQUIRED");
  assert.throws(() => c.reviewVersion(next.versionId, "approve", "t1"), (e) => e.code === "FORBIDDEN");
  c.reviewVersion(next.versionId, "reject", "h1", "史实表述仍不准确");
  assert.equal(c.getVersion(next.versionId).status, "draft");
  // 驳回后重新派生修订
  const v3 = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "亲历者修订2",
    entries: [entry("seg1", "Grapevines took root on the relocated Gobi land."), entry("seg2", "Life has hope.")],
  });
  c.reviewVersion(v3.versionId, "approve", "h1");
  c.lockVersion(v3.versionId, "u1");
  assert.equal(c.getVersion(v3.versionId).status, "locked");
});

test("术语决议：普通术语主创裁决，历史称谓需顾问", () => {
  const { c } = freshWorld();
  const term = c.proposeTerm({ productionId: "P1", sourceTerm: "戈壁滩", alternatives: ["Gobi", "Gobi desert"], raisedBy: "t1" });
  c.resolveTerm(term.termId, "Gobi", "u1");
  assert.equal(c.store.get("terms", term.termId).status, "resolved");

  const hist = c.proposeTerm({ productionId: "P1", sourceTerm: "吊庄移民", raisedBy: "t1" });
  assert.throws(() => c.resolveTerm(hist.termId, "Diaozhuang migrants", "u1", { historical: true }), (e) => e.code === "FORBIDDEN");
  c.resolveTerm(hist.termId, "Diaozhuang ecological migrants", "h1", { historical: true });
  assert.equal(c.store.get("terms", hist.termId).decidedBy, "h1");
});

test("文化注释可挂在片段上，并随片段语境一起保留", () => {
  const { c } = freshWorld();
  c.addCulturalNote({ segmentId: "seg1", text: "戈壁垦荒是1990年代闽宁协作扶贫的背景", authorMemberId: "h1" });
  const notes = c.listCulturalNotes({ segmentId: "seg1" });
  assert.equal(notes.length, 1);
  const seg = c.getSegment("seg1");
  assert.equal(seg.context.dialect, "西北官话");
  assert.equal(seg.historical, true);
});

test("争议必须显式解决，且解决记录带裁决人与结论", () => {
  const { c } = freshWorld();
  const d = c.raiseDispute({
    productionId: "P1", subjectType: "segment", subjectId: "seg1",
    summary: "字幕/导赏/讲解对同一句方言用了三个译法", raisedBy: "t1",
  });
  assert.equal(d.status, "open");
  assert.throws(() => c.resolveDispute(d.disputeId, { decision: "暂定", byMemberId: "t1" }), (e) => e.code === "FORBIDDEN");
  const resolved = c.resolveDispute(d.disputeId, { decision: "统一为 Gobi resettlement land", byMemberId: "h1", historical: true });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution.by, "h1");
});

test("亲历者补充史实可追踪到受影响版本与场次", () => {
  const { c, r, clock } = freshWorld();
  const v1 = lockVersion(c, {
    materialId: "SUB",
    entries: [entry("seg1", "A vineyard rose from the Gobi."), entry("seg2", "Life has hope.")],
  });
  clock.advance(60000);
  const fact = c.addHistoricalFact({
    segmentIds: ["seg1"], source: "亲历者马大爷口述",
    text: "葡萄园实际是1998年开垦，而非此前所说的1996年", recordedBy: "h1",
  });
  const impact = c.historicalImpact(fact.factId, r.listPerformances(null));
  assert.deepEqual(impact.versions.map((x) => x.versionId), [v1.versionId]);
  assert.equal(impact.versions[0].recordedBeforeFact, true);
});

test("版本差异精确给出增删改的句子", () => {
  const d = diffEntries(
    [entry("seg1", "old A"), entry("seg2", "old B")],
    [entry("seg1", "new A"), entry("seg3", "new C")],
  );
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].from, "old A");
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
});

test("锁定要求授权与有效期；续期后可锁定更晚的场次", () => {
  const { c } = freshWorld();
  const res = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "s",
    entries: [entry("seg2", "x")], license: { holder: "A", expiresAt: "2000-01-01T00:00:00.000Z" },
  });
  assert.throws(() => c.lockVersion(res.versionId, "u1"), /授权/);
  c.extendLicense(res.versionId, { expiresAt: "2027-01-01T00:00:00.000Z" }, "s1");
  c.lockVersion(res.versionId, "u1");
  assert.equal(c.getVersion(res.versionId).status, "locked");
});
