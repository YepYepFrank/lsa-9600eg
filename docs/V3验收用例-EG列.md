# V3 验收用例对照：EG 列核对（EG 0.3.0）

用途：核对后端库 `docs/V3验收用例对照.md` v1.0 的「EG 侧自检」列，并补全 EG 侧缺口。

依据：EG 库各自检脚本的步骤号，2026-10-08 逐个核过。本表供后端合并进总表。

**怎么跑**：在 EG 库根目录执行 `pnpm <脚本>`。
- g0–g5、i1–i4、ui：在开发样机上跑（dev:up + dev:emu + dev:agent）。
- 阶段 A 那几个（a / a:prod / a:e2e / a11）：都能对虚拟样机或现场 EG 跑，设 `EG_AGENT_URL`、`EG_CONFIG_DIR`；e2e 和 a11 的还原还要 `EXT_BASE` + `EXT_PASSWORD`。

**脚本名改正**：原表写的 `verify:g4` 等是 agent 包里的名字。根目录应写 `g4:verify`；阶段 A 的根目录名是 `a:verify`、`a:prod:verify`、`a:e2e:verify`、`a11:verify`（16f9d45 起有）。

| 编号 | 原表 EG 列 | 改为（EG 侧自检，步骤号） | EG 侧缺口 / 实机要做的 |
|---|---|---|---|
| A01 | — | `g0:verify`（仿真器 → 总线 → IoT Gateway → 本地 TB → 子站，整条链路通、按原时刻落库）；`g1:verify` 1（总线格式与点表目录一致：key、单位） | EG 只转发同事程序给的值，不改数。**实机**：寄存器原值 → 同事程序 → EG 本地页 → 子站页面，四处截图 |
| A02 | — | `g4:verify` 5（区域温升：eg-agent 派生 ir.R<n>.rise = 区最高 − 本柜 SAM env.t，两者时间差 ≤ 15 s 才出值）、7（环境温度缺或失效 → 温升不出值、质量码标它，不补 0） | 露点 EG 不算（子站算）。**实机**：T04 温湿度来源定了以后核对 |
| A03 | `verify:g4`、`verify:a` | `g4:verify` 9（**只断可见光主码流** → 探测失败、cam.online = 3，测温照常）、10（测温源不可达后自动恢复）；`a:verify` 3（cam.vis / cam.ir / cam.rest 三路分开）；`g5:verify` 4（断流期间可见光证据标 MISSING / 缺口，同一窗口的热像照常 READY） | 原表「只断一路没有自检」，EG 侧其实有（g4 第 9 步、g5 第 4 步）。子站页面只标该通道仍要实机看 |
| A04 | `verify:g1`（换算口径请 EG 确认） | `g1:verify` 1（us.amp 单位 dBμV 与点表一致） | **EG 不换算**：寄存器 258 → 25.8 由同事的采集程序按点表做，EG 原样转发 us.amp。**实机**：T05 / T06 定了后，看同事程序的输出 → EG → 子站 |
| A05 | `verify:i4` | `i4:verify` 2–6（应用、本地告警随之变、停用整类、不认识的规则跳过、PENDING 排队后自动应用、失败回原因且不改本机、重复下发）；`a11:verify` 1–3（errorCode 七类、requestId 原样带回、票据 401 的 TICKET_TIME / TICKET_INVALID） | — |
| A06 | `verify:i2` | `i2:verify` 2–3（剪断上行 → 恢复后实时优先、限速补传、按原时间补齐） | — |
| A07 | `verify:a`（§13） | `a:verify` 2（SAM 停发 → OFFLINE、dev.link 0、fails、TIMEOUT，恢复 → ONLINE）；`g1:verify` 7（PM6 整台停发 → 质量码 invalid，其他设备不受影响） | 自检停的是 SAM / PM6，电表走同一路径。**实机**：拔电表 485 线 |
| A08 | `verify:i3` | `i3:verify` 2–5（钩子直达、恢复、伪造钩子不收、子站不在期间发生又恢复 → 只送一条、时间正确） | — |
| A09 | — | — | 确认只在子站做，EG 本地告警状态不随子站确认改，所以 EG 侧无项 |
| A10 | `verify:i2`、`verify:a:e2e` 3 | `i2:verify` 0b（大批补传切批 ≤ 500 条 / 48 KB）、3–4（按原时间补齐、重启本机组件不丢）；`i3:verify` 5–6（同一事件只留最新 revision、钩子漏了对账补） | 去掉 `a:e2e` 3：那是「pending 期间不补传」，和 A10 无关，应归 A18 |
| A11 | `verify:g5` | `g5:verify` 1（双光子码流循环录像）、2（告警触发：双光视频 + 抓图 + 录波，sha256 与索引一致）、3（锁定 ACCEPTED / PARTIAL / EXPIRED、同事件共用一组）、4（断流标缺口）；`g4:verify` 3（主码流按需拉，看完 20 s 内断） | **实机**：T13 录像策略；实际播放核对双光时间区间 |
| A12 | `verify:g5`（断点续传、归档前不删） | `g5:verify` 0（临时库：唯一副本到期不删；盘满兜底按 已上传 → 不需上传 → 待上传 的顺序删，降到 highWater 停，删到待上传时给告警条数与最早时刻）、2（文件 sha256 与索引一致）、6（重要证据送子站，子站按 sha256 校验） | **传输方式已定**（用户 2026-10-08 拍板）：失败整份重传 + sha256 校验，不做分段续传。「确认归档前不删唯一副本」0.3.0 起；盘满兜底与 EG 告警「证据未上传即被清理」0.3.2 起，实机用占位文件撑满数据盘验过（评审记录） |
| A13 | `verify:g5`（循环覆盖跳过锁定） | `g5:verify` 3（早于循环覆盖 → EXPIRED、部分 → PARTIAL，如实标）、4、5（eg.evid_full / eg.rec_ok / eg.evid_pending 上报） | 锁定的证据由 agent 另存成文件，循环录像的覆盖和水位清理不碰它。这是设计保证，没有「写满盘」的断言。**实机**：持续录像写满盘的容量测试 |
| A14 | — | — | 总负荷在子站算 |
| A15 | — | — | 评分在子站 |
| A16 | — | — | 巡检在子站 |
| A17 | `verify:g1`（质量码看护） | `g1:verify` 7（停发 → stale / invalid）、8（同事程序报的 q 与看护合并，优先级 invalid > calibrating / warmup > stale） | 同事程序要报 warmup / calibrating（《EG 内部 MQTT 格式》§6）。**实机**：颗粒物 / SAM 上电预热期间看 q |
| A18 | `verify:a:prod` | `a:prod:verify`（production 口径；`EG_A_READONLY=1` 可只读核对真子站下发的配置：EG-arc / EG-pm 经 offCabs 关，PM6 不进本地也不上送）；`a:verify` 1、1b（unsupported 整台不进本地也不上送，pending 进本地不上送）；`a:e2e:verify` 1–3（经子站能力接口改 pending → unsupported → confirmed，子站与 EG 两头看，pending 期间不补传） | — |
| A19 | `ui:verify`、`verify:i4` | `ui:verify`（会话、证据 / 流反代路径白名单、LAN1 一律 403）；`g2:verify` 1、4–5（票据验签严格、经子站单点登录、只读 / 维护权限）、2（本地账号锁定）、10（审计）；`i4:verify` 1（配置只认服务票据）；`a11:verify` 2（票据各类错误 → 401 + code） | **实机**：LAN1 防火墙（部署手册 §6d，`install.sh --fw-on`）从摄像机网段连 22 / 80 / 8554 都不通 |
| A20 | — | 无自动化 | EG 侧的恢复办法：换 EG = 新装 + 子站重新生成 eg.yaml 并下发配置（部署手册 §6c）；回退 = `install.sh --rollback`。EG 本地的 events.db、outbox、证据不备份：重要证据已上传子站，告警以子站为准。**实机**：按 §6c 换一台 EG 演练一次并记录 |

## 本次核对新发现、已处理的

- **A12「归档前不删唯一副本」**：原先到期就删，没上传的也删。0.3.0（16f9d45）改为：要上传、未确认归档的不删。
- **A10 行引用错误**：原表把 `a:e2e` 3 归到 A10，它测的是「pending 期间不补传」，应归 A18。
