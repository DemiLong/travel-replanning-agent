# coveredYou 三个代码缺陷修补记录

> 日期：2026-09-23（Asia/Shanghai）  
> 项目：`C:\Users\yingl\Documents\Codex\2026-09-10\files-pasted-by-the-user-ai`  
> 基线提交：`2113fea` 之上的现有未提交工作区  
> 当前结论：三个指定缺陷的代码修补、受控回归和三项真实外部服务验收均已完成。

## 1. 实施范围

本轮只修改了与三个缺陷直接相关的代码和测试：

- `services/itinerary-domain.ts`：保留已保存活动的时长事实和来源。
- `agents/agent-orchestrator.ts`：草稿往返时保留时长来源，并继续执行固定活动保护。
- `types/index.ts`：为确认草稿增加可选 `durationSource`，兼容旧草稿。
- `services/semantic-parser.ts`：删除 considering 到 existing_plan 的关键词强制升级，完善 Prompt 正反例。
- `components/workflows.tsx`：读取 JSON 后执行接口级运行时结构校验。
- `evals/validator-tests.ts`、`e2e/coveredYou.spec.ts`、`live-e2e/p0-live.spec.ts`：增加 A/B/C 精确回归和真实验证用例。

没有更换模型，没有扩大补问次数，没有调整路由、缓存或启动配置，没有清理 `.next`，没有改变 `coveredYou` 名称和现有数据键，也没有处理其他 P1 项。

## 2. 修改前失败证据

按照方案先增加 A1、B2、C1，并在修补前执行：

| 用例 | 修改前实际结果 | 测试是否成功抓住缺陷 |
|---|---|---|
| A1 固定活动重申 | 抛出“固定安排‘上海国金中心’的时间、地点、名称和锁定状态不能修改” | 是 |
| B2 明确犹豫序列 | 期望 existingPlans=0，实际被强制升级为 2 项 | 是 |
| C1 合法 JSON `null` | 页面直接显示 `Cannot read properties of null (reading 'status')` | 是 |

C1 首次定向运行前曾因本地没有生产构建而未进入测试；完成正常构建后再次运行，以上技术异常稳定复现。该构建问题不计为 C1 的业务结果。

## 3. 缺陷一：未知新值覆盖已保存时长

### 具体改动

1. 领域合并先计算新输入是否真的提供了 `endTime` 或 `durationMinutes`，使用 `!== null` 判断。
2. 匹配到旧活动、开始时间未变，且新输入未提供时长时，沿用旧 `endTime` 和旧 `durationSource`。
3. 草稿显式携带可选 `durationSource`；旧草稿没有该字段时，若时间事实与旧活动一致，仍从旧活动回退来源。
4. 新活动没有结束时间或时长时继续表示为 `endTime=startTime`、`durationSource=unknown`，不臆造一小时。
5. 明确的新结束时间仍按用户修改处理；固定活动校验没有删除或放宽。

### A 组结果

| 用例 | 依赖类型 | 结果 |
|---|---|---|
| A1 固定活动18:00—19:00，仅重申18:00并补一次位置 | 注入稳定 Parser/World，调用真实编排与真实草稿续接 | 通过；ID、placeId、18:00—19:00、`user`、locked 全部保留 |
| A2 普通活动同样重申 | 注入稳定 Parser/World，真实合并 | 通过；已知结束时间和来源不丢失 |
| A3 空行程新增18:00活动 | 注入稳定 Parser/World，真实合并 | 通过；结束仍为18:00，来源 `unknown`，未生成19:00 |
| A4 固定活动明确改结束时间 | 注入稳定 Parser，真实固定保护 | 通过；仍抛出固定安排不可修改，没有吞掉冲突 |
| A5 `suggested`/`unknown` 草稿往返 | 真实草稿生成与合并 | 通过；来源分别保持 `suggested` 和 `unknown` |

## 4. 缺陷二：代码强制覆盖明确犹豫意图

### 具体改动

1. 删除 `explicitFeasibilitySequence` 以及把模型 `considering` 改写成 `existing_plan` 的代码。
2. 规范化层只核对 `sourceText`、转换稳定字段和过滤重复，不再用整段关键词替用户确认活动。
3. Prompt 增加逐活动判断要求和 B1/B2/B3/B6 对照：
   - 不确定“是否去”时保持 considering。
   - “原定但担心赶不上”时保持 existing_plan。
   - 同一句中已确定 A、仍考虑 B 时分别处理。
   - 单独出现“我想”不自动等于 considering。

### B 组受控结果

精确测试将模型输出作为输入，验证规范化代码不会越权改写：

| 用例 | 结果 |
|---|---|
| B1 完整三活动可行性序列 | 模型给 existing_plan 时保留三项和15:00/18:00/20:00 |
| B2 明确不确定是否去 | 两项 considering 均保留，existingPlans=0 |
| B3 原定两项但担心赶不上 | 两项 existing_plan 均保留 |
| B4 二选一且没决定 | 两项 considering，不变成两项必做 |
| B5 已有B的取消问题 | B保留原活动身份，并保留 changed_mind 请求 |
| B6 A已确定、B仍考虑 | A进入 existingPlans，B保持 considering |

这些测试证明“规范化代码不再强制升级”，不能替代真实模型 Prompt 验证；真实模型部分见第7节。

## 5. 缺陷三：合法 JSON 结构错误

### 具体改动

1. `readApiJson` 只返回 `unknown`，不再用泛型断言把 `JSON.parse` 结果直接当作可信对象。
2. `/api/parse`：HTTP成功时必须通过 `ParsedUserInputSchema`；失败响应必须有合法中文 `error`。
3. `/api/assist`：
   - `READY` 必须包含并验证 result、base、request、parsedInput。
   - `NEEDS_INPUT` 必须包含并验证问题、字段 key、confirmedDraft、resolutionState、parsedInput 和 impactAnalysis。
   - 合法终态必须有已知 status 和中文 error。
   - 非成功 HTTP 仍允许现有无 status 的合法业务错误对象。
4. `/api/validate`：`ok` 必须是真正的 boolean；字符串和数字均拒绝。
5. 读取正文时遇到 `AbortError` 原样抛出，由现有取消分支静默处理，不包装成普通错误。
6. Zod 结构错误统一显示“服务暂时返回异常，你的输入已保留，请稍后重试。”，业务错误仍保留原中文说明。

### C 组结果

故障均在浏览器请求边界受控注入，不冒充真实上游自然故障：

| 编号 | 注入 | 结果 |
|---|---|---|
| C1 | `null` | 通过；受控中文提示，无 TypeError、跳转或保存 |
| C2 | `[]`、`"text"`、`123`、`true` | 通过；全部拒绝为结构异常 |
| C3 | `{}`、未知 status、READY缺结果 | 通过；不进入结果页 |
| C3-parse | `/api/parse` 200但缺必要字段 | 通过；不创建编辑项，保留输入 |
| C4 | NEEDS_INPUT缺问题/草稿/key | 通过；不展示无法提交的问题 |
| C5 | validate返回 `{"ok":"false"}`、`{"ok":1}` | 通过；均停留结果页，revision保持1，pendingPlan保留 |
| C6 | 合法中文业务错误 | 通过；原业务信息正常展示 |
| C7 | HTML、空正文、截断JSON | 通过；统一受控提示 |
| C8 | 响应对象已返回、读取正文时取消 | 通过；静默结束，无迟到保存 |
| C9 | 合法创建、补问和validate成功响应 | 通过；原正常流程未被结构校验破坏 |

浏览器受控套件总计 **23/23 通过**。

## 6. 本地验证汇总

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run test:unit` | 通过，包含 A1—A5、B1—B6 及原有回归 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 23/23 通过 |
| `git diff --check` | 通过；仅有 Windows LF/CRLF 提示，无空白错误 |

## 7. 真实外部验证：完成

方案要求的 DeepSeek 与高德环境变量均已配置；验证过程没有读取、输出或记录密钥值。首次运行时项目进程返回503，脱敏网络分层诊断确认：

- DNS 正常；DeepSeek 与高德域名均能解析。
- Node `fetch` 直连目标 `443` 时返回 `connect EACCES (-4092)`。
- 当前环境已经提供 HTTPS 代理，但 Node 24 默认没有读取该代理；临时设置 `NODE_USE_ENV_PROXY=1` 后，不带密钥的 DeepSeek 探测正常到达 HTTP 401，高德探测正常到达 HTTP 200。
- 因此最初的阻塞点是“测试进程未使用当前环境代理，而直接出站连接被禁止”，不是密钥、额度、模型或地图服务故障。

网络打通后，真实测试暴露并修复了三个收口问题：

1. 固定预约可能先出现预约地点 POI 消歧，再询问当前位置；测试不再写死补问顺序，仍逐轮验证草稿事实不变。
2. Planner 返回 `ok=false/plan=null` 时，编排器原先错误返回 `READY`；现已改为 `NO_SAFE_PLAN`，并增加受控回归。
3. B6 一次运行中，模型正确给出 `role=existing_plan`，但地点为 null；规范化原先把它留在 `activityMentions`。现在仅依据模型明确 role 做结构归位，缺地点触发补问，不通过关键词擅自改变语义。

最终使用 `retries: 0` 在同一次运行中完成10个真实测试，结果 **10/10通过，耗时1.4分钟**：

| 待验收项 | 真实链路 | 最终结果 |
|---|---|---|
| 固定预约创建、重申并补位置 | 真实浏览器 → `/api/parse` → 保存预约 → `/api/assist` → 高德 POI/路线 → DeepSeek Planner | 通过；原活动ID、18:00—19:00、`durationSource=user` 和 locked 均保持；先选择上海ifc商场，再补人民广场地铁站 |
| 原句、犹豫与混合意图 | 真实浏览器 fetch → `/api/parse` → DeepSeek | B1、B2、B3、B6各独立运行两次，8/8通过 |
| 空正式行程完整闭环 | 空 revision 0 → 真实 Parser → 高德地点/路线 → Planner → 结果页 → `/api/validate` → 保存 | 通过；保存后 revision 从0变为1，pendingPlan清空，刷新后正式行程仍存在 |

脱敏证据位于 `work/three-defect-live-evidence/`：

- `A-real-fixed-restatement.{json,png}`
- `B1/B2/B3/B6-semantic-run-{1,2}.{json,png}`
- `normal-empty-session-closure.{json,png}`

在同类代理环境中复跑命令为：

```powershell
$env:NODE_USE_ENV_PROXY='1'
node scripts/run-playwright.mjs -c playwright.live.config.ts --grep "DEFECT-"
```

真实 POI 用例按名称、城市和地址选择候选，不默认点击第一项。

## 8. 最终判定

- 三个指定缺陷的代码修补：完成。
- A/B/C 受控回归：完成并通过。
- 三项真实外部服务验收：完成，最终10/10通过。
- 本轮结论：**三个缺陷修补和本方案定义的完整验收均已完成**。

本记录不代表 coveredYou 其他问题或此前整个 P0 已完成。

## 9. 工作区保护

- 保留进入本轮时已有的全部未提交修改。
- 未修改用户原有未跟踪文件 `CoveredYou.md`、`P0修复任务书.md`。
- 未清理 `.next`，未部署、未 push、未修改生产数据。
