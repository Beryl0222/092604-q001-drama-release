import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../src/api.js";
import { ManualClock } from "../src/clock.js";
import { Service } from "../src/service.js";

function setup() {
  const service = new Service({ clock: new ManualClock("2026-10-01T00:00:00.000Z") });
  return (body) => JSON.parse(handle(JSON.stringify(body), service));
}

test("JSON 边界完成一次发布并查询场次最终版本", () => {
  const call = setup();
  call({ action: "createDocument", documentId: "doc-sub", productionId: "minning", materialKind: "subtitle" });
  call({ action: "createSession", sessionId: "s-1", productionId: "minning", showtimeAt: "2026-10-07T20:00:00.000Z" });
  const submitted = call({
    action: "submitVersion",
    documentId: "doc-sub",
    versionId: "v-1",
    segments: [{ segmentId: "seg-1", sourceText: "尕娃，莫走", translatedText: "Little lad, don't go", sourceContext: "第一幕 村口" }],
    submittedBy: "translator-1",
    submissionId: "sub-1",
  });
  assert.equal(submitted.state, "draft");
  const replayed = call({
    action: "submitVersion",
    documentId: "doc-sub",
    versionId: "v-1",
    segments: [{ segmentId: "seg-1", sourceText: "尕娃，莫走", translatedText: "Little lad, don't go", sourceContext: "第一幕 村口" }],
    submittedBy: "translator-1",
    submissionId: "sub-1",
  });
  assert.equal(replayed.replayed, true);

  call({ action: "lockVersion", versionId: "v-1", by: "creator-1" });
  const job = call({ action: "publishVersion", versionId: "v-1", sessionIds: ["s-1"], jobId: "job-1", by: "manager-1" });
  assert.equal(job.state, "completed");

  const final = call({ action: "sessionFinal", sessionId: "s-1" });
  assert.equal(final.materials.subtitle.versionId, "v-1");
  assert.equal(final.materials.subtitle.segments[0].translatedText, "Little lad, don't go");
});

test("不支持的请求动作抛出错误", () => {
  const call = setup();
  assert.throws(() => call({ action: "nope" }), /不支持的请求动作/);
});
