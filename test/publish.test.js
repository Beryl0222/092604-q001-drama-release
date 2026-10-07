import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ManualClock } from "../src/clock.js";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";

const SHOWTIME = "2026-10-07T20:00:00.000Z";
const SEG_A = { segmentId: "seg-1", sourceText: "尕娃，莫走", translatedText: "Little lad, don't go", sourceContext: "第一幕 村口" };
const SEG_B = { segmentId: "seg-2", sourceText: "戈壁滩上种蘑菇", translatedText: "Growing mushrooms on the gobi", sourceContext: "第二幕 田间" };

function setup({ showtime = SHOWTIME, now = "2026-10-01T00:00:00.000Z" } = {}) {
  const clock = new ManualClock(now);
  const service = new Service({ clock });
  service.createDocument({ documentId: "doc-sub", productionId: "minning", materialKind: "subtitle" });
  service.createSession({ sessionId: "s-1", productionId: "minning", showtimeAt: showtime });
  service.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A, SEG_B], submittedBy: "translator-1" });
  service.lockVersion("v-1");
  return { service, clock };
}

test("发布流程：锁定版本发布后绑定场次，旧版本转为替代", () => {
  const { service } = setup();
  const job = service.publishVersion({ versionId: "v-1", sessionIds: ["s-1"], jobId: "job-1" });
  assert.equal(job.state, "completed");
  assert.deepEqual(job.steps.map((s) => s.status), ["done", "done", "done", "done", "done"]);
  assert.equal(service.versionInfo("v-1").state, "published");
  assert.equal(service.sessionInfo("s-1").bindings.subtitle.versionId, "v-1");

  service.submitVersion({ documentId: "doc-sub", versionId: "v-2", baseVersionId: "v-1", segments: [SEG_A, { ...SEG_B, translatedText: "Farming mushrooms on the gobi" }], submittedBy: "translator-1" });
  service.lockVersion("v-2");
  service.publishVersion({ versionId: "v-2", sessionIds: ["s-1"] });
  assert.equal(service.versionInfo("v-1").state, "superseded");
  assert.equal(service.sessionInfo("s-1").bindings.subtitle.versionId, "v-2");
});

test("未锁定版本不能发布", () => {
  const { service } = setup();
  service.submitVersion({ documentId: "doc-sub", versionId: "v-2", baseVersionId: "v-1", segments: [SEG_A, { ...SEG_B, translatedText: "Farming mushrooms on the gobi" }], submittedBy: "translator-1" });
  assert.throws(() => service.publishVersion({ versionId: "v-2", sessionIds: ["s-1"], jobId: "job-1" }), /已锁定版本/);
  assert.equal(service.jobInfo("job-1").state, "interrupted");
});

test("已排练场次继续使用旧版且不停演，差异通过查询暴露", () => {
  const { service } = setup();
  service.publishVersion({ versionId: "v-1", sessionIds: ["s-1"] });
  service.updateSessionStatus("s-1", "rehearsed");

  // 普通措辞调整：发布后已排练场次保留旧版，演出状态不受影响
  service.submitVersion({ documentId: "doc-sub", versionId: "v-2", baseVersionId: "v-1", segments: [SEG_A, { ...SEG_B, translatedText: "Farming mushrooms on the gobi" }], submittedBy: "translator-1" });
  service.lockVersion("v-2");
  service.publishVersion({ versionId: "v-2", sessionIds: ["s-1"] });

  const session = service.sessionInfo("s-1");
  assert.equal(session.status, "rehearsed");
  assert.equal(session.bindings.subtitle.versionId, "v-1");
  assert.deepEqual(session.updatesAvailable.map((u) => u.versionId), ["v-2"]);

  const diff = service.sessionDiff("s-1", "subtitle");
  assert.equal(diff.upToDate, false);
  assert.equal(diff.boundVersionId, "v-1");
  assert.equal(diff.latestPublishedVersionId, "v-2");
  assert.deepEqual(diff.diff.changed.map((c) => c.segmentId), ["seg-2"]);
});

test("临近开演的冻结场次不能发布或换绑，但可紧急撤回", () => {
  const { service, clock } = setup();
  service.publishVersion({ versionId: "v-1", sessionIds: ["s-1"] });
  service.submitVersion({ documentId: "doc-sub", versionId: "v-2", baseVersionId: "v-1", segments: [SEG_A, { ...SEG_B, translatedText: "Farming mushrooms on the gobi" }], submittedBy: "translator-1" });
  service.lockVersion("v-2");

  // 进入开演前两小时冻结窗口
  clock.set("2026-10-07T19:00:00.000Z");
  assert.equal(service.isSessionFrozen("s-1"), true);
  assert.throws(() => service.publishVersion({ versionId: "v-2", sessionIds: ["s-1"] }), /冻结/);
  assert.throws(() => service.rebindSession({ sessionId: "s-1", materialKind: "subtitle", versionId: "v-2" }), /冻结/);

  const withdrawn = service.withdrawVersion({ versionId: "v-1", reason: "字幕授权被撤回", by: "manager-1" });
  assert.equal(withdrawn.state, "withdrawn");
  assert.equal(service.sessionInfo("s-1").bindings.subtitle, undefined);
});

test("紧急撤回后绑定场次回退到上一可用版本", () => {
  const { service } = setup();
  service.publishVersion({ versionId: "v-1", sessionIds: ["s-1"] });
  service.submitVersion({ documentId: "doc-sub", versionId: "v-2", baseVersionId: "v-1", segments: [SEG_A, { ...SEG_B, translatedText: "Farming mushrooms on the gobi" }], submittedBy: "translator-1" });
  service.lockVersion("v-2");
  service.publishVersion({ versionId: "v-2", sessionIds: ["s-1"] });
  assert.equal(service.sessionInfo("s-1").bindings.subtitle.versionId, "v-2");

  const result = service.withdrawVersion({ versionId: "v-2", reason: "史实存疑", by: "manager-1" });
  assert.deepEqual(result.affectedSessions, [{ sessionId: "s-1", materialKind: "subtitle", toVersionId: "v-1" }]);
  assert.equal(service.sessionInfo("s-1").bindings.subtitle.versionId, "v-1");
  assert.equal(service.versionInfo("v-1").state, "published");
  assert.equal(service.sessionFinal("s-1").materials.subtitle.versionId, "v-1");
  assert.throws(() => service.withdrawVersion({ versionId: "v-1", reason: "" }), /原因/);
});

test("进程中断后恢复尚未完成的发布步骤", () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-"));
  const path = join(dir, "store.json");
  const clock = new ManualClock("2026-10-01T00:00:00.000Z");
  const crash = (step) => {
    if (step === "bind_sessions") throw new Error("模拟进程中断");
  };
  const serviceA = new Service({ store: new Store({ path }), clock, stepHook: crash });
  serviceA.createDocument({ documentId: "doc-sub", productionId: "minning", materialKind: "subtitle" });
  serviceA.createSession({ sessionId: "s-1", productionId: "minning", showtimeAt: SHOWTIME });
  serviceA.submitVersion({ documentId: "doc-sub", versionId: "v-1", segments: [SEG_A], submittedBy: "translator-1" });
  serviceA.lockVersion("v-1");
  assert.throws(() => serviceA.publishVersion({ versionId: "v-1", sessionIds: ["s-1"], jobId: "job-1" }), /模拟进程中断/);
  assert.equal(serviceA.jobInfo("job-1").state, "interrupted");
  assert.equal(serviceA.versionInfo("v-1").state, "published");
  assert.equal(serviceA.sessionInfo("s-1").bindings.subtitle, undefined);

  // 新进程从同一存储启动，自动恢复未完成的步骤
  const serviceB = new Service({ store: new Store({ path }), clock });
  const job = serviceB.jobInfo("job-1");
  assert.equal(job.state, "completed");
  assert.deepEqual(job.steps.map((s) => s.status), ["done", "done", "done", "done", "done"]);
  assert.equal(serviceB.sessionInfo("s-1").bindings.subtitle.versionId, "v-1");
  const publishedEvents = serviceB.listEvents().filter((e) => e.type === "version.published" && e.details.jobId === "job-1");
  assert.equal(publishedEvents.length, 1);
});
