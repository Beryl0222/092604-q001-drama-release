import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../src/api.js";
import { Service } from "../src/service.js";
import { SequentialIds } from "../src/ids.js";
import { MutableClock } from "./helpers.js";

function svc() {
  return new Service({ clock: new MutableClock(), ids: new SequentialIds("id") });
}

function call(service, obj) {
  return JSON.parse(handle(JSON.stringify(obj), service));
}

function setup(service) {
  call(service, { action: "member.register", memberId: "u1", name: "主创", roles: ["creator"] });
  call(service, { action: "member.register", memberId: "t1", name: "翻译", roles: ["translator"] });
  call(service, { action: "member.register", memberId: "h1", name: "顾问", roles: ["history_advisor"] });
  call(service, { action: "member.register", memberId: "s1", name: "经理", roles: ["stage_manager"] });
  call(service, { action: "production.create", productionId: "P1", title: "闽宁镇", by: "u1" });
  call(service, { action: "material.create", materialId: "SUB", productionId: "P1", type: "subtitle", title: "字幕" });
  call(service, {
    action: "segment.register", materialId: "SUB", segmentId: "seg1",
    sourceText: "咱这戈壁滩上长出了葡萄园", historical: true,
    context: { dialect: "西北官话" },
  });
  call(service, {
    action: "segment.register", materialId: "SUB", segmentId: "seg2",
    sourceText: "日子有奔头了", historical: false,
  });
}

test("健康检查与旧版登记接口仍然可用", () => {
  assert.equal(JSON.parse(handle('{"action":"health"}')).status, "ok");
  const service = svc();
  const rec = call(service, { action: "register", recordId: "r-1", ownerId: "o-1" });
  assert.equal(rec.state, "draft");
  assert.equal(call(service, { action: "find", recordId: "r-1" }).ownerId, "o-1");
});

test("非法 JSON 与未知动作返回结构化错误", () => {
  const r1 = JSON.parse(handle("not json"));
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, "VALIDATION");
  const r2 = JSON.parse(handle('{"action":"nope"}'));
  assert.equal(r2.ok, false);
});

test("端到端：提交→史实复核→锁定→发布→经理查询采用版本", () => {
  const service = svc();
  setup(service);
  const submit = call(service, {
    action: "translation.submit", materialId: "SUB", by: "t1", source: "定稿",
    license: { holder: "A", expiresAt: "2026-12-31T00:00:00.000Z" },
    entries: [
      { segmentId: "seg1", translatedText: "A vineyard rose from the Gobi." },
      { segmentId: "seg2", translatedText: "Life has hope." },
    ],
  });
  assert.equal(submit.changeKind, "historical_fact");
  // 未复核直接锁定被拒
  const blocked = call(service, { action: "version.lock", versionId: submit.versionId, by: "u1" });
  assert.equal(blocked.error.code, "REVIEW_REQUIRED");
  call(service, { action: "version.review", versionId: submit.versionId, decision: "approve", by: "h1" });
  call(service, { action: "version.lock", versionId: submit.versionId, by: "u1" });

  call(service, {
    action: "performance.schedule", performanceId: "PF1", productionId: "P1", name: "晚场",
    startsAt: "2026-10-20T19:30:00.000Z", by: "s1",
  });
  const job = call(service, {
    action: "publish.start", performanceId: "PF1", by: "s1",
    targets: [{ materialId: "SUB", versionId: submit.versionId }],
  });
  assert.equal(job.status, "completed");

  const adopted = call(service, { action: "query.adopted", performanceId: "PF1" });
  assert.equal(adopted[0].adoptedVersionId, submit.versionId);
  assert.equal(adopted[0].entries[1].translatedText, "Life has hope.");
});

test("端到端：争议如何解决可被查询", () => {
  const service = svc();
  setup(service);
  const d = call(service, {
    action: "dispute.raise", productionId: "P1", subjectType: "segment", subjectId: "seg1",
    summary: "三处译法不一致", by: "t1",
  });
  call(service, {
    action: "dispute.resolve", disputeId: d.disputeId, by: "h1", historical: true,
    decision: "统一为 Gobi resettlement land",
  });
  const list = call(service, { action: "dispute.list", productionId: "P1" });
  assert.equal(list[0].status, "resolved");
  assert.equal(list[0].resolution.decision, "统一为 Gobi resettlement land");
  assert.equal(list[0].timeline.length, 2);
});

test("端到端：冻结期拒绝发布、紧急撤回并可查撤回记录", () => {
  const service = svc();
  setup(service);
  const submit = call(service, {
    action: "translation.submit", materialId: "SUB", by: "t1", source: "定稿",
    license: { holder: "A", expiresAt: "2026-12-31T00:00:00.000Z" },
    entries: [{ segmentId: "seg2", translatedText: "Life has hope." }],
  });
  call(service, { action: "version.lock", versionId: submit.versionId, by: "u1" });
  call(service, {
    action: "performance.schedule", performanceId: "PF1", productionId: "P1", name: "晚场",
    startsAt: "2026-10-20T19:30:00.000Z", by: "s1",
  });
  const published = call(service, {
    action: "publish.start", performanceId: "PF1", by: "s1",
    targets: [{ materialId: "SUB", versionId: submit.versionId }],
  });
  assert.equal(published.status, "completed");
  // 经理提前冻结场次：此后新版本不能上线
  call(service, { action: "performance.freeze", performanceId: "PF1", by: "s1" });
  const blocked = call(service, {
    action: "publish.start", performanceId: "PF1", by: "s1",
    targets: [{ materialId: "SUB", versionId: submit.versionId }],
  });
  assert.equal(blocked.error.code, "FROZEN");
  // 冻结窗口内允许紧急撤下字幕
  const withdrawn = call(service, {
    action: "publish.withdraw", performanceId: "PF1", materialIds: ["SUB"],
    reason: "开演前发现字幕授权争议", by: "s1",
  });
  assert.deepEqual(withdrawn.withdrawal.pulled.map((x) => x.materialId), ["SUB"]);
  assert.equal(
    call(service, { action: "query.adopted", performanceId: "PF1" })[0].adoptedVersionId,
    null,
  );
  const list = call(service, { action: "withdrawal.list", performanceId: "PF1" });
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, "开演前发现字幕授权争议");
});

test("端到端：回滚审计与授权失效预警接口", () => {
  const service = svc();
  setup(service);
  call(service, { action: "material.create", materialId: "TLK", productionId: "P1", type: "talk_script", title: "讲解" });

  const v1 = call(service, {
    action: "translation.submit", materialId: "SUB", by: "t1", source: "s",
    license: { holder: "A", expiresAt: "2026-12-31T00:00:00.000Z" },
    entries: [{ segmentId: "seg2", translatedText: "Life has hope." }],
  });
  call(service, { action: "version.lock", versionId: v1.versionId, by: "u1" });

  call(service, {
    action: "performance.schedule", performanceId: "PF1", productionId: "P1", name: "晚场",
    startsAt: "2026-10-20T19:30:00.000Z", by: "s1",
  });
  call(service, {
    action: "publish.start", performanceId: "PF1", by: "s1",
    targets: [{ materialId: "SUB", versionId: v1.versionId }],
  });
  // 短授权讲解稿钉版 → 预警
  const v2 = call(service, {
    action: "translation.submit", materialId: "TLK", by: "t1", source: "s",
    license: { holder: "临时", expiresAt: "2026-10-10T00:00:00.000Z" },
    entries: [{ segmentId: null, sourceText: "讲解", translatedText: "Talk" }],
  });
  call(service, { action: "version.lock", versionId: v2.versionId, by: "u1" });
  call(service, { action: "performance.pin", performanceId: "PF1", materialId: "TLK", versionId: v2.versionId, by: "s1" });
  const expiring = call(service, { action: "query.expiring_licenses", performanceId: "PF1" });
  assert.equal(expiring.length, 1);
  assert.equal(expiring[0].versionId, v2.versionId);

  const rb = call(service, { action: "publish.rollback", performanceId: "PF1", reason: "测试", by: "s1" });
  assert.deepEqual(rb.removed.map((x) => x.materialId), ["SUB"]);
  const audit = call(service, { action: "rollback.audit", performanceId: "PF1" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].removed[0].materialId, "SUB");
});
