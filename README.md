# 国际剧目译本发布

本项目提供国际剧目译本发布的服务端能力：主创、翻译、史实顾问和演出经理围绕场次版本协作，管理舞台字幕、导赏词和演员口述背景三类物料的译本生命周期。

## 领域概念

- **场次（session）**：一场演出，含开演时间与冻结窗口（默认开演前 120 分钟）。状态：`scheduled / rehearsed / performed / cancelled`。
- **文档（document）**：某剧目某类物料（`subtitle / guide / narration`）的译本系列。
- **版本（version）**：一次译稿。状态流转：`draft → locked → published → superseded / withdrawn`。台词片段关联原始语境、术语决议（termRefs）、文化注释、适用受众与授权期限。
- **术语决议（term）**：同一方言/短语的统一译法，`proposed → ratified`，用于检查各版本译法一致性。
- **争议（dispute）**：挂在版本或片段上，可标记阻断性；解决方式全程留痕。
- **发布任务（job）**：分步执行（校验 → 冻结检查 → 标记发布 → 绑定场次 → 记录事件），每步落盘，进程中断后自动从断点恢复。

## 核心规则

- 修订只能从已锁定版本派生；内容相同的提交不产生新修订——同一来源视为重复，不同来源合并到既有版本；`submissionId` 保证重复提交幂等。
- 涉及历史事实的改动需史实顾问（`historian`）复核通过后才能锁定、发布；普通措辞调整无需复核，也不会让已排练场次停演。
- 已排练场次继续使用旧版，仅登记可用更新，差异通过 `sessionDiff` 暴露；未排练场次在发布时自动采用新版。
- 临近开演的冻结场次禁止发布与换绑；紧急撤回（`withdrawVersion`）始终可用，绑定场次自动回退到最近可用版本；冻结中回滚需 `emergency` 标记。
- 回滚（`rollbackSession`）记录实际撤下的材料（目标版本没有或内容不同的片段），可通过 `rollbackDetails` 查询。

## 演出经理查询

- `sessionFinal`：场次最终采用的字幕、导赏与口述版本，可按受众过滤片段与文化注释。
- `sessionDiff`：场次绑定版本与最新已发布版本的差异。
- `disputes`：每条争议及其解决方式（按版本或场次）。
- `expiringLicenses`：演出前将失效的授权（含已过期标记）。
- `rollbackDetails`：一次回滚实际撤下的材料。
- `jobInfo` / `listEvents`：发布任务进度与全部审计事件。

## 目录

- `src/model.js` 常量、台词片段规范化、内容哈希与差异计算。
- `src/store.js` 进程内集合存储，可选 JSON 文件落盘（原子写）。
- `src/service.js` 领域规则与查询。
- `src/api.js` 进程内 JSON 请求分发。
- `src/cli.js` 标准输入入口，设置 `DRAMA_STORE` 环境变量可跨进程持久化。
- `test/` 覆盖上述行为。

## 运行

运行测试：`npm test`

检查构建：`npm run build`

本地冒烟：`printf '%s' '{"action":"health"}' | npm run cli --silent`

持久化冒烟：`DRAMA_STORE=/tmp/drama.json npm run cli --silent <<< '{"action":"sessionFinal","sessionId":"s-1"}'`

项目只使用 Node.js 内置能力，运行期间不连接其他服务。
