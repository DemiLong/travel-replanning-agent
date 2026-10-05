# 第六步验收记录

基线：本地 main 的 `b6e7898`。本阶段改动未提交、未推送、未部署；未操作 Supabase 数据。

## 已完成

- 将集中类型定义拆成 travel、activity、workflow、agent、session 五个模块；统一入口仍导出原有全部 72 个公开符号。
- Session 升级为 v5，仅读取 `travel-session-real-v5`。缺失、无效 JSON 或不符合 v5 的数据回退到 starter session。旧浏览器键及其原始值保留，但不读取或迁移。
- 当前默认值与过期状态修复移入 `services/session-state.ts`。过期草稿、过期补问、revision 冲突、展示时钟与持久化时钟隔离仍受测试保护。
- 删除 pending plan 的 accepted、pending input 的 stage、legacy protection source、旧迁移路径与无人调用的兼容接口。
- 删除 58 个无调用 UI 组件和 use-mobile Hook，保留 Checkbox、Drawer、Table；移除 14 个无调用直接依赖及 58 个 lockfile 包条目，保留包的版本没有变化。
- 旧文档归档到 `docs/archive/`；旧 001 SQL 移到 `supabase/legacy/` 并标明不可应用。当前 Supabase 配置说明只指向 002 SQL。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| typecheck | 通过 |
| lint | 通过，无错误或警告 |
| 完整单测 | 9 组入口全部通过，含新增契约静态检查 |
| 浏览器受控回归 | 35/35，通过六路由、三条保存路径、补问、错误、取消和并发检查 |
| activity-integrity QA | 17/17，受控数据与真实页面交互 |
| 普通生产 build | 通过，使用正常配置独立构建 |
| 类型导出/契约对照 | 72 个公开符号保留；45 个原有初始化定义的对照只发现本阶段明确修改的契约及两处局部变量更名 |
| 废弃符号与依赖扫描 | 生产源文件无旧活动字段、旧接口或已删除依赖引用 |
| 差异空白检查 | 按 Windows CRLF 规则通过，见下述命令 |

原有 `SYSTEM_ERROR` / `NEEDS_INPUT` 单测差异在本阶段开始前已经消失，本次完整单测无基线豁免项。

`/evals` 保持仅开发可见：开发页面 HTTP 200、无报告状态正常渲染；通过受控报告的静态渲染检查保留的 Table；生产浏览器回归确认 HTTP 404。开发验证没有浏览器异常或外部认证请求，截图位于忽略目录 `work/stage6-verification/evals-development.png`。

活动完整性证据：`qa/activity-integrity/runs/2026-10-05T06-16-04-070Z/report.html`、`results.json`、页面截图与 trace。该目录被 Git 忽略。

本仓库的既有 lockfile 使用 CRLF；普通 Git 空白检查会将新增行的 CR 识别成尾随空白。本次保留原换行格式以避免整文件差异，使用 `git -c core.whitespace=cr-at-eol diff --check` 校验。

真实 DeepSeek、高德及 live 浏览器测试没有运行；以上受控回归不代表真实服务质量验收。模型、地图与认证配置内容未修改。
