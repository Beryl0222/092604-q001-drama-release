import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Service } from "../src/service.js";
import { JsonFilePersistence } from "../src/persistence.js";
import { SequentialIds } from "../src/ids.js";
import { buildWorld, entry, lockVersion, seedWorld, SHOWN_AT } from "./helpers.js";
import { MutableClock } from "./helpers.js";

test("状态持久化到文件，新进程可从快照恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drama-"));
  const file = path.join(dir, "state.json");
  const clock = new MutableClock();
  const svc1 = new Service({ clock, persistence: new JsonFilePersistence(file), ids: new SequentialIds("id") });
  seedWorld({ service: svc1, c: svc1.collab, r: svc1.release, clock });
  const res = lockVersion(svc1.collab, { materialId: "SUB", entries: [entry("seg2", "Life has hope.")] });

  // 模拟新进程：重新加载同一状态文件
  const svc2 = Service.withFile(file, { clock, ids: new SequentialIds("id") });
  assert.equal(svc2.collab.getMaterial("SUB").title, "舞台英文字幕");
  assert.equal(svc2.collab.getVersion(res.versionId).status, "locked");
  assert.equal(svc2.collab.actor("h1").roles[0], "history_advisor");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("发布任务在进程中断后，恢复时续跑未完成步骤", () => {
  const world = seedWorld(buildWorld());
  const { c, r } = world;
  const v1 = lockVersion(c, {
    materialId: "SUB",
    entries: [entry("seg1", "A vineyard rose from the Gobi."), entry("seg2", "Life has hope.")],
  });
  r.schedulePerformance({ performanceId: "PF1", productionId: "P1", name: "晚场", startsAt: SHOWN_AT, byMemberId: "s1" });

  // 模拟进程在发布中途被杀死：任务停在 running，前两步已落盘，后三步未执行。
  const job = {
    jobId: "job_interrupted",
    performanceId: "PF1",
    targets: [{ materialId: "SUB", versionId: v1.versionId }],
    requestedBy: "s1",
    status: "running",
    startedAt: c.now(), finishedAt: null, error: null,
    steps: [
      { name: "check_freeze", status: "done" },
      { name: "check_locked", status: "done" },
      { name: "check_licenses", status: "pending" },
      { name: "apply_adoption", status: "pending" },
      { name: "handoff", status: "pending" },
    ],
  };
  c.store.put("releaseJobs", job.jobId, job);
  c.persist();

  const outcome = r.recover();
  assert.equal(outcome.recoveredJobs[0].status, "completed");
  assert.equal(r.getJob("job_interrupted").steps.every((s) => s.status === "done"), true);
  // 采用已生效且只生效一次
  assert.equal(r.getPerformance("PF1").published.SUB, v1.versionId);
  assert.equal(r.getPerformance("PF1").adoptionLog.length, 1);
  // 恢复是幂等的：再次恢复不会重复采用
  r.recover();
  assert.equal(r.getPerformance("PF1").adoptionLog.length, 1);
});

test("原子快照文件始终是完整 JSON（无半写残留）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drama-"));
  const file = path.join(dir, "state.json");
  const p = new JsonFilePersistence(file);
  p.save({ version: 1, data: { x: [["k", { v: 1 }]] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).data.x[0][1], { v: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});
