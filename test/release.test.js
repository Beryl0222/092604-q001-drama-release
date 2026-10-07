import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { buildWorld, entry, lockVersion, seedWorld, SHOWN_AT, LIC } from "./helpers.js";

function preparedWorld() {
  const world = seedWorld(buildWorld());
  const { c } = world;
  const v1 = lockVersion(c, {
    materialId: "SUB",
    entries: [entry("seg1", "A vineyard rose from the Gobi."), entry("seg2", "Life has hope.")],
  });
  const pgm = lockVersion(c, {
    materialId: "PGM",
    entries: [{ segmentId: null, sourceText: "导赏原文", translatedText: "English program note v1" }],
  });
  const tlk = lockVersion(c, {
    materialId: "TLK",
    entries: [{ segmentId: null, sourceText: "讲解原文", translatedText: "English talk script v1" }],
  });
  return { ...world, v1, pgm, tlk };
}

test("场次排期后可发布采用版本，经理能查到最终采用的字幕与导赏", () => {
  const { r, v1, pgm } = preparedWorld();
  r.schedulePerformance({ performanceId: "PF1", productionId: "P1", name: "1020晚场", startsAt: SHOWN_AT, byMemberId: "s1" });
  const job = r.startPublish("PF1", [
    { materialId: "SUB", versionId: v1.versionId },
    { materialId: "PGM", versionId: pgm.versionId },
  ], "s1");
  assert.equal(job.status, "completed");
  const adopted = r.adoptedMaterials("PF1");
  const sub = adopted.find((m) => m.type === "subtitle");
  assert.equal(sub.adoptedVersionId, v1.versionId);
  assert.equal(sub.entries.length, 2);
  assert.equal(adopted.find((m) => m.type === "talk_script").status, "not_published");
});

test("已排练场次可继续用旧版，但 pendingDiffs 暴露与新版的逐句差异", () => {
  const { c, r, v1 } = preparedWorld();
  r.schedulePerformance({ performanceId: "PF1", productionId: "P1", name: "晚场", startsAt: SHOWN_AT, byMemberId: "s1" });
  r.pinForRehearsal("PF1", "SUB", v1.versionId, "s1");
  // 译出 v2（普通措辞）
  const v2res = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "s",
    entries: [entry("seg1", "A vineyard rose from the Gobi."), entry("seg2", "There is hope ahead.")],
  });
  c.lockVersion(v2res.versionId, "u1");
  const diffs = r.pendingDiffs("PF1");
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].pinnedVersionId, v1.versionId);
  assert.equal(diffs[0].diff.changed[0].segmentId, "seg2");
  assert.equal(diffs[0].diff.changed[0].to, "There is hope ahead.");
  // 排练钉版仍是旧版
  assert.equal(r.getPerformance("PF1").pinned.SUB, v1.versionId);
  // 换钉 v2 时差异也写入 pinEvents
  const pinned = r.pinForRehearsal("PF1", "SUB", v2res.versionId, "s1");
  assert.equal(pinned.diff.changed.length, 1);
});

test("冻结窗口内拒绝发布，但允许紧急撤回", () => {
  const { clock, r, v1, pgm } = preparedWorld();
  r.schedulePerformance({ performanceId: "PF1", productionId: "P1", name: "晚场", startsAt: SHOWN_AT, byMemberId: "s1" });
  r.startPublish("PF1", [{ materialId: "SUB", versionId: v1.versionId }], "s1");
  clock.advance(20 * 24 * 3600 * 1000); // 越过默认 24 小时冻结点（当前 10-01 → 10-21）
  assert.throws(
    () => r.startPublish("PF1", [
      { materialId: "SUB", versionId: v1.versionId },
      { materialId: "PGM", versionId: pgm.versionId },
    ], "s1"),
    (e) => e instanceof DomainError && e.code === "FROZEN",
  );
  const { withdrawal } = r.emergencyWithdraw("PF1", ["SUB"], "开演前发现字幕授权争议", "s1");
  assert.deepEqual(withdrawal.pulled.map((x) => x.materialId), ["SUB"]);
  assert.equal(r.adoptedMaterials("PF1").find((m) => m.type === "subtitle").adoptedVersionId, null);
});

test("非冻结期使用回滚，回滚审计列出实际撤下与还原的材料", () => {
  const { r, v1, pgm, tlk } = preparedWorld();
  r.schedulePerformance({ performanceId: "PF1", productionId: "P1", name: "晚场", startsAt: SHOWN_AT, byMemberId: "s1" });
  r.startPublish("PF1", [
    { materialId: "SUB", versionId: v1.versionId },
    { materialId: "PGM", versionId: pgm.versionId },
  ], "s1");
  const second = r.startPublish("PF1", [{ materialId: "TLK", versionId: tlk.versionId }], "s1");
  // 回滚第二次发布：TLK 应被撤下，SUB/PGM 保持
  const rb = r.rollback("PF1", { reason: "讲解稿授权材料未齐", byMemberId: "s1" });
  assert.deepEqual(rb.removed.map((x) => x.materialId), ["TLK"]);
  assert.deepEqual(rb.reverted, []);
  const audit = r.rollbackAudit("PF1");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].removed[0].versionId, tlk.versionId);
});

test("回滚能把被替换的材料还原到旧版本（reverted 明细）", () => {
  const { c, r, v1 } = preparedWorld();
  r.schedulePerformance({ performanceId: "PF1", productionId: "P1", name: "晚场", startsAt: SHOWN_AT, byMemberId: "s1" });
  r.startPublish("PF1", [{ materialId: "SUB", versionId: v1.versionId }], "s1");
  const v2res = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "s",
    entries: [entry("seg1", "A vineyard rose from the Gobi."), entry("seg2", "There is hope ahead.")],
  });
  c.lockVersion(v2res.versionId, "u1");
  r.startPublish("PF1", [{ materialId: "SUB", versionId: v2res.versionId }], "s1");
  const rb = r.rollback("PF1", { reason: "现场设备只兼容旧字幕", byMemberId: "s1" });
  assert.deepEqual(rb.reverted, [{ materialId: "SUB", fromVersionId: v2res.versionId, toVersionId: v1.versionId }]);
  assert.equal(r.getPerformance("PF1").published.SUB, v1.versionId);
});

test("授权将在演出前失效时发布被拒绝，经理可通过接口预警", () => {
  const { c, r, v1 } = preparedWorld();
  r.schedulePerformance({ performanceId: "PF1", productionId: "P1", name: "晚场", startsAt: SHOWN_AT, byMemberId: "s1" });
  // 短授权版本：10-05 到期，早于 10-20 开演
  const res = c.submitTranslation({
    materialId: "PGM", submittedBy: "t1", source: "s",
    entries: [{ segmentId: null, sourceText: "导赏原文", translatedText: "short-licensed note" }],
    license: { holder: "临时版权", expiresAt: "2026-10-05T00:00:00.000Z" },
  });
  c.lockVersion(res.versionId, "u1");
  assert.throws(
    () => r.startPublish("PF1", [{ materialId: "PGM", versionId: res.versionId }], "s1"),
    /授权将在演出前失效/,
  );
  // 排练钉版同样进入预警
  r.pinForRehearsal("PF1", "PGM", res.versionId, "s1");
  const expiring = r.expiringLicenses("PF1");
  assert.equal(expiring.length, 1);
  assert.equal(expiring[0].materialIds.includes("PGM"), true);
  assert.equal(expiring[0].expiresAt, "2026-10-05T00:00:00.000Z");
  // 未发布未钉版的正常版本不预警
  r.pinForRehearsal("PF1", "SUB", v1.versionId, "s1");
  const still = r.expiringLicenses("PF1").filter((x) => x.materialIds.includes("SUB"));
  assert.equal(still.length, 0, LIC.expiresAt);
});

test("发布只能使用已锁定版本", () => {
  const { c, r } = preparedWorld();
  r.schedulePerformance({ performanceId: "PF1", productionId: "P1", name: "晚场", startsAt: SHOWN_AT, byMemberId: "s1" });
  const draft = c.submitTranslation({
    materialId: "SUB", submittedBy: "t1", source: "s",
    entries: [entry("seg2", "draft wording")],
  });
  assert.throws(
    () => r.startPublish("PF1", [{ materialId: "SUB", versionId: draft.versionId }], "s1"),
    /已锁定/,
  );
});
