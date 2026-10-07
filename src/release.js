/**
 * 场次发布流水线：
 * 排期与冻结窗口、排练钉版与差异暴露、可恢复的多步发布、
 * 临近开演紧急撤回、回滚及其撤下材料审计、授权到期预警。
 */
import { DomainError, ErrorCode } from "./errors.js";
import { requireRole, Role } from "./roles.js";
import { diffEntries } from "./policy.js";

const DEFAULT_FREEZE_BEFORE_MS = 24 * 60 * 60 * 1000;

export class Release {
  constructor(collab) {
    this.collab = collab;
    this.store = collab.store;
    for (const name of ["performances", "releaseJobs", "rollbacks", "withdrawals"]) {
      this.store.collection(name);
    }
  }

  get now() {
    return this.collab.now.bind(this.collab);
  }

  // ---------- 场次排期 ----------
  schedulePerformance({
    performanceId = this.collab.ids.next(), productionId, name, startsAt,
    freezeBeforeMs = DEFAULT_FREEZE_BEFORE_MS, byMemberId,
  }) {
    const actor = this.collab.actor(byMemberId);
    requireRole(actor, Role.STAGE_MANAGER);
    this.collab.getProduction(productionId);
    const start = Date.parse(startsAt);
    if (Number.isNaN(start)) throw new DomainError(ErrorCode.VALIDATION, "开演时间无效");
    if (this.store.has("performances", performanceId)) {
      throw new DomainError(ErrorCode.ALREADY_EXISTS, "场次已存在");
    }
    const performance = {
      performanceId, productionId, name,
      startsAt: new Date(start).toISOString(), freezeBeforeMs,
      status: "scheduled",
      pinned: {}, // 排练使用：materialId -> versionId
      published: {}, // 本场最终采用：materialId -> versionId
      pinEvents: [],
      adoptionLog: [],
      createdAt: this.now(),
    };
    this.store.put("performances", performanceId, performance);
    this.collab.audit(byMemberId, "performance.schedule", { performanceId, productionId }, { startsAt: performance.startsAt });
    this.collab.persist();
    return structuredClone(performance);
  }

  getPerformance(performanceId) {
    const p = this.store.get("performances", performanceId);
    if (!p) throw new DomainError(ErrorCode.NOT_FOUND, "场次不存在");
    return p;
  }

  listPerformances(productionId = null) {
    return this.store
      .list("performances", (p) => (productionId ? p.productionId === productionId : true))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  freezeAt(performance) {
    return new Date(Date.parse(performance.startsAt) - performance.freezeBeforeMs).toISOString();
  }

  isFrozen(performance, at = this.now()) {
    return performance.status === "frozen" || Date.parse(at) >= Date.parse(this.freezeAt(performance));
  }

  /** 手动提前冻结；到达冻结窗口后所有发布动作也会自动按冻结处理。 */
  freeze(performanceId, byMemberId) {
    const actor = this.collab.actor(byMemberId);
    requireRole(actor, Role.STAGE_MANAGER);
    const updated = this.store.update("performances", performanceId, (p) => {
      p.status = "frozen";
      return p;
    });
    this.collab.audit(byMemberId, "performance.freeze", { performanceId });
    this.collab.persist();
    return updated;
  }

  // ---------- 排练钉版 ----------
  /**
   * 为排练钉住某个已锁定版本。已在排练的旧版仍可继续使用；
   * 换版时保存与旧钉版的逐句差异，差异始终可查。
   */
  pinForRehearsal(performanceId, materialId, versionId, byMemberId) {
    const actor = this.collab.actor(byMemberId);
    requireRole(actor, Role.STAGE_MANAGER);
    const performance = this.getPerformance(performanceId);
    const version = this.collab.getVersion(versionId);
    if (version.materialId !== materialId) throw new DomainError(ErrorCode.VALIDATION, "版本与材料不匹配");
    if (version.status !== "locked") throw new DomainError(ErrorCode.CONFLICT, "排练只能钉住已锁定版本");

    const previousId = performance.pinned[materialId] || null;
    let diff = null;
    if (previousId && previousId !== versionId) {
      diff = diffEntries(this.collab.getVersion(previousId).entries, version.entries);
    }
    const updated = this.store.update("performances", performanceId, (p) => {
      p.pinned[materialId] = versionId;
      p.pinEvents.push({
        at: this.now(), materialId, versionId, previousVersionId: previousId,
        diff, by: byMemberId,
      });
      return p;
    });
    this.collab.audit(byMemberId, "performance.pin", { performanceId, materialId, versionId }, { previousVersionId: previousId });
    this.collab.persist();
    return { performance: updated, diff };
  }

  /** 已排练场次相对各材料最新锁定版的待处理差异（旧版可继续用，但差异必须暴露）。 */
  pendingDiffs(performanceId) {
    const performance = this.getPerformance(performanceId);
    const result = [];
    for (const [materialId, pinnedId] of Object.entries(performance.pinned)) {
      const latest = this.collab.latestLockedVersion(materialId);
      if (!latest || latest.versionId === pinnedId) continue;
      result.push({
        materialId,
        pinnedVersionId: pinnedId,
        latestVersionId: latest.versionId,
        latestRevisionNo: latest.revisionNo,
        diff: diffEntries(this.collab.getVersion(pinnedId).entries, latest.entries),
      });
    }
    return result;
  }

  // ---------- 可恢复的发布流水线 ----------
  /**
   * 发起一次发布：为多个材料指定本场采用的锁定版本。
   * 每个步骤完成后立即持久化；进程中断后用 resumeJob / resumeIncompleteJobs 续跑。
   */
  startPublish(performanceId, targets, byMemberId) {
    const actor = this.collab.actor(byMemberId);
    requireRole(actor, Role.STAGE_MANAGER);
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION, "发布至少包含一个材料目标");
    }
    const performance = this.getPerformance(performanceId);
    const normalized = targets.map((t) => {
      const version = this.collab.getVersion(t.versionId);
      if (version.materialId !== t.materialId) throw new DomainError(ErrorCode.VALIDATION, "版本与材料不匹配");
      return { materialId: t.materialId, versionId: t.versionId };
    });
    // 冻结窗口在发起时即拦截（紧急情况只能撤回，不能新版上线）。
    if (this.isFrozen(performance)) {
      throw new DomainError(ErrorCode.FROZEN, "场次已进入冻结窗口，不能发布新版本；如需处理请使用紧急撤回", {
        performanceId, freezeAt: this.freezeAt(performance), now: this.now(),
      });
    }

    const job = {
      jobId: this.collab.ids.next(),
      performanceId,
      targets: normalized,
      requestedBy: byMemberId,
      status: "running",
      startedAt: this.now(), finishedAt: null, error: null,
      steps: [
        { name: "check_freeze", status: "pending" },
        { name: "check_locked", status: "pending" },
        { name: "check_licenses", status: "pending" },
        { name: "apply_adoption", status: "pending" },
        { name: "handoff", status: "pending" },
      ],
    };
    this.store.put("releaseJobs", job.jobId, job);
    this.collab.audit(byMemberId, "publish.start", { jobId: job.jobId, performanceId }, { targetCount: normalized.length });
    this.collab.persist();
    const result = this.runJob(job.jobId);
    // 同步发起时，校验失败直接抛出（任务失败记录仍保留，可经 job.get 查询）；
    // 进程恢复路径走 recover()，按任务状态聚合，不受抛出影响。
    if (result.status === "failed") {
      throw new DomainError(result.error.code, result.error.message, result.error.details);
    }
    return result;
  }

  getJob(jobId) {
    const job = this.store.get("releaseJobs", jobId);
    if (!job) throw new DomainError(ErrorCode.NOT_FOUND, "发布任务不存在");
    return job;
  }

  listJobs(performanceId = null) {
    return this.store
      .list("releaseJobs", (j) => (performanceId ? j.performanceId === performanceId : true))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  resumeIncompleteJobs() {
    const pending = this.store.list("releaseJobs", (j) => j.status === "running");
    return pending.map((j) => this.runJob(j.jobId));
  }

  runJob(jobId) {
    const job = this.getJob(jobId);
    if (job.status !== "running") return job;

    const stepHandlers = {
      check_freeze: () => {
        const performance = this.getPerformance(job.performanceId);
        if (this.isFrozen(performance)) {
          throw new DomainError(ErrorCode.FROZEN, "发布执行时场次已进入冻结窗口", {
            freezeAt: this.freezeAt(performance), now: this.now(),
          });
        }
      },
      check_locked: () => {
        for (const t of job.targets) {
          const v = this.collab.getVersion(t.versionId);
          if (v.status !== "locked") {
            throw new DomainError(ErrorCode.REVIEW_REQUIRED, "只有已锁定版本可以发布", {
              materialId: t.materialId, versionId: t.versionId, status: v.status,
            });
          }
        }
      },
      check_licenses: () => {
        const performance = this.getPerformance(job.performanceId);
        for (const t of job.targets) {
          const v = this.collab.getVersion(t.versionId);
          const expires = Date.parse(v.license?.expiresAt);
          if (Number.isNaN(expires) || expires < Date.parse(performance.startsAt)) {
            throw new DomainError(ErrorCode.VALIDATION, "授权将在演出前失效，不能发布", {
              materialId: t.materialId, versionId: t.versionId,
              expiresAt: v.license?.expiresAt || null, startsAt: performance.startsAt,
            });
          }
        }
      },
      apply_adoption: () => {
        // 幂等：以同一 jobId 记录过的采用不重复落账。
        const performance = this.getPerformance(job.performanceId);
        const already = performance.adoptionLog.some((a) => a.jobId === jobId);
        if (already) return;
        const before = { ...performance.published };
        const after = { ...performance.published };
        const changes = [];
        for (const t of job.targets) {
          const from = before[t.materialId] || null;
          if (from !== t.versionId) changes.push({ materialId: t.materialId, fromVersionId: from, toVersionId: t.versionId });
          after[t.materialId] = t.versionId;
        }
        this.store.update("performances", job.performanceId, (p) => {
          p.published = after;
          p.adoptionLog.push({ jobId, at: this.now(), before, after, changes, by: job.requestedBy });
          return p;
        });
      },
      handoff: () => {
        // 模拟向字幕/导赏投放通道交接；真实环境中此处可换成外部投递。
        this.collab.audit(job.requestedBy, "publish.handoff", { jobId, performanceId: job.performanceId }, {
          targets: job.targets,
        });
      },
    };

    for (const step of job.steps) {
      if (step.status === "done") continue;
      try {
        stepHandlers[step.name]();
        step.status = "done";
        step.finishedAt = this.now();
        // 每完成一步立即落盘：中断后已完成步骤不会重跑。
        this.store.put("releaseJobs", jobId, job);
        this.collab.persist();
      } catch (error) {
        job.status = "failed";
        job.finishedAt = this.now();
        job.error = { code: error.code || "INTERNAL", message: error.message, details: error.details || {} };
        step.status = "failed";
        step.finishedAt = this.now();
        step.error = job.error;
        this.store.put("releaseJobs", jobId, job);
        this.collab.audit(job.requestedBy, "publish.fail", { jobId, performanceId: job.performanceId }, job.error);
        this.collab.persist();
        if (error instanceof DomainError) return structuredClone(job);
        throw error;
      }
    }

    job.status = "completed";
    job.finishedAt = this.now();
    this.store.put("releaseJobs", jobId, job);
    this.collab.audit(job.requestedBy, "publish.complete", { jobId, performanceId: job.performanceId });
    this.collab.persist();
    return structuredClone(job);
  }

  // ---------- 紧急撤回 ----------
  /**
   * 冻结窗口内允许的紧急操作：把材料从当场采用清单撤下。
   * materialIds 为空数组表示撤下本场全部材料。
   */
  emergencyWithdraw(performanceId, materialIds, reason, byMemberId) {
    const actor = this.collab.actor(byMemberId);
    requireRole(actor, Role.STAGE_MANAGER);
    const performance = this.getPerformance(performanceId);
    if (!this.isFrozen(performance)) {
      throw new DomainError(ErrorCode.CONFLICT, "紧急撤回仅用于冻结窗口内；非冻结期请使用回滚");
    }
    const targets = materialIds.length ? materialIds : Object.keys(performance.published);
    const pulled = [];
    for (const materialId of targets) {
      const versionId = performance.published[materialId];
      if (versionId) pulled.push({ materialId, versionId });
    }
    if (pulled.length === 0) throw new DomainError(ErrorCode.CONFLICT, "没有已发布材料可撤下");

    const withdrawalId = this.collab.ids.next();
    const updated = this.store.update("performances", performanceId, (p) => {
      for (const { materialId } of pulled) delete p.published[materialId];
      return p;
    });
    const withdrawal = {
      withdrawalId, performanceId, reason, by: byMemberId, at: this.now(),
      pulled, frozen: true,
    };
    this.store.put("withdrawals", withdrawalId, withdrawal);
    this.collab.audit(byMemberId, "publish.emergency_withdraw", { withdrawalId, performanceId }, { reason, pulled });
    this.collab.persist();
    return { performance: updated, withdrawal };
  }

  // ---------- 回滚 ----------
  /**
   * 回滚到上一次采用快照（或指定 adoption 记录的 before 快照）。
   * 返回并持久化本次实际撤下/替换的材料明细，可经 rollbackAudit 查询。
   */
  rollback(performanceId, { toAdoptionJobId = null, reason = "", byMemberId } = {}) {
    const actor = this.collab.actor(byMemberId);
    requireRole(actor, Role.STAGE_MANAGER);
    const performance = this.getPerformance(performanceId);
    if (performance.adoptionLog.length === 0) {
      throw new DomainError(ErrorCode.CONFLICT, "该场次没有可回滚的发布记录");
    }
    const entry = toAdoptionJobId
      ? performance.adoptionLog.find((a) => a.jobId === toAdoptionJobId)
      : performance.adoptionLog[performance.adoptionLog.length - 1];
    if (!entry) throw new DomainError(ErrorCode.NOT_FOUND, "指定的发布记录不存在");

    const current = { ...performance.published };
    const restored = { ...entry.before };
    const removed = [];
    const reverted = [];
    for (const [materialId, versionId] of Object.entries(current)) {
      if (!(materialId in restored)) {
        removed.push({ materialId, versionId });
      } else if (restored[materialId] !== versionId) {
        reverted.push({ materialId, fromVersionId: versionId, toVersionId: restored[materialId] });
      }
    }

    const rollbackId = this.collab.ids.next();
    this.store.update("performances", performanceId, (p) => {
      p.published = restored;
      return p;
    });
    const rollback = {
      rollbackId, performanceId, at: this.now(), by: byMemberId, reason,
      fromAdoptionJobId: entry.jobId, removed, reverted, restored,
    };
    this.store.put("rollbacks", rollbackId, rollback);
    this.collab.audit(byMemberId, "publish.rollback", { rollbackId, performanceId }, { removed, reverted });
    this.collab.persist();
    return rollback;
  }

  rollbackAudit(performanceId) {
    this.getPerformance(performanceId);
    return this.store
      .list("rollbacks", (r) => r.performanceId === performanceId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  withdrawals(performanceId) {
    this.getPerformance(performanceId);
    return this.store
      .list("withdrawals", (w) => w.performanceId === performanceId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  // ---------- 演出经理查询 ----------
  /** 某场次最终采用的字幕、节目册导赏、团体讲解版本。 */
  adoptedMaterials(performanceId) {
    const performance = this.getPerformance(performanceId);
    const materials = this.collab.listMaterials(performance.productionId);
    return materials.map((m) => {
      const versionId = performance.published[m.materialId] || null;
      const pinnedVersionId = performance.pinned[m.materialId] || null;
      const version = versionId ? this.collab.getVersion(versionId) : null;
      return {
        materialId: m.materialId, type: m.type, title: m.title,
        adoptedVersionId: versionId,
        pinnedVersionId: pinnedVersionId,
        revisionNo: version ? version.revisionNo : null,
        status: version ? version.status : "not_published",
        license: version ? version.license : null,
        entries: version ? version.entries : [],
      };
    });
  }

  /** 某场采用/排练版本中，将在开演前失效的授权。 */
  expiringLicenses(performanceId) {
    const performance = this.getPerformance(performanceId);
    const refs = new Map();
    for (const [materialId, versionId] of Object.entries({ ...performance.pinned, ...performance.published })) {
      refs.set(versionId, new Set([...(refs.get(versionId) || []), materialId]));
    }
    const findings = [];
    for (const [versionId, materialIds] of refs) {
      const v = this.collab.getVersion(versionId);
      if (!v.license || !v.license.expiresAt) {
        findings.push({ versionId, materialIds: [...materialIds], expiresAt: null, expired: true, missing: true });
        continue;
      }
      if (Date.parse(v.license.expiresAt) <= Date.parse(performance.startsAt)) {
        findings.push({
          versionId, materialIds: [...materialIds], expiresAt: v.license.expiresAt,
          expired: Date.parse(v.license.expiresAt) <= Date.parse(this.now()),
          missing: false,
        });
      }
    }
    return findings;
  }

  /** 进程中断后恢复：续跑未完成的发布步骤，返回恢复结果。 */
  recover() {
    const jobs = this.resumeIncompleteJobs();
    return { recoveredJobs: jobs.map((j) => ({ jobId: j.jobId, status: j.status, error: j.error })) };
  }
}
