# Dayshift 真实世界服务改造与验收记录

日期：2026-09-13–14。此次保留原有页面路由、SessionRepository、flowStage、decision trace 和 Validator。没有部署，没有操作飞书。工作区已有历史改动；以下列表仅描述本轮升级涉及的文件。

## 1. 修改文件

- `.env.example`：新增高德变量；Supabase、EVAL_MODELS、ALLOW_LOCAL_LIVE 的原配置值未改变。
- `services/semantic-parser.ts`：DeepSeek 优先、移除地点目录补全、保留部分事实、去除系统时间对抽取的干扰、同一活动问句去重。
- `types/index.ts`：附加定位、世界上下文、候选比较和缺失信息字段；兼容原会话结构。
- `components/workflows.tsx`：真实解析、浏览器定位、交通方式、城市和 POI 选择、候选比较、数据说明；未确认方案不写入原行程。
- `services/trip-service.ts`：新匿名会话的目的地改成“待确认城市”。仓储接口、键名和流程状态不变。
- `agents/replanning-agent.ts`：复用并扩展决策记录，记录地点、路线来源和未检查项目。
- `validators/index.ts`、`validators/travel-time-validator.ts`、`validators/opening-hours-validator.ts`：世界事实分支、路线算术和真实地点约束；保留原校验器。
- `app/api/assist/route.ts`：首次真实输入的统一 Agent Orchestrator 入口。
- `app/api/parse/route.ts`、`app/api/replan/route.ts`、`app/api/validate/route.ts`、`app/api/config/route.ts`：真实服务绑定、配置提示和模式隔离；解析接口把上游网络不可用与结构化输出错误分开返回。
- `evals/validator-tests.ts`、`scripts/smoke.mjs`、`scripts/test-semantic-live.ts`、`package.json`、`README.md`：回归、验证入口和说明。

本机 `.env.local.txt` 已改名为 `.env.local`；未打印、复制到模板或提交其中的 Key。

## 2. 新增文件

- `types/world.ts`：世界数据契约。
- `services/deepseek-format.ts`：SDK JSON Schema 的可空字段和引用适配，保留严格结构解析。
- `services/deepseek-planner.ts`：独立 Planner、候选结构、代码排时间。
- `services/world/amap-client.ts`：服务端请求、脱敏错误、缓存、去重、节流。
- `services/world/location-service.ts`：浏览器 Geolocation 适配。
- `services/world/coordinate-service.ts`：官方 WGS84 → GCJ02 转换。
- `services/world/amap-places-service.ts`：关键词、周边、详情、逆地理编码。
- `services/world/amap-routes-service.ts`：驾车、步行、公交及受控批量查询。
- `services/world/amap-weather-service.ts`：精简实况与预报。
- `services/world/world-context-service.ts`：按需汇总世界事实与缺失信息。
- `agents/real-context-builder.ts`、`agents/real-replanning-agent.ts`：真实上下文和最多两轮的规划校验循环。
- `agents/agent-orchestrator.ts`：统一串联语义解析、缺失事实门控、真实规划和结果返回。
- `services/impact-analysis.ts`：只判断受影响节点、完成状态、固定安排和可用时间窗；休息或新增活动的体验判断交给 Planner。
- `app/api/world/places/route.ts`、`app/api/world/context/route.ts`。
- `evals/world-tests.ts`、`scripts/test-live.mjs`、本报告。

## 3. API 路由

新增 `POST /api/world/places`、`POST /api/world/context`。保留并修改 `/api/parse`、`/api/replan`、`/api/validate`、`/api/config`。路线和天气只由聚合服务调用，没有新增可随意传入上游 URL 的代理接口。

## 4. 环境变量

根目录模板为 `.env.example`，实际配置文件与 `package.json` 同级：

```env
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
AMAP_API_KEY=
EVAL_MODELS=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
ALLOW_LOCAL_LIVE=false
```

新增变量为 `AMAP_API_KEY`。`.gitignore` 已忽略 `.env.local`，仅放行 `.env.example`。没有任何 `NEXT_PUBLIC_DEEPSEEK_API_KEY` 或 `NEXT_PUBLIC_AMAP_API_KEY`。配置变化后须重启本地服务。

## 5. DeepSeek Parser 调用链

首页／创建／救援文字 → `parseWithModel` → `/api/parse` → `DeepSeekSemanticParser` → DeepSeek `/responses` + `json_schema` → Zod 校验及事实证据归一化 → 用户确认。

SDK 包名是 `openai`，但请求 baseURL 为 DeepSeek，密钥与模型均读取 DeepSeek 变量。`OpenAISemanticParser` 只是兼容旧导入的别名。

真实页面复验发现上游偶发返回无效 JSON：Parser 仅针对结构损坏最多再调用一次 DeepSeek，第二次仍失败则返回解析错误并保留原文。网络、配置错误不转本地解析。模型输出损坏不再被误报成用户“请求无效”；普通回归已覆盖修复成功和两次都失败。

未知时间、酒店和活动名称不会补成示例值。缺结束时间的活动保存在 `activityMentions`；已完整的活动保存在 `existingPlans`。`missingFacts` 包含 `activity:<id>:location/startTime/duration`，关联已经识别的活动；确认不会要求从头逐行重建。

## 6–8. 高德调用链

| 能力 | 实际服务调用 |
|---|---|
| POI | 确认页 → `/api/world/context` → `WorldContextService` → `AmapPlacesService` → `/v3/place/text`、`around`、`detail`；需要行政编码时调用 `/v3/geocode/regeo` |
| 路线 | `WorldContextService` → `AmapRoutesService.batch` → `/v3/direction/driving`、`walking`、`transit/integrated` |
| 天气 | 变化与天气相关 → 必要时补查 adcode → `AmapWeatherService` → `/v3/weather/weatherInfo` 的 `base` 和 `all` |

多候选不由 LLM 替用户猜地点。目标地点多义时确认页展示高德候选；附近替代地点只是明确标注的推荐。

最多 5 个替代地点、40 对路线、3 个并发批处理任务；底层请求以 400 ms 间隔排队，缓存并合并同一请求。地点缓存 5 分钟，路线 2 分钟，天气 10 分钟，坐标转换 1 天。缓存的 `fetchedAt` 保留原抓取时间。

## 9. 坐标转换

浏览器获取 latitude、longitude、accuracy、capturedAt、source=`browser_geolocation`、coordinateSystem=`WGS84`。明确输入的位置优先。拒绝／超时则补问位置。

所有高德位置参数先经过 `CoordinateService`。WGS84 通过 `/v3/assistant/coordinate/convert?coordsys=gps` 转换；GCJ02 不重复转换。格式固定为“经度,纬度”，保留 6 位小数。转换失败不把原坐标重新贴上 GCJ02 标签。

已真实验证公开测试坐标 `(116.4, 39.9)` 转换为约 `(116.40624186, 39.90140272)`；此坐标不是用户设备位置。设备真实位置授权未代替用户执行。

## 10. RealWorldContext

```text
currentTime { value, date, source, confirmedAt }
currentLocation { id, latitude, longitude, coordinateSystem, city,
                  adcode, source, capturedAt, accuracy? } | null
resolvedPlaces [{ placeId, poi }]
alternatives [真实 POI]
routes [{ origin, destination, travelMode, distanceMeters,
          durationSeconds, trafficDurationSeconds?, fare?, source,
          fetchedAt, status }]
weather { condition, temperature, humidity, windDirection, windPower,
          forecast, source, fetchedAt, reportedAt, status }
dataFreshness { groundedAt, routeMaxAgeSeconds, locationMaxAgeSeconds }
missingWorldFacts [{ kind: user | world, field, message }]
ambiguities [{ field, label, candidates }]
travelMode
status: ready | needs_input | unavailable
```

用户缺失事实与系统查询缺失分别标记 `user`、`world`；不会把“坐标在哪”“路程多久”作为让用户填的表格。

## 11. Planner 输入／输出

输入为已确认原行程、变化、用户偏好、RealWorldContext 和上轮校验反馈。提示词与 Parser 独立。

输出 1–3 个候选：时间紧或固定安排多时可只返回一个，只有存在真实体验取舍时才增加候选。每个包含标题、取舍说明、保留／新增活动引用、移除理由。现有活动只传 eventId；新增候选只传已查到的 poiId 及建议停留时长。模型不返回经纬度、路线耗时或开始结束时间。

`materializeCandidate` 使用用户当前时间、高德路线秒数、原活动时长及固定预约时刻计算具体时间。未知活动、未知 POI、缺少可用路段、跨日安排直接拒绝。

## 12. Validator 与循环

继续使用锁定活动、时间冲突、过去活动、时长、预算及变更完整性等现有校验器。真实分支改查高德路线，向上取整到分钟，逐段判断是否赶得上。模型不得修改已确认活动时长和身份，不允许把未报告费用伪装成免费。

最多 2 次 Planner 调用，每次检查全部候选。失败的约束作为下一轮反馈；没有可行方案返回“目前没有找到满足全部硬约束的方案。”并显示冲突原因。

接受前检查浏览器会话版本、重新 Ground 并重新 Validate。确认时间超过 5 分钟要求更新；失败保留原行程和草稿。尚未接受的方案不提交到今日行程。

每条修改记录输入事实、决定、理由与证据；包含原活动重新排时间的记录。证据状态为 passed / failed / not_checked。未核实营业状态、费用或未请求天气不会被写成通过完整硬约束。

## 13–14. Mock 边界

真实流程移除了本地自然语言 fallback、Bangkok POI 补全、Mock 路线、默认天气、默认当前位置和 DemoPlanner。旧 `local` 请求也必须走真实服务；不能给真实快照标上 `demo` 来绕过。

本地目录、确定性 DemoPlanner、旧规则解析器仍供 `/demo`、离线测试和旧评测基线使用；它们没有真实用户 API 入口。真实结果页拒绝显示旧本地 Mock 待确认方案。

## 15. 当前限制

- 高德真实流程面向中国境内，泰国行程的真实路线不在本轮范围。
- POI 基础数据不证明实时营业、入场资格或预约名额，不能声称完整营业约束已通过。
- 路线为提供商查询时的预计耗时，公交班次、未来拥堵和景区具体入场口仍可能影响实际到达。未提供独立交通拥堵耗时的响应不伪造该字段。
- 本轮全行程使用一种用户选择的交通方式；地点与候选合计超过路线组合上限时明确停止。
- 已有活动时长须用户确认，不能由 Planner 自动压缩；新增停留时长只是建议。
- 费用不足时预算检查不完整；没有票务、酒店订单或支付系统。
- LLM 仍可能提出不可行或相似候选；Validator 拒绝不可行结果，候选比较显示理由。
- 匿名数据仅本浏览器保存。没有新增登录、账号同步或公网部署；公开上线前还需独立处理身份与调用额度管理。
- 浏览器定位成功／拒绝通过适配层测试覆盖，页面实测覆盖定位不可用后的补问；没有替用户授权真实设备定位。

## 16. 核心 regression 与验证结果

指定原句：

> 我十点要去故宫，但是我睡过头了，已经11:46了，我下午还要去故宫吗？因为我预约了下午5点的景点参观，同时下午3点需要和朋友在酒店集合去另一个景点，来得及吗？

真实 DeepSeek 已识别 10:00 故宫、11:46 当前时间、15:00 酒店集合、17:00 固定景点预约和睡过头；酒店及预约景点名称保留为待补。没有自动设置下雨或低体力。

统一 `/api/assist` 已验证：解析后先生成 Impact Analysis，只把会影响路线、地点歧义、固定约束或时间算术的缺失事实标为 blocking；预算、体力等非关键字段不阻塞。Planner 候选数量动态为 1–3 个，空闲时间窗由 Planner 决定保留自由、休息或新增活动。

主流程通过首页调用 `/api/assist`；页面默认直接进入 `/result`，只有存在会实质影响路线或固定约束的缺失事实时，才在首页弹窗补问。`/rescue` 仍保留为兼容的分析／编辑入口，不再是首次使用的强制步骤。

自动测试以显式测试答案补充“北京饭店”“天坛公园”和停留时长，选择返回的 POI 后进行 Ground → Planner → Validator。一次真实联调查到 9 对路线，其中部分不可用；不可用路段没有被本地数据替换。Planner 经两轮返回保留 15:00 集合和 17:00 预约的可行方案；保留长时间故宫参观但赶不上集合的候选被拒绝。

真实 HTTP 联调另验证了高德 POI、官方坐标转换、步行／驾车路线及天气实况和预报。公交接口既覆盖了无可用路线情况，也用另一对公开地点取得了实际公交结果。完整联调和仅语义复验现在分别写入 `work/live-provider-report.json`、`work/live-semantic-report.json`，避免后一次局部复验覆盖完整记录；上述完整联调结论来自本轮已完成的实际调用。

八个 Phase 均分别运行了 `npm run typecheck`、`npm test`、`npm run build`，修复失败后重新检查。测试包括模拟第三方 HTTP、数据隔离、固定预约、缺失路线、有限重试、天气按需查询和来源证据。生产 HTTP 冒烟覆盖已有页面、重定向、解析、Demo、防篡改和模式隔离。

复验命令：

```sh
npm run typecheck
npm test
npm run build
npm run test:semantic-live
npm run test:world-live
# 服务启动后
node scripts/smoke.mjs http://127.0.0.1:3000
```

`*-live` 会调用真实第三方并消耗对应账户额度；普通 `npm test` 只模拟 HTTP。

## 官方接口依据

- [DeepSeek Responses / Structured Output](https://api-docs.deepseek.com/api/create-response/)
- [高德 POI](https://lbs.amap.com/api/webservice/guide/api-advanced/search)
- [高德路线](https://lbs.amap.com/api/webservice/guide/api/direction)
- [高德天气](https://lbs.amap.com/api/webservice/guide/api/weatherinfo)
- [高德坐标转换](https://lbs.amap.com/api/webservice/guide/api/convert)

确认：自然语言解析与候选规划实际调用 DeepSeek；真实 POI、路线、天气来自高德；浏览器 WGS84 先转换；真实模式第三方失败不会偷偷 fallback 到 Mock。

## 2026-09-16 追加：先推断、查询验证、必要时单项追问

本节记录本次变更，不覆盖前文历史。本节取代旧章节中“交通方式默认必填”“所有活动时长都需补齐”“首页必须逐项确认事实”的描述。

### 行为与数据契约

- `/api/assist` 保持请求兼容，先合并 Parser 的完整活动、部分活动和已保存安排，再查询世界数据；只有真实歧义和无法查明的关键用户事实进入追问。`missingFacts` 返回当前最关键的一项，附带该项实际 POI 候选。优先最近固定预约地点，再出发地，再其他节点。
- “航班晚点＋刚到虹桥”生成上海虹桥国际机场查询候选，以高德返回的 POI、坐标和城市为依据。泛称“美术馆”即使遇到“上海美术馆”也不会仅凭名称自动选定。指定地点优先 GPS；唯一已有酒店可以解析“在酒店”。
- 新 `services/world/context-resolution.ts` 集中处理查询候选、名称匹配、有效 GPS 与出行限制。查询依据和最终 POI ID 保存在 `resolutionEvidence`，进入决策记录；推断不是用户亲自确认事实。
- WorldOptions 增加可选 `allowedTravelModes`；未指定 `travelMode` 自动比较。原有明确方式继续兼容。“不打车”等限制约束查询及校验。每轮最多 40 个不同起点／终点／方式组合，最多 3 并发；优先原安排及固定预约相关路段。某种方式失败可选其他真实路线，全部失败返回不可用。
- 候选 step 与结果 Event 增加可选 `travelMode`。自动比较时 Planner 必须选定已查询方式；代码排时、展示分钟数和 Validator 引用同一条路线。公共交通费用只使用接口提供值，未知费用不当作零。
- Event 增加可选 `durationSource: user | suggested | unknown`。普通活动缺时长保留，Planner 可建议 10～180 分钟。最后固定预约缺结束时间以 `endTime === startTime` 加 `durationSource=unknown` 表示“仅到达锚点”；页面显示“结束时间未提供”，Validator 不将它当作零分钟已完成活动，不允许其后安排活动。若影响后续固定预约则追问时长。
- 首页补问保留一个自然语言框与真实地点候选按钮。补充内容附加在原文后，选定 POI 通过 `venueSelections` 传回。先服务端解析，确实缺出发地时再尝试浏览器定位一次；拒绝后显示地点问题。
- 保留 SessionRepository、真实／Demo 隔离、旧接口与有限两轮重规划；接受方案重新取得真实地点与路线校验，失败不替换正式行程。

### 主要文件

新增：`services/world/context-resolution.ts`、`evals/assist-resolution-tests.ts`、`scripts/test-assist-live.mjs`、`scripts/smoke-browser.mjs`、`scripts/package-source.ps1`。

修改：`agents/agent-orchestrator.ts`、`agents/replanning-agent.ts`、`services/world/world-context-service.ts`、`services/world/amap-places-service.ts`、`services/deepseek-planner.ts`、`services/impact-analysis.ts`、`validators/index.ts`、`validators/travel-time-validator.ts`、`types/index.ts`、`types/world.ts`、`components/workflows.tsx`、`evals/world-tests.ts`、`scripts/test-live.mjs`、`tsconfig.json`、根 README 与交付说明。没有新增 API 路由或环境变量；没有部署。

### 验证记录（真实调用与模拟测试分开）

1. `npm run typecheck`、`npm test`、`npm run build` 均通过。模拟 HTTP 回归覆盖：虹桥城市推断、自动三种交通、餐厅单项追问、补充答案保留、多 POI 选择、不打车限制、全部路线失败、唯一酒店、过期 GPS、完成活动隔离、未知时长与固定预约到达锚点、方案接受复核及交通方式篡改拒绝。
2. 生产服务在构建完成后重新启动。HTTP 冒烟通过现有页面／接口、首页 9 个脚本资源、重定向、生产评测隐藏、锁定事件篡改拒绝与真实／Demo 隔离。`smoke.mjs` 中的 Demo 场景不是对真实供应商规划成功的证明。
3. 实际 DeepSeek＋高德复验：原句无餐厅信息返回单项晚餐地点问题；显式 TEST Session 指定上海美术馆（中华艺术宫）、上海和平饭店龙凤厅，以及测试当前时间 12:00 后，进入 Planner 并生成通过 Validator 的方案。取得 12 条真实路线记录，覆盖步行、公共交通、驾车；18:00 晚餐保留。真实查询发生于记录时间，测试 12:00 不表示当时真实墙钟时间；不把该试验作为未来交通保证。
4. 原始本地记录为 `work/assist-resolution-live.json`、`work/assist-resolution-live-ready.json`；最终复验 `work/assist-resolution-live-retest.json` 的时间为 2026-09-16T13:26:30Z。`work` 不进入源码包。可用下面命令独立复验（消耗实际 API 额度）：

```sh
node --env-file-if-exists=.env.local scripts/test-assist-live.mjs
```

### 仍有边界

浏览器补充验证：`scripts/smoke-browser.mjs` 使用独立、无用户历史数据的 Edge 会话，在 390×844 视口通过首页水合、真实 DeepSeek＋高德单项晚餐追问、无城市／交通方式表单与键盘回答提交。初次请求真实联网，补充回答的响应刻意拦截为测试结果，仅验证提交内容保留，不宣称该次补充又做了真实规划。无页面 JavaScript 错误。截图及报告保存在 `work/assist-mobile-smoke.png`、`work/browser-smoke-report.json`。浏览器控制连接器两次连接失败后改用本机独立浏览器测试，未改用户浏览器数据。

该浏览器脚本需要测试环境提供 Playwright（可通过 `PLAYWRIGHT_MODULE_PATH` 指向已有安装）及 Edge，不为应用新增依赖。运行 `node scripts/smoke-browser.mjs http://127.0.0.1:3000/`。

- 虹桥机场父 POI 不是航站楼、登机口或用户精确坐标；短时间接驳及机场内部移动没有专门建模，不能承诺这部分到达时间。
- 商户实时营业、排队、门票与未来交通仍不由当前 POI 基础查询保证。天气按需读取；本次虹桥案例未请求天气，天气回归主要沿用现有模拟测试和此前独立真实联调记录。
- 地点别名和语境规则有限；真正无法消歧时仍需要一项选择。浏览器 GPS 的时间与精度会验证；普通文本位置没有新的独立过期时间字段，沿用当天 Session。
- LLM 输出仍可能失败或给出不可行候选；最多两轮，不以 Mock 替代。最后固定预约结束未知时保守终止后续安排。
- 手机竖屏视觉设计本轮未重做，账号同步未实现。
