/** 测试辅助：可控时钟、顺序编号、标准世界搭建。 */
import { Service } from "../src/service.js";
import { SequentialIds } from "../src/ids.js";

export class MutableClock {
  constructor(iso = "2026-10-01T00:00:00.000Z") {
    this.t = Date.parse(iso);
  }
  now() {
    return new Date(this.t).toISOString();
  }
  advance(ms) {
    this.t += ms;
  }
}

export const LIC = { holder: "版权方A", scope: "overseas_tour", expiresAt: "2026-12-31T00:00:00.000Z" };
export const SHOWN_AT = "2026-10-20T19:30:00.000Z";

export function buildWorld(options = {}) {
  const clock = options.clock || new MutableClock();
  const service = new Service({ clock, persistence: options.persistence || null, ids: new SequentialIds("id") });
  return { service, c: service.collab, r: service.release, clock };
}

/** 四名成员 + 闽宁镇剧目 + 三类材料 + 两个片段（seg1 为方言史实句）。 */
export function seedWorld(world) {
  const { c } = world;
  c.registerMember("u1", "主创林", ["creator"]);
  c.registerMember("t1", "翻译王", ["translator"]);
  c.registerMember("h1", "顾问赵", ["history_advisor"]);
  c.registerMember("s1", "经理孙", ["stage_manager"]);
  c.createProduction({ productionId: "P1", title: "闽宁镇", ownerMemberId: "u1" });
  c.createMaterial({ materialId: "SUB", productionId: "P1", type: "subtitle", title: "舞台英文字幕" });
  c.createMaterial({ materialId: "PGM", productionId: "P1", type: "program_note", title: "节目册导赏词" });
  c.createMaterial({ materialId: "TLK", productionId: "P1", type: "talk_script", title: "团体讲解词" });
  c.registerSegment({
    materialId: "SUB", segmentId: "seg1",
    sourceText: "咱这戈壁滩上长出了葡萄园",
    context: { scene: "第一幕", speaker: "老农", dialect: "西北官话" },
    historical: true,
  });
  c.registerSegment({
    materialId: "SUB", segmentId: "seg2",
    sourceText: "日子有奔头了",
    context: { scene: "第三幕" },
    historical: false,
  });
  return world;
}

export function entry(segmentId, translatedText, sourceText = "") {
  return { segmentId, translatedText, sourceText };
}

/** 提交 → 必要时史实复核 → 锁定，返回提交结果。 */
export function lockVersion(c, { materialId, entries, license = LIC, declared = null, submittedBy = "t1" }) {
  const res = c.submitTranslation({
    materialId, submittedBy, source: "翻译组定稿", entries, license, declaredChange: declared,
  });
  if (res.changeKind === "historical_fact") c.reviewVersion(res.versionId, "approve", "h1");
  c.lockVersion(res.versionId, "u1");
  return res;
}
