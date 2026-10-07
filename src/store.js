/**
 * 进程内集合存储。
 *
 * 按命名集合保存不可变快照（读写都经过结构化克隆），
 * 并可整体导出/恢复快照，供持久化层在进程重启后恢复状态。
 */
import { DomainError, ErrorCode } from "./errors.js";

export class Store {
  constructor() {
    this.collections = new Map();
    // 兼容旧版基础登记接口。
    this.collection("records");
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  put(name, id, value) {
    this.collection(name).set(id, structuredClone(value));
  }

  has(name, id) {
    return this.collection(name).has(id);
  }

  get(name, id) {
    if (arguments.length === 1) {
      // 兼容旧用法：store.get(recordId)
      const value = this.collection("records").get(name);
      return value ? structuredClone(value) : null;
    }
    const value = this.collection(name).get(id);
    return value ? structuredClone(value) : null;
  }

  add(record) {
    const coll = this.collection("records");
    if (coll.has(record.recordId)) {
      throw new DomainError(ErrorCode.ALREADY_EXISTS, "记录编号已存在");
    }
    coll.set(record.recordId, structuredClone(record));
  }

  delete(name, id) {
    return this.collection(name).delete(id);
  }

  list(name, predicate = null) {
    const values = [...this.collection(name).values()].map((v) => structuredClone(v));
    return predicate ? values.filter(predicate) : values;
  }

  /** 条件更新：取出记录、应用变更、写回，返回更新后的克隆。 */
  update(name, id, mutator) {
    const coll = this.collection(name);
    if (!coll.has(id)) throw new DomainError(ErrorCode.NOT_FOUND, `对象不存在: ${name}/${id}`);
    const next = mutator(structuredClone(coll.get(id)));
    coll.set(id, structuredClone(next));
    return structuredClone(next);
  }

  snapshot() {
    const data = {};
    for (const [name, coll] of this.collections) {
      data[name] = [...coll.entries()];
    }
    return { version: 1, data };
  }

  restore(snapshot) {
    this.collections = new Map();
    for (const [name, entries] of Object.entries(snapshot.data || {})) {
      this.collections.set(name, new Map(entries.map(([id, v]) => [id, structuredClone(v)])));
    }
    return this;
  }
}
