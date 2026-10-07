/** 国际剧目译本发布的应用服务：版本、审核、发布、撤回、回滚与查询。 */
import { Clock } from "./clock.js";
import {
  MATERIAL_KINDS,
  ROLE_HISTORIAN,
  ROLE_LABELS,
  contentHashOf,
  diffSegments,
  hashOf,
  nextId,
  normalizeSegment,
} from "./model.js";
import { Store } from "./store.js";

const DEFAULT_FREEZE_MINUTES = 120;
const PUBLISH_STEPS = ["validate_version", "check_freeze", "mark_published", "bind_sessions", "record_event"];

export class Service {
  /**
   * @param {Store} store 存储；传入带 path 的 Store 可跨进程恢复。
   * @param {Clock} clock 业务时钟。
   * @param {Function} stepHook 发布步骤前钩子，测试可用它模拟进程中断。
   */
  constructor({ store = new Store(), clock = new Clock(), stepHook = null } = {}) {
    this.store = store;
    this.clock = clock;
    this.stepHook = stepHook;
    // 进程重启后恢复尚未完成的发布步骤。
    this.recover();
  }

  health() {
    return { service: "drama_release", status: "ok" };
  }

  register(recordId, ownerId) {
    const record = { recordId, ownerId, state: "draft", revision: 1, createdAt: this.clock.now() };
    this.store.add(record);
    return structuredClone(record);
  }

  find(recordId) {
    return this.store.get(recordId);
  }

  // ---- 场次 ----

  createSession({ sessionId, productionId = "default", showtimeAt, freezeBeforeMinutes = DEFAULT_FREEZE_MINUTES }) {
    if (!sessionId) throw new Error("场次缺少 sessionId");
    if (!showtimeAt) throw new Error("场次缺少开演时间");
    if (this.store.has("sessions", sessionId)) throw new Error("场次已存在");
    const session = {
      sessionId,
      productionId,
      showtimeAt: new Date(showtimeAt).toISOString(),
      freezeBeforeMinutes,
      status: "scheduled",
      manuallyFrozen: false,
      bindings: {},
      updatesAvailable: [],
      createdAt: this.clock.now(),
    };
    this.store.put("sessions", sessionId, session);
    this.#event("session.created", null, { sessionId });
    return structuredClone(session);
  }

  updateSessionStatus(sessionId, status, by = null) {
    const session = this.#mustSession(sessionId);
    const allowed = ["scheduled", "rehearsed", "performed", "cancelled"];
    if (!allowed.includes(status)) throw new Error("不支持的场次状态");
    session.status = status;
    this.store.put("sessions", sessionId, session);
    this.#event("session.status", by, { sessionId, status });
    return structuredClone(session);
  }

  freezeSession(sessionId, by = null) {
    const session = this.#mustSession(sessionId);
    session.manuallyFrozen = true;
    this.store.put("sessions", sessionId, session);
    this.#event("session.frozen", by, { sessionId });
    return structuredClone(session);
  }

  unfreezeSession(sessionId, by = null) {
    const session = this.#mustSession(sessionId);
    session.manuallyFrozen = false;
    this.store.put("sessions", sessionId, session);
    this.#event("session.unfrozen", by, { sessionId });
    return structuredClone(session);
  }

  /** 临近开演（冻结窗口内）或被人工冻结的场次视为已冻结。 */
  isSessionFrozen(sessionOrId) {
    const session = typeof sessionOrId === "string" ? this.#mustSession(sessionOrId) : sessionOrId;
    if (session.manuallyFrozen) return true;
    if (["performed", "cancelled"].includes(session.status)) return false;
    const freezeAt = new Date(session.showtimeAt).getTime() - session.freezeBeforeMinutes * 60000;
    return new Date(this.clock.now()).getTime() >= freezeAt;
  }

  sessionInfo(sessionId) {
    return this.#mustSession(sessionId);
  }

  // ---- 文档（某剧目某类物料的译本系列） ----

  createDocument({ documentId, productionId = "default", materialKind, title = "" }) {
    if (!documentId) throw new Error("文档缺少 documentId");
    if (!MATERIAL_KINDS.includes(materialKind)) throw new Error("不支持的物料类型");
    if (this.store.has("documents", documentId)) throw new Error("文档已存在");
    const document = { documentId, productionId, materialKind, title, createdAt: this.clock.now() };
    this.store.put("documents", documentId, document);
    return structuredClone(document);
  }

  // ---- 译本版本 ----

  /**
   * 提交译本版本（草稿）。
   * - 修订只能从已锁定版本派生（baseVersionId 指向已锁定版本）；
   * - submissionId 保证同一译稿重复提交幂等；
   * - 内容相同但来源不同的提交合并到既有版本；
   * - 涉及历史事实的改动标记 requiresReview，需史实顾问复核。
   */
  submitVersion({ documentId, versionId, baseVersionId = null, segments = [], submittedBy, source = null, submissionId = null }) {
    if (!documentId) throw new Error("译本缺少 documentId");
    const document = this.store.getById("documents", documentId);
    if (!document) throw new Error("文档不存在");
    if (!submittedBy) throw new Error("译本缺少提交人");
    if (!Array.isArray(segments) || segments.length === 0) throw new Error("译本至少包含一条台词片段");
    const normalized = segments.map(normalizeSegment);
    if (new Set(normalized.map((s) => s.segmentId)).size !== normalized.length) {
      throw new Error("台词片段编号重复");
    }

    const requestHash = hashOf({ documentId, versionId: versionId ?? null, baseVersionId, segments: normalized, submittedBy, source });
    if (submissionId) {
      const seen = this.store.getById("submissions", submissionId);
      if (seen) {
        if (seen.requestHash !== requestHash) throw new Error("提交编号已被其他内容使用");
        return { ...seen.result, replayed: true };
      }
    }

    const existing = this.store.find("versions", (v) => v.documentId === documentId);
    const contentHash = contentHashOf({ productionId: document.productionId, materialKind: document.materialKind, segments: normalized });
    const sourceEntry = { submittedBy, origin: source, submissionId, at: this.clock.now() };

    // 内容相同：同一来源视为重复提交，不同来源合并到既有版本；均不产生新修订。
    const sameContent = existing.find((v) => v.contentHash === contentHash && v.state !== "withdrawn");
    if (sameContent) {
      const knownSource = sameContent.sources.some((s) => s.submittedBy === submittedBy && s.origin === source);
      sameContent.sources.push(sourceEntry);
      this.store.put("versions", sameContent.versionId, sameContent);
      const result = knownSource
        ? { versionId: sameContent.versionId, state: sameContent.state, duplicate: true, merged: false }
        : { versionId: sameContent.versionId, state: sameContent.state, duplicate: false, merged: true };
      if (submissionId) this.store.put("submissions", submissionId, { requestHash, result });
      this.#event(knownSource ? "version.duplicate" : "version.merged", submittedBy, { versionId: sameContent.versionId, documentId });
      return result;
    }

    // 派生规则：修订只能从已锁定版本派生。
    let base = null;
    if (baseVersionId) {
      base = this.store.getById("versions", baseVersionId);
      if (!base) throw new Error("基础版本不存在");
      if (base.documentId !== documentId) throw new Error("基础版本属于其他文档");
      if (!base.lockedAt) throw new Error("修订只能从已锁定版本派生");
      if (base.state === "withdrawn") throw new Error("不能从已撤回版本派生");
    } else if (existing.some((v) => v.state !== "withdrawn")) {
      throw new Error("已有版本的文档必须指定已锁定的基础版本");
    }
    if (versionId && this.store.has("versions", versionId)) throw new Error("版本编号已存在");

    const vid = versionId ?? nextId("ver");
    const requiresReview = this.#touchesHistorical(base, normalized) ? [ROLE_HISTORIAN] : [];
    const version = {
      versionId: vid,
      documentId,
      productionId: document.productionId,
      materialKind: document.materialKind,
      baseVersionId: base?.versionId ?? null,
      state: "draft",
      segments: normalized,
      contentHash,
      sources: [sourceEntry],
      requiresReview,
      reviews: [],
      createdAt: this.clock.now(),
      lockedAt: null,
      publishedAt: null,
    };
    this.store.put("versions", vid, version);
    const result = { versionId: vid, state: "draft", requiresReview, duplicate: false, merged: false };
    if (submissionId) this.store.put("submissions", submissionId, { requestHash, result });
    this.#event("version.submitted", submittedBy, { versionId: vid, documentId, baseVersionId: base?.versionId ?? null });
    return result;
  }

  /** 相对基础版本是否触及历史事实片段。 */
  #touchesHistorical(base, segments) {
    if (!base) return segments.some((s) => s.historical);
    const diff = diffSegments(base.segments, segments);
    if (diff.added.some((s) => s.historical)) return true;
    if (diff.removed.some((s) => s.historical)) return true;
    return diff.changed.some((c) => c.before.historical || c.after.historical);
  }

  /** 指定角色复核；同一角色以最新结论为准。 */
  submitReview({ versionId, reviewerId, role, decision, note = "" }) {
    const version = this.#mustVersion(versionId);
    if (!version.requiresReview.includes(role)) throw new Error("该版本不需要此角色复核");
    if (!["approved", "rejected"].includes(decision)) throw new Error("复核结论必须是 approved 或 rejected");
    if (version.state !== "draft") throw new Error("只有草稿版本可以复核");
    version.reviews = version.reviews.filter((r) => r.role !== role);
    version.reviews.push({ role, reviewerId, decision, note, at: this.clock.now() });
    this.store.put("versions", versionId, version);
    this.#event("version.reviewed", reviewerId, { versionId, role, decision });
    return structuredClone(version.reviews.at(-1));
  }

  /** 锁定版本：需通过所需复核，且无未解决的阻断性争议。 */
  lockVersion(versionId, by = null) {
    const version = this.#mustVersion(versionId);
    if (version.state !== "draft") throw new Error("只有草稿版本可以锁定");
    this.#assertReviewed(version);
    const blocking = this.store.find("disputes", (d) => d.versionId === versionId && d.blocking && d.state === "open");
    if (blocking.length > 0) throw new Error("存在未解决的阻断性争议，不能锁定");
    version.state = "locked";
    version.lockedAt = this.clock.now();
    this.store.put("versions", versionId, version);
    this.#event("version.locked", by, { versionId });
    const { violations } = this.termConsistency(versionId);
    return { ...structuredClone(version), termViolations: violations };
  }

  #assertReviewed(version) {
    for (const role of version.requiresReview) {
      const review = version.reviews.find((r) => r.role === role);
      if (!review || review.decision !== "approved") {
        throw new Error(`涉及历史事实的改动需要${ROLE_LABELS[role] ?? role}复核通过`);
      }
    }
  }

  versionInfo(versionId) {
    return this.#mustVersion(versionId);
  }

  // ---- 术语决议 ----

  proposeTerm({ termId, sourcePhrase, decidedTranslation, rationale = "", by = null }) {
    if (!sourcePhrase || !decidedTranslation) throw new Error("术语决议缺少原文或译法");
    const tid = termId ?? nextId("term");
    if (this.store.has("terms", tid)) throw new Error("术语编号已存在");
    const term = {
      termId: tid,
      sourcePhrase,
      decidedTranslation,
      rationale,
      state: "proposed",
      proposedBy: by,
      createdAt: this.clock.now(),
      ratifiedAt: null,
      ratifiedBy: null,
    };
    this.store.put("terms", tid, term);
    this.#event("term.proposed", by, { termId: tid });
    return structuredClone(term);
  }

  ratifyTerm(termId, by = null) {
    const term = this.store.getById("terms", termId);
    if (!term) throw new Error("术语决议不存在");
    if (term.state === "ratified") return term;
    term.state = "ratified";
    term.ratifiedAt = this.clock.now();
    term.ratifiedBy = by;
    this.store.put("terms", termId, term);
    this.#event("term.ratified", by, { termId });
    return structuredClone(term);
  }

  /** 检查版本译文与已批准术语决议的一致性（显式关联 + 原文包含）。 */
  termConsistency(versionId) {
    const version = this.#mustVersion(versionId);
    const ratified = this.store.find("terms", (t) => t.state === "ratified");
    const violations = [];
    for (const seg of version.segments) {
      const translated = seg.translatedText.toLowerCase();
      for (const term of ratified) {
        const declared = seg.termRefs.includes(term.termId);
        const mentioned = seg.sourceText.includes(term.sourcePhrase);
        if ((declared || mentioned) && !translated.includes(term.decidedTranslation.toLowerCase())) {
          violations.push({
            segmentId: seg.segmentId,
            termId: term.termId,
            sourcePhrase: term.sourcePhrase,
            expected: term.decidedTranslation,
            actual: seg.translatedText,
            via: declared ? "ref" : "text",
          });
        }
      }
    }
    return { versionId, violations };
  }

  // ---- 争议 ----

  openDispute({ disputeId, versionId, segmentId = null, issue, by = null, blocking = false }) {
    const version = this.#mustVersion(versionId);
    if (!issue) throw new Error("争议缺少问题描述");
    if (segmentId && !version.segments.some((s) => s.segmentId === segmentId)) throw new Error("争议指向的台词片段不存在");
    const did = disputeId ?? nextId("dis");
    if (this.store.has("disputes", did)) throw new Error("争议编号已存在");
    const dispute = {
      disputeId: did,
      versionId,
      segmentId,
      issue,
      blocking: Boolean(blocking),
      state: "open",
      raisedBy: by,
      raisedAt: this.clock.now(),
      resolution: null,
    };
    this.store.put("disputes", did, dispute);
    this.#event("dispute.opened", by, { disputeId: did, versionId });
    return structuredClone(dispute);
  }

  resolveDispute({ disputeId, decision, rationale = "", by = null }) {
    const dispute = this.store.getById("disputes", disputeId);
    if (!dispute) throw new Error("争议不存在");
    if (dispute.state === "resolved") return dispute;
    if (!decision) throw new Error("争议解决缺少结论");
    dispute.state = "resolved";
    dispute.resolution = { decision, rationale, by, at: this.clock.now() };
    this.store.put("disputes", disputeId, dispute);
    this.#event("dispute.resolved", by, { disputeId, decision });
    return structuredClone(dispute);
  }

  /** 每条争议及其解决方式；可按版本或场次（当前绑定版本）查询。 */
  disputesFor({ versionId = null, sessionId = null } = {}) {
    let versionIds = null;
    if (sessionId) {
      const session = this.#mustSession(sessionId);
      versionIds = new Set(Object.values(session.bindings).map((b) => b.versionId));
    }
    return this.store.find("disputes", (d) => {
      if (versionId && d.versionId !== versionId) return false;
      if (versionIds && !versionIds.has(d.versionId)) return false;
      return true;
    });
  }

  // ---- 发布（分步、可恢复） ----

  publishVersion({ versionId, sessionIds = [], by = null, jobId = null }) {
    this.#mustVersion(versionId);
    const jid = jobId ?? nextId("job");
    if (this.store.has("jobs", jid)) throw new Error("发布任务编号已存在");
    const job = {
      jobId: jid,
      type: "publish",
      versionId,
      sessionIds: [...sessionIds],
      by,
      state: "running",
      steps: PUBLISH_STEPS.map((name) => ({ name, status: "pending", at: null })),
      createdAt: this.clock.now(),
      completedAt: null,
      error: null,
    };
    this.store.put("jobs", jid, job);
    return this.#runJob(jid);
  }

  /** 恢复进程中断时未完成的发布任务；构造时自动调用。 */
  recover() {
    const resumed = [];
    for (const job of this.store.find("jobs", (j) => j.state === "running" || j.state === "interrupted")) {
      job.state = "running";
      job.error = null;
      for (const step of job.steps) if (step.status === "failed") step.status = "pending";
      this.store.put("jobs", job.jobId, job);
      try {
        resumed.push(this.#runJob(job.jobId));
      } catch {
        // 恢复失败：任务保持中断状态并记录错误，等待人工处理后再次恢复。
      }
    }
    return resumed;
  }

  #runJob(jobId) {
    const job = this.store.getById("jobs", jobId);
    for (const step of job.steps) {
      if (step.status === "done") continue;
      try {
        if (this.stepHook) this.stepHook(step.name, structuredClone(job));
        this.#runPublishStep(job, step.name);
        step.status = "done";
        step.at = this.clock.now();
      } catch (error) {
        step.status = "failed";
        job.state = "interrupted";
        job.error = String(error?.message ?? error);
        this.store.put("jobs", jobId, job);
        throw error;
      }
      // 每完成一步立即落盘，进程中断后可从断点继续。
      this.store.put("jobs", jobId, job);
    }
    job.state = "completed";
    job.completedAt = this.clock.now();
    this.store.put("jobs", jobId, job);
    return structuredClone(job);
  }

  #runPublishStep(job, name) {
    if (name === "validate_version") {
      const version = this.#mustVersion(job.versionId);
      if (version.state === "published") return;
      if (version.state !== "locked") throw new Error("只有已锁定版本可以发布");
      this.#assertReviewed(version);
      const blocking = this.store.find("disputes", (d) => d.versionId === version.versionId && d.blocking && d.state === "open");
      if (blocking.length > 0) throw new Error("存在未解决的阻断性争议，不能发布");
    } else if (name === "check_freeze") {
      const frozen = job.sessionIds.filter((id) => this.isSessionFrozen(id));
      if (frozen.length > 0) throw new Error(`场次已冻结，不能发布: ${frozen.join(", ")}`);
    } else if (name === "mark_published") {
      const version = this.#mustVersion(job.versionId);
      if (version.state === "published") return;
      for (const other of this.store.find("versions", (v) => v.documentId === version.documentId && v.state === "published" && v.versionId !== version.versionId)) {
        other.state = "superseded";
        this.store.put("versions", other.versionId, other);
      }
      version.state = "published";
      version.publishedAt = this.clock.now();
      this.store.put("versions", version.versionId, version);
    } else if (name === "bind_sessions") {
      const version = this.#mustVersion(job.versionId);
      for (const sessionId of job.sessionIds) {
        const session = this.#mustSession(sessionId);
        const kind = version.materialKind;
        const current = session.bindings[kind];
        if (current?.versionId === version.versionId) continue;
        if (current && session.status === "rehearsed") {
          // 已排练场次继续使用旧版，仅登记可用更新，差异通过查询暴露。
          if (!session.updatesAvailable.some((u) => u.materialKind === kind && u.versionId === version.versionId)) {
            session.updatesAvailable.push({ materialKind: kind, versionId: version.versionId, publishedAt: version.publishedAt });
          }
        } else {
          session.bindings[kind] = { versionId: version.versionId, boundAt: this.clock.now() };
          session.updatesAvailable = session.updatesAvailable.filter((u) => u.materialKind !== kind);
        }
        this.store.put("sessions", sessionId, session);
      }
    } else if (name === "record_event") {
      const recorded = this.store.listEvents().some((e) => e.type === "version.published" && e.details?.jobId === job.jobId);
      if (!recorded) this.#event("version.published", job.by, { versionId: job.versionId, sessionIds: job.sessionIds, jobId: job.jobId });
    } else {
      throw new Error(`未知发布步骤: ${name}`);
    }
  }

  jobInfo(jobId) {
    const job = this.store.getById("jobs", jobId);
    if (!job) throw new Error("发布任务不存在");
    return job;
  }

  // ---- 紧急撤回与回滚 ----

  /** 紧急撤回：冻结中也可执行；绑定场次回退到最近可用的已发布版本。 */
  withdrawVersion({ versionId, reason, by = null }) {
    const version = this.#mustVersion(versionId);
    if (version.state === "withdrawn") return { versionId, state: "withdrawn", affectedSessions: [], already: true };
    if (!reason) throw new Error("紧急撤回必须说明原因");
    const wasPublished = version.state === "published";
    const wasLive = wasPublished || version.state === "superseded";
    version.state = "withdrawn";
    version.withdrawnAt = this.clock.now();
    version.withdrawReason = reason;
    this.store.put("versions", versionId, version);

    const affectedSessions = [];
    if (wasLive) {
      const fallback = this.#latestUsableVersion(version.documentId, versionId);
      // 撤回的是当前发布版本时，回退版本恢复为已发布状态，保证场次始终有有效版本可用。
      if (wasPublished && fallback && fallback.state === "superseded") {
        fallback.state = "published";
        this.store.put("versions", fallback.versionId, fallback);
      }
      const bound = this.store.find("sessions", (s) => Object.values(s.bindings).some((b) => b.versionId === versionId));
      for (const session of bound) {
        const kind = version.materialKind;
        if (fallback) {
          session.bindings[kind] = { versionId: fallback.versionId, boundAt: this.clock.now(), fallbackFrom: versionId };
        } else {
          delete session.bindings[kind];
        }
        session.updatesAvailable = session.updatesAvailable.filter((u) => u.versionId !== versionId);
        this.store.put("sessions", session.sessionId, session);
        affectedSessions.push({ sessionId: session.sessionId, materialKind: kind, toVersionId: fallback?.versionId ?? null });
      }
    }
    this.#event("version.withdrawn", by, { versionId, reason, affectedSessions });
    return { versionId, state: "withdrawn", affectedSessions };
  }

  #latestUsableVersion(documentId, excludeVersionId) {
    const candidates = this.store
      .find("versions", (v) => v.documentId === documentId && v.versionId !== excludeVersionId && (v.state === "published" || v.state === "superseded"))
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    return candidates[0] ?? null;
  }

  /** 显式换绑（采纳更新）；冻结场次不可换绑。 */
  rebindSession({ sessionId, materialKind, versionId, by = null }) {
    const session = this.#mustSession(sessionId);
    if (this.isSessionFrozen(session)) throw new Error("场次已冻结，不能换绑");
    const version = this.#mustVersion(versionId);
    if (version.materialKind !== materialKind) throw new Error("版本物料类型不匹配");
    if (version.state !== "published") throw new Error("只能绑定已发布版本");
    session.bindings[materialKind] = { versionId, boundAt: this.clock.now() };
    session.updatesAvailable = session.updatesAvailable.filter((u) => u.materialKind !== materialKind);
    this.store.put("sessions", sessionId, session);
    this.#event("session.rebound", by, { sessionId, materialKind, versionId });
    return structuredClone(session);
  }

  /** 回滚场次绑定，并记录实际撤下的材料。 */
  rollbackSession({ sessionId, materialKind, toVersionId, by = null, emergency = false, rollbackId = null }) {
    const session = this.#mustSession(sessionId);
    if (!MATERIAL_KINDS.includes(materialKind)) throw new Error("不支持的物料类型");
    if (this.isSessionFrozen(session) && !emergency) throw new Error("场次已冻结，回滚需要 emergency 标记");
    const current = session.bindings[materialKind];
    if (!current) throw new Error("场次当前没有绑定该物料的版本");
    if (current.versionId === toVersionId) throw new Error("场次已经绑定目标版本");
    const target = this.#mustVersion(toVersionId);
    if (target.materialKind !== materialKind) throw new Error("目标版本物料类型不匹配");
    if (!["published", "superseded"].includes(target.state)) throw new Error("只能回滚到已发布过的版本");
    const from = this.#mustVersion(current.versionId);
    const diff = diffSegments(target.segments, from.segments);
    // 撤下的材料：当前生效版本中有、而回滚目标中没有或内容不同的片段。
    const withdrawnMaterials = {
      removed: diff.added,
      replaced: diff.changed.map((c) => ({ segmentId: c.segmentId, fields: c.fields, withdrawn: c.after, restored: c.before })),
    };
    session.bindings[materialKind] = { versionId: toVersionId, boundAt: this.clock.now(), rollbackFrom: current.versionId };
    session.updatesAvailable = session.updatesAvailable.filter((u) => u.materialKind !== materialKind);
    this.store.put("sessions", sessionId, session);
    const rid = rollbackId ?? nextId("rb");
    const record = {
      rollbackId: rid,
      sessionId,
      materialKind,
      fromVersionId: current.versionId,
      toVersionId,
      withdrawnMaterials,
      emergency: Boolean(emergency),
      by,
      at: this.clock.now(),
    };
    this.store.put("rollbacks", rid, record);
    this.#event("session.rolledBack", by, { rollbackId: rid, sessionId, materialKind, fromVersionId: current.versionId, toVersionId });
    return structuredClone(record);
  }

  rollbackDetails(rollbackId) {
    const record = this.store.getById("rollbacks", rollbackId);
    if (!record) throw new Error("回滚记录不存在");
    return record;
  }

  // ---- 演出经理查询 ----

  /** 场次最终采用的字幕、导赏与口述版本；可按受众过滤片段与文化注释。 */
  sessionFinal(sessionId, { audience = null } = {}) {
    const session = this.#mustSession(sessionId);
    const materials = {};
    for (const kind of MATERIAL_KINDS) {
      const binding = session.bindings[kind];
      if (!binding) {
        materials[kind] = null;
        continue;
      }
      const version = this.#mustVersion(binding.versionId);
      materials[kind] = {
        versionId: version.versionId,
        state: version.state,
        boundAt: binding.boundAt,
        segments: this.#filterSegments(version.segments, audience),
      };
    }
    return {
      sessionId,
      showtimeAt: session.showtimeAt,
      status: session.status,
      frozen: this.isSessionFrozen(session),
      materials,
      updatesAvailable: structuredClone(session.updatesAvailable),
    };
  }

  #filterSegments(segments, audience) {
    const list = audience ? segments.filter((s) => s.audiences.length === 0 || s.audiences.includes(audience)) : segments;
    return list.map((s) => {
      const seg = structuredClone(s);
      if (audience) seg.culturalNotes = seg.culturalNotes.filter((n) => !n.audience || n.audience === audience);
      return seg;
    });
  }

  /** 场次绑定版本与最新已发布版本的差异（已排练场次继续使用旧版时由此暴露差异）。 */
  sessionDiff(sessionId, materialKind = null) {
    const session = this.#mustSession(sessionId);
    const kinds = materialKind ? [materialKind] : MATERIAL_KINDS;
    const result = {};
    for (const kind of kinds) {
      const binding = session.bindings[kind];
      const bound = binding ? this.#mustVersion(binding.versionId) : null;
      const latest = this.store
        .find("versions", (v) =>
          v.state === "published" &&
          (bound ? v.documentId === bound.documentId : v.materialKind === kind && v.productionId === session.productionId))
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))[0] ?? null;
      if (!bound || !latest || bound.versionId === latest.versionId) {
        result[kind] = {
          boundVersionId: bound?.versionId ?? null,
          latestPublishedVersionId: latest?.versionId ?? null,
          upToDate: Boolean(bound && latest && bound.versionId === latest.versionId),
          diff: null,
        };
        continue;
      }
      result[kind] = {
        boundVersionId: bound.versionId,
        latestPublishedVersionId: latest.versionId,
        upToDate: false,
        diff: diffSegments(bound.segments, latest.segments),
      };
    }
    return materialKind ? result[materialKind] : result;
  }

  /** 演出前将失效的授权（含已过期标记）。 */
  expiringLicenses(sessionId) {
    const session = this.#mustSession(sessionId);
    const showtime = new Date(session.showtimeAt).getTime();
    const now = new Date(this.clock.now()).getTime();
    const expiring = [];
    for (const [kind, binding] of Object.entries(session.bindings)) {
      const version = this.#mustVersion(binding.versionId);
      for (const seg of version.segments) {
        if (!seg.license?.expiresAt) continue;
        const expires = new Date(seg.license.expiresAt).getTime();
        if (expires <= showtime) {
          expiring.push({
            materialKind: kind,
            versionId: version.versionId,
            segmentId: seg.segmentId,
            holder: seg.license.holder,
            expiresAt: seg.license.expiresAt,
            expiredAlready: expires <= now,
          });
        }
      }
    }
    return { sessionId, showtimeAt: session.showtimeAt, expiring };
  }

  listEvents() {
    return this.store.listEvents();
  }

  // ---- 内部工具 ----

  #mustSession(sessionId) {
    const session = this.store.getById("sessions", sessionId);
    if (!session) throw new Error("场次不存在");
    return session;
  }

  #mustVersion(versionId) {
    const version = this.store.getById("versions", versionId);
    if (!version) throw new Error("版本不存在");
    return version;
  }

  #event(type, by, details) {
    this.store.appendEvent({ eventId: nextId("evt"), type, by: by ?? null, at: this.clock.now(), details });
  }
}
