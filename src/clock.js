/** 提供可替换的业务时钟。 */
export class Clock {
  now() {
    return new Date().toISOString();
  }
}

/** 测试用手动时钟，可精确控制当前时刻。 */
export class ManualClock {
  constructor(start = "2026-01-01T00:00:00.000Z") {
    this.current = new Date(start).toISOString();
  }

  now() {
    return this.current;
  }

  set(iso) {
    this.current = new Date(iso).toISOString();
  }

  advanceMinutes(minutes) {
    const at = new Date(this.current).getTime() + minutes * 60000;
    this.set(new Date(at).toISOString());
  }
}
