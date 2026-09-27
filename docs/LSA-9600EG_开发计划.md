# LSA-9600EG 边缘网关端 · 开发计划 v0.5

> 日期：2026-09-27。**v0.5：本地管理页的界面基线换成领导 80e01ad 的单柜界面**（本柜总览 / 电气量 / 事件与录像 / 设备与通信，已接真实接口，见 `单柜主界面设计与预览.md`、`EG本地接口.md`）。v0.3 于 2026-09-24 经用户批准；**v0.4 按用户 2026-09-27 的决定改写：EG 本地跑独立 ThingsBoard CE，不再用 TB Edge**（后端库 `docs/EG独立TB调整方案.md`，接口约定 §8 冻结），G 系列之间插入的 I1–I5 已完成，实施结果见 §7 与 `评审记录.md`。
> 依据：后端库《EG / SAM 接入规范》、《EG独立TB调整方案》、模拟器 `apps/sim`、拟采购硬件《X26A-J1900/J2900 双网口 6 串口 6USB 工控主机》。
> 里程碑前缀 **G**（EG 端）与 **I**（改独立 TB，协调会话「子站一级系统技术栈分析」派活）。未明确处先按推测做，评审时改；待确认点记在 `评审记录.md`。

## 1. 硬件与网络

**拟采购：新创云 XCY-X26A（J1900 / J2900）**

| 项 | 规格 | 对本项目的意义 |
|---|---|---|
| CPU | Intel 赛扬 J1900 / 奔腾 J2900，4 核 4 线程，x86_64，无 AVX | 只出 **amd64** 镜像；所选组件都不需要 AVX；CPU 弱，**视频只转发不转码** |
| 内存 | 单条 DDR3L SODIMM，**最大 8 GB** | **建议配 8 GB**（最低 4 GB）；预算见 §4 |
| 存储 | 1 × mSATA + 1 × 2.5" SATA | **建议 mSATA 工业级 ≥ 128 GB**（本地 TB 留 7 天 + 上送 outbox ≤ 2 GB + 抓拍录波排队 + 系统） |
| 网口 | 2 × Intel i211 RJ45 | **LAN1 接双目摄像机，LAN2 接子站一级交换机**（上行） |
| 串口 | 6 × RS232，仅 COM2 可在 BIOS 里改成 RS485 | 传感器由同事转成 MQTT，我方不直接接串口 |
| 其他 | 无开关量输入、无电池；工作温度 −20 ~ 65 ℃，无风扇，来电自启 | 分合位 `sw.cb`、电源失电 `eg.power` 由同事经 MQTT 给；`eg.volt`、`eg.ssd_health` 没有来源，不报 |
| 系统 | 支持 Ubuntu / CentOS | **Ubuntu Server 24.04 LTS（最小安装）+ Docker**；用户同意也可用更轻的发行版（如 Debian 12），G6 定 |

**网络与链路**

```
                         ┌──────────────────────── EG（X26A，每面柜一台）────────────────────────┐
双目摄像机 ──LAN1──────────┼─▶ eg-video + mediamtx（子码流常录做循环录像，主码流按需；不经 TB）             │
                          │                                                                    │
传感器 ─▶ 同事的转换程序（跑在 EG 上）─MQTT─▶ Mosquitto（127.0.0.1:1884）─▶ TB IoT Gateway ─▶ EG 本地 TB CE
                          │                     │                                   （存 7 天、算 7 类告警）
                          │                     ▼                                          │ 告警钩子
                          │                 eg-agent ◀──────────────────────────────────────┘
                          │     派生量与质量码、outbox、上送、告警事件、配置应用、本地管理页、抓拍录波（G5）
                          └────────────LAN2─────┼───────────────────────────────────────────────────┘
                                                │ 遥测 MQTT over TLS 8883（子站 TB 网关接口）
                                                │ 告警事件 / 配置回执 HTTPS 443（子站扩展服务）
                                                ▼
             子站一级交换机 ◀── 维护笔记本直连：http://<EG 上行 IP>/
                   │
                 子站主机：TB（收遥测）、扩展服务（收事件、下发配置、签票据）、Nginx /eg/<柜号>/ 反代到 EG（免二次登录）；
                           mediamtx 按需从 EG 拉视频（G4）；接收抓拍 / 录波（G5）
```

## 2. 范围

| 模块 | 内容 |
|---|---|
| **数据链路** | EG 本机 Mosquitto 收同事的 MQTT → **TB IoT Gateway**（MQTT 连接器）按映射写 **EG 本地 TB**；映射由我方按 `eg.yaml` 生成；给同事一份《EG 内部 MQTT 格式》 |
| **上送子站（I2–I4）** | eg-agent 订阅同一条总线，全部遥测 / 属性先落 **outbox（SQLite）**，经子站 TB 网关接口（MQTT QoS1）上送，断网补传；本地 TB 的告警以**告警事件**送子站扩展服务（回执后才删）；子站下发的阈值与规则开关由 agent 写进本地 TB 并**回执实际生效版本** |
| **eg-agent（我方服务）** | ① 派生量：`el.load_pct`、质量码 `q`（按周期看护）、`eg.state`、EG 自身指标 `eg.*`、南向统计 `dev.*`；② 上送、告警事件、配置应用；③ 本地 API 与本地管理页；④ 抓拍 / 录波与上传（G5）；⑤ 本地 TB / IoT Gateway / mediamtx 的状态与受限运维 |
| **本地管理页（B/S）** | 概览、实时数据、下挂设备、视频、诊断、日志、系统；维护人员两条路进：**交换机直连**或**经子站系统**（§5） |
| **视频（独立服务 eg-video，不经 TB）** | 每面柜**一台**双目摄像机（可见光 + 热像，ONVIF）。eg-video 按 ONVIF 查流地址、生成本机 mediamtx 配置、抓帧、报 `cam.*`；EG mediamtx 按需从摄像机拉，子站 mediamtx 按需从 EG 拉，**只拉有人在看的那路** |
| **抓拍 / 录波** | EG 抓帧、环形缓冲、本地排队、断网补传；子站接收端 `POST /ext/eg/<柜号>/snapshots|recordings`（后端库做） |
| **EG 部署包** | 通用发布件（`pnpm pack:eg`：compose、安装脚本、镜像）+ 子站生成的每台 `eg.yaml` 与 `sp-ca.pem`（后端 `scripts/pack-eg.sh`）；本地 TB CE + PostgreSQL + Mosquitto + IoT Gateway + eg-agent（+ mediamtx）；chrony 对时；升级 / 回滚（`docs/EG部署手册.md`） |
| **子站配套**（后端库 + 前端库） | 上送接入、事件接入、配置下发与版本、抓拍 / 录波接收、`/eg/<柜号>/` 反代与单点登录、视频改拉模式、网关页「打开 EG 管理页」、接入规范 v0.2 |

**不在本计划**：传感器到 MQTT 的转换（同事做）；摄像机厂家接口的真实联调（等样机，归 H）；本地 AI；工单类功能。

## 3. 仓库：`D:\Work Files\GWDR\lsa-9600eg`

GitHub 私有库 `YepYepFrank/lsa-9600eg`。点表与告警规则生成用后端库的 `packages/points`、`packages/model`：开发时经 `link:` 引用（两库同在 `D:\Work Files\GWDR\` 下），打镜像时由 `pack:eg` 拷进构建上下文（记下后端提交号）。

```
lsa-9600eg/
  apps/agent        eg-agent（NestJS）：派生量、上送 outbox、告警事件、配置应用、本地 API、抓拍录波
  apps/video        eg-video（NestJS）：视频扩展服务，不经 TB
  apps/admin-web    本地管理页（Vue3 + Element Plus，构建后由 agent 直出）
  packages/config   eg.yaml / local.yaml 的读取与类型
  packages/emu      开发用：同事 MQTT 的仿真发布器（用 @lsa/points 的发生器）
  deploy/dev        开发样机（本地 TB CE + PostgreSQL + Mosquitto + IoT Gateway）
  deploy/eg         EG 上的正式编排、Mosquitto 配置、agent 镜像、安装脚本
  deploy/tb-gateway IoT Gateway 自定义连接器 extensions/lsa（LsaSelfConnector）
  scripts/          dev.mjs / dev-config.mjs（开发样机）、pack-eg.mjs（发布件）
  docs/             本计划、《EG 内部 MQTT 格式》、EG 部署手册、评审记录、验收截图
```

## 4. 技术栈与资源预算（按 X26A 定）

| 部分 | 选型 | 理由 |
|---|---|---|
| EG 本地数据与告警 | **ThingsBoard CE 4.2.2.5 单体**（与子站同版，以后可各自升级）+ PostgreSQL 16 | 本地存 7 天、用与子站同一份设备配置算 7 类告警；两端都不是 TB Edge（交接说明 V3.0 §2.1） |
| eg-agent | **Node 22 + TS + NestJS**，与子站扩展服务同一套（`@swc-node/register` 跑）；outbox / 事件库用 better-sqlite3 | 维护人员只学一套；SQLite 本机落盘、断电安全（WAL） |
| 本地管理页 | Vue 3 + TS + Element Plus，样式 token 与前端一致；哈希路由 + 相对路径，能挂在 `/eg/<柜号>/` 下 | 与子站页面同一套观感 |
| 数据接入 | Mosquitto 2.1 + `thingsboard/tb-gateway` 3.8.5（MQTT 连接器 + 自定义连接器） | 用户选定 IoT Gateway |
| 视频 | mediamtx 1.21.x（与子站同版），抓帧用 ffmpeg 单帧解码 | J1900 不转码 |
| 对时 | chrony，指向子站主机（子站再对站内时钟源） | |
| 系统 | Ubuntu Server 24.04 LTS + Docker CE（离线 deb） | |

**内存预算（按最低 4 GB 核算，配 8 GB 时余量更大；I1 / I5 实测后修正）**

| 进程 | 预算 | 实测（开发机） |
|---|---|---|
| 系统 + Docker | 300 MB | — |
| EG 本地 TB CE | 900 MB（容器上限 1400 MB） | 空载 688 MB，接一面柜数据与告警 846–904 MB（JVM 堆 384 MB，I1-1） |
| PostgreSQL | 150 MB（上限 256 MB） | 100–125 MB |
| TB IoT Gateway | 100 MB（上限 256 MB） | 37 MB |
| Mosquitto | 20 MB（上限 64 MB） | 2–3 MB |
| eg-agent | 250 MB（上限 384 MB） | 容器里 253 MB（含 swc 即时编译；I5 冒烟测试） |
| mediamtx | 60 MB | G4 实测 |
| 抓帧 ffmpeg（临时） | 60 MB | G5 实测 |
| **合计** | **≈ 1.85 GB**，4 GB 余一半做页缓存 | |

TB Edge 时代本地库是 Edge（770–810 MB），换 TB CE 后本地 TB 多约 0.1 GB，总预算基本不变。G6 在 4 GB 虚拟样机上实测，X26A 到货后在实机复测。

## 5. 维护人员怎么进 EG 页面

| 入口 | 做法 | 登录 |
|---|---|---|
| **经子站系统**（常用） | 子站前端网关页「EG 管理页」→ 新窗口 `/eg/<柜号>/`，子站 Nginx 反代到 `http://<EG 上行 IP>/` | **免二次登录**：子站扩展服务签一张 60 s、一次性的票据（HMAC，密钥由这台 EG 的访问令牌派生，两边本来都有，不另发密钥），带子站用户名与角色（维护 / 只看）；EG 按角色放权。操作记进 EG 本地审计 |
| **交换机直连**（子站主机坏了 / 现场调试） | 笔记本接子站一级交换机，浏览器开 `http://<EG 上行 IP>/` | EG 本地维护账号 `maint`（口令 ≥ 8 位含字母数字，连错 5 次锁 15 分钟，会话 30 分钟），只此一个 |

子站扩展服务下发配置也用同一套票据（角色 `station` 的**服务票据**，换不了浏览器会话）。管理页走 HTTP（站内网）；LAN1 进来的一律 403（G6，`install.sh --lan1`）。

页面（v0.5 起，界面基线 80e01ad）：侧栏 **本柜总览**（双光实况 + 测温区、温湿度 / 露点、局放、烟雾 / 气体、UV 弧光）、**电气量**、**事件与录像**（本地事件、关联证据回放）、**设备与通信**（原有的服务状态、实时数据、下挂设备、视频与测温、证据、诊断、日志、系统）。实时画面由 agent 带会话鉴权反代本机 mediamtx 的 WebRTC（WHEP）/ HLS，mediamtx 的信令端口只听本机；健康评分不在网关计算。

## 6. 关键设计

### 6.1 数据链路与派生量

- **同事的 MQTT**（同事的程序跑在 EG 上）：发到 EG 本机 Mosquitto（`127.0.0.1:1884`）。主题与载荷由我方定成《EG 内部 MQTT 格式》：`lsa/<设备名>/telemetry`，载荷 `{"ts":毫秒,"values":{...}}`，**key 直接用接入规范 §6 的名字**，设备名用规范 §5 的名字；EG 级信号（分合位 `sw.cb`、电源 `eg.power`）发 `lsa/EG-<柜号>/telemetry`。IoT Gateway 的映射只做「主题 → 设备名」，不做换算。
- **IoT Gateway**（3.8.5）：内置 MQTT 连接器按**设备清单逐台**订阅 `lsa/<设备名>/…`，JSON 转换器用 `"*"` 原样转发、保留设备侧时间戳；以 `EG-<柜号>` 的令牌连 EG 本地 TB。配置由 agent 从 `eg.yaml` 生成（内容不变就不重写，免得触发重载），远程配置与统计遥测关掉；持久会话，重启不丢。
- **EG 自己的数据走自定义连接器** `LsaSelfConnector`：内置连接器把与网关同名的 `EG-<柜号>` 当子设备发会被断开网关会话、另开连接用同一令牌又会互相挤掉（G0 实测），所以经网关**自己的会话**发 `v1/devices/me/…`；agent 停了时它代发 `eg.state=degraded`。它在 IoT Gateway 主线程里被开关，**任何一步都不能等**（I1 修多实例、I4 修重载自锁，`i1:verify` 6b 常驻回归）。
- **eg-agent 也订阅 Mosquitto**，派生量发回 Mosquitto，与传感器数据走同一条路进本地 TB 与上送：
  - `el.load_pct` = max(Ia, Ib, Ic) ÷ 额定电流 × 100（额定电流取 `eg.yaml`）；
  - **质量码看护**：每个 key 按规范周期计时，超 3 个周期没来标 `stale`，超 max(30 s, 5 个周期) 标 `invalid`，整台都没来的列全部 key + `eg.state=degraded`；恢复后发 `q="{}"`；不替同事补值；
  - EG 自身 `eg.*`（`/proc`、`/sys`、SNTP 偏差、到子站 TCP 时延、上行流量）；南向统计 `dev.*`；本地 TB 版本 `tbVersion`、生效配置版本 `cfg` 作为 EG 属性上报。

### 6.2 上送、告警事件、配置下发（I2–I4，接口见后端方案 §8）

- **上送**：总线上的每条遥测 / 属性先写 outbox（按写入序号；子站按「设备 + key + 源时间戳」覆盖写，重发无害），PUBACK 后才删。连上后新来的（实时）优先，积压按 2000 条 / s 限速补传（待确认 I2-1）；容量 7 天 / 2 GB 先到为准，超了丢最旧的遥测、记丢失段。每 5 s 随 EG 自身指标报 `eg.buf_depth`、`eg.oldest_unsent`、`eg.backfill_pct`、`eg.uplink`、`eg.outbox_full`、`eg.lost`（累计、只增不减，子站据此报「缓存溢出」）。
- **告警事件**：本地 TB 规则链的告警钩子推 `POST /hooks/alarm`（只当提示，agent 回本地 TB 核对后才记），另 30 s 对账补漏。事件库每条告警记状态与 revision（状态 / 级别 / 恢复时刻变化才 +1），待送每条只留最新一版；`POST /ext/eg/<柜号>/events` 回执 accepted / duplicate 才删。agent 启动时把活动告警重发一遍。
- **配置下发**：子站 `PUT http://<EG>/api/config`（服务票据）送阈值表与规则开关，agent 用后端 `@lsa/model` 同一份代码生成 7 类告警规则、按开关去掉停用的，只写有变化的设备配置，失败回滚；回执 APPLIED / FAILED + 原因，并上报 `cfg`。设备清单在线改暂不支持（I4-1）。

### 6.3 配置归属

| 配置 | 在哪管 | 怎么到 EG |
|---|---|---|
| 柜号、设备清单、设备名、隔室、额定电流、子站地址与令牌 | 子站 `tb/model.yaml` 与 provision | `eg.yaml`（子站 `pack-eg.sh` 出，每台一份）；设备清单变更要重新生成部署 |
| 7 类告警的阈值与规则开关 | 子站页面 | `PUT /api/config` 下发，EG 回执实际生效版本 |
| 摄像机地址（ONVIF）与各路 RTSP、对时服务器、上行网口 | EG 本地管理页 | 存 `local.yaml` |

### 6.4 抓拍与录波（G5）

- **触发**：已有的告警钩子（本地 TB → agent `/hooks/alarm`）即触发源；子站手动录波走 HTTP 控制（`http://<EG>/api/*`，服务票据）。
- **抓拍**：可见光 + 热像各一帧（摄像机有抓图接口就用，没有就 ffmpeg 从 RTSP 解一帧）。
- **录波**：agent 从 Mosquitto 收的数据按隔室维护前 10 s 环形缓冲，触发后再收 20 s；采样率按同事实际发的频率如实写 `rateHz`（规范要 10 Hz，要同事那边支持）。
- **上传**：与告警事件同一套做法 —— 先落本地库，带 EG 生成的 `id`，子站按 `id` 幂等，回执后才删；失败退避、按时间顺序补；本地留 7 天且设容量上限。
- **子站接收端**：`X-EG-Token` 校验 EG 设备令牌且与路径柜号一致；落盘 + 入库；按 `ts` 挂告警证据链；模拟器改走同一接口（后端库）。

### 6.5 视频（G4：按需，不全推；独立服务 eg-video，不经 TB）

- 每面柜一台双目摄像机（可见光 + 热像，ONVIF），四路：可见光主 / 子码流、热像主 / 子码流。
- eg-video：按 `local.yaml` 的 ONVIF 地址查各路 RTSP（也可手填）、生成本机 mediamtx 配置、抓帧给 eg-agent、每分钟报 `cam.online` `cam.fps` `cam.bitrate`。
- EG mediamtx：每路 `source: rtsp://<摄像机>/…`，`sourceOnDemand: yes` —— 没人看就不连摄像机。
- 子站 mediamtx：每路 `source: rtsp://<EG 上行 IP>:8554/<柜号>[-ir][-sub]`，`sourceOnDemand: yes`。有人看某路才逐级拉起，看完 10 s 后断开。
- **子站要跟着改**：视频通道从「每隔室（每台 SAM）一组」改为「每柜一组」；分框温度仍按隔室列（后端 + 前端库）。
- 规范 §10 改为拉模式、每柜一台摄像机（v0.2）。EG 只对子站主机开放 8554/TCP。

## 7. 里程碑

| # | 内容 | 验收 | 估算 |
|---|---|---|---|
| **G0 基座** ✅ | 建库；agent / eg-video / 管理页骨架；`eg.yaml` / `local.yaml`；后端抽 `packages/points`、模拟器 `--except`；开发样机（当时接 TB Edge） | `g0:verify` 24 项（2026-09-24） | 2 d |
| **G1 数据链路** ✅ | 《EG 内部 MQTT 格式》；IoT Gateway 映射生成；派生量与质量码看护；EG 自身指标与南向统计；设备属性；持久会话 | `g1:verify` 39 项（2026-09-24；G1 当时查的是 Edge 同步到子站的数据，I2 起上送换成 agent） | 4 d |
| **G2 本地服务与访问** ✅ | 本地 API；本地账号 + 子站票据单点登录；子站签票据、反代 `/eg/<柜号>/`；前端网关页「EG 管理页」 | `g2:verify` 52 项（2026-09-24；I1 后按独立 TB 改为 46 项 `--fast`） | 4 d |
| **G3 本地管理页** ✅ | 七页；暗 / 浅主题 | `pnpm g3:shots` 17 张（2026-09-24） | 4 d |
| **I1 本地 TB CE** ✅ | 样机换独立 TB CE；provision:eg 建本地实体；IoT Gateway 改连本地 TB；修 LsaSelfConnector 多实例 | `i1:verify` 25 项 → 29 项（加重载回归）；内存见 §4（02d1346） | 2 d |
| **I2 上送** ✅ | outbox、遥测上送、实时优先与限速补传、容量看护、上送状态指标 | `i2:verify`：剪上行 10 分钟，1615 条 2 s 补完、无缺口无重复；重启 Mosquitto / 本地 TB 无断档（66abb95） | 4 d |
| **I3 告警事件** ✅ | 告警钩子 + 30 s 对账；事件库与回执；乱序 / 断网合并 | `i3:verify` 假子站 24 项、真子站 8 项：子站 0.6 s 出告警（全链路复测子站 0.35 s、前端 0.40 s）（6cd818a） | 4 d |
| **I4 配置下发** ✅ | 服务票据；按阈值表与规则开关写本地设备配置、回滚、回执、`cfg`；修 LsaSelfConnector 重载自锁 | `i4:verify` 24 项（a034f62）；复测修正（f9bc7f3、d1d0173） | 3 d |
| **I5 部署包（EG 侧）** ✅ | 正式编排（钉版本、内存上限、日志轮转）、agent 镜像、安装脚本、`pack:eg`、TLS（8883 / 443）、部署手册 | 发布件出件、compose 校验；agent 镜像 555 MB 构建通过、隔离冒烟通过（3811349、dd7d5f8）；整套 Linux 安装留 G6 | 2 d |
| **G4 视频** | EG 与子站 mediamtx 两级按需拉；配置按 `eg.yaml` / `model.yaml` 生成；RTSP 测试源扮摄像机；子站视频通道改每柜一组（后端 + 前端） | 子站监视墙播 AH03 各路（WebRTC 延迟 < 1 s，关 UDP 退 HLS）；**无人看时 EG 上行与摄像机侧都无视频流量**；看完 10 s 内断开 | 4 d |
| **G5 抓拍 / 录波** | 子站接收端 + 证据链 + 模拟器改走接口；告警钩子触发 EG 抓帧、环形缓冲、上传（复用事件的库与回执做法）、手动录波 | AH03 打弧光 → 子站证据链 10 s 内出现 EG 上传的抓拍；断上行期间的抓拍 / 录波恢复后按原时间补齐；重复上传不重复入库；子站页面可手动录波 | 4 d |
| **G6 部署包与样机验收** | Docker 离线 deb；chrony 与网卡配置模板；管理页只听 LAN2（I5-2）；mediamtx 并入编排 | **虚拟样机**：Ubuntu 24.04（4 GB、4 核）从裸系统装发布件 + 子站配置包，接子站跑 2 h，记各进程内存 / CPU / 磁盘增速；**容量 / 寿命**：循环录像（两路子码流常录，估每天约 11 GB 写入）+ 本地 TB + outbox + 证据的磁盘占用与写入量实测，按所选 SSD 的 TBW 算寿命；断电重启后全部自起；CRLF / 中文路径检查。X26A 到货后在实机复测同一套 | 3 d |
| **G7 联调与文档** | 接入规范 v0.2 的 EG 侧内容核对（规范归后端库）；部署手册定稿；子站相关页真后端重截；评审记录 | 文档与实现自检比对；评审 | 2 d |

I 阶段合计约 15 人日（EG 侧），G4–G7 剩约 **13 人日**。每个里程碑把待确认点记进 `评审记录.md`；涉及子站的改动在后端 / 前端库同一次提交里改规范、记修订记录。

## 8. 与子站的接口（汇总）

| # | 方向 | 接口 | 状态 |
|---|---|---|---|
| 1 | 同事程序 → EG | MQTT `lsa/<设备名>/telemetry`（《EG 内部 MQTT 格式》） | G1 |
| 2 | IoT Gateway → EG 本地 TB | TB 网关 MQTT 接口（容器网络 `tb:1883`） | I1 |
| 3 | EG → 子站 TB | MQTT over TLS 8883，子站 TB 网关接口 `v1/gateway/*`、`v1/devices/me/*`（后端方案 §8.1） | I2 |
| 4 | 本地规则链 → agent | `POST http://host.docker.internal/hooks/alarm`（provision:eg `--hook`） | I3 |
| 5 | EG → 子站 | 告警事件 `POST https://<子站>/ext/eg/<柜号>/events`，`X-EG-Token`，回执（§8.2） | I3 |
| 6 | 子站 → EG | 配置下发 `PUT http://<EG>/api/config`，服务票据，回执（§8.3） | I4 |
| 7 | 子站 → EG | 页面反代 `/eg/<柜号>/`；单点登录票据 | G2 |
| 8 | EG → 子站 | `POST /ext/eg/<柜号>/snapshots`、`/recordings`，`X-EG-Token`，按 `id` 幂等 | G5 |
| 9 | 子站 → EG 视频 | 子站 mediamtx 按需拉 `rtsp://<EG 上行 IP>:8554/<路径>` | G4，改规范 §10 |
| 10 | 对时 | EG chrony → 子站主机 → 站内时钟源 | G6 |

## 9. 需要确认的点

**用户已答复（2026-09-24）**：同事的转换程序跑在 EG 上；每面柜一台 ONVIF 双目摄像机，视频不经 TB、独立服务 eg-video；分合位、电源失电由同事经 MQTT 给；Ubuntu 或更轻的 Linux；管理页走 HTTP。
**用户已决定（2026-09-27）**：EG 本地跑独立 ThingsBoard CE，不再保留 TB Edge 方案。

**仍要厂家 / 同事答复的**：摄像机抓图接口、温度矩阵（点温）、实际分辨率与帧率；同事的程序能否给 10 Hz 录波数据、弧光持续时间；站内时钟源。

**I 阶段待确认**（我先按括号里的做，详见 `评审记录.md`）：I2-1 补传限速（2000 条 / s）、I4-1 设备清单在线改（暂不支持）、I5-1 部署时子站经 SSH 隧道建本地实体、I5-2 管理页只听 LAN2（G6 做，现在靠防火墙）、I5-4 本机总线不鉴权（只绑本机）、I5-5 整套在 Linux 上安装（G6）。

## 10. 开发环境

- EG 样机：`deploy/dev/compose.yaml`（项目 `lsa-eg-dev`、网络 `lsa-eg-dev`）—— 本地 TB CE（127.0.0.1:18080 / 11884）+ PostgreSQL + Mosquitto（127.0.0.1:11883）+ IoT Gateway；`pnpm dev:config` 从后端库拷 `eg.yaml`，`pnpm dev:up` 首次自动建库；本地实体由后端库 `pnpm provision:eg -- --cabinet AH03 --url http://127.0.0.1:18080 --hook http://host.docker.internal:9100/hooks/alarm` 建。
- 宿主机进程：`pnpm dev:emu`（3190，扮同事程序）、`pnpm dev:agent`（9100，带 `EG_DEBUG=1`）。子站模拟器按新协议扮演其余各柜的 EG，AH03 让给样机。
- agent 的开发开关：`EG_UPLINK=off`（不上送）、`EG_EVENTS=on|off`、`EG_STATION_HTTP`（事件目标覆盖）、`EG_EVENTS_DB`（独立事件库，假子站自检必须）。**对共享的子站打开上送要用户本人同意**（Claude Code 的权限审查不认会话间的批准），打开上送的 agent 由用户在自己的终端起。
- 自检：`g0`–`g2`、`i1`–`i4`（`pnpm <名>:verify`）；`i1:verify` 6b 是 LsaSelfConnector 重载的常驻回归；`i2:verify` 第 0 节离线验丢失记账。
- 时间按东八区看。端口：扩展服务 3001、模拟器 3100、前端 8797、agent 9100、仿真器 3190；不要停用户的 open-webui（3000）。

## 修订记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v0.1 | 2026-09-24 | 初稿 |
| v0.2 | 2026-09-24 | 按用户答复：硬件定为 X26A（x86_64、≤ 8 GB）→ 只出 amd64、agent 改用 NestJS 与子站一致、预算按 4 GB 核算；采集改用 TB IoT Gateway + 本机 Mosquitto，传感器数据由同事转成 MQTT，我方定内部格式并负责派生量与质量码看护；网口 LAN1 摄像机 / LAN2 上行；新增维护访问（交换机直连 + 经子站反代免二次登录）；视频两级按需拉；子站 → EG 控制改走 HTTP（不用 TB RPC）；G6 改为 Ubuntu 虚拟样机 + 实机复测 |
| v0.3 | 2026-09-24 | 用户批准并答复 §9：同事程序在 EG 上、每柜一台 ONVIF 双目摄像机、视频独立服务 eg-video 不经 TB、分合位 / 电源由同事经 MQTT 给、Ubuntu 或更轻的 Linux、HTTP。G0 实测：IoT Gateway 按设备清单逐台订阅；EG 自身数据改走自定义连接器 LsaSelfConnector |
| v0.5 | 2026-09-27 | 本地管理页界面基线换成领导 80e01ad（yangjun1966/lsa-9600eg）的单柜界面并接真实接口：新增 `GET api/history`（本地 TB 趋势）、`api/stream/…`（WHEP / HLS 反代，会话鉴权、只认本柜四路）、`GET api/video/recording`（循环录像断档）；mediamtx 打开只听本机的 WebRTC / HLS；原有管理页挂到「设备与通信」下。§5 补页面结构与 LAN1 已关 |
| v0.4 | 2026-09-27 | 用户决定 EG 本地改跑**独立 ThingsBoard CE**、不再保留 TB Edge 方案（后端库《EG独立TB调整方案》）。改写链路图、范围、技术栈（本地 TB CE 4.2.2.5）、内存预算（按 I1 / I5 实测）、上送 / 告警事件 / 配置下发设计（新 §6.2）、配置归属、接口汇总、开发环境；里程碑插入 I1–I5 实施结果，G4–G7 重估（G4 +1 d 含子站视频通道改造，G5 −1 d 复用事件的做法，G6 部署包大半已在 I5 做完）；单点登录票据按实际实现改为 HMAC（由 EG 令牌派生密钥），不再写 JWT |
