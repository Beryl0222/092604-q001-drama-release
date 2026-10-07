# 国际剧目译本发布

服务于戏剧村落国际剧目的译本协作与场次发布：主创、翻译、史实顾问、演出经理围绕**场次版本**协作，
解决同一句方言在字幕、节目册导赏、团体讲解中译法不一的问题，并支持冻结、紧急撤回、回滚与进程中断恢复。

仅使用 Node.js 内置能力，默认进程内运行；设置 `DRAMA_STATE_FILE` 后以原子 JSON 快照持久化，进程重启自动恢复。

## 领域模型

| 对象 | 说明 |
| --- | --- |
| 成员/角色 | `creator` 主创、`translator` 翻译、`history_advisor` 史实顾问、`stage_manager` 演出经理 |
| 剧目/材料 | 一个剧目下有三类材料：`subtitle` 字幕、`program_note` 导赏词、`talk_script` 团体讲解 |
| 片段 segment | 台词片段，带原始语境（场景、说话人、方言）、`historical` 史实标记 |
| 术语决议 term | 统一译法决议；历史称谓只能由史实顾问裁决 |
| 文化注释 note | 挂在片段或材料上 |
| 史实记录 fact | 亲历者/顾问补充，关联片段，可反查受影响版本与场次 |
| 争议 dispute | 有提出、裁决角色、结论、时间线，状态只能显式解决 |
| 提交 submission / 版本 version | 提交按内容指纹去重；版本是带状态（草稿/待审/已批准/已锁定/撤回）的修订链 |
| 场次 performance | 排期、冻结窗口、排练钉版 `pinned`、最终采用 `published` |
| 发布任务 job / 撤回 / 回滚 | 多步流水线，逐步落盘，可恢复 |

## 关键规则

- **三个译法归一**：材料下译文按 `(segmentId/原文, 译文)` 规范化后做 SHA-256 指纹。
  - 同指纹同源 → `duplicate`，不产生新版本；
  - 同指纹不同来源 → `merged`，来源并入 `mergedSources`，仍不产生新版本。
- **版本只能从锁定版派生**：草稿不能再派生草稿；唯一例外是被史实顾问驳回、从未投入使用的版本，
  可显式传 `parentVersionId` 重新修订。
- **史实改动强制复核**：修订覆盖被标记为史实的片段（或显式声明 `historical_fact`）时，
  版本进入 `in_review`，必须由史实顾问 `approve` 后主创才能锁定；首版覆盖史实片段同样要复核。
- **普通措辞不停演**：`wording` 改动不触发复核，只影响对应材料的新版本，其他材料与在演场次不受影响。
- **排练旧版继续用、差异必须暴露**：排练钉住锁定版后，新版上线不替换钉版；
  `performance.pending_diffs` 与换钉事件给出逐句增删改差异。
- **授权**：锁定必须持有含 `expiresAt` 的授权且未过期；修订默认继承父版授权；`license.extend` 可续期；
  发布前校验授权覆盖整场演出。
- **冻结与撤回**：默认开演前 24 小时（可配置 `freezeBeforeMs`，也可提前手动冻结）。
  冻结后拒绝一切新发布；冻结窗口内只允许 `publish.withdraw` 紧急撤下已发布材料。
- **回滚**：非冻结期回滚到上一次（或指定）发布前快照，记录实际 `removed`（撤下）与 `reverted`（还原旧版）明细。
- **可恢复发布**：发布任务分为 `check_freeze → check_locked → check_licenses → apply_adoption → handoff`，
  每步完成立即落盘；采用落账按 `jobId` 幂等。进程重启后 `job.recover` 续跑未完成步骤，不重复采用。

## 演出经理查询接口

| 动作 | 回答的问题 |
| --- | --- |
| `query.adopted` | 某场次最终采用的字幕、导赏、讲解版本（含条目与授权） |
| `dispute.list` | 每条争议的裁决人、结论、时间线 |
| `query.expiring_licenses` | 排练/采用版本中哪些授权将在演出前失效 |
| `rollback.audit` | 一次回滚实际撤下了哪些材料、把哪些材料还原到哪版 |
| `withdrawal.list` | 紧急撤回记录与撤下明细 |
| `query.fact_impact` | 亲历者补充的史实影响哪些版本、哪些场次 |
| `performance.pending_diffs` | 已排练旧版与最新锁定版的逐句差异 |
| `job.get` / `job.list` | 发布任务每一步的状态与失败原因 |

## 动作一览（JSON over stdin）

协作：`member.register`、`production.create`、`material.create/list`、`segment.register/list`、
`fact.add`、`term.propose/resolve/list`、`note.add/list`、
`dispute.raise/resolve/list`、`translation.submit`、
`version.get/list/compare/review/lock`、`license.extend`。

场次与发布：`performance.schedule/list/freeze/pin/pending_diffs`、
`publish.start/withdraw/rollback`、`job.get/list/recover`、
`rollback.audit`、`withdrawal.list`、`query.adopted/expiring_licenses/fact_impact`。

## 运行

```bash
npm test            # 31 个测试
npm run build       # 全部模块语法检查
npm run cli --silent # 健康检查冒烟
```

带持久化的跨进程用法：

```bash
export DRAMA_STATE_FILE=.runtime/state.json
printf '%s' '{"action":"health"}' | npm run cli --silent
printf '%s' '{"action":"performance.schedule","performanceId":"PF1","productionId":"P1","name":"晚场","startsAt":"2026-10-20T19:30:00.000Z","by":"s1"}' | npm run cli --silent
```

成功动作直接返回数据负载；领域错误返回
`{"ok":false,"error":{"code":"FROZEN|REVIEW_REQUIRED|CONFLICT|FORBIDDEN|NOT_FOUND|VALIDATION",...}}`。

## 目录

- `src/roles.js` 角色与权限
- `src/policy.js` 内容指纹、逐句差异、史实/措辞分级（纯函数）
- `src/collaboration.js` 协作核心：材料、片段、术语、注释、争议、提交去重、版本与复核
- `src/release.js` 场次、冻结、钉版差异、可恢复发布、撤回、回滚与经理查询
- `src/store.js` 命名集合适存储（快照/恢复）
- `src/persistence.js` 原子 JSON 文件持久化（临时文件 + rename）
- `src/api.js` JSON 动作分发；`src/cli.js` 标准输入入口
- `test/` 协作、发布、崩溃恢复、API 端到端测试
