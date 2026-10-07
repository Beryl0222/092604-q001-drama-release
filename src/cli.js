/**
 * 从标准输入接收 JSON 请求。
 * 设置 DRAMA_STATE_FILE 后状态持久化到该文件，进程重启自动恢复。
 */
import { handle } from "./api.js";
import { Service } from "./service.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

const service = process.env.DRAMA_STATE_FILE
  ? Service.withFile(process.env.DRAMA_STATE_FILE)
  : new Service();

console.log(handle(raw.trim() || '{"action":"health"}', service));
