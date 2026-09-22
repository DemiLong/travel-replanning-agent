# Dayshift · 单日行程动态调整

Dayshift 只做一件事：当用户已经有一份今天的行程，并遇到晚点、天气、体力、地点关闭或明确想重排时，基于真实地点与路线数据给出可接受的新方案。它不负责账号、云同步、多日、海外、预订或长期推荐。

## 本地运行

要求 Node.js 22.13+。

```sh
npm ci
npm run dev
```

在 `.env.local` 中配置服务端密钥：

```text
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
AMAP_API_KEY=...
```

密钥不会进入浏览器包。缺少密钥或上游不可用时，系统保留草稿和正式行程，并返回可重试的明确终态。

## 用户流程

- `/onboarding`：创建或编辑正式的单日行程，不自动规划。
- `/trip`：查看今天的行程；页面用当前系统时间重新判断下一项，未知天气显示“天气未查询”。
- `/`：输入本次明确变化；一次只补充一个必要字段。
- `/rescue`：复杂活动编辑和重新理解整段原文。
- `/result`：查看一个推荐方案；只有取舍明显不同时才显示一个备选，接受前再次校验。

持久化阶段只有：

```text
NO_ITINERARY | HAS_ITINERARY | NEEDS_INPUT | PLAN_READY |
OUT_OF_SCOPE | UNAVAILABLE | NO_SAFE_PLAN
```

`/api/assist` 的业务结果只有：

```text
READY | NEEDS_INPUT | OUT_OF_SCOPE | UPSTREAM_UNAVAILABLE | NO_SAFE_PLAN
```

首次请求发送 `{ snapshot, rawText }`。补问续接发送 `{ snapshot, confirmedDraft, answer, resolutionState }`；回答只更新 blocker 指定的字段，不与原文拼接，也不重新解析全文。

## 可靠性边界

- 空白、闲聊、乱码和试探性输入在地图及 Planner 之前结束。
- 没有明确变化、明确优化表达或确定活动修改时，不默认进入优化。
- 同一 blocker 最多展示两次；整个补充流程最多三轮。
- Parser 单次上限 8 秒；Planner 单轮上限 10 秒、最多两轮；高德单请求上限 8 秒；统一编排上限 30 秒。
- 路线只查询当前位置到下一活动、相邻保留活动、固定预约必要路段和候选所需路段，不构造全地点组合。
- 固定安排、已完成活动和已确认字段不能被模型静默修改。
- 只有用户接受且 `/api/validate` 使用新鲜世界数据复验成功，正式行程才更新；revision 防止多标签页覆盖。
- Session 使用 `schemaVersion: 3`。旧 v2 原文会先备份，再迁移活动、固定状态和 revision；失败时创建干净 v3 会话。

## 正式 API

- `POST /api/parse`
- `POST /api/assist`
- `POST /api/validate`
- `GET /api/config`

地点和路线只能通过编排服务调用。旧的独立规划与世界查询路由已移除。

## 验证

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

真实 DeepSeek 与高德联调是手动测试，避免默认 CI 消耗额度：

```sh
npm run test:semantic-live
npm run test:world-live
```

离线测试覆盖 v3 迁移、无效输入门控、字段续接隔离、防循环、候选数量、两轮规划上限和固定安排保护。

## 项目结构

```text
app/          页面与四个正式 API
components/   创建、今日、补问、复杂编辑与结果界面
services/     解析、规划、会话迁移、影响分析和高德服务
agents/       统一编排与有限重规划
validators/   固定安排、时间、路线、地点和变更完整性校验
types/        Zod 公共契约
evals/        离线可靠性测试
scripts/      冒烟和真实服务手动测试
```

## 已知限制

- 只支持同一天的正式行程。
- 高德基础地点数据不能证明商户实时营业；无法验证时会明确标记，不编造结论。
- 浏览器定位超过 10 分钟或精度差于 1000 米时不会复用。
- 匿名数据只保存在当前浏览器；清除浏览器数据或更换设备后无法恢复。
