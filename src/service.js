/**
 * 国际剧目译本发布应用服务。
 * 组合译本协作核心（Collaboration）与场次发布流水线（Release），
 * 保留基础登记接口（register/find）与健康检查。
 */
import { Clock } from "./clock.js";
import { Store } from "./store.js";
import { Collaboration } from "./collaboration.js";
import { Release } from "./release.js";
import { JsonFilePersistence } from "./persistence.js";

export class Service {
  constructor({ store = new Store(), clock = new Clock(), persistence = null, ids = null } = {}) {
    this.store = store;
    this.clock = clock;
    this.persistence = persistence;
    this.collab = new Collaboration({ store, clock, persistence, ids });
    this.release = new Release(this.collab);
  }

  static withFile(filePath, { clock = new Clock(), ids = null } = {}) {
    return new Service({ clock, persistence: new JsonFilePersistence(filePath), ids });
  }

  health() {
    return { service: "drama_release", status: "ok" };
  }

  // 兼容旧版基础登记。
  register(recordId, ownerId) {
    return this.collab ? this.legacyRegister(recordId, ownerId) : null;
  }

  legacyRegister(recordId, ownerId) {
    const record = { recordId, ownerId, state: "draft", revision: 1, createdAt: this.clock.now() };
    this.store.add(record);
    if (this.persistence) this.persistence.save(this.store.snapshot());
    return structuredClone(record);
  }

  find(recordId) {
    return this.store.get("records", recordId);
  }
}
