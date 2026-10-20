# LSA-9600EG 部署手册

> 适用：I 阶段起（EG 跑独立 ThingsBoard CE，后端库 `docs/EG独立TB调整方案.md`）。子站侧的安装见后端库 `docs/子站部署手册.md`。
> 状态（2026-10-08）：G6 起发布件含视频（eg-video + mediamtx）、Docker / chrony 离线包、升级回退、磁盘检查；Hyper-V 虚拟样机（Ubuntu 24.04、4 GB）已验收：裸系统安装、2 h 长跑、硬断电、升级 / 回退、子站现场流程（一键安装 0.9.1–0.9.3）、连续运行 10 天。X26A 实机与麒麟 / UOS 待复测。
> 两样东西配套装：**本库的通用发布件**（`pnpm pack:eg`，各台一样、不含凭据）+ **子站出的每台配置包**（后端库 `scripts/pack-eg.sh`：这台的 `eg.yaml` 与站内 CA 证书 `sp-ca.pem`）。

## 1. 组成与端口

一台 EG（新创云 XCY-X26A，x86_64，硬件见 §2a）上跑 7 个容器，全部由 `compose.yaml` 编排（内存上限合计约 3.0 GB，日志各 10 MB × 3 轮转）：

| 容器 | 作用 | 端口 | 谁访问 |
|---|---|---|---|
| lsa-eg-agent | eg-agent：派生量与质量码、上送子站、告警事件、配置下发、本地管理页 | **80/TCP**（宿主机网络） | 维护笔记本（LAN2 直连）、子站 Nginx 反代 `/eg/<柜号>/`、子站扩展服务下发配置 |
| lsa-eg-tb | EG 本地 ThingsBoard CE 4.2.2.6（0.17 起；之前 4.2.2.5）：存 7 天数据、算 7 类设备告警 | 18080/TCP 只绑 127.0.0.1 | agent；部署时子站经 SSH 隧道 |
| lsa-eg-postgres | 本地 TB 的库 | 不对外 | 本地 TB |
| lsa-eg-mosquitto | 本机总线 | 1884/TCP 只绑 127.0.0.1 | 同事的采集程序（本机）、agent、IoT Gateway |
| lsa-eg-gateway | TB IoT Gateway 3.8.5：总线 → 本地 TB | 不对外 | — |
| lsa-eg-video | eg-video：摄像机驱动、测温、生成 mediamtx 配置、抓帧、裁证据片段（与 agent 同一镜像 `lsa-eg-app`，含 ffmpeg） | 9110/TCP 只听 127.0.0.1 | agent |
| lsa-eg-mediamtx | 视频：主码流按需拉、两路子码流常拉常录（循环录像在 `recordings/`） | **8554/TCP**（宿主机网络）；API 9997、回放 9996 只听 127.0.0.1 | 子站 mediamtx（只许子站主机读）；eg-video、agent |

**网口**：LAN1 接双目摄像机（设备网），LAN2 接子站交换机（上行网）。

**防火墙（EG 上，ufw 或 nftables）**：

| 方向 | 端口 | 说明 |
|---|---|---|
| 入站 LAN2 | 80/TCP | 本地管理页、子站反代、子站下发配置 |
| 入站 LAN2 | 8554/TCP | 子站拉视频（RTSP；mediamtx 只许子站主机读） |
| 入站 LAN2 | 8189/UDP | 本地管理页看实时画面（WebRTC 媒体；信令经 agent 80 口、要会话，没协商过的包不回）。挡住也行，页面自动退到 HLS（经 80 口） |
| 入站 LAN2 | 22/TCP | 维护（部署时子站开 SSH 隧道跑 provision:eg）；可只放子站主机的地址 |
| 出站 → 子站 | **8883/TCP**（MQTT over TLS） | 遥测上送（`station.mqtt`） |
| 出站 → 子站 | **443/TCP**（HTTPS） | 告警事件与回执（`station.http`） |
| 出站 → 子站 | 123/UDP | 对时（chrony 与 agent 的 SNTP 测量） |
| 入站 LAN1 | **全关**（install.sh 加） | 摄像机网只出不进。`install.sh --lan1 <网口>` 时装 nftables 表 `inet lsa_eg`：LAN1 进来的只放已建立 / 相关连接的回包，其余丢 —— 22 / 80 / 8554 从摄像机网都连不上（超时）；Docker 发布到容器的端口走 forward 链，同样挡。开机由 `lsa-eg-fw.service` 加载；`install.sh --status` 看状态与丢包数；`--fw-off` 关掉并记住、`--fw-on` 重开；回退到不管它的老版本时自动清掉。管理页对 LAN1 另有应用层 403 兜底 |
| 入站 LAN1 | 123/UDP（只摄像机） | **摄像机对时**（0.7.x，缺省开）：EG 给 LAN1 上的摄像机当 NTP 服务器 —— chrony 对 LAN1 网段 `allow`（`/etc/chrony/conf.d/lsa-eg-cam.conf`，加 `local stratum 12`：EG 一时没对上子站也照常给时间，摄像机始终跟 EG 一致），防火墙只对 `local.yaml` 摄像机一段里的地址（restv1 / onvif / rtsp 的主机）放行 UDP 123。摄像机管理页把 NTP 服务器设成 **EG 的 LAN1 地址**。`install.sh --cam-ntp-off` 关掉并记住、`--cam-ntp-on` 重开（**改了摄像机地址后也跑它**重新放行）；`--status` 显示，地址没放行会提示。只为录像、抓拍画面上叠的时间跟子站一致：EG 上送的测温、报警、录像分段、证据一律用 EG 自己的钟，摄像机钟不对也不影响子站判断 |
| 出站 → LAN1 | 554、80 | 拉摄像机 RTSP、ONVIF / 测温接口。**一律 RTSP over TCP**（mediamtx `rtspTransport: tcp`、抓帧 `-rtsp_transport tcp`，sim / onvif / rtsp 三种驱动一样）：UDP 的 RTP 是摄像机主动发来的，LAN1 防火墙下不保证能进。**不用 ONVIF 组播发现**：摄像机地址在「视频与测温」里静态配置 |

容器之间走 docker 网络 `lsa-eg`；本地 TB 的告警钩子经 `host.docker.internal`（宿主机网关地址）推给宿主机网络上的 agent 的 80 口 —— 防火墙要允许 docker 网段访问本机 80。

## 2. 主机准备

- 系统：**只支持 Ubuntu Server 24.04 LTS**（最小安装；开发计划 §1，G6 定稿；2026-10-09 用户确认不出 22.04 离线包）。X26A 出厂是 Ubuntu 22.04 中文桌面版，**部署前改装 Ubuntu Server 24.04**，步骤见 §2a「改装 Ubuntu Server 24.04」。离线包 `debs/` 是 24.04（noble）的，22.04 上装不上。
- Docker Engine + compose 插件、chrony：**不用先装** —— 发布件的 `debs/`（`pack:eg -- --debs`）带离线包，install.sh 发现没有就装：先卸与 chrony 冲突的 systemd-timesyncd，再 `dpkg -i` 一次装本机没有 / 比本机新的那些（不联网；不用 `apt-get install ./debs/*.deb` —— 机器上留着装系统时的源索引时 apt 会报「Pathname to install is not absolute」，虚拟样机实测）。发布件的 `IMAGES.txt` 列各镜像的 tag / digest / ID，导入后逐个核对。
- 对时：install.sh 第二轮按 `eg.yaml sp.host` 写 `/etc/chrony/sources.d/lsa-eg.sources`，并把 `chrony.conf` 的 `makestep` 改成 `1 -1`（X26A **有** RTC 电池（2026-10-09 答复 X3，更正以前「没有」的说法），断电重启时钟大体是对的；但电池老化或长期断电后仍可能偏得多，缺省只在头 3 次更新里跳、之后差几分钟也要追几小时，所以照样改成随时可跳）。agent 另用 SNTP 测偏差上报 `eg.clk_offset`。
- **子站主机当时间服务器**：一键安装 `--role sp` 给子站的 chrony 加 `allow` 站内私网与 `local stratum 10 orphan`（没有上级时全站至少跟子站一致），站内时钟源用 `--ntp <地址>` 给（记住，升级不用再给）；子站防火墙放 UDP 123。**EG 与子站时钟差超过 60 s 时，子站下发配置、单点登录的票据会被 EG 拒收**（「票据时间在未来」，0.9.3 无 AVX 样机上踩到：实验网里没有任何对时，跑了 10 天的 VM 漂了 63 s）。
- 系统日志：install.sh 写 `/etc/systemd/journald.conf.d/lsa-eg.conf`，journald 封顶 200 MB。
- **系统版本检查**（0.4 起）：install.sh 一开始就看 `/etc/os-release`，不是 Ubuntu 24.04 就用中文报错退出，并提示先按 §2a 改装（离线包装不上，装到一半才失败更麻烦）。
- **软件看门狗**（0.4 起，I13；X26A 没有硬件看门狗）：install.sh 缺省打开 —— 加载 `softdog`（写 `/etc/modules-load.d/lsa-eg-softdog.conf`，开机自动加载），并写 `/etc/systemd/system.conf.d/lsa-eg-watchdog.conf`：`RuntimeWatchdogSec=60s`（systemd 每 30 s 喂一次，系统卡死 60 s 没喂就重启整机）、`RebootWatchdogSec=10min`（关机 / 重启卡住也强制重启）。本机有硬件看门狗时直接用它，不加载 softdog。
  - 看状态：`sudo bash install.sh --status` 里有「看门狗：开（Software Watchdog；systemd 每 1min 内没喂就重启）」。
  - **关掉**：`sudo bash install.sh --watchdog-off`（删上面两个文件、systemd 正常关闭看门狗设备后卸 softdog，并记在 `.env` 的 `EG_WATCHDOG=off`，以后重跑 install.sh 也不再开）；**重新打开**：`--watchdog-on`。现场调试内核、或怀疑看门狗误重启时才关。
  - 回退到 0.4 以前的版本时自动关掉（那些版本不管它）。
- 网卡：LAN1 静态地址 **`192.168.100.1/24`**（与摄像机同段；每台 EG 都一样，各台 LAN1 只连自己的摄像机、互相隔离；netplan 加 `ignore-carrier: true`，不插网线也有地址），LAN2 静态地址（站内网），缺省路由走 LAN2。摄像机统一 **`192.168.100.64`**，NTP 服务器设 `192.168.100.1`（S19 起，协调 2026-10-19 定；厂家预装见《EG厂家出厂预装手册》v1.1）。
- 数据盘：本地 TB 留 7 天、上送 outbox 最多 2 GB、**循环录像**（两路子码流常录，按 1 Mbit/s 估每天约 10.8 GB，留 24 h）、锁定的证据片段（30 天，按每次告警约 12 MB 估），按 128 GB 工业级 mSATA 准备（开发计划 §1）。**X26A 实配 mSATA 256 GB、300 TBW**（2026-10-09 答复 X2）：按每天 11–20 GB 写入，300 TBW 远超 10 年，写入寿命不再是风险。
- **摄像机侧没人看时也一直有流量**：EG 从摄像机常拉两路子码流做循环录像（约 1 Mbit/s，LAN1 上），主码流才按需；**SSD 每天约 11 GB 写入**（一年约 4 TB，按盘的 TBW 核寿命）。
- **容量 / 寿命检查**：`sudo bash diskcheck.sh [采样秒数] [盘的 TBW]` —— 各部分占用（录像、证据、outbox、TB 卷、日志）、开机以来与当前的写入速率、按 TBW 估的寿命；有 smartctl 时另报盘自己记的累计写入。

## 2a. X26A 实际配置、改装 Ubuntu Server 24.04 与 485 接线（2026-10-09 外部答复）

依据：《待确认事项清单》第 4 版 X1–X5、ARC7、B1–B6、I12–I15。

**主机**

| 项 | 实际 | 对我们的影响 |
|---|---|---|
| 系统 | 出厂预装 Ubuntu 22.04 中文桌面版；可以改装（用户 2026-10-09 确认） | **部署前改装 Ubuntu Server 24.04**，见下面「改装 Ubuntu Server 24.04」 |
| 内存 | 8 GB，最多可扩到 16 GB | 编排内存上限合计约 3.0 GB，Server 版没有图形界面，够用 |
| 硬盘 | mSATA 256 GB，300 TBW | 见 §2「数据盘」 |
| 来电自启 | 有，默认开 | 断电恢复后自己开机，容器 `restart: unless-stopped` 自起 |
| 看门狗 | **没有硬件看门狗** | 0.4 起 install.sh 缺省启用软件看门狗（softdog + systemd `RuntimeWatchdogSec=60s`）兜底系统卡死，可关，见 §2「软件看门狗」（I13） |
| RTC 电池 | 有 | 见 §2「对时」 |
| 串口 | **COM2 = `/dev/ttyS1`**，批量机只有 COM2 能做 485；**样机没有 485**；COM2 没有隔离、没有自动收发 | **批量机必须加隔离**（用户 2026-10-10 定，Q2），选型与接线见下面「485 隔离（批量机必须加）」；样机上测 485 设备用 USB 转 485 |
| 开关量 | 没有 DI / DO | 分合位、失电首期不做（《EG 内部 MQTT 格式》§5.4） |
| 供电 | 只能 12 V，整机 20–25 W | 柜内要有 12 V 电源 |

**485 接线规定**（X26A 的 COM2：没有自动收发、没有隔离、没有终端电阻；ALS10 弧光传感器**固定内置 120 Ω** 终端电阻、不能断开）

1. 每条 485 总线**只接一只 ALS10，而且放在总线末端**（它就是这一端的终端电阻）。
2. 总线另一端（EG 这端，加了隔离模块就是隔离模块那一端）按需加 120 Ω 终端电阻：隔离模块自带可开关的终端电阻时，**按总线长度决定开不开** —— 短线、低速（9600）时可以不开，线长（几十米以上）或误码多时打开；ALS10 那一端始终是它内置的那只，不要再加。
3. 一条总线上挂其余几种传感器（同事测过 5 种同挂没问题）照常；ALS10 与其他传感器同挂还没测过，现场先测。
4. **COM2 没有自动收发**：直接用 COM2（或 COM2 后面串隔离中继器）时，收发方向要由转换程序控制（串口 RTS 或内核 RS485 模式），这是同事程序的事，接线时确认程序已按此配置。用自动收发的 USB 转 485 模块时没有这个问题。
5. **批量机必须加隔离**（用户 2026-10-10 定，待确认事项 Q2）：柜内强电磁环境下，COM2 与外部设备之间没有电气隔离，**浪涌、地电位差会损坏 X26A 的串口或造成误码**。选型与接线见下一节。

**485 隔离（批量机必须加；具体型号未定，以下是给采购的要求）**

| | 方式 A（优先）：工业级隔离型 USB 转 RS485 | 方式 B（备选）：RS485 隔离中继器串在 COM2 后面 |
|---|---|---|
| 选型要求 | USB 转串口芯片 **FTDI**（FT232R / FT231X 等）或同级、Linux 内核自带驱动（**免驱**，Ubuntu 24.04 插上即出 `/dev/ttyUSB0`）；**芯片带唯一序列号**（FTDI 出厂写好；CH340 一类没有序列号，`/dev/serial/by-id` 下的名字不唯一、不能当稳定路径用）；**自动收发方向**（硬件控制，不靠 RTS）；**隔离 ≥ 2.5 kV**（电源与信号都隔离）；**带浪涌保护**（TVS，A / B 线对地）；**终端电阻可选、可断开**（拨码或跳线）；工业级温度（−40–85 ℃）、导轨或螺丝固定；USB 线够短、能固定，不会松 | 隔离 ≥ 2.5 kV、带浪涌保护、两侧终端电阻可选可断开；输入侧接 COM2、输出侧接现场总线；如果标称「自动收发」，指的是中继器两侧之间的方向切换，**COM2 本身仍然没有自动收发** |
| 设备名 | `/dev/ttyUSB0`（多插一个 USB 串口、或重启后枚举顺序变了，号可能变；稳定路径是 `/dev/serial/by-id/usb-…-if00-port0`，见评估「转换程序串口用稳定路径」） | 仍是 `/dev/ttyS1`（COM2），转换程序配置不用改 |
| 启用 | `sudo bash install-conv.sh`（只插一个 USB 模块时自动用它；或 `--serial /dev/ttyUSB0`，记成 by-id；容器里仍是 `/dev/ttyS1`，程序不用改） | 不用给（没插 USB 模块时缺省就是 `/dev/ttyS1`） |
| 接线 | X26A 的 USB 口 → 模块；模块 A / B / GND（隔离地）→ 现场总线，总线末端是 ALS10 | X26A 的 COM2（A / B / GND）→ 中继器输入侧；中继器输出侧 A / B / 隔离地 → 现场总线，总线末端是 ALS10 |
| 收发方向 | 模块自己切，转换程序不用控制 | **还要转换程序控制**（RTS / 内核 RS485 模式，上面第 4 条）；BIOS 里 COM2 设成 485 模式 |
| 优缺点 | 隔离、浪涌、自动收发一次解决；多一个 USB 设备要固定好 | 不占 USB、设备名不变；COM2 不能自动收发的问题没解决，同事程序要按 RTS 方向控制写 |

- 两种方式下，ALS10 的规定不变：**每条总线只接一只 ALS10，放在末端**；隔离模块 / 中继器那一端的终端电阻按总线长度决定开不开（上面第 2 条）。
- 样机（没有 COM2 的 485）一直用 USB 转 485 测，方式 A 的设备名与配置和样机一样。

**转换程序**（同事的 edge-gateway，Python + aiomqtt + aiosqlite + PyYAML，串口自己读 Modbus RTU）。EG 0.6.2 起按同事 1.1.1 的实际程序落地（2026-10-16 全链路联调，见 `docs/全链路联调记录-0.17.1.md`）：
- **镜像**：同事仓库 + 我方补丁（`tools/conv-patches/edge-gateway-1.1.1/`，0001–0005）由 `tools/conv-image/build.sh <同事仓库> lsa-eg-conv:<版本>` 离线打（本机 `python:3.12-slim` + 同事 `wheels/`，构建时断网）。镜像里带同事的配置模板（`/app/config.default`）。
- compose 里的可选服务 `conv`（容器 `lsa-eg-conv`）：宿主机网络、`restart: unless-stopped`、日志 10 MB × 3 轮转、内存上限 128 MB（联调实测 19–23 MiB，5 路传感器、含 10 分钟断子站）。
  - **配置**：`EDGE_GATEWAY_CONFIG=/config`，就是本机的 `config/conv/`。数据（缓存库、心跳）在 `config/conv-data/`。`config/eg.yaml` 只读挂进去（补丁 0001 读柜号，clientId 用 `lsa-conv-<柜号>`）。
  - **总线地址与串口由 EG 统一管**：compose 给 `LSA_MQTT_URL=mqtt://127.0.0.1:1884`、`LSA_SERIAL=/dev/ttyS1`，补丁 0005 用它们覆盖 `gateway.yaml` 里写的值。现场换串口只用 `install-conv.sh --serial`，不用进容器改配置。
  - **健康检查**：进程在，并且最近 2 分钟有数据发出或写进缓存（补丁 0005 的心跳文件 `/data/heartbeat`）。`--status` 显示 healthy / unhealthy。
- **启用只走 `install-conv.sh`**（EG 0.6.2 起，在 EG 安装目录里；同一套脚本也在单独的「转换程序接入包」里）。发布件带转换程序镜像（`CONV_IMAGE.txt`、`images-conv.tar.gz`，install.sh 导入），**缺省不启用**，现场接好 485 以后：
  1. `sudo bash install-conv.sh`：按 `eg.yaml` 从镜像模板生成 `config/conv/`（局放、气体、温湿度、弧光、红外都打开 —— 0.7.1 起红外也开（S19 五种传感器全配，子站 `samIr` 缺省已确认）；温湿度挂第一台 SAM、其余挂第二台；从站地址用同事的缺省 1–5）。**非 S19 的站 SAM 没接红外的，用 `--sensors pd,gas,temperature,arc` 关掉**，否则子站会判红外缺量；已有的 `config/conv/` 不动→ 选串口（`/dev/serial/by-id` 下只有一个 USB 转 485 就用它，多个让选，没有就 `/dev/ttyS1` COM2）→ 写 `.env`（`EG_CONV=on`、镜像、串口、dialout 组、`COMPOSE_PROFILES=conv`）→ 起 conv，20 s 后给一句结论（通了 / 部分通 / 没应答 / 串口打不开）。
  2. 现场调整：`--sensors pd,arc`、`--addr pd=7`、`--dev temperature=SAM-<柜号>-B`、`--baud`，只改给了的项、改完自动重启；也可以直接改 `config/conv/sensors/*.yaml` 后 `docker restart lsa-eg-conv`。**挂在哪台设备**决定了看护口径：EG 按这里打开的传感器推出每台的预期测点（W1，见开发计划 §6.1）。
  3. 核对：`sudo bash install-conv.sh --status`（各路配置、设备名有没有对上、最近采集）、`--check`（lsa_check 跑 2 分钟）；本地管理页「设备与通信 → 服务状态」的转换程序卡片。
  4. 读不到：`--diag [rs485|modbus]` 先停 conv、在镜像里跑同事的诊断脚本直接问从站；没有传感器时 `--sim` 在容器里跑模拟器自测。停用 `--off`。
  - 详细步骤与常见问题见 `tools/conv-addon/硬件联调步骤.md`（发布件里是 `转换程序硬件联调步骤.md`）。
- install.sh 对转换程序只做两件事：导入镜像；升级 / 回退时，启用过的（`.env` 的 `EG_CONV=on`，或 0.6.1 以前的 `COMPOSE_PROFILES=conv` 没关过）换成本发布件的镜像接着跑，串口不在了就不起并说明原因。老参数 `--conv-on` / `--conv-off` / `--conv-serial <设备>` 转给 install-conv.sh。`--status` 显示启用与否、串口、自动重启次数。
- 串口：宿主机的设备映射成容器里的 `/dev/ttyS1`，加宿主机 `dialout` 组；`/dev/ttyUSB*` / `/dev/ttyACM*` 自动换成 `/dev/serial/by-id/…` 的稳定名字（EG 0.5.1 起），找不到 by-id 时提醒「芯片没有序列号」；路径里有「:」「#」或空格的拒绝（compose 的设备映射会拆错，AH11 实测）。运行中拔掉 USB 模块，conv 起不来（eg-agent 的重启也会报 Docker 找不到设备），插回后 `sudo bash install-conv.sh`。
- 出包：`tools/conv-image/build.sh` 先打镜像，`pnpm pack:eg -- --images --debs --conv lsa-eg-conv:1.1.1-p5`；发布件里多 `images-conv.tar.gz`、`CONV_IMAGE.txt`，并总是带 `install-conv.sh`、`conv-kit/`。**这一版是试用**：同事 1.1.1 + 我方补丁 A–E，等他把补丁合进自己仓库、改完 C1 / C3 后换正式版。
- **转换程序保险**（0.17，eg-agent 自动做，不管用的是哪个转换程序）：本机总线 `lsa-eg-mosquitto` 重启过、而 `lsa-eg-conv` 是在它之前起的 → 重启 conv；conv 在跑、但 60 s 总线上没有它的任何读数（SAM / 电表的遥测；0.7.1 起不再看颗粒物 PM6）→ 重启 conv，连续重启按 60 s × 2^n 退避（最多 30 min），读数回来清零。每次重启记本地审计「自动重启转换程序」、上送 EG 遥测 `eg.conv_restarts` / `eg.conv_restart`（子站 check.sh 据此提示），`--status` 也会显示次数与最近一次原因。参数在 `config/local.yaml` 的 `convGuard: { enabled, silentS, maxBackoffS }`（缺省 true / 60 / 1800）；conv 没启用时什么也不做。
- **MQTT 连接保活**（0.17）：上送子站（8883）、本机总线（1884）的连接被对端拒绝（CONNACK 非 0，如子站 TB 重启中途回「Server unavailable」、令牌错回「Not authorized」）时照样重连 —— mqtt.js 默认被拒一次就再也不连；连续被拒按 5 s → 60 s 翻倍退避，连上恢复；断了而库没在重连时换个客户端重连。上送被拒时日志写 CONNACK 码与原因，EG 遥测 `eg.uplink_err`、本地管理页上送状态、`--status`（读 `config/uplink-state.json`）都显示原因；4 / 5 / 134 / 135（令牌类）提示查 `eg.yaml` 的 `station.token` 与子站上这台 EG 的设备。
- 在那之前（发布件里没有它的镜像）按同事自己的方式部署，只要连 `127.0.0.1:1884` 按《EG 内部 MQTT 格式》发就行。

**改装 Ubuntu Server 24.04**（X26A 出厂是 22.04 桌面版；我们只支持 24.04 Server。改装会清空整块盘，出厂系统不保留）

1. **准备安装盘**：Ubuntu Server 24.04.x LTS amd64 ISO（与虚拟样机同一版本 24.04.5，`ubuntu-24.04.5-live-server-amd64.iso`，SHA256 `97f3d7ff…0fd8`），写进 U 盘（Windows 用 Rufus，Linux 用 `dd`）。
2. **进 BIOS 先确认**：
   - **COM2 设为 RS-485 模式**（如果 BIOS 有串口模式选项；批量机只有 COM2 能做 485）。改完存盘。
   - 来电自启（AC Power Loss → Power On）开着（出厂默认开）。
   - 启动顺序把 U 盘放前面，装完再改回硬盘。
3. **安装时的选择**：
   - 安装类型选 **Ubuntu Server (minimized)**；不选任何额外 snap。
   - 磁盘：整块 mSATA（256 GB），默认分区即可。
   - **勾选 OpenSSH server**（部署、维护、子站开隧道都要用）。
   - 网卡：LAN2（接站内交换机）设静态地址与缺省网关；LAN1（接摄像机）设静态地址、**不设网关**。可以不联网装完（离线）。两块网卡是 Intel i211，24.04 自带驱动（igb）。
   - 用户名统一用现场约定的维护账号；口令按现场规定，记进现场交接单（不要写进任何发给别人的文档）。
4. **装完立刻做**：
   - **关自动更新**：Server 版缺省也开着 unattended-upgrades，会在后台装更新、甚至重启，还可能把 Docker / chrony 升到与离线包不一致的版本：`sudo systemctl disable --now unattended-upgrades`，并把 `/etc/apt/apt.conf.d/20auto-upgrades` 里两项改成 `"0"`。
   - 时区：`sudo timedatectl set-timezone Asia/Shanghai`。
   - **确认 485 口在**：`ls -l /dev/ttyS1`、`sudo dmesg | grep ttyS1` 能看到 COM2；它属 `dialout` 组，转换程序的容器映射它时要带这个组（I11）。
   - 确认两块网卡都起来了：`ip -br addr`（i211 驱动是 `igb`：`ethtool -i <网口>`）。
5. 然后按 §3b / §4 用一键安装文件 `--role eg` 装（离线装 Docker、chrony、导入镜像）。

注意：
- 网卡地址在 Server 版里由 netplan（`/etc/netplan/*.yaml`）管；改地址改这个文件再 `sudo netplan apply`，不要另装 NetworkManager。
- 不要装桌面环境：多占内存，还会带回自动挂起、自动更新这些问题。
- 第一台 X26A 改装完、装好 EG 后，用**真 COM2**（不是 USB 转 485）接一只传感器验一遍串口收发（样机没有 485，I12 剩下的就是这一步）。

## 3. 子站侧要先准备的

1. 子站跑过 `provision`：子站上有 `EG-<柜号>` 网关设备与令牌，`tb/provision/out/eg/<柜号>/eg.yaml` 已生成。
2. **TLS**：子站对 EG 开 MQTT 8883（TB 的 MQTT over TLS）与 HTTPS 443（Nginx），证书由后端库 `scripts/gen-certs.sh --san <EG 连子站用的地址>` 签：
   - 证书的 SAN 要含 **EG 用来连子站的那个地址**（通常是子站 LAN 的 IP），否则 EG 报 `Hostname/IP does not match`；
   - 站内 CA 证书 `sp-ca.pem` 随 `eg.yaml` 一起拷到 EG 的 `config/`。agent 容器用 `NODE_EXTRA_CA_CERTS=/config/sp-ca.pem` 信任它，上送（mqtts）与事件（https）都生效；
   - 用正规 CA 签的证书就不用 `sp-ca.pem`（没有这个文件时 agent 启动会打一行「忽略额外证书」的提示，无害）。
3. 子站 TLS 的配置细节见后端库 `docs/子站部署手册.md`。

## 3b. 一键安装文件（整个系统一个文件）

`pnpm bundle -- --sp <子站离线包目录>`（子站离线包由后端库 `scripts/pack-offline.sh --web <前端 dist>` 打；EG 发布件不给就现打）出 `dist/bundle/LSA-9600SP-<版本>-offline.run`：自解压 bash + tar，约 3.7 GB，子站主机与各柜 EG 都用它，装时选角色。负载打包前后各扫一遍，不带任何密钥 / 凭据；`SHA256SUMS` 覆盖每个文件，装前自动校验。

```bash
sudo bash LSA-9600SP-<版本>-offline.run --role sp [--ip <站内 IP>]     # 子站：随机口令写 /opt/lsa9600sp/初始账号口令.txt
sudo bash LSA-9600SP-<版本>-offline.run --role sp --kiosk             # 0.16：子站装好后接着装机柜双屏（安装文件要带 sp/kiosk/）
sudo bash LSA-9600SP-<版本>-offline.run --role eg --lan1 <摄像机网口>  # EG 第一轮（= 下面 §4 的 install.sh）
sudo bash LSA-9600SP-<版本>-offline.run --role eg --lan1 <摄像机网口> --join-key '<子站给的一行>'   # 0.17.4：一键加柜，其余在子站做（§4a）
sudo bash LSA-9600SP-<版本>-offline.run --role eg --eg-config <目录>   # 子站 provision:eg + pack-eg.sh 之后，带 eg.yaml、sp-ca.pem 起全部
```

`--kiosk`（0.16）只用于 `--role sp`：子站装好后调子站的 `scripts/install-kiosk.sh sp/kiosk` 装机柜双屏；安装文件里没有 `sp/kiosk/`（子站离线包打的时候没带 `--with-kiosk`；安装说明与 MANIFEST 里写着「机柜双屏 kiosk：有 / 没有」）时，**装任何东西之前**就报错停下，不会只装一半；双屏装失败时子站本身已装好，修好后重跑 `--role sp --kiosk`（幂等）。不带 `--kiosk` 行为不变。

只支持 x86_64 + **Ubuntu Server 24.04**（子站主机、EG 都是）：EG 0.5.x 起安装文件一开头就查，别的系统（22.04、Debian、麒麟等）直接中文报错退出，子站指向《子站部署手册》§2b、EG 指向本手册 §2a 的改装步骤（以前只在要装离线 Docker 时才查）。不带 `--role` 就交互选；`--extract <目录>` 只解包。重跑更新的安装文件即升级（子站保留 `docker/.env`，EG 保留 `config/`、`.env`）。以下 §4 是 EG 这一段拆开的步骤。

## 4. 安装

发布件在开发机上生成：`pnpm pack:eg -- --images --debs`，得到 `dist/eg-<版本>/`（compose、安装脚本、磁盘检查、Mosquitto 配置、自定义连接器、`images-amd64.tar.gz`、`debs/`）。所有 EG 通用，不含任何凭据。

```bash
# 在 EG 上
sudo mkdir -p /opt/lsa-eg && sudo cp -r eg-<版本>/* /opt/lsa-eg/ && cd /opt/lsa-eg
sudo bash install.sh --lan1 <摄像机网口>   # 第一轮：没有 Docker 先装离线包、导入镜像、生成 .env（本地库口令）、建本地 TB 的库、起本地 TB
```

第一轮结束时本地 TB 已起、但还是空的。由**子站主机**给它建实体（子站 0.9.1 起有现场入口，子站主机不用装 Node）。

**1. 给子站授权开隧道**（每台 EG 一次）：把子站主机的 SSH 公钥（如 `~/.ssh/id_ed25519.pub`，没有就 `ssh-keygen -t ed25519` 生成）拷到 EG：

```bash
# 在 EG 上
sudo bash install.sh --sp-key /tmp/sp_id_ed25519.pub     # 一键安装文件：--role eg --sp-key <公钥>
```

它建一个**只能开隧道**的账号 `lsa-sp`：没有口令、没有 shell，authorized_keys 带 `restrict,port-forwarding,permitopen="127.0.0.1:18080"` —— 只能从子站转发到 EG 本机的本地 TB（18080），拿不到 shell、转发不了别的端口、拷不了文件（虚拟样机 AH09 上实测）。同一把公钥反复给不会重复加；**部署完删掉**：`sudo bash install.sh --drop-sp-key`（以后再要 provision 重新 `--sp-key`）。install.sh 装完与 `--status` 会在「安全提醒」里提示它还在。
不预置共用账号：所有 EG 共用一把钥匙，丢一台就全丢。

**2. 子站主机上建实体**（子站部署目录 `/opt/lsa9600sp/lsa9600sp-backend`）：

```bash
# 先只读核对一遍
scripts/provision-eg.sh --cabinet <柜号> --ssh lsa-sp@<EG 的 LAN2 地址> [--ssh-key <私钥>] --hook http://host.docker.internal/hooks/alarm --sp <子站地址> --plan
# 正式建：本地租户、下挂设备（名字与子站一致）、带告警规则的设备配置、告警钩子，并更新 eg.yaml（加 tb: 本地 TB 账号）
scripts/provision-eg.sh --cabinet <柜号> --ssh lsa-sp@<EG 的 LAN2 地址> [--ssh-key <私钥>] --hook http://host.docker.internal/hooks/alarm --sp <子站地址>
```

`--ssh` 在容器里开隧道连 EG 本机的 127.0.0.1:18080。provision-eg 同时把本地 TB 系统管理员的出厂口令改掉（新口令只留在子站 `tb/provision/out/eg/<柜号>/tb-sysadmin.json`）。

**3. 出这台的配置包**（纯 bash，子站主机上直接跑）：

```bash
scripts/pack-eg.sh --sp <子站地址> --only <柜号>     # → dist/eg/<柜号>/eg.yaml（station 改成 mqtts://<子站>:8883）与 sp-ca.pem
```

**4. 拷到 EG**：用 EG 的维护账号（`lsa-sp` 拷不了文件）把 `eg.yaml`、`sp-ca.pem` 放到 `/opt/lsa-eg/config/`（权限 600）；或者用一键安装文件 `--role eg --eg-config <放这两个文件的目录>`。

然后在 EG 上：

```bash
sudo bash install.sh        # 第二轮：配 chrony、生成 IoT Gateway 与 mediamtx 配置、起全部
```

**验收**：浏览器开 `http://<EG 的 LAN2 地址>/`，本地维护账号 `maint`，初始口令在 `config/initial-password.txt`（登录后改掉口令、删掉这个文件）。
「诊断」页各项应为绿色：本机总线已连、到子站时延正常、数据上送「正常」、告警事件上送「正常」、对时偏差 < 1 s；子站网关页看到这台 EG 在线、积压为 0。

## 4a. 一键加柜（0.17.4 起，推荐）

§4 的 1–4 步（授权隧道、建实体、出配置包、拷到 EG 再跑第二轮）可以全交给子站：EG 上只动一次手，可以在进场前的库房做。子站侧用法见子站部署手册「一键加柜」（`docs/子站一键加柜.md`，脚本 `/opt/lsa9600sp/join-egs.sh`）。§4 的老做法照旧能用。

**EG 上**（一次）：子站上 `join-egs.sh --keygen` 打印一行 join-key，装软件时带上：

```bash
sudo bash LSA-9600SP-<版本>.run --role eg --lan1 <摄像机网口> --join-key 'LSAJOIN1 192.168.77.20 ssh-ed25519 AAAA… ssh-ed25519 AAAA… 3f2a9c1e'
sudo bash /opt/lsa-eg/install.sh --join-key '<那一行>'        # 已经装好的 EG 只补授权
```

- **join-key** 共 7 段：`LSAJOIN1`、子站地址、隧道公钥（类型 + 内容）、升级公钥（类型 + 内容）、校验（前 6 段 sha256 的前 8 位）。只有公钥，可以随便传；少粘一截、抄错一位直接拒绝。
- **效果**等于 `--sp-key` 加 `--upgrade-key`，两把 key 都加 `from=<子站地址>`：隧道账号 lsa-sp 只能从子站开隧道到本机 18080；升级账号 lsa-upg 只能进升级入口（§6c）。另记 `config/join.json`（子站地址、两把 key 的指纹、时间，600）。
- 已接入别的子站的 EG 再给别的子站的 join-key：拒绝，换子站加 `--force`。同一个子站的重复给：只更新 key（幂等）。
- **待接入**：有 join.json、还没有 eg.yaml。第一轮装完起本地 TB 和一张只读的**待接入页**（容器 `lsa-eg-pending`，同一个应用镜像，在 80 口）：授权的子站、本机各网口的 IP / MAC、软件版本、本地 TB 起没起、子站上要执行的下一条命令。页面上没有密钥、没有任何操作，LAN1 进来照样 403。`install.sh --status` 显示「接入：待接入 —— 已授权子站 …」，接入后显示「接入：已接入子站 X（柜号 Y）」。

**子站做的**（经升级入口，0.17.4 入口版本 3 新加 4 个动作，仍是白名单；0.18.0 入口版本 4：hello 报 `unit=`、apply-config 按单元）：

| 动作 | 做什么 | 校验 |
|---|---|---|
| `put-config <sha256> <字节>` | 收配置包（tar.gz） | ≤ 1 MB、sha256 对；包里只许 `eg.yaml`（必须有）、`sp-ca.pem`、`conv.args` 三个普通文件 |
| `apply-config <sha256> [force]` | 后台任务换配置：备份 → 换上 → install.sh 起全部 → 自查（7 个容器、agent 连上子站，最多 240 s）→ 单元变了（拆柜改作单元、force 改接）且转换程序配过：`install-conv.sh --rebind` 改挂设备名、重启转换程序（clientId 跟着换）→ 包里带 conv.args 就设转换程序 | eg.yaml 的子站地址要和 join.json 一致（老办法接入的认现在 eg.yaml 里的）；已接入的单元不能改（比 eg.yaml 的 `unit.code`，照旧一柜一台的比柜号；例外：拆柜 —— 本机照旧接在柜 X、配置包是 X 的某个单元，原来那台改作单元；子站 `join-egs.sh --force` 带 `force`）；和现在的配置一模一样就不换（不重启）。**失败自动换回**：原来待接入的回到待接入，已接入的回到旧配置（state 记 rolled-back） |
| `conv <选项…>` | 调 install-conv.sh | 只认 `--serial`（`/dev/ttyS<n>`、`/dev/ttyUSB<n>`、`/dev/ttyACM<n>`、`/dev/serial/by-id/…`）、`--sensors`（pd / gas / temperature / arc / infrared）、`--addr`（名字=1–247）、`--dev`（设备名要在 eg.yaml 里）、`--baud`（标准波特率）、`--off`、`--status`；不认的整句拒绝，参数按数组传、不经 shell |
| `drop-tunnel` | 撤隧道账号 lsa-sp（同 `--drop-sp-key`） | 升级授权留着 |

`hello` 多报 `joined`、`unit`（0.18.0；照旧一柜一台的 = 柜号，待接入为空）、`cabinet`、`sp`、`join_sp`。换配置的状态、日志和升级任务同一处（`/var/lib/lsa-upg/state`、`jobs/`），旧配置备份在 `config/.join-backup-<任务号>/`。

## 5. eg.yaml 的现场取值

`eg.yaml` 由子站生成、EG 上只读（改要回子站改 `tb/model.yaml` 再生成）。与现场网络有关的几项：

| 字段 | 开发环境 | 现场 | 说明 |
|---|---|---|---|
| `station.mqtt` | `mqtt://127.0.0.1:1883` | **`mqtts://<子站 LAN IP>:8883`**（`pack-eg.sh --sp` 写入） | 遥测上送（§8.1）。主机名要与子站证书的 SAN 一致 |
| `station.http` | `http://127.0.0.1:3001` | **`https://<子站 LAN IP>`**（同上） | 扩展服务基址：事件 POST `<http>/ext/eg/<柜号>/events`（经子站 Nginx 443）。不写时缺省 `http://<sp.host>` |
| `station.token` | 子站 `EG-<柜号>` 网关设备的令牌 | 同左 | 上送用户名、事件 `X-EG-Token`、验子站票据（单点登录、配置下发）都用它 |
| `sp.host` | `localhost` | 子站 LAN IP | 没配 `station.mqtt` 时的探测目标；对时服务器缺省也用它 |
| `eg.token` | 同 `station.token` | 同左 | IoT Gateway 连本地 TB 用；provision:eg 把本地 `EG-<柜号>` 的令牌设成同一个 |
| `tb.user / tb.password` | provision:eg 写入 | 同左 | 本地 TB 租户管理员（agent 读本地告警、写设备配置） |
| `eg.attrs.ip / ipUp` | 模型里的值 | LAN1 / LAN2 实际地址 | 子站台账显示用 |

`local.yaml`（EG 本地，本地管理页「系统」里可改）：对时服务器（空 = `sp.host`）、上行网口名（空 = 按缺省路由自动找）、摄像机地址与账号。其余（总线、本地 TB 地址、端口、容器名）按 compose 的缺省即可，不要改。

## 5a. 双目摄像机（2026-10-10 厂家答复，待确认事项清单 4.4 版 CAM1–CAM8）

- **驱动改成 restv1**（EG 0.5 起；发布件缺省是 `rtsp`（只有视频），**现场接真机时改成 `restv1`**；开发和演示环境用 `sim`（测试件 `test.sh up` 自动改）。2026-10-10 协调会话定）：本地管理页「视频与测温」→「摄像机接入」，驱动选 **restv1**，摄像机地址填 `http://<摄像机 LAN1 地址>`（只到主机[:端口]），账号口令填改过之后的，保存。**真机有两套账号**（2026-10-14 实测，G4 视频接口约定 §10）：「取流账号 / 口令」填 RTSP 用的 `admin`，「接口账号 / 口令」填 restv1 登录用的那个（接口账号留空 = 同取流账号；用错了的表现：测温报 AUTH、或四路探测都 401）。eg-video 马上按新配置取流地址、开始每秒测温；页面「区域测温」一栏看到「测温接口 cam.rest：正常」、固件版本、令牌剩余时间即通。连不上 / 口令不对 / 令牌失效会在那里直接显示原因（CONNECT / AUTH / TOKEN …），同时温度量在子站标「无效」。
- **出厂地址是 192.168.1.x 段的固定地址**（不走 DHCP，ONVIF 搜不到）：统一改成 **`192.168.100.64`**（掩码 24，不设网关），再接 EG 的 LAN1（`192.168.100.1`）。不要让 LAN1 用 192.168.1.x：出厂 LAN2 临时地址 192.168.1.250 和站内上行网也在这一段，会冲突。出厂时钟是 1970 年：摄像机管理页把 NTP 服务器设成 `192.168.100.1`，EG 0.7.x 起缺省给 LAN1 上的摄像机对时（`install.sh --cam-ntp-on/off`，端口表「入站 LAN1 123/UDP」）。
- `local.yaml` 样板（厂家预装时只写这几行，口令到现场在管理页填）：
  ```yaml
  camera:
    driver: restv1
    restv1: http://192.168.100.64
  ```
- **投运前必须改摄像机的出厂默认账号口令**（两套都改）：在摄像机自己的管理页里改（出厂口令见厂家资料原件，**不要写进任何发给别人的文档、工单或聊天**），新口令填到 EG 本地管理页「视频与测温」的摄像机账号里（只存在 EG 本地 `local.yaml`，不上送、不给浏览器），记进现场交接单。
- **测温区画好之后不要再翻转 / 镜像画面**：区域坐标是热像画面（640×480）的像素、原点左上，画面翻转后坐标不跟着变，框就对不上部位了；确实要翻转，翻转后在摄像机上把全部测温区重画一遍。
- 测温区：摄像机最多 12 个（接口 ID 0–11 = 平台 R1–R12），首期画 3 个，名字设成 `R1`、`R2`、`R3`（按名对应；不是这个名字就按启用顺序编号）。各区对应哪个部位由子站 model.yaml 的 `regions.R<n>.label` 给。
- 编码保持缺省 H.264（四路都是）：H.265 浏览器大多播不了。RTSP 端口固定 554。
- 摄像机最多 2 个会话同时连（厂家 CAM4）：2026-10-14 真机实测 RTSP 拉流不算在内，restv1 令牌同时 3 个也正常（G4 视频接口约定 §10）。现场用厂家工具调试时万一连不上，先 `docker stop lsa-eg-video`，调完再 `docker start lsa-eg-video`。
- 摄像机的 HTTP 接口是串行的：可见光抓拍要 3–4 s，这期间测温会慢一拍（不报错）；不要在 EG 运行时用脚本高频抓拍。
- 摄像机的「红外 Modbus」输出（RS485 / Modbus TCP）**不接**：和网络接口给的是同一份测温数据，EG 走网络接口。

## 5b. 改设备清单（换传感器、加减下挂设备）

配置下发只改阈值与规则开关；**下挂设备清单不能在线改**（I4-1，协调会话 2026-10-08 定）：子站下发的设备清单与本机 `eg.yaml` 不一致时回 FAILED。改设备清单走这一遍：

1. 子站改 `tb/model.yaml` 里这面柜的设备（型号、数量），重跑子站 provision（子站 TB 上增删设备）；
2. EG 授权隧道（删过 lsa-sp 的话）：EG 上 `sudo bash install.sh --sp-key <子站公钥>`；
3. 子站主机 `scripts/provision-eg.sh --cabinet <柜号> --ssh lsa-sp@<EG> … --plan` 核对，再正式跑（本地 TB 增删设备、更新 `eg.yaml`）；
4. `scripts/pack-eg.sh --sp <子站> --only <柜号>` 重出配置包，拷到 EG 的 `config/`；
5. EG 上 `sudo bash install.sh`（第二轮，重生成 IoT Gateway 映射、重启 agent）；
6. 子站网关页对这台点「下发配置」（或等自动重发），回执 APPLIED；删掉 lsa-sp。

## 6. 升级与回滚

- **升级**：新发布件直接解压覆盖到 `/opt/lsa-eg`（`config/`、`recordings/`、`.env` 不在发布件里、不会被覆盖），`sudo bash install.sh`。install.sh 把上一次装好的部署文件（`.installed/`）挪成 `.previous/`、`.env` 的 `EG_APP_IMAGE` 改成新版本；更早的 `lsa-eg-app` 镜像清掉，只留现在的与可回退的。
  **一定要在 `/opt/lsa-eg` 里跑**：在解压出来的别的目录直接跑会生成另一份 `.env`（新的本地库口令），把正在跑的本地库 / TB 按新口令重建、TB 连不上库反复重启（0.9.1 现场流程验收踩到）。install.sh 发现本机已装在别处会拒绝并给出正确命令（确实要另装加 `--force`）。
- **回滚**：`sudo bash install.sh --rollback` —— 部署文件换回 `.previous/`、镜像改回旧版本、`docker compose up -d`；再跑一次 `--rollback` 又回到新版。本地 TB 版本变过时见下「本地 TB 升级与回退」。
- **本地 TB 升级与回退**（0.17：4.2.2.5 → 4.2.2.6，与子站、平台同步，修了十几个 CVE）：
  - **升级**照常跑新安装文件 `--role eg`（或新发布件 + `install.sh`）。install.sh 看库里记的版本（`tb_schema_settings.schema_version`，4.2.2.6 记作 4002002006）：
    同一补丁线（只差第 4 位）→ **先把本地库（含遥测）备份**到 `/opt/lsa-eg/backups/tb-<旧版本>-<时间>.dump`（只留最近一份；盘上空间不够库大小就拒绝，确实不要备份加 `--no-tb-backup`，那样回不去），
    **不跑 TB 的升级脚本**（TB 官方：同补丁线 DO NOT run the upgrade script；跑了会报「database version … is not supported for upgrade」停在半路），直接换镜像起，
    新 TB 启动时自己补数据（`docker logs lsa-eg-tb` 里 SystemPatchApplier「Version increased from 4.2.2.5 to 4.2.2.6」），install.sh 等库里版本变成新的（最多约 2 分钟）再往下走。
    降级、跨小版本（如 4.2 → 4.3）直接拒绝，什么都不动。`--status` 显示本地 TB 版本与备份文件。
  - **回退**：库已补成新版后旧 TB 起不来（库只升不降），只能用升级前的备份恢复：
    1. `sudo bash install.sh --rollback` —— 不动任何东西，说明要用哪个备份、会丢什么；
    2. 确认后 `sudo bash install.sh --rollback --restore-tb` —— 停本地 TB → 删库重建 → `pg_restore` 备份 → 部署文件、镜像换回旧版（旧 TB 镜像 `tb-node:4.2.2.5` 还在本机）→ 起来。约 1–2 分钟。
    **丢什么**：备份之后本地 TB 新写的遥测、告警（子站那边是全的；本地页近期曲线缺这一段）。上送 outbox、配置目录（eg.yaml、生效配置、审计）不在库里，不受影响。
    新版 TB 没起来过 / 库没补过（比如升级中途停了）时库还是旧的，`--rollback` 直接回，不用恢复。
  - 回退之后要再升：跑新安装文件 `--role eg`（同上，会再备份一次）。
  - 验收：`bash deploy/test/upgrade-eg.sh <旧 .run> <新 .run>`（一次性沙箱：旧版装好、种数据 → 升级 → 回退 → 再升级，每步核对设备、告警规则、告警、历史点、cfg 与库里版本）。
- **子站回滚时的电表变比**：子站回滚到 0.12（下发的配置不带 `meters`）后，EG 变比会回到 eg.yaml 初值（电表属性 `ctRatio` / `ptRatio`，没写就是 1），这次变化子站侧不会留倍率变更记录；如需追溯，在维护记录里手工登记。（EG 0.4 起：配置体没有 `meters`、或没有本柜那一块，就按初值；重启后也是初值，不会恢复上一次下发的变比）
- `sudo bash install.sh --status`：容器状态、已装版本、可回退到哪个版本。
- 升级期间 agent 停几秒：同事的数据由 Mosquitto 持久会话排着，上送 outbox 在磁盘上，都不丢（I2 实测重启无断档）。

**断网与补传**（`local.yaml` 的 `outbox` 段，本地管理页「系统」里看）：

| 项 | 缺省 | 说明 |
|---|---|---|
| `backfillRate` | 2000 条 / s | 恢复后补传限速（实时数据先走、不限速）。30 面柜同时恢复子站约 6 万条 / s，规模测试总吞吐约 4.1 万条 / s 子站扛得住（I2-1，协调会话定维持 2000）；**子站主机偏弱时降到 1000** |
| `maxAgeDays` / `maxMb` | 7 天 / 2048 MB | outbox 只留这么多；超了丢最旧的，丢掉的时段记进「数据缺口」（`eg.lost`，子站可见） |

- 断上行期间告警照常在本地判、存事件库，恢复后补送，**事件不受 7 天限制**（等子站回执才删）。
- 对账窗口（本地 TB 告警 → 事件库）= 上次对账以来，**上限 7 天**（与 outbox 保留期一致，I3-2）；首次部署看 24 h。
- 实测（虚拟样机 AH09，2026-10-08）：子站侧停了 9.3 天，恢复后补传 225 万条；超出 7 天的约 2.3 天（75 万条）按设计丢弃并记缺口；outbox 文件不会自动缩小（SQLite），上限内无害。

## 6b. 测试件（只在虚拟样机 / 实验台上用，**现场不装**）

`pnpm pack:eg -- --test` 另出 `dist/eg-<版本>-test/`：仿真器 `lsa-eg-emu`（代替同事的采集程序往本机总线发数据、扮摄像机测温接口）与 RTSP 测试源（扮摄像机四路视频，127.0.0.1:8555）。不进 `IMAGES.txt`、与正式编排不共用容器。

```bash
# 正式编排第二轮装完之后
sudo cp -r eg-<版本>-test /opt/lsa-eg/test
sudo bash /opt/lsa-eg/test/test.sh up      # 导入测试镜像、local.yaml 摄像机改 sim + 本机测试源、起 emu 与 camera、重启 eg-video
sudo bash /opt/lsa-eg/test/test.sh down
```

造告警（emu 控制面只听本机 3190）：`curl -X POST "http://127.0.0.1:3190/emu/arc?intensity=450&ms=25"`（弧光）、`…/emu/cam/overtemp?region=R1&max=120&s=300`（区域过温）、`…/emu/dev/<设备>/dead?on=1`（整台停发）。

**单网口的机器不要给 `--lan1`**：那样唯一的网口也被挡掉，管理页谁都打不开。install.sh 在只有一个物理网口时拒绝 `--lan1`（确实要这样加 `--force`）；给的网口名不存在也直接报错。单网口时靠防火墙挡摄像机网。

**开发用开关**：`EG_PASSIVE=1`（旁观模式，只收不发）只给开发机并排验接口，发布件的 compose 与 install.sh 里没有；现场 agent 看到它会连打三条错误日志 —— 看到就去掉。

## 6c. 换机、逐台升级与批量升级

**换机（EG 坏了换一台新的，柜号不变）**——子站上这面柜的设备、令牌、历史数据都不动：

| # | 步骤 | 检查 |
|---|---|---|
| 1 | 新机按 §2 装系统、配网（LAN2 用**原来的地址**；地址变了要在子站网关页改「现场配置」或重跑 provision-eg.sh） | `ip -br a` |
| 2 | 一键安装文件 `--role eg --lan1 <摄像机网口> --sp-key <子站公钥>`（第一轮） | 结束时提示子站侧 4 步 |
| 3 | 子站主机 `provision-eg.sh --cabinet <柜号> --ssh lsa-sp@<新机> …`（本地 TB 是新的，按子站重建）→ `pack-eg.sh --only <柜号>` | 「完成：新建 …」 |
| 4 | 配置包拷到新机 `config/`（600），第二轮 `--role eg` | 7 个容器 Up |
| 5 | 摄像机：本地管理页「视频与测温」核对地址、账号（`local.yaml` 不在配置包里，要重填） | cam.online = 4 |
| 6 | 子站网关页：这台在线、积压 0、配置版本与期望一致（不一致点「下发配置」） | APPLIED |
| 7 | 改 maint 口令、删 `initial-password.txt`、`install.sh --drop-sp-key` | 「安全提醒」为空 |

旧机上没送出去的 outbox、本地录像与未上传的证据**不迁移**（坏机一般也取不出来）；能开机的旧机可先接回上行网等积压送完（诊断页积压 0）再拆。新机的 `hostBootId` 会变，子站按「重启」记一次。

**逐台升级**（现在的做法）：每台 EG 跑新的一键安装文件 `--role eg`（或把新发布件拷进 `/opt/lsa-eg` 再 `install.sh`，§6）。每台约 30 s、agent 中断 1–2 s，不丢数据。建议顺序：先 1 台跑一天 → 再按母线段分批；每台装完看 `install.sh --status` 与子站网关页（在线、积压 0、版本对）。出问题 `install.sh --rollback`（约 11 s）。

**批量升级（0.17.2 起）**：在子站主机上一条命令把多台 EG 升到新的一键安装文件（子站侧用法见子站部署手册「批量升级 EG」，脚本 `/opt/lsa9600sp/upgrade-egs.sh`）。EG 这边要做的只有授权：
- **授权**（每台一次，用维护账号）：子站上 `sudo bash /opt/lsa9600sp/upgrade-egs.sh --keygen` 会打印公钥和要在每台 EG 上执行的命令：`sudo bash /opt/lsa-eg/install.sh --upgrade-key '<公钥>'`。
  - 会建一个专用账号 `lsa-upg`：锁口令；key 只认来自子站的连接（`from=`，地址缺省取 `eg.yaml` 的 `station.mqtt`，要改加 `--upgrade-from <地址>`）。
  - 不管子站发什么，都只进升级入口 `/usr/local/sbin/lsa-eg-upgrade`（`authorized_keys` 的 `command=`）。sudoers 只放行这一个入口。
- **入口只认这几个动作**，其余一律拒绝，并记进 `/var/log/lsa-upg.log`：
  - `hello`：版本、可用空间、正在做的别的维护（lsa-sp 隧道开着、有安装在跑）：子站据此跳过这台；
  - `put`：从 SSH 收安装文件，收之前查空间，收完核对字节数和 sha256；
  - `put-sig`（0.18.1，入口版本 5）：收这个安装文件的分离签名 `<run>.sig`（≤ 16 KB，要是 `ssh-keygen -Y sign` 出的格式）；
  - `start`：开始升级。先验签（见下），再看是不是 LSA 的一键安装文件、里面要有 EG 发布件，版本不低于现装版本，同时只跑一个，有人在手工跑安装时拒绝；
  - `status` / `log`：查进度和日志；
  - `drop`：删掉拷过来的文件。
  - 沙箱里试过都被拒的：执行任意命令、命令串接 / 替换、空登录、sudo 别的程序、scp / sftp、端口转发、换一台机器用同一把 key、sha256 不对、不是安装文件。
- **升级在 EG 上自己做完**：`start` 用 systemd-run（没有就 setsid nohup）起后台任务，子站断开、网络断了照样做完。状态在 `/var/lib/lsa-upg/state`，日志在 `/var/lib/lsa-upg/jobs/`。
  - 安装文件失败：自动 `install.sh --rollback`；本地 TB 版本变了时加 `--restore-tb`。
  - 装完但自查不过（版本、7 个容器 60 s 不重启、本地 TB 镜像、连上子站）：**不自动回退**（可能是子站或网络的问题），由子站停下来、给出回退命令。
- **撤销**：`sudo bash install.sh --drop-upgrade-key`（账号、key、sudoers 条目、入口一并删掉）。`--status` 和「安全提醒」里能看到授权在不在、最近一次任务。
- **验签（0.18.1 起）**：一键安装文件出包时签名，旁边多一个 `<run>.sig`（ed25519，`ssh-keygen -Y sign`）；EG 发布件带发布公钥 `/opt/lsa-eg/release-signers`。
  - `start` 用**本机已经装着的**发布公钥验（不是新安装文件里带的那份），验过才起任务；`/var/lib/lsa-upg/state` 的 `sig=` 记结果：
    `ok`（验过，`sig_note=` 是 key 指纹）/ `unsigned`（没有 .sig）/ `nokey`（有 .sig，但本机没有发布公钥）。
  - 签名不对（不是发布方签的，或安装文件 / 签名被改过）：**一律拒绝**，收到的文件当场删掉，子站汇总写「EG 没开始升级：签名校验不过 …」。
  - **过渡期（0.18.1）**：没有 .sig 照装，记「未验签」；**下一版起**入口改成 `SIG_REQUIRED=1`，没签名 / 没公钥都拒。现场想提前强制：`/opt/lsa-eg/.env` 加一行 `EG_UPG_SIG_REQUIRED=1`（`hello` 会报 `sig_required=1`，子站 `--plan` 遇到没签名的直接 !!）。
  - 从 0.18.1 之前的版本**升到 0.18.1 的那一次**，EG 上跑的还是老入口（版本 4），收不了 .sig：只有子站验过（子站汇总会写明）。升上去以后的每次升级 EG 都验。
  - `install.sh --status` 的「子站批量升级」下面多一行「升级验签」：发布公钥几把、指纹、最近一次任务的签名结果。
  - 手工核对一个安装文件：`ssh-keygen -Y verify -f /opt/lsa-eg/release-signers -I lsa9600-release -n lsa9600-release -s <run>.sig < <run>`（打印 `Good "lsa9600-release" signature …` 就对）。
- **注意**：持子站那把升级 key 的人能让 EG 装安装文件、等于 root。有了签名以后，他只能让 EG 装**发布方签过**、版本不低于现装的安装文件；过渡期里没签名的安装文件照样能装（汇总会写「未验签」）。key 只放在子站主机 root 下，不用时撤销。
- 0.17.2 之前的 EG 没有 `--upgrade-key`：先手工升到 0.17.2（§6），以后才能批量升。

**网页入口（0.19.0 起）**：子站网页「系统 → 网关升级」能做上面的批量升级（选包 → 计划 → 先升一台 → 其余并发 → 停止 / 续查 → 历史），EG 这边**不用多做什么**（授权同上，签名照样 EG 再验）。子站侧：
- 网页（扩展服务，容器里、没有升级 key）只往 `/var/lib/lsa9600sp/eg-upgrade/requests/` 写白名单请求；子站主机上 root 的执行器 `/opt/lsa9600sp/lsa-eg-upgrade-runner`（systemd `lsa-eg-upgrade-runner.path` 发现新请求就跑）校验后调同一个 `upgrade-egs.sh`，批次另起 `lsa-eg-upgrade-<批次>` unit。命令行和网页共用批次与日志，同一时间只跑一个批次。
- 目录（一键安装文件 `--role sp` 建）：安装包目录 `/var/lib/lsa9600sp/eg-upgrade/packages/`（root:lsa-upgrade 2775）、请求 `requests/`（root 0700，挂进容器）、处理完的请求 `done/` 与安装文件工作拷贝 `work/`（root 0700，不挂进容器）、结果 `state/`（0755）、批次 `/var/log/lsa9600sp/eg-upgrade/<批次>/`。
- **维护账号加进 `lsa-upgrade` 组**（每个子站一次，重新登录生效）：`sudo usermod -aG lsa-upgrade <维护账号>`。
- **放包**：安装文件连同 `.sig` 一起 scp 进安装包目录，网页上点「重新扫描」：
  `scp LSA-9600SP-<版本>-offline.run LSA-9600SP-<版本>-offline.run.sig <维护账号>@<子站>:/var/lib/lsa9600sp/eg-upgrade/packages/`
- **网页只认签名验过的安装包**（续查也只认签名包的批次）；没签名 / 验不过的只能命令行升。目录只留最近 3 个包。
- 细节（「开始」只照计划原样、10 分钟有效、查问题的 journalctl）见《子站批量升级EG》§8。

## 6d. 安全

| 项 | 做法 |
|---|---|
| 本地维护账号 maint | 初始口令随机，在 `config/initial-password.txt`；登录后到「系统」改口令，再删这个文件。文件还在时管理页每页顶上有提醒条，install.sh 的「安全提醒」也会列 |
| 隧道账号 lsa-sp | 只在部署 / 改设备清单时需要；用完 `install.sh --drop-sp-key` |
| 批量升级账号 lsa-upg（0.17.2） | `install.sh --upgrade-key` 授权，只认子站、只能进升级入口（§6c）；0.18.1 起安装文件要验发布签名（过渡期没签名照装、记「未验签」，下一版起强制），不用时 `--drop-upgrade-key` |
| 一键加柜（0.17.4） | `--join-key` 一次给两把 key，都只认子站地址；隧道接入完由子站撤掉，升级授权留着（§4a）。能推配置的人也能改 EG 的配置，所以入口要求子站地址和 join.json 一致、已接入的单元不能改（拆柜、`force` 例外，见 §4a） |
| SSH | 维护账号改用密钥登录后，建议关掉口令登录（`/etc/ssh/sshd_config.d/` 下写 `PasswordAuthentication no`，`systemctl reload ssh`）。install.sh 只提醒、不替你改（免得把自己锁在外面）；防火墙可只放子站主机与维护笔记本访问 22 |
| LAN1 防火墙 | `--lan1` 时自动加（见 §1）：摄像机网上 22 / 80 / 8554 都连不上。实测（无 AVX 样机）：从摄像机网全部超时；EG 主动连摄像机网、经 LAN1 拉 RTSP（TCP）照常；重启后 28 s 内规则在；回退到老版本清掉、再升回来又加上 |
| 对外端口 | 只有 22、80（管理页）、8554（RTSP，mediamtx 只许子站主机与本机读）、8189/UDP（WebRTC）听所有网口；本地 TB 18080、本机总线 1884、mediamtx API / 回放、eg-video 都只绑 127.0.0.1（虚拟样机 `ss -tulnp` 核对过）。LAN1 进来的管理页请求一律 403（`--lan1`） |
| 本机总线不鉴权（I5-4） | 只绑 127.0.0.1 与容器网络，站内网摸不到；同事的采集程序在本机直连。结论：维持不鉴权 |
| `EG_PASSIVE` | 开发用旁观模式，发布件里没有；现场 `.env` 里出现会被「安全提醒」列出、agent 也会打错误日志 |

## 7. 排障速查

| 现象 | 看哪里 |
|---|---|
| 管理页打不开 | `docker compose ps`；`docker logs lsa-eg-agent`（eg.yaml 缺失 / 格式版本不对会直接退出） |
| 诊断「数据上送」连不上子站 | `station.mqtt` 地址、8883 是否放通、证书（日志里 `self-signed certificate` / `Hostname/IP does not match` → `sp-ca.pem` 或证书 SAN） |
| 告警事件「重试中」 | 同上查 443；子站回 401 → `station.token` 与子站设备令牌不一致（重新生成 eg.yaml） |
| 本地告警不出 | 本地 TB 设备配置是否有规则（子站下发过配置吗）；`docker logs lsa-eg-gateway` 看总线与本地 TB 的连接 |
| 诊断「对时」灰、eg.clk_offset 没有值 | 对时服务器（`local.yaml ntp.server`，空 = `sp.host`）UDP 123 不通：诊断页灰、日志每分钟一行「对时测量失败」，不报警、不影响其它功能（虚拟样机上宿主没有 NTP 服务，就是这样）。现场由站内 NTP 提供 |
| EG 自身指标本地 TB 上不更新 | `docker logs lsa-eg-gateway \| grep "LSA EG 自身"`，重载后应有「订阅本机总线」（I4 修过一次死锁） |

## 7b. 已知情况

- **弧光事件在本地 TB 可能多一条同一时刻的「弧光异常」**（0.17，协调会话 2026-10-14 接受为已知情况，不再改）：转换程序发布超时的那一条会转入缓存再补传，而原来那次 QoS1 发送在总线恢复后也会送到（at-least-once）。eg-agent 对 `uv.pulse` 按「同一设备、同一 ts」去重，上送子站、派生、录波都只算一次；但「总线 → IoT Gateway → 本地 TB」这条路不经 agent，本地 TB 的设备配置规则会对重复的那条再判一次，前一次告警已恢复时就在本地多起一条同一时刻的「弧光异常」。只在总线卡住的那一瞬间恰好发生弧光事件时出现，概率很低；本地历史曲线、子站的告警与次数不受影响。

## 8. 待定（记在评审记录 I5）

| # | 问题 | 现在的做法 |
|---|---|---|
| I5-1 | 本地 TB 的实体由子站经 SSH 隧道跑 provision:eg 建 —— 现场要给子站开 EG 的 SSH | 按此；以后可改为 agent 按 eg.yaml 自建（I4 已有生成告警规则的代码） |
| I5-2 | ~~agent 用宿主机网络听 0.0.0.0:80，LAN1（摄像机网）也能访问管理页~~ | 已解决（G6）：`install.sh --lan1 <网口>` → 从该网口进来的请求 403（按网口现有地址判，不 bind 地址，免得开机时地址没配上起不来）；也可在 `local.yaml http.denyOn` 列网口名 |
| I5-3 | ~~本地 TB 的系统管理员沿用出厂口令~~ | 已解决：provision:eg 建完租户后改掉（后端 01a28c5） |
| I5-4 | ~~本机总线不鉴权~~ | 已定：维持不鉴权（只绑 127.0.0.1 与容器网络，见 §6d） |
| I5-5 | ~~镜像与整套安装未在 Linux 上跑过~~ | 已解决：虚拟样机（Ubuntu 24.04）全套验过；X26A 实机与麒麟 / UOS 待复测 |
