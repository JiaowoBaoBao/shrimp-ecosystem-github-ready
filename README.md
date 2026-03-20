# 《虾系进化生态场（Shrimp Evolution Ecosystem）》V4.6 方案说明书

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0-43853D?style=flat-square&logo=node.js)
![OKX Trade Kit](https://img.shields.io/badge/OKX_Agent_Trade_Kit-Deep_Integration-black?style=flat-square)
![Status](https://img.shields.io/badge/Status-Demo_Ready-success?style=flat-square)
![License](https://img.shields.io/badge/License-TBD-lightgrey?style=flat-square)

### OpenClaw + OKX Agent Trade Kit（Demo-first）

## 0. 项目摘要
虾系进化生态场不是单一自动下单器，而是一个多智能体交易生态系统。  
6 个代理在统一风控与审计框架下持续竞争、复盘、进化、淘汰与补位。  
系统目标同时优化三件事：收益质量、风险控制、可解释性与可复验性。

---

## 1. 方案定位
系统以“策略生态”而非“单策略”建模：  
6 席代理围绕不同市场风格协同工作，运行中通过评分、状态机和进化机制动态调整执行资格与预算，形成持续迭代的交易群体。

---

## 2. 技术边界与原则
- 核心框架：OpenClaw + OKX Agent Trade Kit  
- 默认环境：Demo-first  
- 执行主线：Spot + Swap（并保留 Futures 执行能力）  
- 原则：合规优先 > 风控优先 > 收益优先

---

## 3. 架构分层
1. **治理层（OpenClaw）**：调度、评分、HR 状态机、风控、审计、报告  
2. **执行层（OKX Trade Kit）**：行情读取、下单执行、回执解析、账户与持仓查询  
3. **验证层（Replay / A-B）**：审计回放、基线/变体评估、长窗口验证

---

## 4. 六席角色
- A1 虾菲特：价值/收益  
- A2 虾弗莫尔：趋势  
- A3 虾蒙斯：均值  
- A4 虾尼斯：突破  
- A5 虾鲁肯：事件观察  
- A6 虾里奥：风险防守

---

## 5. 触发机制（五层）
### 5.1 总开关触发
- `shadow_only=true`（默认影子模式）  
- `demo_trade=true`（进入模拟执行）  
- `arm_write`（写单授权，带 TTL）

### 5.2 定时触发
- `round_tick`：轮次决策与执行  
- `epoch_close`：周期收口与状态评估  
- `evolution_tick`：进化/补位/语义突变  
- `weekly_report`：周报  
- `copilot_brief`：早报摘要

### 5.3 事件触发（A6 风险）
当回撤、波动、点差等指标触发 RED，自动执行 Kill Switch：  
停新单 → 撤挂单 → reduce-only 去风险。

### 5.4 状态触发（HR）
`ACTIVE -> WARN -> PIP -> ELIMINATED -> REVIVAL -> ACTIVE`

### 5.5 安全门禁触发
写单需同时满足：  
`demo_trade + writeEnabled + arm + 时间窗口 + 风控通过`

---

## 6. 决策与执行闭环
每轮执行流程：  
行情输入 → 六席信号 → pre-trade 风控门禁 → 执行路由与下单 → 回执写回 → 账户/状态更新 → 审计写账本。

执行层深度调用 OKX Agent Trade Kit，核心包括：

- **执行路由与下单**：按动态执行席生成订单计划，调用 OKX 原生下单能力（Spot/Swap/Futures），并支持 TP/SL 参数编译（`tp/sl trigger`）。  
- **冲突消解与归因**：同一轮同标的仅允许一个代理进入实单路径，其余自动 shadow，保留 `inst-conflict-shadow` 记录；归因采用 `intentId -> ordId/clOrdId -> agentId`。  
- **成本与边际约束**：执行前进行成本门禁（fee + spread + slippage 估算），edge 不足覆盖成本自动跳过。  
- **回执写回**：解析 OKX 回执关键字段（`ordId/clOrdId/state/avgPx/fillSz/sCode`），并沉淀到 execution/audit ledger。

---

## 7. 动态执行席与预算分配
- 执行策略：`dynamic_top5`（Top5 EXEC + 1 Shadow）  
- 切换防抖：`switch_confirm_epochs` 连续确认后晋升/降级  
- 预算分配：基于综合分进行 softmax 归一并设边界约束

---

## 8. 评分体系（内核）
\[
Score_i = 0.25RQ_i + 0.20CF_i + 0.25RC_i + 0.15ES_i + 0.15CP_i
\]

- RQ：收益质量  
- CF：反事实评分  
- RC：风险控制  
- ES：执行稳定性（拒单/超时/延迟）  
- CP：合规纪律

---

## 9. 反事实评分（DecisionAlpha）
\[
DecisionAlpha = R_{act} - \max(R_{nt}, R_{rev}), \quad R_{nt}=0
\]

用于回答两件事：  
1) 交易是否优于“不交易”；  
2) 是否优于“反向交易”。

---

## 10. 风控硬约束与 Kill Switch
- 单笔风险预算、日/周回撤、止损强制、白名单、杠杆上限  
- 命中硬红线直接阻断（`hard-violation`）  
- Kill Switch 固定动作：Stop New Orders → Cancel Open Orders → Reduce-Only

---

## 11. 单轮同标的冲突策略与归因
- 同一轮同一标的仅允许 1 个代理实单  
- 其余代理自动 shadow，记录 `inst-conflict-shadow` 与 `lockOwner`  
- 全链路保留 `intentId/ordId/clOrdId/agentId` 绑定

---

## 12. 进化算法（数值 + 语义）
- 数值突变：参数小步扰动，先 shadow 后执行  
- 语义突变：失败归因触发 patch  
- 语义安全：可改字段白名单 + 不可变规则保护 + 校验失败阻断  
- 审计增强：突变过程记录 hash、patch 与 safety 结果

---

## 13. 模拟层隔离（Sim Safety）
- `SIM_ENGINE_MODE` 启用后，写单链路硬阻断（`sim-engine-write-blocked`）  
- `run_task` 在 sim 模式下执行白名单控制，防止误触交易写调用

---

## 14. A/B 创新有效性
- baseline / variant 对照  
- sample gate 最小样本门槛  
- 长窗口分段评估（long window + segment）  
- 报告导出：`output/ab-report.json`、`output/ab-report.md`

---

## 15. Trading Copilot 场景
- 默认影子模式  
- 早报推送（适应度变化、反事实提醒、A6 风险预警）  
- 推送与看板分析联动

---

## 16. 可视化与审计
- 六席状态、执行资格、账户面板、结构分析卡片  
- DecisionAlpha 趋势图与趋势解读  
- 审计回放 PASS/FAIL  
- A/B 指标与长窗口差分展示

---

## 17. 复现与工具链
常用命令（统一入口）：
- `node scripts/run_task.mjs round_tick`
- `node scripts/run_task.mjs epoch_close`
- `node scripts/run_task.mjs evolution_tick`
- `node scripts/run_task.mjs audit_replay`
- `node scripts/run_task.mjs ab_runner`
- `node scripts/run_task.mjs export_submission_bundle`

---

## 18. 交付清单
1. 六席配置与版本  
2. Demo 运行日志与执行回执  
3. 日报/周报与推送样例  
4. 风控与进化事件记录  
5. 审计回放结果  
6. A/B 报告（含长窗口）  
7. 一键复现提交包（`output/submission_bundle/`）  
8. 可视化看板与说明文档

---

## 19. 四维评分对齐（评审快速索引）

本项目严格围绕 OKX Agent Trade Kit AI 赛道的四大评审维度进行设计与交付，核心结论如下：

1）**结合度（Integration，权重 25%）**  
本项目的结合度主要体现在 Section 6、10、11。系统不是只做下单调用，而是把执行计划、风险门禁、冲突消解、订单回执和席位归因串成完整链路，形成 `intentId -> ordId/clOrdId -> agentId` 的可追溯闭环。评审可直接从执行与审计账本验证“谁决策、谁执行、谁承担结果”。

2）**实用性（Utility，权重 25%）**  
本项目的实用性主要体现在 Section 10、15。系统默认 Demo-first，并具备多重写单门禁、A6 风险熔断（Kill Switch）、影子模式与日报/早报联动，能够在不直接上实盘的情况下提供稳定、可解释的交易辅助能力，解决“黑盒失控”和“风控滞后”的实际痛点。

3）**创新性（Innovation，权重 30%）**  
本项目的创新性主要体现在 Section 8、12。系统通过 DecisionAlpha 评估“交易是否优于不交易与反向交易”，减少运气噪声；同时引入数值进化与语义进化，并对语义补丁增加安全校验与审计哈希链，兼顾迭代速度与安全边界。

4）**可复制性（Reproducibility，权重 20%）**  
本项目的可复制性主要体现在 Section 17、18。系统提供标准化 CLI 任务入口（`run_task`）、审计回放（`audit_replay`）、A/B 报告（`ab_runner`）和一键交付包（`export_submission_bundle`），评审可以按固定步骤快速重跑验证，复现实验路径清晰。

综合评分口径为：  
\[
\text{Total}=Integration\times0.25+Utility\times0.25+Innovation\times0.30+Reproducibility\times0.20
\]

补充说明：交付包包含可复现所需配置、脚本与审计产物；运行态敏感信息（真实密钥、私有推送目标）不进入公开发布目录。
