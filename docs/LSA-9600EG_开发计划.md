# LSA-9600EG 边缘网关端 · 开发计划 v0.3

> **2026-09-27 调整**：EG 改为独立 ThingsBoard CE（不再用 TB Edge），后端库 `docs/EG独立TB调整方案.md`；G 系列之间插入 I1–I7，进度见 `评审记录.md`。本计划 v0.4 在 I7 统一改写。
>
> 日期：2026-09-24。**用户已批准**（v0.3 写进了用户对 §9 的答复与 G0 的实测结论，见文末修订记录）。
> 依据：后端库《EG / SAM 接入规范》v0.1、《EG 边缘 TB 调整方案》、模拟器 `apps/sim`、拟采购硬件《X26A-J1900/J2900 双网口 6 串口 6USB 工控主机》。
> 里程碑前缀 **G**。未明确处先按推测做（§9 列了默认假设），评审时改。

## 1. 硬件与网络

**拟采购：新创云 XCY-X26A（J1900 / J2900）**

| 项 | 规格 | 对本项目的意义 |
|---|---|---|
| CPU | Intel 赛扬 J1900 / 奔腾 J2900，4 核 4 线程，x86_64，无 AVX | 只出 **amd64** 镜像；所选组件都不需要 AVX；CPU 弱，**视频只转发不转码** |
| 内存 | 单条 DDR3L SODIMM，**最大 8 GB** | **建议配 8 GB**（最低 4 GB）；预算见 §4 |
| 存储 | 1 × mSATA + 1 × 2.5" SATA | **建议 mSATA 工业级 ≥ 128 GB**（Edge 本地 7 天 + 抓拍录波排队 + 系统） |
| 网口 | 2 × Intel i211 RJ45 | **LAN1 接双目摄像机，LAN2 接子站一级交换机**（上行） |
| 串口 | 6 × RS232，仅 COM2 可在 BIOS 里改成 RS485 | 传感器由同事转成 MQTT，我方不直接接串口 |
| 其他 | 无开关量输入、无电池；工作温度 −20 ~ 65 ℃，无风扇，来电自启 | 分合位 `sw.cb`、电源失电 `eg.power` 在 EG 本机采不到，要另找来源（§8） |
| 系统 | 支持 Ubuntu / CentOS | **Ubuntu Server 24.04 LTS（最小安装）+ Docker**；用户同意也可用更轻的发行版（如 Debian 12），G6 定 |

**网络**

```
                         ┌───────────────── EG（X26A，每面柜一台）──────────────────┐
双目摄像机 ──LAN1──────────┼─▶ eg-video + mediamtx（按需拉流，不经 TB）                 │
                          │                                                          │
传感器 ─▶ 同事的转换程序（跑在 EG 上）─MQTT─▶ Mosquitto（1884）─▶ TB IoT Gateway ─▶ TB Edge ─gRPC 7070─▶ 子站 TB
                          │          │                              ▲   │             │
                          │          └─▶ eg-agent（派生量、看护、本地页、抓拍录波）─┘   │             │
                          │                     │                                     │
                          └────────────LAN2─────┼───────────────────────────────────────┘
                                                ▼
             子站一级交换机 ◀── 维护笔记本直连：http://<EG 上行 IP>/
                   │
                 子站主机：Nginx /eg/<柜号>/ 反代到 EG（免二次登录）；mediamtx 按需从 EG 拉视频；接收抓拍 / 录波
```

## 2. 范围

| 模块 | 内容 |
|---|---|
| **数据链路** | EG 本机 Mosquitto 收同事的 MQTT → **TB IoT Gateway**（MQTT 连接器）按映射写本机 Edge；映射配置由我方按 `eg.yaml` 生成；给同事一份《EG 内部 MQTT 格式》 |
| **eg-agent（我方服务）** | ① 派生量：`el.load_pct`、质量码 `q`（按周期看护，超时标 `stale` / `invalid`）、`eg.state`、EG 自身指标 `eg.*`、南向统计 `dev.*`；② 本地 API 与本地管理页；③ 抓拍 / 录波与上传；④ Edge / IoT Gateway / mediamtx 的状态与受限运维 |
| **本地管理页（B/S）** | 概览、实时数据、设备与映射、视频、诊断、日志、系统；维护人员两条路进：**交换机直连**或**经子站系统**（§5） |
| **视频（独立服务 eg-video，不经 TB）** | 每面柜**一台**双目摄像机（可见光 + 热像，ONVIF）。eg-video 按 ONVIF 查流地址、生成本机 mediamtx 配置、抓帧、报 `cam.*`；EG mediamtx 按需从摄像机拉，子站 mediamtx 按需从 EG 拉，**只拉有人在看的那路** |
| **抓拍 / 录波** | EG 抓帧、环形缓冲、本地排队、断网补传；子站接收端 `POST /ext/eg/<柜号>/snapshots|recordings`（后端库做） |
| **子站配套**（后端库 + 前端库） | 抓拍 / 录波接收、`/eg/<柜号>/` 反代与单点登录、视频改拉模式、网关页加「打开 EG 管理页」、边缘根规则链加告警钩子、接入规范 v0.2 |
| **EG 部署包** | Ubuntu 上一键装：Docker（离线）、Edge + PG + Mosquitto + IoT Gateway + eg-agent + mediamtx；chrony 对时；升级 / 回滚 |

**不在本计划**：传感器到 MQTT 的转换（同事做）；摄像机厂家接口的真实联调（等样机，归 H）；本地 AI；工单类功能。

## 3. 仓库：`D:\Work Files\GWDR\lsa-9600eg`（已同意）

GitHub 私有库 `YepYepFrank/lsa-9600eg`。后端库抽 `packages/points`（点表 + 模拟发生器，已同意），EG 库用 pnpm git 依赖钉提交号引用。

```
lsa-9600eg/
  apps/agent        eg-agent（NestJS）：派生量、本地 API、抓拍录波
  apps/video        eg-video（NestJS）：视频扩展服务，不经 TB
  packages/config   eg.yaml / local.yaml 的读取与类型
  apps/admin-web    本地管理页（Vue3 + Element Plus，构建后由 agent 直出）
  packages/emu      开发用：同事 MQTT 的仿真发布器（用 @lsa/points 的发生器）、RTSP 测试源
  deploy/           EG compose、Mosquitto / IoT Gateway（含自定义连接器 extensions/lsa）/ mediamtx 配置、Ubuntu 安装与升级脚本
  docs/             计划、《EG 内部 MQTT 格式》、EG 部署与运维手册、评审记录
```

## 4. 技术栈与资源预算（按 X26A 定）

X26A 是 x86_64、内存可到 8 GB，2 GB 的紧预算不再成立，所以**优先与子站一致**：

| 部分 | 选型 | 理由 |
|---|---|---|
| eg-agent | **Node 22 + TS + NestJS**，与子站扩展服务同一套（`@swc-node/register` 跑，不用 tsx —— B3 的坑） | 认证、校验、OpenAPI、日志写法与 ext 一致，维护人员只学一套 |
| 本地管理页 | Vue 3 + TS + Element Plus，样式 token 与前端一致；哈希路由 + 相对路径，能挂在 `/eg/<柜号>/` 下 | 与子站页面同一套观感 |
| 数据接入 | Mosquitto 2 + `thingsboard/tb-gateway`（MQTT 连接器） | 用户选定 IoT Gateway |
| 视频 | mediamtx 1.21.x（与子站同版），抓帧用 ffmpeg 单帧解码 | J1900 不转码 |
| 对时 | chrony，指向子站主机（子站再对站内时钟源） | |
| 系统 | Ubuntu Server 24.04 LTS + Docker CE（离线 deb） | |

**内存预算（按最低 4 GB 核算，配 8 GB 时余量更大）**

| 进程 | 预算 |
|---|---|
| 系统 + Docker | 300 MB |
| TB Edge | 800 MB（本机实测 770–810 MB；内存富余时 JVM 堆放到 768 MB，更稳） |
| PostgreSQL（Edge 本地库） | 200 MB |
| TB IoT Gateway（Python） | 200 MB（G1 实测后修正） |
| Mosquitto | 20 MB |
| eg-agent | 200 MB |
| mediamtx | 60 MB |
| 抓帧 ffmpeg（临时） | 60 MB |
| **合计** | **≈ 1.85 GB**，4 GB 余一半做页缓存 |

各容器设内存上限；G6 在 4 GB 虚拟样机上实测，X26A 到货后在实机复测。

## 5. 维护人员怎么进 EG 页面

| 入口 | 做法 | 登录 |
|---|---|---|
| **经子站系统**（常用） | 子站前端「边缘网关 → 某网关」加按钮「打开 EG 管理页」→ 新窗口 `https://<子站>/eg/<柜号>/`，子站 Nginx 反代到 `http://<EG 上行 IP>/` | **免二次登录**：子站扩展服务签一张短时票据（JWT，子站私钥签、EG 部署包里放公钥验），带上子站用户名与角色；EG 按角色放权。操作记进 EG 本地审计并回报子站审计 |
| **交换机直连**（子站主机坏了 / 现场调试） | 笔记本接子站一级交换机，浏览器开 `http://<EG 上行 IP>/` | EG 本地维护账号（部署时设密码，锁定策略同子站），只此一个 |

EG 页面只在 LAN2 上监听；LAN1（摄像机网）不开管理页。站内网默认 HTTP，要 HTTPS 时部署包里生成自签证书（§9 默认假设 5）。

## 6. 关键设计

### 6.1 数据链路与派生量

- **同事的 MQTT**（用户确认：同事的程序跑在 EG 上）：发到 EG 本机 Mosquitto（`127.0.0.1:1884`）。主题与载荷由我方定成《EG 内部 MQTT 格式》：`lsa/<设备名>/telemetry`，载荷 `{"ts":毫秒,"values":{...}}`，**key 直接用接入规范 §6 的名字**，设备名用规范 §5 的名字；EG 级信号（分合位 `sw.cb`、电源 `eg.power`，用户确认由同事给）发 `lsa/EG-<柜号>/telemetry`。这样 IoT Gateway 的映射只做「主题 → 设备名」，不做换算，出错面最小。
- **IoT Gateway**（3.8.5）：内置 MQTT 连接器按**设备清单逐台**订阅 `lsa/<设备名>/…`，JSON 转换器用 `"*"` 原样转发、保留设备侧时间戳；以 `EG-<柜号>` 的令牌连本机 Edge（1883）。配置由 agent 从 `eg.yaml` 生成，远程配置与统计遥测关掉。
- **EG 自己的数据走自定义连接器**（G0 实测）：内置连接器把 `EG-<柜号>` 当子设备发时 Edge 会立即断开网关会话；另开一条连接用同一令牌又会与网关互相挤掉。所以写了一个 Python 小连接器 `LsaSelfConnector`（`deploy/tb-gateway/extensions/lsa`），订阅 `lsa/EG-<柜号>/…`，经网关**自己的会话**发 `v1/devices/me/…`。
- **eg-agent 也订阅 Mosquitto**，并把派生量发回 Mosquitto（`lsa/<设备名>/telemetry`），同样经 IoT Gateway 上去，全程只有一条上送路：
  - `el.load_pct` = max(Ia, Ib, Ic) ÷ 额定电流 × 100（额定电流取 `eg.yaml`，子站可改）；
  - **质量码看护**：每个 key 按规范周期计时，超 3 个周期没来标 `stale`，超 30 s 标 `invalid`，整台都没来的列全部 key + `eg.state=degraded`；恢复后发 `q="{}"`；
  - `uv.int` 背景值：同事没按 2 s 报时由看护标 `stale`，**不替同事补值**（弧光恢复靠真实读数）；
  - EG 自身 `eg.*`（`/proc`、`/sys`、chrony 偏差、到子站 ping）；南向统计 `dev.*` 按每台设备的消息到达情况统计。
- 断网：只写本机，由 Edge 排队补传（规范 §8 不变）。

### 6.2 配置归属

| 配置 | 在哪管 | 怎么到 EG |
|---|---|---|
| 柜号、设备清单、设备名、隔室、额定电流 | 子站 `tb/model.yaml` | 部署包里的 `eg.yaml`（pack-eg 生成）；子站改了经 §6.3 的 HTTP 下发 |
| 摄像机地址（ONVIF）与各路 RTSP、Mosquitto 账号、上行 IP | EG 本地管理页 | 存 `local.yaml`，并作为 `EG-<柜号>` 的客户端属性上报（子站网关页可见） |

### 6.3 子站 → EG 的控制

子站能通 EG 的 LAN2（反代、拉视频都要），所以控制直接走 HTTP：子站扩展服务 → `http://<EG>/api/*`，用同一套子站签发的票据。首批：手动录波（招标「人工触发」）、下发额定电流等配置、重启采集链路、取诊断摘要。**不再用 TB RPC**（RPC 会落到 IoT Gateway 而不是 agent）。

### 6.4 抓拍与录波

- **触发**：边缘根规则链加「告警产生 → REST 调用 `http://eg-agent:9100/hooks/alarm`」（provision 改）；子站手动录波走 §6.3。
- **抓拍**：可见光 + 热像各一帧（摄像机有抓图接口就用，没有就 ffmpeg 从 RTSP 解一帧）。
- **录波**：agent 从 Mosquitto 收的数据按隔室维护前 10 s 环形缓冲，触发后再收 20 s；采样率按同事实际发的频率如实写 `rateHz`（规范要 10 Hz，要同事那边支持）。
- **上传**：先落本地 outbox 再发，带 EG 生成的 `id`，子站按 `id` 幂等；失败退避、按时间顺序补；本地留 7 天且设容量上限。
- **子站接收端**：`X-EG-Token` 校验 EG 设备令牌且与路径柜号一致；落盘 + 入库（替代模拟器的 `index.json`）；按 `ts` 挂告警证据链；模拟器改走同一接口。

### 6.5 视频（已同意：按需，不全推；独立服务 eg-video，不经 TB）

- 每面柜一台双目摄像机（可见光 + 热像，ONVIF），四路：可见光主 / 子码流、热像主 / 子码流。
- eg-video：按 `local.yaml` 的 ONVIF 地址查各路 RTSP（也可手填）、生成本机 mediamtx 配置、抓帧给 eg-agent、每分钟报 `cam.online` `cam.fps` `cam.bitrate`。
- EG mediamtx：每路 `source: rtsp://<摄像机>/…`，`sourceOnDemand: yes` —— 没人看就不连摄像机。
- 子站 mediamtx：每路 `source: rtsp://<EG 上行 IP>:8554/<柜号>[-ir][-sub]`，`sourceOnDemand: yes`。有人看某路才逐级拉起，看完 10 s 后断开。
- **子站要跟着改**：现在的视频通道是「每隔室（每台 SAM）一组」，改为「每柜一组」；分框温度仍按隔室列（G4，后端 + 前端库）。
- 规范 §10 改为拉模式、每柜一台摄像机（v0.2）。EG 只对子站主机开放 8554/TCP。

## 7. 里程碑

| # | 内容 | 验收 | 估算 |
|---|---|---|---|
| **G0 基座** ✅ | 建库；NestJS agent / eg-video、Vue 管理页骨架；`eg.yaml` / `local.yaml`；后端库抽 `packages/points`、模拟器加 `--except`、加 `pnpm eg:config`；**开发用 EG 样机**：Mosquitto + IoT Gateway 容器接本机 `lsa-edge-ah03`，仿真器扮同事程序，模拟器让出 AH03 | `g0:verify` 24 项、`sim:verify` 22 项、`e:verify` 18 项全过（2026-09-24） | 2 d |
| **G1 数据链路** ✅ | 《EG 内部 MQTT 格式》；IoT Gateway 映射生成；派生量与质量码看护；EG 自身指标与南向统计；设备属性；持久会话不丢数 | `g1:verify -- --edge` 39 项全过（逐点核负荷率、单量 / 整台停发、agent 停发维持在线、重启 Mosquitto / IoT Gateway / Edge 无断档、断上行 2 min 补齐）；eg-agent 147 MB、IoT Gateway 37 MB（2026-09-24） | 4 d |
| **G2 本地服务与访问** ✅ | 本地 API（状态、组件、诊断、Edge 本地排队、日志、配置、审计）；本地账号 + 子站票据单点登录；子站签票据、反代 `/eg/<柜号>/`、Nginx；前端网关页「EG 管理页」 | `g2:verify` 52 项全过（票据两边一致与验签、锁定、直连 / 经子站、权限、重启、断网时本地排队涨落、两边审计）；浏览器实测经子站免登录进入（2026-09-24） | 4 d |
| **G3 本地管理页** ✅ | 概览、实时数据（含原始消息）、下挂设备、视频（接入配置）、诊断、日志、系统七页；暗 / 浅主题 | `pnpm g3:shots` 17 张（直连、经子站维护 / 只看、浅色、1920、质量异常场景）无问题，看图改了 4 处（2026-09-24） | 4 d |
| **G4 视频** | EG 与子站 mediamtx 两级按需拉；配置按 `eg.yaml` / `model.yaml` 生成；RTSP 测试源扮摄像机 | 子站监视墙播 AH03 各路（WebRTC 延迟 < 1 s，关 UDP 退 HLS）；**无人看时 EG 上行与摄像机侧都无视频流量**；看完 10 s 内断开 | 3 d |
| **G5 抓拍 / 录波** | 子站接收端 + 证据链 + 模拟器改走接口；边缘规则链告警钩子；EG 抓帧、环形缓冲、outbox、手动录波 | AH03 打弧光 → 子站证据链 10 s 内出现 EG 上传的抓拍；断上行期间的抓拍 / 录波恢复后按原时间补齐；重复上传不重复入库；子站页面可手动录波；`b5:verify` `f3:verify` 仍过 | 5 d |
| **G6 部署包与样机验收** | Ubuntu 24.04 离线安装包（Docker deb + 镜像 + compose + chrony + 网卡配置模板）；pack-eg 改为「EG 库发布件 + 子站生成的每台凭据与 `eg.yaml`」；升级 / 回滚；日志轮转；容器内存上限 | **虚拟样机**：Ubuntu 24.04 虚拟机（4 GB、4 核）从裸系统装离线包，接子站跑 2 h，记各进程内存 / CPU / 磁盘增速；断电重启后全部自起；CRLF / 中文路径检查（沿用子站 Linux 复测做法）。X26A 到货后在实机复测同一套 | 3 d |
| **G7 联调与文档** | 接入规范 v0.2（X26A、IoT Gateway + 内部 MQTT、视频拉模式、EG 管理页访问、抓拍录波定稿）+ 重新生成 Word 版；《EG 部署与运维手册》；子站相关页真后端重截；评审记录 | 文档与实现自检比对；评审 | 2 d |

合计约 **27 人日**。G1 后 G2/G3 与 G4 可并行。每个里程碑把待确认点记进 EG 库 `docs/评审记录.md`；涉及子站的改动在后端 / 前端库同一次提交里改规范、记修订记录。

## 8. 与子站的接口（汇总）

| # | 方向 | 接口 | 状态 |
|---|---|---|---|
| 1 | 同事程序 → EG | MQTT `lsa/<设备名>/telemetry`（《EG 内部 MQTT 格式》） | 新增，G1 |
| 2 | IoT Gateway → 本机 Edge | TB 网关 MQTT 接口 127.0.0.1:1883（规范 §4–§6） | 已定 |
| 3 | Edge ↔ 子站 TB | gRPC 7070 | 已有 |
| 4 | 边缘规则链 → agent | `POST http://eg-agent:9100/hooks/alarm` | 新增，G5 |
| 5 | EG → 子站 | `POST /ext/eg/<柜号>/snapshots`、`/recordings`，`X-EG-Token`，按 `id` 幂等 | G5 实现 |
| 6 | 子站 → EG | 页面反代 `/eg/<柜号>/`；控制 `http://<EG>/api/*`；子站签发票据 | 新增，G2 |
| 7 | 子站 → EG 视频 | 子站 mediamtx 按需拉 `rtsp://<EG 上行 IP>:8554/<路径>` | G4，改规范 §10 |
| 8 | 对时 | EG chrony → 子站主机 → 站内时钟源 | G6 |

## 9. 需要确认的点（括号里是我先按着做的默认值）

**用户已答复（2026-09-24）**

1. 同事的转换程序跑在 EG 上。
2. 每面柜一台双目摄像机，支持 ONVIF；其余（抓图接口、温度矩阵、分辨率）等厂家回复。视频处理不经 TB，独立扩展服务（eg-video）。
3. 分合位、电源失电由同事经 MQTT 一起给。
4. 系统用 Ubuntu 或更轻量的 Linux。
5. 管理页走 HTTP。

**仍要厂家 / 同事答复的**：摄像机抓图接口、温度矩阵（点温）、实际分辨率与帧率；同事的程序能否给 10 Hz 录波数据、弧光持续时间；站内时钟源。

## 10. 开发环境

- 用 `lsa-edge-ah03` 当样机的 Edge，模拟器 `--except AH03`，其余 20 台照常；EG 样机的其他组件新起一组容器（`lsa-eg-*`，`deploy/dev/compose.yaml`）。按需起停，不动 open-webui。
- 开发时 EG 库经 `link:` 引用后端库的 `packages/points` `packages/model`（两库同在 `D:\Work Files\GWDR\` 下）；G6 打包时改为钉提交号的 git 依赖（需后端库推送）。
- G6 的虚拟样机：Ubuntu 24.04 虚拟机（Hyper-V）或 WSL 外的独立环境，4 GB 内存；届时本机内存若紧张，先停部分 Edge 容器（用户已同意按需关停）。
- 时间按东八区看。

## 修订记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v0.1 | 2026-09-24 | 初稿 |
| v0.2 | 2026-09-24 | 按用户答复：硬件定为 X26A（x86_64、≤ 8 GB）→ 只出 amd64、agent 改用 NestJS 与子站一致、预算按 4 GB 核算；采集改用 TB IoT Gateway + 本机 Mosquitto，传感器数据由同事转成 MQTT，我方定内部格式并负责派生量与质量码看护；网口 LAN1 摄像机 / LAN2 上行；新增维护访问（交换机直连 + 经子站反代免二次登录）；视频两级按需拉；子站 → EG 控制改走 HTTP（不用 TB RPC）；G6 改为 Ubuntu 虚拟样机 + 实机复测 |
| v0.3 | 2026-09-24 | 用户批准并答复 §9：同事程序在 EG 上、每柜一台 ONVIF 双目摄像机、视频独立服务 eg-video 不经 TB、分合位 / 电源由同事经 MQTT 给、Ubuntu 或更轻的 Linux、HTTP。G0 实测：IoT Gateway 按设备清单逐台订阅；EG 自身数据改走自定义连接器 LsaSelfConnector |
