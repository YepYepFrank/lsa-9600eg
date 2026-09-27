# LSA-9600EG 部署手册

> 适用：I 阶段起（EG 跑独立 ThingsBoard CE，后端库 `docs/EG独立TB调整方案.md`）。子站侧的安装见后端库 `docs/子站部署手册.md`。
> 状态（2026-09-27）：发布件、编排、安装脚本已写；agent 镜像已构建并在隔离容器里冒烟通过（评审记录 I5）。**整套安装尚未在 Linux 实机 / 虚拟样机上跑过**（G6 的 Ubuntu 虚拟样机验收时补），本手册随之修订。
> 两样东西配套装：**本库的通用发布件**（`pnpm pack:eg`，各台一样、不含凭据）+ **子站出的每台配置包**（后端库 `scripts/pack-eg.sh`：这台的 `eg.yaml` 与站内 CA 证书 `sp-ca.pem`）。

## 1. 组成与端口

一台 EG（新创云 XCY-X26A，x86_64）上跑 5 个容器，全部由 `compose.yaml` 编排：

| 容器 | 作用 | 端口 | 谁访问 |
|---|---|---|---|
| lsa-eg-agent | eg-agent：派生量与质量码、上送子站、告警事件、配置下发、本地管理页 | **80/TCP**（宿主机网络） | 维护笔记本（LAN2 直连）、子站 Nginx 反代 `/eg/<柜号>/`、子站扩展服务下发配置 |
| lsa-eg-tb | EG 本地 ThingsBoard CE 4.2.2.5：存 7 天数据、算 7 类设备告警 | 18080/TCP 只绑 127.0.0.1 | agent；部署时子站经 SSH 隧道 |
| lsa-eg-postgres | 本地 TB 的库 | 不对外 | 本地 TB |
| lsa-eg-mosquitto | 本机总线 | 1884/TCP 只绑 127.0.0.1 | 同事的采集程序（本机）、agent、IoT Gateway |
| lsa-eg-gateway | TB IoT Gateway 3.8.5：总线 → 本地 TB | 不对外 | — |

G4 起另有 `lsa-eg-mediamtx`（视频按需拉），到时补进本表。

**网口**：LAN1 接双目摄像机（设备网），LAN2 接子站交换机（上行网）。

**防火墙（EG 上，ufw 或 nftables）**：

| 方向 | 端口 | 说明 |
|---|---|---|
| 入站 LAN2 | 80/TCP | 本地管理页、子站反代、子站下发配置 |
| 入站 LAN2 | 22/TCP | 维护（部署时子站开 SSH 隧道跑 provision:eg）；可只放子站主机的地址 |
| 出站 → 子站 | **8883/TCP**（MQTT over TLS） | 遥测上送（`station.mqtt`） |
| 出站 → 子站 | **443/TCP**（HTTPS） | 告警事件与回执（`station.http`） |
| 出站 → 子站 | 123/UDP | 对时（chrony 与 agent 的 SNTP 测量） |
| 入站 LAN1 | 全关 | 摄像机网只出不进（agent 听的是 0.0.0.0:80，要靠防火墙挡住 LAN1，见 §8 I5-2） |

容器之间走 docker 网络 `lsa-eg`；本地 TB 的告警钩子经 `host.docker.internal`（宿主机网关地址）推给宿主机网络上的 agent 的 80 口 —— 防火墙要允许 docker 网段访问本机 80。

## 2. 主机准备

- 系统：Ubuntu Server 24.04 LTS 最小安装（开发计划 §1；G6 定稿）。
- Docker Engine + compose 插件。现场无外网时用离线 deb 包（G6 的离线包提供；与子站 `pack-offline.sh` 同一做法）。
- 对时：chrony 指向子站主机（子站再对站内时钟源）。agent 另用 SNTP 测偏差上报 `eg.clk_offset`。
- 网卡：LAN1 静态地址（与摄像机同段），LAN2 静态地址（站内网），缺省路由走 LAN2。
- 数据盘：本地 TB 留 7 天、上送 outbox 最多 2 GB、**循环录像**（两路子码流常录，按 1 Mbit/s 估每天约 10.8 GB，留 24 h）、锁定的证据片段（30 天，按每次告警约 12 MB 估），按 128 GB 工业级 mSATA 准备（开发计划 §1）。
- **摄像机侧没人看时也一直有流量**：EG 从摄像机常拉两路子码流做循环录像（约 1 Mbit/s，LAN1 上），主码流才按需；**SSD 每天约 11 GB 写入**（一年约 4 TB，按盘的 TBW 核寿命；G6 容量 / 寿命检查项）。

## 3. 子站侧要先准备的

1. 子站跑过 `provision`：子站上有 `EG-<柜号>` 网关设备与令牌，`tb/provision/out/eg/<柜号>/eg.yaml` 已生成。
2. **TLS**：子站对 EG 开 MQTT 8883（TB 的 MQTT over TLS）与 HTTPS 443（Nginx），证书由后端库 `scripts/gen-certs.sh --san <EG 连子站用的地址>` 签：
   - 证书的 SAN 要含 **EG 用来连子站的那个地址**（通常是子站 LAN 的 IP），否则 EG 报 `Hostname/IP does not match`；
   - 站内 CA 证书 `sp-ca.pem` 随 `eg.yaml` 一起拷到 EG 的 `config/`。agent 容器用 `NODE_EXTRA_CA_CERTS=/config/sp-ca.pem` 信任它，上送（mqtts）与事件（https）都生效；
   - 用正规 CA 签的证书就不用 `sp-ca.pem`（没有这个文件时 agent 启动会打一行「忽略额外证书」的提示，无害）。
3. 子站 TLS 的配置细节见后端库 `docs/子站部署手册.md`。

## 4. 安装

发布件在开发机上生成：`pnpm pack:eg -- --images`，得到 `dist/eg-<版本>/`（compose、安装脚本、Mosquitto 配置、自定义连接器、`images-amd64.tar.gz`）。所有 EG 通用，不含任何凭据。

```bash
# 在 EG 上
sudo mkdir -p /opt/lsa-eg && sudo cp -r eg-<版本>/* /opt/lsa-eg/ && cd /opt/lsa-eg
sudo bash install.sh        # 第一轮：导入镜像、生成 .env（本地库口令）、建本地 TB 的库、起本地 TB
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
sudo bash install.sh        # 第二轮：生成 IoT Gateway 配置、起全部
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

- **升级**：新发布件解压到新目录，把旧目录的 `.env` 与 `config/` 拷过去（或直接解压覆盖到 `/opt/lsa-eg`，`config/` 与 `.env` 不在发布件里、不会被覆盖），`sudo bash install.sh`。install.sh 会把 `.env` 里的 `EG_AGENT_IMAGE` 改成新版本。
- **回滚**：旧镜像还在本机 —— `.env` 里 `EG_AGENT_IMAGE` 改回旧版本号，`docker compose up -d agent`。本地 TB、PostgreSQL 的版本与数据卷不随 agent 变。
- 升级期间 agent 停几秒：同事的数据由 Mosquitto 持久会话排着，上送 outbox 在磁盘上，都不丢（I2 实测重启无断档）。

## 7. 排障速查

| 现象 | 看哪里 |
|---|---|
| 管理页打不开 | `docker compose ps`；`docker logs lsa-eg-agent`（eg.yaml 缺失 / 格式版本不对会直接退出） |
| 诊断「数据上送」连不上子站 | `station.mqtt` 地址、8883 是否放通、证书（日志里 `self-signed certificate` / `Hostname/IP does not match` → `sp-ca.pem` 或证书 SAN） |
| 告警事件「重试中」 | 同上查 443；子站回 401 → `station.token` 与子站设备令牌不一致（重新生成 eg.yaml） |
| 本地告警不出 | 本地 TB 设备配置是否有规则（子站下发过配置吗）；`docker logs lsa-eg-gateway` 看总线与本地 TB 的连接 |
| EG 自身指标本地 TB 上不更新 | `docker logs lsa-eg-gateway \| grep "LSA EG 自身"`，重载后应有「订阅本机总线」（I4 修过一次死锁） |

## 8. 待定（记在评审记录 I5）

| # | 问题 | 现在的做法 |
|---|---|---|
| I5-1 | 本地 TB 的实体由子站经 SSH 隧道跑 provision:eg 建 —— 现场要给子站开 EG 的 SSH | 按此；以后可改为 agent 按 eg.yaml 自建（I4 已有生成告警规则的代码） |
| I5-2 | agent 用宿主机网络听 0.0.0.0:80，LAN1（摄像机网）也能访问管理页 | 靠防火墙挡；G6 加 `local.yaml http.bind` 只听 LAN2 地址 |
| I5-3 | ~~本地 TB 的系统管理员沿用出厂口令~~ | 已解决：provision:eg 建完租户后改掉（后端 01a28c5） |
| I5-4 | 本机总线不鉴权（只绑 127.0.0.1 与容器网络） | 按此 |
| I5-5 | 镜像与整套安装未在 Linux 上跑过 | G6 虚拟样机验收 |
