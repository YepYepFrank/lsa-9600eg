# LSA-9600EG 边缘网关端

LSA-9600SP 态势感知系统的边缘网关（每面柜一台，硬件拟用新创云 XCY-X26A）上我方的软件。EG 本地跑独立 ThingsBoard CE（后端库 `docs/EG独立TB调整方案.md`）。
计划：`docs/LSA-9600EG_开发计划.md`；进度与待确认：`docs/评审记录.md`；部署：`docs/EG部署手册.md`；给同事的对接文档：`docs/EG内部MQTT格式.md`；本地页接口：`docs/EG本地接口.md`。

## 单柜监测界面

本地管理页的界面基线是领导 80e01ad（yangjun1966/lsa-9600eg「完善边缘网关单柜界面」）：本柜总览、电气量、事件与录像、设备与通信（原有的各管理页都在这里面）。**已接真实接口**：双光实况（agent 带会话鉴权反代本机 mediamtx 的 WebRTC / HLS）、测温区按摄像机坐标画框、温湿度 / 露点 / 局放 / 颗粒物 / 弧光、电表、本地事件与证据回放、近 24 h 趋势（本地 TB）。说明：[单柜主界面设计与预览](docs/单柜主界面设计与预览.md)。

演示预览（不接后端，只在 Vite 开发服务器上）：

```powershell
npx --yes pnpm@9.15.9 --filter @lsa-eg/admin-web install --frozen-lockfile
npx --yes pnpm@9.15.9 web
```

浏览器打开 `http://127.0.0.1:8798/?demo=1#/overview`；生产构建不会因 `demo=1` 绕过登录。前端构建检查：`pnpm -F @lsa-eg/admin-web build`；接口自检：`pnpm ui:verify`；截图：`pnpm g3:shots`。

```
同事的转换程序 ─MQTT─► Mosquitto ─► TB IoT Gateway ─► EG 本地 TB CE（存 7 天、算 7 类告警）
                          │                                  │ 告警钩子
                          └──► eg-agent ◀─────────────────────┘
                                 ├ 遥测 outbox ─MQTT（现场 TLS 8883）─► 子站 TB
                                 ├ 告警事件 / 配置回执 ─HTTP(S)─► 子站扩展服务
                                 └ 派生量、质量码、本地管理页、（G5）抓拍录波
双目摄像机 ─► eg-video + mediamtx（按需，不经 TB）─► 子站 mediamtx（G4）
```

| 目录 | 内容 |
|---|---|
| `apps/agent` | eg-agent（NestJS）：派生量、上送、告警事件、配置应用、本地 API |
| `apps/video` | eg-video（NestJS） |
| `apps/admin-web` | 本地管理页（Vue3 + Element Plus），agent 直出 |
| `packages/config` | `eg.yaml`（子站生成）/ `local.yaml`（本地）读取 |
| `packages/emu` | 同事转换程序的仿真器（开发用） |
| `apps/agent/src/verify` | 自检共用（TB 只读查询、仿真器控制、docker） |
| `deploy/dev` | 开发样机（本地 TB CE + PostgreSQL + Mosquitto + IoT Gateway） |
| `deploy/eg` | EG 上的正式编排、agent 镜像、安装脚本 |
| `deploy/tb-gateway` | IoT Gateway 自定义连接器 `LsaSelfConnector` |

## 开发机上跑起来

前提：子站后端仓库在 `../lsa-9600sp-backend`，其开发环境（子站 TB、扩展服务、模拟器）在跑；模拟器按新协议扮演其余各柜的 EG，AH03 让给本仓库的样机。

```bash
# 本仓库：起样机（首次自动给本地 TB 建库，约 1.5 分钟）
pnpm install
pnpm dev:config          # 拷 eg.yaml、写开发用 local.yaml
pnpm dev:up              # 起本地 TB + PostgreSQL + Mosquitto + IoT Gateway 容器

# 子站后端仓库：对本地 TB 建实体（租户、设备、7 类告警规则、告警钩子），并把本地 TB 账号写回 eg.yaml
pnpm provision:eg -- --cabinet AH03 --url http://127.0.0.1:18080 --hook http://host.docker.internal:9100/hooks/alarm

# 本仓库
pnpm dev:config          # 再拷一次（带上本地 TB 账号）
pnpm dev:emu             # 仿真器（扮同事的程序）
pnpm dev:agent           # eg-agent，管理页 http://localhost:9100/（先 pnpm -F @lsa-eg/admin-web build）
```

agent 的开发开关：`EG_UPLINK=off` 不上送子站；`EG_EVENTS=on|off` 告警事件送不送（缺省跟上送）；`EG_STATION_HTTP` 覆盖事件目标（开发时 `http://127.0.0.1:3001`，假子站 3199）；`EG_EVENTS_DB` 另用一个事件库（假子站自检必须）。
**对共享的子站打开上送要用户本人同意**：打开上送的 agent 由用户在自己的终端起，自检只经 HTTP 驱动它。

```bash
pnpm i1:verify           # I1：本地 TB 的实体、数据、本地告警、连接器稳定与重载回归、内存
pnpm i2:verify           # I2：丢失记账（离线）、上送子站、断网 10 分钟补齐、重启不丢（-- --fast 断 2 分钟）
pnpm i3:verify           # I3：本地告警 → 告警事件（缺省起假子站 3199，agent 要带独立事件库；-- --real 查真子站）
pnpm i4:verify           # I4：子站下发配置 → 本地 TB 规则 / 阈值 → 回执与 cfg 属性（最后恢复原样）
pnpm g2:verify           # G2：访问控制、子站单点登录与反代、组件、诊断、审计（子站扩展服务要能反代到 9100）
pnpm g3:shots            # G3 验收截图：本地管理页 17 张 → docs/验收截图/G3/（先 pnpm -F @lsa-eg/admin-web build）
pnpm pack:eg             # EG 发布件（-- --images 连同镜像）；装法见 docs/EG部署手册.md
```

`g0:verify` `g1:verify` 是 TB Edge 时期写的（查本柜 Edge 容器、`--edge` 重启 Edge），待按独立 TB 改写后再用；其中派生量、质量码、南向统计的检查仍有效。

仿真器控制面（开发 / 自检用）：`POST http://127.0.0.1:3190/emu/dev/<设备>/dead?on=1|0` 整台停发，`.../drop?keys=env.t,env.rh` 单个量停发，`/emu/arc` 打弧光。

本地管理页要登录：本地维护账号 `maint`，首次启动的口令在 `run/initial-password.txt`（或启动前设 `EG_ADMIN_PASSWORD`）。从子站网关页点「EG 管理页」进来不用登录。

EG 库在开发期经 `link:` 引用后端库的 `packages/points` `packages/model`，两个仓库要放在同一目录下；打镜像时 `pack:eg` 把它们拷进构建上下文。
