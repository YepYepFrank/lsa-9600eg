# LSA-9600EG 部署手册

> 适用：I 阶段起（EG 跑独立 ThingsBoard CE，后端库 `docs/EG独立TB调整方案.md`）。子站侧的安装见后端库 `docs/子站部署手册.md`。
> 状态（2026-09-27）：G6 起发布件含视频（eg-video + mediamtx）、Docker / chrony 离线包、升级回退、磁盘检查；**Hyper-V 虚拟样机（Ubuntu 24.04、4 GB / 4 核）验收进行中**，本手册随之修订。
> 两样东西配套装：**本库的通用发布件**（`pnpm pack:eg`，各台一样、不含凭据）+ **子站出的每台配置包**（后端库 `scripts/pack-eg.sh`：这台的 `eg.yaml` 与站内 CA 证书 `sp-ca.pem`）。

## 1. 组成与端口

一台 EG（新创云 XCY-X26A，x86_64）上跑 7 个容器，全部由 `compose.yaml` 编排（内存上限合计约 2.9 GB，日志各 10 MB × 3 轮转）：

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
| 入站 LAN2 | 22/TCP | 维护（部署时子站开 SSH 隧道跑 provision:eg）；可只放子站主机的地址 |
| 出站 → 子站 | **8883/TCP**（MQTT over TLS） | 遥测上送（`station.mqtt`） |
| 出站 → 子站 | **443/TCP**（HTTPS） | 告警事件与回执（`station.http`） |
| 出站 → 子站 | 123/UDP | 对时（chrony 与 agent 的 SNTP 测量） |
| 入站 LAN1 | 全关 | 摄像机网只出不进。agent 听 0.0.0.0:80，但 `install.sh --lan1 <网口>` 后从 LAN1 进来的请求一律 403（I5-2 已做） |
| 出站 → LAN1 | 554、80 | 拉摄像机 RTSP、ONVIF / 测温接口 |

容器之间走 docker 网络 `lsa-eg`；本地 TB 的告警钩子经 `host.docker.internal`（宿主机网关地址）推给宿主机网络上的 agent 的 80 口 —— 防火墙要允许 docker 网段访问本机 80。

## 2. 主机准备

- 系统：Ubuntu Server 24.04 LTS 最小安装（开发计划 §1；G6 定稿）。
- Docker Engine + compose 插件、chrony：**不用先装** —— 发布件的 `debs/`（`pack:eg -- --debs`）带离线包，install.sh 发现没有就装：先卸与 chrony 冲突的 systemd-timesyncd，再 `dpkg -i` 一次装本机没有 / 比本机新的那些（不联网；不用 `apt-get install ./debs/*.deb` —— 机器上留着装系统时的源索引时 apt 会报「Pathname to install is not absolute」，虚拟样机实测）。发布件的 `IMAGES.txt` 列各镜像的 tag / digest / ID，导入后逐个核对。
- 对时：install.sh 第二轮按 `eg.yaml sp.host` 写 `/etc/chrony/sources.d/lsa-eg.sources`（子站再对站内时钟源）。agent 另用 SNTP 测偏差上报 `eg.clk_offset`。
- 系统日志：install.sh 写 `/etc/systemd/journald.conf.d/lsa-eg.conf`，journald 封顶 200 MB。
- 网卡：LAN1 静态地址（与摄像机同段），LAN2 静态地址（站内网），缺省路由走 LAN2。
- 数据盘：本地 TB 留 7 天、上送 outbox 最多 2 GB、**循环录像**（两路子码流常录，按 1 Mbit/s 估每天约 10.8 GB，留 24 h）、锁定的证据片段（30 天，按每次告警约 12 MB 估），按 128 GB 工业级 mSATA 准备（开发计划 §1）。
- **摄像机侧没人看时也一直有流量**：EG 从摄像机常拉两路子码流做循环录像（约 1 Mbit/s，LAN1 上），主码流才按需；**SSD 每天约 11 GB 写入**（一年约 4 TB，按盘的 TBW 核寿命）。
- **容量 / 寿命检查**：`sudo bash diskcheck.sh [采样秒数] [盘的 TBW]` —— 各部分占用（录像、证据、outbox、TB 卷、日志）、开机以来与当前的写入速率、按 TBW 估的寿命；有 smartctl 时另报盘自己记的累计写入。

## 3. 子站侧要先准备的

1. 子站跑过 `provision`：子站上有 `EG-<柜号>` 网关设备与令牌，`tb/provision/out/eg/<柜号>/eg.yaml` 已生成。
2. **TLS**：子站对 EG 开 MQTT 8883（TB 的 MQTT over TLS）与 HTTPS 443（Nginx），证书由后端库 `scripts/gen-certs.sh --san <EG 连子站用的地址>` 签：
   - 证书的 SAN 要含 **EG 用来连子站的那个地址**（通常是子站 LAN 的 IP），否则 EG 报 `Hostname/IP does not match`；
   - 站内 CA 证书 `sp-ca.pem` 随 `eg.yaml` 一起拷到 EG 的 `config/`。agent 容器用 `NODE_EXTRA_CA_CERTS=/config/sp-ca.pem` 信任它，上送（mqtts）与事件（https）都生效；
   - 用正规 CA 签的证书就不用 `sp-ca.pem`（没有这个文件时 agent 启动会打一行「忽略额外证书」的提示，无害）。
3. 子站 TLS 的配置细节见后端库 `docs/子站部署手册.md`。

## 4. 安装

发布件在开发机上生成：`pnpm pack:eg -- --images --debs`，得到 `dist/eg-<版本>/`（compose、安装脚本、磁盘检查、Mosquitto 配置、自定义连接器、`images-amd64.tar.gz`、`debs/`）。所有 EG 通用，不含任何凭据。

```bash
# 在 EG 上
sudo mkdir -p /opt/lsa-eg && sudo cp -r eg-<版本>/* /opt/lsa-eg/ && cd /opt/lsa-eg
sudo bash install.sh --lan1 <摄像机网口>   # 第一轮：没有 Docker 先装离线包、导入镜像、生成 .env（本地库口令）、建本地 TB 的库、起本地 TB
```

第一轮结束时本地 TB 已起、但还是空的。**在子站主机上**给它建实体：

```bash
# 子站主机：开隧道（EG 的本地 TB 只听 127.0.0.1）
ssh -N -L 18080:127.0.0.1:18080 <账号>@<EG 的 LAN2 地址> &
# 子站后端库：建本地租户、6 台设备（名字与子站一致）、带 7 类告警的设备配置、告警钩子，并更新 eg.yaml（加 tb: 本地 TB 账号）
pnpm provision:eg -- --cabinet <柜号> --url http://127.0.0.1:18080 --hook http://host.docker.internal/hooks/alarm --sp <子站地址>
```

provision:eg 同时把本地 TB 系统管理员的出厂口令改掉（新口令只留在子站 `tb/provision/out/eg/<柜号>/tb-sysadmin.json`）。然后出这台的配置包并拷到 EG：

```bash
# 子站后端库：dist/eg/<柜号>/ 下出 eg.yaml（station 改成 mqtts://<子站>:8883、https://<子站>）与 sp-ca.pem
scripts/pack-eg.sh --sp <子站地址> --only <柜号>
scp dist/eg/<柜号>/eg.yaml dist/eg/<柜号>/sp-ca.pem <账号>@<EG 的 LAN2 地址>:/opt/lsa-eg/config/
```

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

## 6. 升级与回滚

- **升级**：新发布件直接解压覆盖到 `/opt/lsa-eg`（`config/`、`recordings/`、`.env` 不在发布件里、不会被覆盖），`sudo bash install.sh`。install.sh 把上一次装好的部署文件（`.installed/`）挪成 `.previous/`、`.env` 的 `EG_APP_IMAGE` 改成新版本；更早的 `lsa-eg-app` 镜像清掉，只留现在的与可回退的。
- **回滚**：`sudo bash install.sh --rollback` —— 部署文件换回 `.previous/`、镜像改回旧版本、`docker compose up -d`；再跑一次 `--rollback` 又回到新版。本地 TB 版本（`compose.yaml` 里 tb-node 的标签）变过的不许回退（库结构只升不降）。
- `sudo bash install.sh --status`：容器状态、已装版本、可回退到哪个版本。
- 升级期间 agent 停几秒：同事的数据由 Mosquitto 持久会话排着，上送 outbox 在磁盘上，都不丢（I2 实测重启无断档）。

## 6b. 测试件（只在虚拟样机 / 实验台上用，**现场不装**）

`pnpm pack:eg -- --test` 另出 `dist/eg-<版本>-test/`：仿真器 `lsa-eg-emu`（代替同事的采集程序往本机总线发数据、扮摄像机测温接口）与 RTSP 测试源（扮摄像机四路视频，127.0.0.1:8555）。不进 `IMAGES.txt`、与正式编排不共用容器。

```bash
# 正式编排第二轮装完之后
sudo cp -r eg-<版本>-test /opt/lsa-eg/test
sudo bash /opt/lsa-eg/test/test.sh up      # 导入测试镜像、local.yaml 摄像机改 sim + 本机测试源、起 emu 与 camera、重启 eg-video
sudo bash /opt/lsa-eg/test/test.sh down
```

造告警（emu 控制面只听本机 3190）：`curl -X POST "http://127.0.0.1:3190/emu/arc?intensity=450&ms=25"`（弧光）、`…/emu/cam/overtemp?region=R1&max=120&s=300`（区域过温）、`…/emu/dev/<设备>/dead?on=1`（整台停发）。

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
| I5-4 | 本机总线不鉴权（只绑 127.0.0.1 与容器网络） | 按此 |
| I5-5 | 镜像与整套安装未在 Linux 上跑过 | G6 虚拟样机验收（进行中） |
