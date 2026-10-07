/**
 * 处理进程内 JSON 请求。
 * 请求形如 {"action":"...", ...参数}，成功直接返回数据负载，
 * 领域错误返回 {"ok":false,"error":{"code","message","details"}}。
 */
import { Service } from "./service.js";
import { DomainError } from "./errors.js";

/** 动作分发表：每个处理器接收 (body, service)。 */
export function routes() {
  return {
    health: (_b, _t, s) => s.health(),

    // 兼容旧版基础登记
    register: (b, _t, s) => s.register(String(b.recordId), String(b.ownerId)),
    find: (b, _t, s) => s.find(String(b.recordId)),

    "member.register": (b, c) => c.registerMember(b.memberId, b.name, b.roles),

    "production.create": (b, c) => c.createProduction({ productionId: b.productionId, title: b.title, ownerMemberId: b.by }),

    "material.create": (b, c) => c.createMaterial({
      materialId: b.materialId || undefined,
      productionId: b.productionId, type: b.type, title: b.title, defaultLicense: b.defaultLicense || null,
    }),
    "material.list": (b, c) => c.listMaterials(b.productionId),

    "segment.register": (b, c) => c.registerSegment({
      segmentId: b.segmentId || undefined,
      materialId: b.materialId, sourceText: b.sourceText,
      context: b.context || {}, historical: !!b.historical,
    }),
    "segment.list": (b, c) => c.listSegments(b.materialId),

    "fact.add": (b, c) => c.addHistoricalFact({
      segmentIds: b.segmentIds || [], source: b.source, text: b.text, recordedBy: b.by,
    }),

    "term.propose": (b, c) => c.proposeTerm({
      productionId: b.productionId, materialId: b.materialId || null,
      sourceTerm: b.sourceTerm, alternatives: b.alternatives || [], raisedBy: b.by,
    }),
    "term.resolve": (b, c) => c.resolveTerm(b.termId, b.decision, b.by, { historical: !!b.historical }),
    "term.list": (b, c) => c.listTerms(b.productionId),

    "note.add": (b, c) => c.addCulturalNote({
      segmentId: b.segmentId || null, materialId: b.materialId || null, text: b.text, authorMemberId: b.by,
    }),
    "note.list": (b, c) => c.listCulturalNotes({ segmentId: b.segmentId || null, materialId: b.materialId || null }),

    "dispute.raise": (b, c) => c.raiseDispute({
      productionId: b.productionId, subjectType: b.subjectType, subjectId: b.subjectId,
      summary: b.summary, raisedBy: b.by, relatedVersionIds: b.relatedVersionIds || [],
    }),
    "dispute.resolve": (b, c) => c.resolveDispute(b.disputeId, {
      decision: b.decision, byMemberId: b.by,
      historical: !!b.historical, resultingVersionId: b.resultingVersionId || null,
    }),
    "dispute.list": (b, c) => c.listDisputes(b.productionId),

    "translation.submit": (b, c) => c.submitTranslation({
      materialId: b.materialId, submittedBy: b.by, source: b.source,
      entries: b.entries, audience: b.audience || [],
      license: b.license || null, declaredChange: b.declaredChange || null,
      parentVersionId: b.parentVersionId || null,
    }),

    "version.get": (b, c) => c.getVersion(b.versionId),
    "version.list": (b, c) => c.listVersions(b.materialId),
    "version.compare": (b, c) => c.compareVersions(b.fromVersionId, b.toVersionId),
    "version.review": (b, c) => c.reviewVersion(b.versionId, b.decision, b.by, b.comment || ""),
    "version.lock": (b, c) => c.lockVersion(b.versionId, b.by),
    "license.extend": (b, c) => c.extendLicense(b.versionId, b.license, b.by),

    "performance.schedule": (b, r) => r.schedulePerformance({
      performanceId: b.performanceId || undefined,
      productionId: b.productionId, name: b.name, startsAt: b.startsAt,
      freezeBeforeMs: b.freezeBeforeMs, byMemberId: b.by,
    }),
    "performance.list": (b, r) => r.listPerformances(b.productionId || null),
    "performance.freeze": (b, r) => r.freeze(b.performanceId, b.by),
    "performance.pin": (b, r) => r.pinForRehearsal(b.performanceId, b.materialId, b.versionId, b.by),
    "performance.pending_diffs": (b, r) => r.pendingDiffs(b.performanceId),

    "publish.start": (b, r) => r.startPublish(b.performanceId, b.targets, b.by),
    "job.get": (b, r) => r.getJob(b.jobId),
    "job.list": (b, r) => r.listJobs(b.performanceId || null),
    "job.recover": (_b, r) => r.recover(),
    "publish.withdraw": (b, r) => r.emergencyWithdraw(b.performanceId, b.materialIds || [], b.reason || "", b.by),
    "publish.rollback": (b, r) => r.rollback(b.performanceId, {
      toAdoptionJobId: b.toAdoptionJobId || null, reason: b.reason || "", byMemberId: b.by,
    }),
    "rollback.audit": (b, r) => r.rollbackAudit(b.performanceId),
    "withdrawal.list": (b, r) => r.withdrawals(b.performanceId),

    // 演出经理查询接口
    "query.adopted": (b, r) => r.adoptedMaterials(b.performanceId),
    "query.expiring_licenses": (b, r) => r.expiringLicenses(b.performanceId),
    "query.fact_impact": (b, r) => {
      const performances = b.productionId ? r.listPerformances(b.productionId) : r.listPerformances(null);
      return r.collab.historicalImpact(b.factId, performances);
    },
  };
}

export function handle(raw, service = new Service()) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return JSON.stringify({ ok: false, error: { code: "VALIDATION", message: "请求不是合法 JSON" } });
  }

  const table = routes();
  const handler = table[body.action];
  if (!handler) {
    return JSON.stringify({ ok: false, error: { code: "VALIDATION", message: `不支持的请求动作: ${body.action}` } });
  }

  // 协作类动作走 collab，场次/发布类动作走 release。
  const target = handler.length >= 2 && usesRelease(body.action) ? service.release : service.collab;
  try {
    const result = handler(body, target, service);
    return JSON.stringify(result);
  } catch (error) {
    if (error instanceof DomainError) {
      return JSON.stringify({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
    }
    return JSON.stringify({ ok: false, error: { code: "INTERNAL", message: error.message } });
  }
}

const RELEASE_ACTIONS = new Set([
  "performance.schedule", "performance.list", "performance.freeze", "performance.pin",
  "performance.pending_diffs", "publish.start", "job.get", "job.list", "job.recover",
  "publish.withdraw", "publish.rollback", "rollback.audit", "withdrawal.list",
  "query.adopted", "query.expiring_licenses", "query.fact_impact",
]);

function usesRelease(action) {
  return RELEASE_ACTIONS.has(action);
}
