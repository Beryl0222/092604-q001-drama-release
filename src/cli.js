/** 从标准输入接收 JSON 请求；设置 DRAMA_STORE 可启用文件持久化。 */
import { handle } from "./api.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

const path = process.env.DRAMA_STORE || null;
const service = new Service({ store: new Store({ path }) });

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
console.log(handle(raw.trim() || '{"action":"health"}', service));
