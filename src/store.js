/** 进程内集合存储，可选 JSON 文件落盘以支持中断后恢复。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const COLLECTIONS = [
  "records",
  "sessions",
  "documents",
  "versions",
  "terms",
  "disputes",
  "jobs",
  "rollbacks",
  "submissions",
];

export class Store {
  constructor({ path = null } = {}) {
    this.path = path;
    for (const name of COLLECTIONS) this[name] = new Map();
    this.events = [];
    if (this.path) this.#load();
  }

  /** 兼容既有登记接口。 */
  add(record) {
    if (this.records.has(record.recordId)) {
      throw new Error("记录编号已存在");
    }
    this.put("records", record.recordId, record);
  }

  /** 兼容既有登记接口。 */
  get(recordId) {
    return this.getById("records", recordId);
  }

  put(collection, id, value) {
    this.#collection(collection).set(id, structuredClone(value));
    this.#persist();
  }

  getById(collection, id) {
    const value = this.#collection(collection).get(id);
    return value ? structuredClone(value) : null;
  }

  has(collection, id) {
    return this.#collection(collection).has(id);
  }

  list(collection) {
    return [...this.#collection(collection).values()].map((value) => structuredClone(value));
  }

  find(collection, predicate) {
    return this.list(collection).filter(predicate);
  }

  appendEvent(event) {
    this.events.push(structuredClone(event));
    this.#persist();
  }

  listEvents() {
    return structuredClone(this.events);
  }

  #collection(name) {
    if (!this[name] || !(this[name] instanceof Map)) throw new Error(`未知集合: ${name}`);
    return this[name];
  }

  #load() {
    if (!existsSync(this.path)) return;
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    for (const name of COLLECTIONS) {
      for (const [id, value] of raw.collections?.[name] ?? []) this[name].set(id, value);
    }
    this.events = raw.events ?? [];
  }

  #persist() {
    if (!this.path) return;
    const data = { collections: {}, events: this.events };
    for (const name of COLLECTIONS) data.collections[name] = [...this[name].entries()];
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
  }
}
