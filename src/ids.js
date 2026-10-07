/** 编号生成：默认使用时间戳与随机后缀，测试可注入固定序列。 */
export class IdGenerator {
  constructor(prefix) {
    this.prefix = prefix;
    this.seq = 0;
  }

  next() {
    this.seq += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${this.prefix}_${Date.now().toString(36)}${rand}${this.seq}`;
  }
}

/** 确定性编号生成器：仅用于测试或可复现脚本。 */
export class SequentialIds {
  constructor(prefix) {
    this.prefix = prefix;
    this.seq = 0;
  }

  next() {
    this.seq += 1;
    return `${this.prefix}_${this.seq}`;
  }
}
