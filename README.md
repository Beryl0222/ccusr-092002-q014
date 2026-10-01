# 医护供给规划版本库

维护执业医师、注册护士和基层服务能力的区域规划情景与兑现证据，核心是**假设审议与情景共识服务**：

- 以 `contracts/workforce_scenario.json` 的 2030 年目标、单位、统计定义、地区代码和来源时效为**公共基线**；
- 医院、基层机构、教育部门、财政部门分别提交带来源、适用地区、时间范围与置信区间的假设；
- 单位冲突、统计口径不一致或来源过期时，假设**先进入澄清流程，不能直接求和**；
- 研究人员只能把通过兼容性检查的假设组合成候选情景，运行逐年推演与敏感性分析；
- 反对意见和少数方案随版本保存；评审成员披露利益关系后才能表决；
- 正式发布冻结输入快照、计算程序指纹和审批记录；新数据只能另起修订版；
- 决策者查看任一指标时，可看到假设链、未解决分歧、替代情景，并在相同快照上复现结果。

服务只保存**机构级汇总假设与治理记录，没有个人医护档案入口**。

## 基线契约

`contracts/workforce_scenario.json` 的 `baseline` 段定义公共语言：

| 内容 | 说明 |
| --- | --- |
| `snapshot_id` / `target_year` / `first_projection_year` | 基线快照 `BASE-2030`，推演窗口 2026–2030 |
| `currencies` | 登记单位：`headcount`、`headcount_rate`、`fraction`、`percent`（与 fraction 同源可自动换算）、`service_visits`、`index` |
| `fields` | 可提交变量：退休率、培训完成率、年招生、跨区净流动率、人均效率等，含单位、职业适用范围与取值边界 |
| `regions` | 全国/东部/中部/西部/省的层级代码 |
| `national_targets` | 2030 年执业医师 500 万、注册护士 700 万（医师不含执业助理医师） |
| `stocks_2025` / `initial_inputs_2026` | 基准存量与基线初始输入 |
| `source_max_age_days` / `stale_exceptions` | 来源时效阈值（默认 730 天，效率类 1095 天） |

## 核心规则

1. **不可比不得求和**。提交即校验单位、口径、地区、职业、时间窗、取值边界、置信区间和来源时效；任何阻断性问题令假设状态变为 `clarification`，只能在澄清后更正重提（`reconcile`）或撤回（`withdraw`）。
2. **兼容才能组合**。候选情景必须满足：无未决澄清、同一投影单元（字段×职业×地区×年）只有一个假设、必要变量无覆盖缺口、省级净流动通过全国平衡带（±2%，避免"所有地区同时净流入"）。
3. **推演透明**。逐年递推 `存量_end = 存量_start + 招生×完成率 − 退休 + 净流动`，服务能力 = 存量×人均效率；每行记录每个输入的来源（假设或基线默认值）。
4. **敏感性可追溯**。对每个带置信区间的假设分别取上下限重算，标记哪些变量翻转了达标结论，并按效应幅度输出 tornado 排序。
5. **冻结不可变**。发布封存输入快照指纹（SHA-256 规范 JSON）、计算程序指纹（引擎版本+模型源码哈希）、全部投票（含披露快照）和异议；之后新数据只能开立修订版，重新走情景与表决。

## HTTP 接口

启动：`npm start`（默认 8000 端口；`WORKFORCE_DATA_FILE=path.json` 可持久化），`npm run check` 检查服务身份。

| 方法 路径 | 用途 |
| --- | --- |
| `GET /health` `/baseline` | 服务身份、公共基线 |
| `POST /sources` · `POST /sources/:id/supersede` | 来源登记与替代标记 |
| `POST /assumptions` · `GET /assumptions` | 提交假设（冲突返回 202 + 澄清单）、列表 |
| `GET /clarifications` · `POST /clarifications/:id/resolve` · `.../threads` | 澄清列表、更正/撤回、讨论 |
| `GET /disagreements` | 同投影单元的分歧 |
| `POST /scenarios` · `GET /scenarios/:id` · `POST /scenarios/:id/dissent` | 候选情景、异议/少数方案 |
| `POST /scenarios/:id/runs` · `GET /runs/:id` | 推演+敏感性分析 |
| `POST /runs/:id/reproduce` | 在相同快照与程序指纹上复现 |
| `GET /runs/:id/lineage?metric=physician.stock_end.2030` | 指标的假设链、来源、未决分歧与少数方案 |
| `POST /reviewers` · `POST /disclosures` | 评审成员、利益关系披露 |
| `POST /releases` · `POST /releases/:id/votes` · `POST /releases/:id/publish` · `GET /releases/:id` | 提案、表决（未披露返回 403）、冻结发布、读取封存版本 |
| `POST /releases/:id/revisions` · `POST /revisions/:id/bind` | 基于冻结版本开立修订版并绑定新情景 |

## 种子叙事

`npm run seed -- [data.json]` 构建完整示例：四方提交假设；万人/年单位、含助理医师口径、2021 旧来源三类提交分别进入澄清并更正；共识情景与财政高退休率少数情景分别推演；披露后四方表决冻结 R1（附财政异议）；2027 扩招数据另起 R2 修订版。

## 开发与测试

```bash
npm test     # node:test，24 个用例：契约/校验/澄清/兼容性/推演/敏感性/血缘/治理/HTTP
npm run check
```

源码位于 `src/`：`baseline.js`（基线与单位）、`assumptions.js`（提交、澄清、兼容性）、`model.js`（推演、敏感性、指纹、血缘）、`governance.js`（披露、表决、冻结、修订）、`store.js`（内存/JSON 存储）、`service.js`（HTTP）。
