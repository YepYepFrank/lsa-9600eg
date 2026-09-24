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

前提：子站后端仓库在 `../lsa-9600sp-backend`，其开发环境（TB、各柜 Edge 容器）在跑。

```bash
# 子站后端仓库：生成这面柜的 eg.yaml，模拟器让出这面柜
pnpm eg:config -- --only AH03 --sp host.docker.internal
pnpm sim -- --except AH03

# 本仓库
pnpm install
pnpm dev:config          # 拷 eg.yaml、写开发用 local.yaml
pnpm dev:up              # 起 Mosquitto + IoT Gateway 容器
pnpm dev:emu             # 仿真器（扮同事的程序）
pnpm dev:agent           # eg-agent，管理页 http://localhost:9100/（先 pnpm -F @lsa-eg/admin-web build）
pnpm g0:verify           # G0 自检：链路
pnpm g1:verify           # G1 自检：派生量、质量码、EG 自身指标、南向统计、韧性（约 8 分钟；-- --fast 约 3 分钟）
```

仿真器控制面（开发 / 自检用）：`POST http://127.0.0.1:3190/emu/dev/<设备>/dead?on=1|0` 整台停发，`.../drop?keys=env.t,env.rh` 单个量停发，`/emu/arc` 打弧光。

给同事的对接文档：`docs/EG内部MQTT格式.md`。

EG 库在开发期经 `link:` 引用后端库的 `packages/points` `packages/model`，两个仓库要放在同一目录下。
