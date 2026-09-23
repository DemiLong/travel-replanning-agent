# coveredYou P0 实施与验收报告

> 执行日期：2026-09-22（Asia/Shanghai）  
> 工作区：`C:\Users\yingl\Documents\Codex\2026-09-10\files-pasted-by-the-user-ai`  
> 基线提交：`2113fea`，本报告对应其上的未提交工作区修改  
> 外部服务：DeepSeek `deepseek-v4-flash`、高德 Web 服务；密钥、Cookie、Authorization 和完整 SDK 错误均未写入证据。

## 结论

本轮计划规定的代码修改和 10 类验收均已执行。核心结果如下：

- 明确的原计划在空会话中可以建立草稿；已有普通活动、固定活动都能跨补问保留。
- 补一个地点或时间只更新目标活动，活动 ID 不再从 `mention-*` 变成 `event-mention-*`。
- 已有活动的取消询问保留原活动身份；真正“还没决定”的互斥选项不会被排成两项必做行程。
- 前端能够安全处理 HTML、空响应、连接失败和取消请求，不显示 JSON、Zod 或堆栈类技术异常。
- 已完成一次真实同城方案的 Planner、接受前复验、保存和刷新闭环，revision 从 1 增加到 2。
- 当前自有运行代码、页面、标题、Prompt、结构化输出名、测试文件名和新打包名均已统一为 `coveredYou`。

P0-05 的字段续接验收通过，但没有进入 Planner：两个活动时间和当前位置正好用完三轮补充额度，下一步真实 POI 选择被既有总轮数上限安全终止为 `OUT_OF_SCOPE`。这是计划明确不调整轮数规则后的产品边界，不应描述为“全链路出方案”。P0-08 已单独证明完整成功闭环。

## 实施摘要

### 1. 草稿与活动身份

- 首次请求统一经过规范化事实、草稿生成和正式行程合并，不再由两条不同路径重复生成活动。
- 已保存的未完成活动、新输入的完整原计划和缺字段活动都进入同一份草稿。
- 完整字段补齐时沿用原 `mention-*` ID；已保存活动继续保留原 ID、placeId、时间和 locked。
- 名称匹配收紧为“相同时间 + 去掉明确动作前缀后的名称相等”，避免模糊合并不同活动。

### 2. 空会话与定向补问

- 空正式行程但输入包含原计划时可直接继续。
- 缺时间或地点先产生稳定字段 key，例如 `activity:<id>:startTime`；后续答案直接修改该字段，不再拼接原文重跑 Parser。
- 明确聊天、无活动或仅考虑中的选项不会进入地图和 Planner。

### 3. 语义边界

- Prompt 明确区分已有计划的可行性/取消询问、真正考虑中的互斥选项、过去经历与他人建议。
- 对“3点…然后6点…晚上8点…还来得及全部做吗”增加有严格条件的共指修正，避免模型因“我想”把完整序列误判为 considering；该规则不按店名硬编码。

### 4. 错误容错与地点阻断修复

- 主流程使用统一安全响应读取，覆盖 JSON、HTML、空响应和网络失败。
- Parser、Grounding 和 Planner 的内部异常转换为稳定中文提示；业务冲突仍保留具体说明。
- “地铁站附近”不再发起全国范围 POI 搜索，而是要求具体地铁站/酒店/道路。
- 城市变化使旧 POI 选择失效时，重新返回当前城市的合法候选，而不是生成前端无法回答的文本字段。

### 5. 品牌和兼容

- 可见品牌、网页标题、DeepSeek Prompt、自有结构化输出名、README、升级说明、测试文件和新压缩包默认名均改为 `coveredYou`。
- 浏览器会话键 `travel-session-real-v3` 保持不变，以保证既有本地行程兼容；它不是旧品牌名。
- 未部署、未 push、未修改生产数据。

## 真实浏览器验收

以下 P0-01 至 P0-08 使用真实浏览器、真实本项目后端、真实 DeepSeek，并在业务需要时调用真实高德。证据 JSON 是脱敏响应摘要，PNG 是对应最终页面截图。

| 编号/运行 | 类别 | 输入与关键回答 | 实际终态 | 判定 | 证据 |
|---|---|---|---|---|---|
| 01-1 | 真实 | 原始三活动句；按页面补当前位置/POI | `NEEDS_INPUT → NEEDS_INPUT → READY` | 通过：3 项及 15:00/18:00/20:00 保留 | `work/p0-live-evidence/01-original-input-run-1.{json,png}` |
| 01-2 | 真实 | 同一原句独立会话 | `NEEDS_INPUT → READY` | 通过：第二次仍保留 3 项及时间 | `work/p0-live-evidence/01-original-input-run-2.{json,png}` |
| 02-1 | 真实 | 页面创建 2 项普通活动；具体位置为人民广场地铁站；选择真实 POI | `NEEDS_INPUT × 3 → READY` | 通过：locked=`[false,false]`，ID/placeId/时间/revision 不变 | `work/p0-live-evidence/02-ordinary-run-1.{json,png}` |
| 02-2 | 真实 | 与 02-1 相同的独立运行 | `NEEDS_INPUT × 3 → READY` | 通过：普通活动前置和事实保留再次成立 | `work/p0-live-evidence/02-ordinary-run-2.{json,png}` |
| 03-1 | 真实 | 页面创建固定 + 普通活动；回答位置并选择真实 POI | `NEEDS_INPUT × 3 → READY` | 通过：locked=`[true,false]`，固定活动未被修改或误删 | `work/p0-live-evidence/03-locked-run-1.{json,png}` |
| 03-2 | 真实 | 与 03-1 相同的独立运行 | `NEEDS_INPUT × 3 → READY` | 通过：固定保护再次成立 | `work/p0-live-evidence/03-locked-run-2.{json,png}` |
| 04 | 真实 | “15点回酒店、18点国金中心”；酒店回答“上海和平饭店” | `NEEDS_INPUT × 3 → READY` | 通过：酒店答案只绑定酒店活动，18 点活动未改变，ID 稳定 | `work/p0-live-evidence/04-hotel-location-answer.{json,png}` |
| 05 | 真实 | 两活动缺时间；国金 15:00、外滩 18:00、当前位置人民广场地铁站 | `NEEDS_INPUT × 3 → OUT_OF_SCOPE` | 字段链路通过：两次时间均定向更新且 ID 稳定；受三轮总上限限制，未进入 POI/Planner | `work/p0-live-evidence/05-missing-time-answer.{json,png}` |
| 06 | 真实 | 页面创建 18 点外滩，再问是否取消 | `NEEDS_INPUT → NEEDS_INPUT → READY` | 通过：外滩保留原活动身份；接受前 revision 仍为 1 | `work/p0-live-evidence/06-cancel-existing-activity.{json,png}` |
| 07 | 真实 | “考虑15点去博物馆东馆还是国金中心，还没决定” | `OUT_OF_SCOPE` | 通过：2 项均为 considering，未调用 Planner，未制造固定约束 | `work/p0-live-evidence/07-considering-options.{json,png}` |
| 08 | 真实 | 页面创建同城两项活动；人民广场当前位置；真实规划并接受 | `NEEDS_INPUT → NEEDS_INPUT → READY → validate → 保存` | 通过：Planner 与复验真实执行；revision `1 → 2`；刷新后仍保留 | `work/p0-live-evidence/08-same-city-success.{json,png}` |

真实套件当前结果：11 个浏览器运行全部通过（01、02、03 各包含两次独立运行）。为避免 Parser 对创建页“固定”初值的波动掩盖前置条件，又通过页面显式设定复选框并单独复跑 02/03，4 次全部通过。

## P0-09：受控故障测试

该部分是故障注入，不冒充真实外部服务自然故障。

| 注入 | 结果 |
|---|---|
| 模型非法/截断 JSON | 单元/集成测试经过真实解析与异常转换边界；返回稳定中文，不泄露结构错误 |
| API 返回 HTML | 浏览器显示“服务暂时返回异常，请稍后重试”，保留输入和正式行程 |
| API 返回空响应 | 同上，结束加载并可继续操作 |
| 连接失败 | 显示稳定错误，输入和 revision 不变，可重试 |
| 请求取消 | 不显示技术错误，不发生迟到跳转或保存 |

受控浏览器套件共 9 项，全部通过。移除拦截后又执行了真实 P0 套件，真实请求恢复可用。

## P0-10：品牌与兼容扫描

扫描命令覆盖 `app`、`components`、`services`、`agents`、`types`、`lib`、`e2e`、`live-e2e`、`evals`、`scripts`、README、docs、package 和 Playwright 配置，不区分大小写搜索旧名。

| 分类 | 结果 |
|---|---|
| 已替换 | 自有运行源码、页面标题、Prompt、输出 schema 名、新测试文件名和新打包默认名中旧品牌命中为 0 |
| 页面检查 | 首页、创建页、今日页、救援页、结果页均检查标题和 header 品牌为 `coveredYou` |
| 数据兼容 | 同一 `travel-session-real-v3` 会话在更名前后仍保留活动 ID 和 revision；测试通过 |
| 历史保留 | `9.21收敛改造.md` 中 2 处旧名是历史标题和历史叙述，按计划不改写 |
| 用户材料 | `CoveredYou.md`、`P0修复任务书.md` 为用户原有未跟踪文件，本轮未修改 |
| 第三方/生成物 | `node_modules`、`.next*`、Playwright 输出、`work` 证据和旧压缩包不参与自有源码零命中要求 |
| 外部兼容 | 未发现必须改名的外部部署资源；会话键有意保持不变 |

## 自动化与真实服务结果

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run test:unit` | 通过；覆盖迁移、门控、草稿往返、定向字段答案、语义正反例、安全错误、轮数/Planner 上限和固定活动校验 |
| `npm run build` | 通过，Next.js 生产构建完成 |
| `npm run test:e2e` | 9/9 通过（受控浏览器/故障/兼容） |
| `npm run test:p0-live` | 11/11 通过（真实浏览器、真实后端、真实 DeepSeek、按需真实高德） |
| `npm run test:semantic-live` | 通过（真实 DeepSeek） |
| `npm run test:world-live` | 通过（真实 DeepSeek、高德地点/路线/天气及 Planner/Validator） |
| `node scripts/test-assist-live.mjs` | 通过（真实补问续接、Grounding、Planner/Validator） |

## 首次失败记录（未隐藏）

真实测试在修改过程中曾暴露并推动修复以下问题：

1. 原句首次被 DeepSeek 将三项都判为 considering；增加严格的“完整时间序列 + 顺序词 + 可行性问题 + 无犹豫词”修正后，两次真实运行稳定保留三项。
2. “地铁站附近”曾触发全国 POI 搜索并先返回北京候选，城市切换后旧 POI 失效，又落入前端无法回答的文本 blocker；改为要求具体当前位置，并在城市变化时重新返回合法候选。
3. P0-04/05 中待确认活动补齐后曾从 `mention-*` 改成 `event-mention-*`；改为字段补齐不改变身份，并补充单元和真实浏览器断言。
4. P0-06 首次真实运行遇到一次模型无效结构，产品正确返回“服务暂时未能生成有效结果，你的输入已保留，请重试”；后续有限复跑成功进入 READY。该记录说明错误边界有效，但不等同于模型永不波动。

## 已知边界与后续事项

- 三轮补充上限会让“多个缺时间字段 + 当前位置 + 多个 POI 候选”的复杂输入在进入 Planner 前安全结束；P0-05 是明确证据。若要提高一次完成率，应在后续版本设计“单页批量补全”，而不是悄悄放大轮数或反复问同一问题。
- 30 秒是单次接口全局 deadline，不是用户思考和多轮补充在内的整段会话承诺。
- 浏览器定位仍受权限和设备环境限制；失败时走人工补充。
- 本轮未做跨刷新草稿恢复、跨日/跨城、多标签并发、账号/云同步、部署和公网额度治理。
- 真实地图与模型仍会受外部波动影响；无数据时保持未知或返回明确失败，不将查询失败解释为“来不及”。

## 改动保护

- 未修改用户原有未跟踪文件 `CoveredYou.md` 和 `P0修复任务书.md`。
- 未恢复或改写历史文件 `9.21收敛改造.md`。
- 未 commit、未 push、未部署。
