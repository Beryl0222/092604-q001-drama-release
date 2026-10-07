/**
 * 国际剧目译本协作核心：
 * 成员/角色、剧目与材料、片段语境、术语决议、文化注释、
 * 译稿提交（去重/异源合并）、版本派生（只从锁定版）、史实复核、争议。
 */
import { Clock } from "./clock.js";
import { Store } from "./store.js";
import { DomainError, ErrorCode } from "./errors.js";
import { IdGenerator } from "./ids.js";
import { requireRole, Role } from "./roles.js";
import { classifyChange, diffEntries, fingerprint, normText } from "./policy.js";

const MATERIAL_TYPES = new Set(["subtitle", "program_note", "talk_script"]);

export class Collaboration {
  constructor({ store = new Store(), clock = new Clock(), persistence = null, ids = null } = {}) {
    this.store = store;
    this.clock = clock;
    this.persistence = persistence;
    this.ids = ids || new IdGenerator("id");
    for (const name of [
      "members", "productions", "materials", "segments", "terms", "notes",
      "historyFacts", "submissions", "versions", "disputes", "audit",
    ]) {
      this.store.collection(name);
    }
    if (persistence) {
      const snapshot = persistence.load();
      if (snapshot) this.store.restore(snapshot);
    }
  }

  persist() {
    if (this.persistence) this.persistence.save(this.store.snapshot());
  }

  now() {
    return this.clock.now();
  }

  // ---------- 审计 ----------
  audit(actorId, action, target = {}, detail = {}) {
    const event = { at: this.now(), actorId, action, target, detail };
    const coll = this.store.collection("audit");
    coll.set(`${event.at}#${this.ids.next()}`, structuredClone(event));
    return event;
  }

  listAudit() {
    return this.store.list("audit");
  }

  // ---------- 成员与角色 ----------
  registerMember(memberId, name, roles) {
    if (this.store.has("members", memberId)) throw new DomainError(ErrorCode.ALREADY_EXISTS, "成员已存在");
    const bad = roles.filter((r) => !Object.values(Role).includes(r));
    if (bad.length) throw new DomainError(ErrorCode.VALIDATION, `未知角色: ${bad.join("、")}`);
    const member = { memberId, name, roles: [...new Set(roles)], createdAt: this.now() };
    this.store.put("members", memberId, member);
    this.audit(memberId, "member.register", { memberId }, { roles });
    this.persist();
    return structuredClone(member);
  }

  actor(memberId) {
    const member = this.store.get("members", memberId);
    if (!member) throw new DomainError(ErrorCode.NOT_FOUND, `成员不存在: ${memberId}`);
    return member;
  }

  // ---------- 剧目、材料、片段 ----------
  createProduction({ productionId = this.ids.next(), title, ownerMemberId }) {
    const owner = this.actor(ownerMemberId);
    requireRole(owner, [Role.CREATOR, Role.STAGE_MANAGER]);
    if (this.store.has("productions", productionId)) {
      throw new DomainError(ErrorCode.ALREADY_EXISTS, "剧目已存在");
    }
    const production = { productionId, title, ownerMemberId, createdAt: this.now() };
    this.store.put("productions", productionId, production);
    this.audit(ownerMemberId, "production.create", { productionId });
    this.persist();
    return structuredClone(production);
  }

  getProduction(productionId) {
    const production = this.store.get("productions", productionId);
    if (!production) throw new DomainError(ErrorCode.NOT_FOUND, "剧目不存在");
    return production;
  }

  createMaterial({ materialId = this.ids.next(), productionId, type, title, defaultLicense = null }) {
    this.getProduction(productionId);
    if (!MATERIAL_TYPES.has(type)) {
      throw new DomainError(ErrorCode.VALIDATION, `材料类型必须是: ${[...MATERIAL_TYPES].join("、")}`);
    }
    const material = { materialId, productionId, type, title, defaultLicense, createdAt: this.now() };
    this.store.put("materials", materialId, material);
    this.audit(null, "material.create", { materialId, productionId }, { type });
    this.persist();
    return structuredClone(material);
  }

  getMaterial(materialId) {
    const material = this.store.get("materials", materialId);
    if (!material) throw new DomainError(ErrorCode.NOT_FOUND, "材料不存在");
    return material;
  }

  listMaterials(productionId) {
    return this.store.list("materials", (m) => m.productionId === productionId);
  }

  /** 登记台词片段及其原始语境（场景、说话人、方言原文、史实标记）。 */
  registerSegment({ segmentId = this.ids.next(), materialId, sourceText, context = {}, historical = false }) {
    this.getMaterial(materialId);
    const segment = {
      segmentId, materialId, sourceText, context, historical,
      createdAt: this.now(), updatedAt: this.now(),
    };
    this.store.put("segments", segmentId, segment);
    this.audit(null, "segment.register", { segmentId, materialId }, { historical });
    this.persist();
    return structuredClone(segment);
  }

  getSegment(segmentId) {
    const segment = this.store.get("segments", segmentId);
    if (!segment) throw new DomainError(ErrorCode.NOT_FOUND, "片段不存在");
    return segment;
  }

  listSegments(materialId) {
    return this.store.list("segments", (s) => s.materialId === materialId);
  }

  segmentsById() {
    return new Map(this.store.list("segments").map((s) => [s.segmentId, s]));
  }

  /** 亲历者/顾问补充史实：记录来源与影响片段，影响面可经查询追踪。 */
  addHistoricalFact({ factId = this.ids.next(), segmentIds = [], source, text, recordedBy }) {
    this.actor(recordedBy);
    for (const id of segmentIds) this.getSegment(id);
    const fact = { factId, segmentIds: [...new Set(segmentIds)], source, text, recordedBy, recordedAt: this.now() };
    this.store.put("historyFacts", factId, fact);
    this.audit(recordedBy, "history_fact.add", { factId }, { segmentIds: fact.segmentIds, source });
    this.persist();
    return structuredClone(fact);
  }

  // ---------- 术语决议与文化注释 ----------
  proposeTerm({ termId = this.ids.next(), productionId, materialId = null, sourceTerm, alternatives = [], raisedBy }) {
    this.actor(raisedBy);
    this.getProduction(productionId);
    const term = {
      termId, productionId, materialId, sourceTerm, alternatives,
      status: "open", decision: null, decidedBy: null, decidedAt: null,
      raisedBy, createdAt: this.now(),
    };
    this.store.put("terms", termId, term);
    this.audit(raisedBy, "term.propose", { termId }, { sourceTerm });
    this.persist();
    return structuredClone(term);
  }

  /** 术语统一决议：主创或史实顾问可裁决（方言中的历史称谓走顾问）。 */
  resolveTerm(termId, decision, byMemberId, { historical = false } = {}) {
    const term = this.store.get("terms", termId);
    if (!term) throw new DomainError(ErrorCode.NOT_FOUND, "术语条目不存在");
    const actor = this.actor(byMemberId);
    requireRole(actor, historical ? Role.HISTORY_ADVISOR : [Role.CREATOR, Role.HISTORY_ADVISOR]);
    const resolved = this.store.update("terms", termId, (t) => {
      t.status = "resolved";
      t.decision = decision;
      t.decidedBy = byMemberId;
      t.decidedAt = this.now();
      return t;
    });
    this.audit(byMemberId, "term.resolve", { termId }, { decision });
    this.persist();
    return resolved;
  }

  listTerms(productionId) {
    return this.store.list("terms", (t) => t.productionId === productionId);
  }

  addCulturalNote({ noteId = this.ids.next(), segmentId = null, materialId = null, text, authorMemberId }) {
    this.actor(authorMemberId);
    if (segmentId) this.getSegment(segmentId);
    if (materialId) this.getMaterial(materialId);
    if (!segmentId && !materialId) {
      throw new DomainError(ErrorCode.VALIDATION, "文化注释必须关联片段或材料");
    }
    const note = { noteId, segmentId, materialId, text, authorMemberId, createdAt: this.now() };
    this.store.put("notes", noteId, note);
    this.audit(authorMemberId, "note.add", { noteId, segmentId, materialId });
    this.persist();
    return structuredClone(note);
  }

  listCulturalNotes({ segmentId = null, materialId = null } = {}) {
    return this.store
      .list("notes")
      .filter((n) => (segmentId ? n.segmentId === segmentId : true))
      .filter((n) => (materialId ? n.materialId === materialId : true));
  }

  // ---------- 争议 ----------
  raiseDispute({ disputeId = this.ids.next(), productionId, subjectType, subjectId, summary, raisedBy, relatedVersionIds = [] }) {
    this.actor(raisedBy);
    this.getProduction(productionId);
    if (!["term", "segment", "fact"].includes(subjectType)) {
      throw new DomainError(ErrorCode.VALIDATION, "争议对象类型必须是 term、segment 或 fact");
    }
    const dispute = {
      disputeId, productionId, subjectType, subjectId, summary, raisedBy,
      relatedVersionIds, status: "open", resolution: null,
      timeline: [{ at: this.now(), by: raisedBy, action: "raised", comment: summary }],
      createdAt: this.now(),
    };
    this.store.put("disputes", disputeId, dispute);
    this.audit(raisedBy, "dispute.raise", { disputeId }, { subjectType, subjectId });
    this.persist();
    return structuredClone(dispute);
  }

  /** 解决争议：史实争议只能由史实顾问裁决，措辞争议由主创裁决。 */
  resolveDispute(disputeId, { decision, byMemberId, historical = false, resultingVersionId = null }) {
    const dispute = this.store.get("disputes", disputeId);
    if (!dispute) throw new DomainError(ErrorCode.NOT_FOUND, "争议不存在");
    if (dispute.status === "resolved") throw new DomainError(ErrorCode.CONFLICT, "争议已解决");
    const actor = this.actor(byMemberId);
    requireRole(actor, historical ? Role.HISTORY_ADVISOR : [Role.CREATOR, Role.HISTORY_ADVISOR]);
    const resolved = this.store.update("disputes", disputeId, (d) => {
      d.status = "resolved";
      d.resolution = { decision, by: byMemberId, historical, resultingVersionId, resolvedAt: this.now() };
      d.timeline.push({ at: this.now(), by: byMemberId, action: "resolved", comment: decision });
      return d;
    });
    this.audit(byMemberId, "dispute.resolve", { disputeId }, { historical, resultingVersionId });
    this.persist();
    return resolved;
  }

  listDisputes(productionId) {
    return this.store
      .list("disputes", (d) => d.productionId === productionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---------- 译稿提交与版本 ----------
  latestLockedVersion(materialId) {
    const locked = this.store
      .list("versions", (v) => v.materialId === materialId && v.status === "locked")
      .sort((a, b) => b.revisionNo - a.revisionNo);
    return locked[0] || null;
  }

  listVersions(materialId) {
    return this.store
      .list("versions", (v) => v.materialId === materialId)
      .sort((a, b) => a.revisionNo - b.revisionNo);
  }

  getVersion(versionId) {
    const version = this.store.get("versions", versionId);
    if (!version) throw new DomainError(ErrorCode.NOT_FOUND, "版本不存在");
    return version;
  }

  normalizeEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION, "译稿至少包含一条译文");
    }
    return entries.map((e) => {
      const segmentId = normText(e.segmentId) || null;
      const sourceText = normText(e.sourceText);
      const translatedText = normText(e.translatedText);
      if (!translatedText) throw new DomainError(ErrorCode.VALIDATION, "每条译文必须包含 translatedText");
      if (!segmentId && !sourceText) throw new DomainError(ErrorCode.VALIDATION, "每条译文必须给出 segmentId 或原文");
      return { segmentId, sourceText, translatedText };
    });
  }

  /**
   * 提交译稿。
   * 内容指纹相同：同源视为重复提交；不同来源合并到同一提交（登记多个来源），不产生新版本。
   * 新版本只能从已锁定版本派生（首版除外）。
   */
  submitTranslation({
    materialId, submittedBy, source, entries: rawEntries,
    audience = [], license = null, declaredChange = null, parentVersionId = null,
  }) {
    const actor = this.actor(submittedBy);
    requireRole(actor, [Role.TRANSLATOR, Role.CREATOR]);
    const material = this.getMaterial(materialId);
    const entries = this.normalizeEntries(rawEntries);
    const fp = fingerprint(materialId, entries);

    const prior = this.store.list("submissions", (s) => s.materialId === materialId && s.fingerprint === fp)[0];
    if (prior) {
      const sameSource = normText(prior.source) === normText(source);
      if (!sameSource && !prior.mergedSources.includes(source)) {
        this.store.update("submissions", prior.submissionId, (s) => {
          s.mergedSources.push(source);
          s.mergedAt = this.now();
          return s;
        });
        this.audit(submittedBy, "submission.merge", { submissionId: prior.submissionId }, { source });
        this.persist();
      } else {
        this.audit(submittedBy, "submission.duplicate", { submissionId: prior.submissionId }, { source });
        this.persist();
      }
      return {
        outcome: sameSource ? "duplicate" : "merged",
        submissionId: prior.submissionId,
        versionId: prior.versionId,
        fingerprint: fp,
      };
    }

    const explicit = parentVersionId ? this.getVersion(parentVersionId) : null;
    const parent = explicit || this.latestLockedVersion(materialId);
    if (parent) {
      if (parent.materialId !== materialId) throw new DomainError(ErrorCode.VALIDATION, "父版本不属于同一材料");
      // 修订只能从已锁定版本派生；唯一例外是被史实顾问驳回的待审版本，
      // 它从未投入使用，允许显式指定为父版重新修订。
      const derivable = parent.status === "locked" || parent.review?.status === "rejected";
      if (!derivable) {
        throw new DomainError(
          ErrorCode.CONFLICT,
          "修订只能从已锁定版本派生",
          { parentVersionId: parent.versionId, parentStatus: parent.status },
        );
      }
    } else if (this.listVersions(materialId).length > 0) {
      throw new DomainError(
        ErrorCode.CONFLICT,
        "该材料尚无已锁定版本：首版需先锁定；被驳回的待审版本可显式指定 parentVersionId 重新修订",
      );
    }

    const maxRevision = Math.max(0, ...this.listVersions(materialId).map((v) => v.revisionNo));
    const revisionNo = maxRevision + 1;
    const diff = parent ? diffEntries(parent.entries, entries) : null;
    let changeKind = parent
      ? classifyChange({ declared: declaredChange, diff, segmentsById: this.segmentsById() })
      : "initial";
    // 首版虽无"改动"，但凡译文覆盖史实片段，仍需史实顾问复核签字。
    if (changeKind === "initial") {
      const segIndex = this.segmentsById();
      const coversHistorical = entries.some((e) => e.segmentId && segIndex.get(e.segmentId)?.historical);
      if (coversHistorical || declaredChange === "historical_fact") changeKind = "historical_fact";
    }
    const submissionId = this.ids.next();
    const versionId = this.ids.next();

    const submission = {
      submissionId, materialId, versionId, fingerprint: fp, source,
      mergedSources: [], submittedBy, createdAt: this.now(),
    };
    const version = {
      versionId, materialId, productionId: material.productionId, revisionNo,
      parentVersionId: parent ? parent.versionId : null,
      entries, fingerprint: fp, changeKind,
      status: changeKind === "historical_fact" ? "in_review" : "draft",
      audience: [...new Set(analysisAudience(entries, audience))],
      // 修订默认继承父版授权；材料默认授权兜底；续期走 license.extend。
      license: license || parent?.license || material.defaultLicense || null,
      review: changeKind === "historical_fact"
        ? { required: true, requiredRole: Role.HISTORY_ADVISOR, status: "pending", decidedBy: null, decidedAt: null, comment: null }
        : { required: false, status: null, decidedBy: null, decidedAt: null, comment: null },
      diff: diff || { added: entries.map((e) => ({ segmentId: e.segmentId, sourceText: e.sourceText, to: e.translatedText })), removed: [], changed: [], changedSegmentIds: [], isEmpty: false },
      submittedBy, createdAt: this.now(), lockedAt: null, lockedBy: null,
    };
    this.store.put("submissions", submissionId, submission);
    this.store.put("versions", versionId, version);
    this.audit(submittedBy, "submission.create", { submissionId, versionId }, { revisionNo, changeKind, source });
    this.persist();
    return { outcome: "new", submissionId, versionId, fingerprint: fp, changeKind, revisionNo };
  }

  /** 史实顾问复核：通过后版本才可锁定；驳回退回草稿，需重新派生修订。 */
  reviewVersion(versionId, decision, advisorMemberId, comment = "") {
    const actor = this.actor(advisorMemberId);
    requireRole(actor, Role.HISTORY_ADVISOR);
    const version = this.getVersion(versionId);
    if (version.changeKind !== "historical_fact") {
      throw new DomainError(ErrorCode.VALIDATION, "该版本不是史实改动，无需指定复核");
    }
    if (!["approve", "reject"].includes(decision)) {
      throw new DomainError(ErrorCode.VALIDATION, "复核结论必须是 approve 或 reject");
    }
    const updated = this.store.update("versions", versionId, (v) => {
      if (decision === "approve") {
        v.status = "approved";
        v.review.status = "approved";
      } else {
        v.status = "draft";
        v.review.status = "rejected";
      }
      v.review.decidedBy = advisorMemberId;
      v.review.decidedAt = this.now();
      v.review.comment = comment;
      return v;
    });
    this.audit(advisorMemberId, "version.review", { versionId }, { decision, comment });
    this.persist();
    return updated;
  }

  /** 锁定版本：主创执行；锁定即要求授权存在且未过期。普通措辞不触发复核，不影响其他材料。 */
  lockVersion(versionId, byMemberId) {
    const actor = this.actor(byMemberId);
    requireRole(actor, Role.CREATOR);
    const version = this.getVersion(versionId);
    if (version.status === "locked") throw new DomainError(ErrorCode.CONFLICT, "版本已锁定");
    if (version.status === "in_review" || (version.changeKind === "historical_fact" && version.review.status !== "approved")) {
      throw new DomainError(
        ErrorCode.REVIEW_REQUIRED,
        "涉及历史事实的改动必须由史实顾问复核通过后才能锁定",
        { versionId, review: version.review },
      );
    }
    if (!version.license || !version.license.expiresAt) {
      throw new DomainError(ErrorCode.VALIDATION, "锁定前必须登记授权与授权期限");
    }
    if (Date.parse(version.license.expiresAt) <= Date.parse(this.now())) {
      throw new DomainError(ErrorCode.VALIDATION, "授权已过期，无法锁定");
    }
    const locked = this.store.update("versions", versionId, (v) => {
      v.status = "locked";
      v.lockedAt = this.now();
      v.lockedBy = byMemberId;
      return v;
    });
    this.audit(byMemberId, "version.lock", { versionId }, { revisionNo: locked.revisionNo });
    this.persist();
    return locked;
  }

  /** 更新版本授权（续期），不改变译文内容，不要求复核。 */
  extendLicense(versionId, license, byMemberId) {
    this.actor(byMemberId);
    const updated = this.store.update("versions", versionId, (v) => {
      v.license = { ...v.license, ...license };
      return v;
    });
    this.audit(byMemberId, "version.license.extend", { versionId }, { expiresAt: license.expiresAt });
    this.persist();
    return updated;
  }

  /** 两个版本的逐句差异（供排练钉版对比与发布确认）。 */
  compareVersions(fromVersionId, toVersionId) {
    const from = this.getVersion(fromVersionId);
    const to = this.getVersion(toVersionId);
    if (from.materialId !== to.materialId) throw new DomainError(ErrorCode.VALIDATION, "只能比较同一材料的版本");
    return diffEntries(from.entries, to.entries);
  }

  /**
   * 史实补充的影响面：所有包含相关片段、且译文出自补充之前锁定的版本，
   * 以及正在使用这些版本的场次（由 release 模块填充 performances）。
   */
  historicalImpact(factId, performances = []) {
    const fact = this.store.get("historyFacts", factId);
    if (!fact) throw new DomainError(ErrorCode.NOT_FOUND, "史实记录不存在");
    const targets = new Set(fact.segmentIds);
    const affectedVersions = this.store.list("versions", (v) => {
      if (v.status === "withdrawn") return false;
      return v.entries.some((e) => e.segmentId && targets.has(e.segmentId));
    });
    const versionIds = new Set(affectedVersions.map((v) => v.versionId));
    const affectedPerformances = performances.filter((p) =>
      [...Object.values({ ...p.pinned, ...p.published })].some((vid) => versionIds.has(vid)),
    );
    return {
      fact,
      segmentIds: [...targets],
      versions: affectedVersions.map((v) => ({
        versionId: v.versionId, materialId: v.materialId, revisionNo: v.revisionNo,
        status: v.status, lockedAt: v.lockedAt, recordedBeforeFact: v.lockedAt != null && v.lockedAt < fact.recordedAt,
      })),
      performanceIds: affectedPerformances.map((p) => p.performanceId),
    };
  }
}

function analysisAudience(_entries, audience) {
  // 适用受众目前以提交方声明为准（如 general、overseas_travel_group），
  // 后续可在此加入基于注释/术语的自动推断。
  return audience;
}
