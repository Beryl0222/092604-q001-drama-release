/**
 * JSON 文件持久化：每次提交生成一次原子快照（临时文件 + rename）。
 * 同步写入，保证单进程命令行入口在进程中断后仍可恢复最近一次已提交状态。
 */
import fs from "node:fs";
import path from "node:path";

export class JsonFilePersistence {
  constructor(filePath) {
    this.filePath = filePath;
  }

  save(snapshot) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  load() {
    if (!fs.existsSync(this.filePath)) return null;
    const raw = fs.readFileSync(this.filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : null;
  }
}
