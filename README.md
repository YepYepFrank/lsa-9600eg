# LSA-9600EG 边缘网关端

LSA-9600SP 态势感知系统的边缘网关（每面柜一台，硬件拟用新创云 XCY-X26A）上，除 TB Edge 以外我方的软件。
计划：`docs/LSA-9600EG_开发计划.md`；进度与待确认：`docs/评审记录.md`。

```
同事的转换程序 ─MQTT─► Mosquitto ─► TB IoT Gateway ─► TB Edge ─gRPC─► 子站
                          └──► eg-agent（派生量、本地管理页、抓拍录波）
双目摄像机 ─► eg-video + mediamtx（按需，不经 TB）─► 子站 mediamtx
```

| 目录 | 内容 |
|---|---|
| `apps/agent` | eg-agent（NestJS） |
| `apps/video` | eg-video（NestJS） |
| `apps/admin-web` | 本地管理页（Vue3 + Element Plus），agent 直出 |
| `packages/config` | `eg.yaml`（子站下发）/ `local.yaml`（本地）读取 |
| `packages/emu` | 同事转换程序的仿真器（开发用） |
| `apps/agent/src/verify` | 自检共用（子站 TB 只读查询、控制面、docker） |
| `deploy/` | 开发样机 compose、Mosquitto、IoT Gateway 自定义连接器 |

## 开发机上跑起来

前提：子站后端仓库在 `../lsa-9600sp-backend`，其开发环境（子站 TB、扩展服务、模拟器）在跑。
I 阶段起 EG 跑独立 ThingsBoard CE（后端库 `docs/EG独立TB调整方案.md`），样机的本地 TB 在本仓库 compose 里（127.0.0.1:18080）。

```bash
# 本仓库：起样机（首次自动给本地 TB 建库，约 1.5 分钟）
pnpm install
pnpm dev:config          # 拷 eg.yaml、写开发用 local.yaml
pnpm dev:up              # 起本地 TB + PostgreSQL + Mosquitto + IoT Gateway 容器

# 子站后端仓库：对本地 TB 建实体（租户、设备、7 类告警规则），并把本地 TB 账号写回 eg.yaml；模拟器让出这面柜
pnpm provision:eg -- --cabinet AH03 --url http://127.0.0.1:18080
pnpm sim -- --except AH03

# 本仓库
pnpm dev:config          # 再拷一次（带上本地 TB 账号）
pnpm dev:emu             # 仿真器（扮同事的程序）
pnpm dev:agent           # eg-agent，管理页 http://localhost:9100/（先 pnpm -F @lsa-eg/admin-web build）；只验本地 TB 时 EG_UPLINK=off 关上送
pnpm i1:verify           # I1 自检：本地 TB 的实体、数据、本地告警、连接器稳定、内存
pnpm i2:verify           # I2 自检：上送子站、断网 10 分钟补齐、重启不丢（-- --fast 断 2 分钟）
pnpm i3:verify           # I3 自检：本地告警 → 告警事件 → 子站（缺省起假子站 3199；-- --real 查真子站）
pnpm g0:verify           # G0 自检：链路
pnpm g1:verify           # G1 自检：派生量、质量码、EG 自身指标、南向统计、韧性（约 8 分钟；-- --fast 约 3 分钟）
pnpm g2:verify           # G2 自检：访问控制、子站单点登录与反代、组件、诊断、审计（约 4 分钟；子站扩展服务要带 EXT_EG_URLS=AH03=http://127.0.0.1:9100）
pnpm g3:shots            # G3 验收截图：本地管理页两条进入路径 17 张 → docs/验收截图/G3/（先 pnpm -F @lsa-eg/admin-web build）
```

仿真器控制面（开发 / 自检用）：`POST http://127.0.0.1:3190/emu/dev/<设备>/dead?on=1|0` 整台停发，`.../drop?keys=env.t,env.rh` 单个量停发，`/emu/arc` 打弧光。

给同事的对接文档：`docs/EG内部MQTT格式.md`。

本地管理页要登录：本地维护账号 `maint`，首次启动的口令在 `run/initial-password.txt`（或启动前设 `EG_ADMIN_PASSWORD`）。从子站网关页点「EG 管理页」进来不用登录。

EG 库在开发期经 `link:` 引用后端库的 `packages/points` `packages/model`，两个仓库要放在同一目录下。
