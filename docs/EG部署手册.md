# LSA-9600EG 部署手册

> 适用：I 阶段起（EG 跑独立 ThingsBoard CE，后端库 `docs/EG独立TB调整方案.md`）。子站侧的安装见后端库 `docs/子站部署手册.md`。
> 状态（2026-10-08）：G6 起发布件含视频（eg-video + mediamtx）、Docker / chrony 离线包、升级回退、磁盘检查；Hyper-V 虚拟样机（Ubuntu 24.04、4 GB）已验收：裸系统安装、2 h 长跑、硬断电、升级 / 回退、子站现场流程（一键安装 0.9.1–0.9.3）、连续运行 10 天。X26A 实机与麒麟 / UOS 待复测。
> 两样东西配套装：**本库的通用发布件**（`pnpm pack:eg`，各台一样、不含凭据）+ **子站出的每台配置包**（后端库 `scripts/pack-eg.sh`：这台的 `eg.yaml` 与站内 CA 证书 `sp-ca.pem`）。

## 1. 组成与端口

一台 EG（新创云 XCY-X26A，x86_64，硬件见 §2a）上跑 7 个容器，全部由 `compose.yaml` 编排（内存上限合计约 3.0 GB，日志各 10 MB × 3 轮转）：

| 容器 | 作用 | 端口 | 谁访问 |
|---|---|---|---|
| lsa-eg-agent | eg-agent：派生量与质量码、上送子站、告警事件、配置下发、本地管理页 | **80/TCP**（宿主机网络） | 维护笔记本（LAN2 直连）、子站 Nginx 反代 `/eg/<柜号>/`、子站扩展服务下发配置 |
| lsa-eg-tb | EG 本地 ThingsBoard CE 4.2.2.5：存 7 天数据、算 7 类设备告警 | 18080/TCP 只绑 127.0.0.1 | agent；部署时子站经 SSH 隧道 |
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
- 网卡：LAN1 静态地址（与摄像机同段），LAN2 静态地址（站内网），缺省路由走 LAN2。
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
| 串口 | **COM2 = `/dev/ttyS1`**，批量机只有 COM2 能做 485；**样机没有 485** | 样机上测 485 设备要用 USB 转 485（`/dev/ttyUSB0`） |
| 开关量 | 没有 DI / DO | 分合位、失电首期不做（《EG 内部 MQTT 格式》§5.4） |
| 供电 | 只能 12 V，整机 20–25 W | 柜内要有 12 V 电源 |

**485 接线规定**（X26A 的 485：没有自动收发、没有隔离、没有终端电阻；ALS10 弧光传感器**固定内置 120 Ω** 终端电阻、不能断开）

1. 每条 485 总线**只接一只 ALS10，而且放在总线末端**（它就是这一端的终端电阻）。
2. 总线另一端（X26A 这端）按需加 120 Ω 终端电阻；短线、低速（9600）时可以不加，误码多时加上。
3. 一条总线上挂其余几种传感器（同事测过 5 种同挂没问题）照常；ALS10 与其他传感器同挂还没测过，现场先测。
4. **没有自动收发**：收发方向要由转换程序控制（串口 RTS 或内核 RS485 模式），这是同事程序的事，接线时确认程序已按此配置。
5. **没有隔离**：柜内强电磁环境下，485 口与外部设备之间没有电气隔离，**浪涌、地电位差可能损坏 X26A 的串口或造成误码**。建议批量机加隔离型 485 模块；不加的话至少在总线上加浪涌保护（硬件采购决定，待确认事项 Q2）。

**转换程序**（同事，2026-10-09 答复 B1）：Docker 镜像，Python 3.11 + pymodbus（异步 RTU）+ aiomqtt + aiosqlite + PyYAML，自带守护进程。0.4 起纳入 EG 的编排与离线安装包（I11 框架已搭好，**等同事给镜像与启动参数后接上**，Q5）：
- compose 里有个可选服务 `conv`（容器 `lsa-eg-conv`）：宿主机网络、连本机总线 `127.0.0.1:1884`（与格式文档 §2 一致）、`restart: unless-stopped`、健康检查（先只看主进程，同事给了命令再换）、日志 10 MB × 3 轮转、内存上限 256 MB；`config/eg.yaml` 只读给它（设备名以它为准），自己的配置与数据放 `config/conv/`、`config/conv-data/`。
- 串口：宿主机的 `/dev/ttyS1`（X26A 的 COM2）映射成容器里的 `/dev/ttyS1`，加宿主机 `dialout` 组。样机没有 485 用 USB 转 485 时：`sudo bash install.sh --conv-serial /dev/ttyUSB0`（记住；容器里仍是 `/dev/ttyS1`，程序不用改）。
- 镜像随发布件：出包时 `pnpm pack:eg -- --images --debs --conv <镜像:确切 tag>`，发布件里多 `images-conv.tar.gz` 与 `CONV_IMAGE.txt`；install.sh 导入后**镜像在、串口在才启用**（`.env` 的 `COMPOSE_PROFILES=conv`），否则不起、说明原因。升级随 EG 发布件走；`--rollback` 回到不带它的版本时，转换程序容器一并停掉。
- 开关：`--conv-off` 关掉并记住、`--conv-on` 重新打开；`--status` 的容器列表里能看到 `lsa-eg-conv`。
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
sudo bash LSA-9600SP-<版本>-offline.run --role eg --lan1 <摄像机网口>  # EG 第一轮（= 下面 §4 的 install.sh）
sudo bash LSA-9600SP-<版本>-offline.run --role eg --eg-config <目录>   # 子站 provision:eg + pack-eg.sh 之后，带 eg.yaml、sp-ca.pem 起全部
```

不带 `--role` 就交互选；`--extract <目录>` 只解包。重跑更新的安装文件即升级（子站保留 `docker/.env`，EG 保留 `config/`、`.env`）。以下 §4 是 EG 这一段拆开的步骤。

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

- **驱动改成 restv1**（EG 0.5 起；发布件缺省是 `rtsp`（只有视频），**现场接真机时改成 `restv1`**；开发和演示环境用 `sim`（测试件 `test.sh up` 自动改）。2026-10-10 协调会话定）：本地管理页「视频与测温」→「摄像机接入」，驱动选 **restv1**，摄像机地址填 `http://<摄像机 LAN1 地址>`（只到主机[:端口]），账号口令填改过之后的，保存。eg-video 马上按新配置取流地址、开始每秒测温；页面「区域测温」一栏看到「测温接口 cam.rest：正常」、固件版本、令牌剩余时间即通。连不上 / 口令不对 / 令牌失效会在那里直接显示原因（CONNECT / AUTH / TOKEN …），同时温度量在子站标「无效」。
- **投运前必须改摄像机的出厂默认账号口令**：在摄像机自己的管理页里改（出厂口令见厂家资料原件，**不要写进任何发给别人的文档、工单或聊天**），新口令填到 EG 本地管理页「视频与测温」的摄像机账号里（只存在 EG 本地 `local.yaml`，不上送、不给浏览器），记进现场交接单。
- **测温区画好之后不要再翻转 / 镜像画面**：区域坐标是热像画面（640×480）的像素、原点左上，画面翻转后坐标不跟着变，框就对不上部位了；确实要翻转，翻转后在摄像机上把全部测温区重画一遍。
- 测温区：摄像机最多 12 个（接口 ID 0–11 = 平台 R1–R12），首期画 3 个，名字设成 `R1`、`R2`、`R3`（按名对应；不是这个名字就按启用顺序编号）。各区对应哪个部位由子站 model.yaml 的 `regions.R<n>.label` 给。
- 编码保持缺省 H.264（四路都是）：H.265 浏览器大多播不了。RTSP 端口固定 554。
- 摄像机最多 2 个会话同时连：EG 占一个；现场用厂家工具调试时如果连不上，先 `docker stop lsa-eg-video`，调完再 `docker start lsa-eg-video`。
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
- **回滚**：`sudo bash install.sh --rollback` —— 部署文件换回 `.previous/`、镜像改回旧版本、`docker compose up -d`；再跑一次 `--rollback` 又回到新版。本地 TB 版本（`compose.yaml` 里 tb-node 的标签）变过的不许回退（库结构只升不降）。
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

**批量升级（建议，未做工具）**：30 面柜逐台登录太慢时，可在子站主机上用一个只做「拷文件 + 跑 install.sh」的脚本，经维护账号的 SSH（不是 lsa-sp，lsa-sp 只能开隧道）逐台执行、串行、遇错即停；要先定维护账号的密钥怎么管（每台独立还是共用）。等实机和规模定了再决定做不做（协调会话 2026-10-08）。

## 6d. 安全

| 项 | 做法 |
|---|---|
| 本地维护账号 maint | 初始口令随机，在 `config/initial-password.txt`；登录后到「系统」改口令，再删这个文件。文件还在时管理页每页顶上有提醒条，install.sh 的「安全提醒」也会列 |
| 隧道账号 lsa-sp | 只在部署 / 改设备清单时需要；用完 `install.sh --drop-sp-key` |
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

## 8. 待定（记在评审记录 I5）

| # | 问题 | 现在的做法 |
|---|---|---|
| I5-1 | 本地 TB 的实体由子站经 SSH 隧道跑 provision:eg 建 —— 现场要给子站开 EG 的 SSH | 按此；以后可改为 agent 按 eg.yaml 自建（I4 已有生成告警规则的代码） |
| I5-2 | ~~agent 用宿主机网络听 0.0.0.0:80，LAN1（摄像机网）也能访问管理页~~ | 已解决（G6）：`install.sh --lan1 <网口>` → 从该网口进来的请求 403（按网口现有地址判，不 bind 地址，免得开机时地址没配上起不来）；也可在 `local.yaml http.denyOn` 列网口名 |
| I5-3 | ~~本地 TB 的系统管理员沿用出厂口令~~ | 已解决：provision:eg 建完租户后改掉（后端 01a28c5） |
| I5-4 | ~~本机总线不鉴权~~ | 已定：维持不鉴权（只绑 127.0.0.1 与容器网络，见 §6d） |
| I5-5 | ~~镜像与整套安装未在 Linux 上跑过~~ | 已解决：虚拟样机（Ubuntu 24.04）全套验过；X26A 实机与麒麟 / UOS 待复测 |
