# 活动完整性与重新提交验收

从项目根目录运行。页面用例需要先启动本地服务：

```powershell
npm run dev
```

另开终端执行基础验收：

```powershell
node --import tsx qa/activity-integrity/run.mjs
```

项目已有 `.env.local` 且需要验证真实模型和高德链路时，执行：

```powershell
node --env-file=.env.local --import tsx qa/activity-integrity/run.mjs --live
```

R01 的固定数据验收与实际页面截图：

```powershell
node --import tsx qa/activity-integrity/r01.mjs
```

真实模型与高德的分阶段诊断（原始提取、必要时的条件核对、归一化、活动 ID、规划请求、地点查询、最终方案）：

```powershell
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=R01
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=R01_ORIGINAL
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=L02_SPACE
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=C02
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=D04
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=I02
```

全新浏览器会话提交 R01 原句，地点多候选逐项选第一项并截图：

```powershell
node --import tsx qa/activity-integrity/r01-live-browser.mjs
```

L02、C03 的真实分阶段诊断，以及本轮时间状态、D02 两方案交通标签、R01 弹窗分区和首页焦点的受控页面验收：

```powershell
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=L02
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=C03
node --env-file=.env.local --import tsx qa/activity-integrity/diagnose.mjs --case=fixed_unknown
node --import tsx qa/activity-integrity/round-two.mjs
```

L02 的诊断记录模型原始时间、归一化、`activityFacts`、草稿和规划请求；C03 还记录可用交通方式、实际查询路线、候选与校验结果；`fixed_unknown` 记录真实模型对固定但无时间活动的事实与条件性建议。`round-two.mjs` 的接口与页面用例明确标为受控测试，D02 两张方案截图展示实际结果页的交通标签；真实模型／高德结果以各自的诊断报告为准。

每次运行创建 `qa/activity-integrity/runs/<时间戳>/`，其中有可本地打开的 `report.html`、逐项断言 `results.json`、每项对应截图以及 Playwright trace。`ui-reanalysis.png`、`ui-result-before.png`、`ui-result-replan.png` 是浏览器页面交互截图；其余截图是断言证据卡。第 7 项使用受控地点候选来验证补问状态；`--live` 的第 11 项使用项目已配置的真实模型和高德服务，并在出现地点候选时选择第一个候选继续到最终状态。报告将受控测试和真实模型／高德测试分别标明。

断言覆盖：首次提交不经过整表核对、无原定时间的多个原安排、未完成与已完成、已识别活动误分类修正、已保存弹性活动防丢失、候选方案逐项记账、单项分类和地点补问、旧补问放弃后重新提交、旧核对会话迁移、结果页返回修改原话、固定预约时间未知的条件性结果。系统只能严格核对已保存和已识别的活动；不能仅凭同一份解析结果证明模型没有漏识别原文。所有本次新增测试脚本和说明均在本目录；`runs/` 已被 Git 忽略。

R01 的新增验收还覆盖：模型原始输出漏项时的独立原文检查、补抽和安全停止；最终取舍与概述及说明的一致性；`mixed` 活动的方式依据与未知状态；完整弹窗、活动理由与删除理由的实际页面截图。真实诊断记录高德查询词、城市、候选数和安全错误类别，不记录密钥。历史笼统的“地点数据暂不可用”无法追溯到当时的高德错误类别；新诊断用于捕获下一次同类故障，不据此猜测接口版本。受控与真实报告分别标明，不把测试规则变更算作产品修复。

一次真实诊断在两项原安排和高德地点候选均完整的情况下返回 `NO_SAFE_PLAN`：候选把新增地点接在第一项原安排之后，但地点服务当时没有查询这一段路线；另一候选的说明声称替换仍被保留的原安排。路线查询现按可用查询预算，为实际提供给规划器的替代地点补齐与每项原安排之间的双向路线；说明矛盾继续拒绝。修复后的真实诊断和全新浏览器会话分别以独立时间戳保存，出现 `NO_SAFE_PLAN` 时浏览器用例立即停止，不把旧地点卡再次点击为成功。

## 2026-09-29 链路收简后的测试口径

以上早期记录描述的是当时版本，不代表当前默认调用次数。当前正常成功路径为一次 DeepSeek 解析、一次高德 Grounding、一次 DeepSeek 规划、最后代码校验；独立覆盖仅在证据异常或角色冲突时调用，闭店对象错配时先做针对性的地点关系核对。`run.mjs` 的旧独立覆盖断言只检验该工具本身，并非声称每轮都会执行。结果页返回首页编辑会保留旧方案，只有提交新描述才使其失效。新增受控断言覆盖“18 点”证据、跨城 POI 阻断、纯备选 OUT_OF_SCOPE，以及返回旧方案；真实诊断新增 L02_SPACE、C02、D04、I02。真实运行以每个时间戳的 JSON/HTML 为准，不能把一次 READY 当作重复稳定性证明。
