# EG 本地接口（eg-agent HTTP）

> 日期：2026-09-27，随 eg-ui-v2（本地管理页换成领导 80e01ad 的单柜界面）整理。与子站之间的接口（上送、告警事件、配置下发、证据）见后端库 `docs/EG独立TB调整方案.md` §8、本库 `docs/G5证据约定.md`；这里只列 EG 本地页用的。
> 地址一律相对路径（`api/...`）：直连是 `http://<EG 上行 IP>/api/...`，经子站是 `/eg/<柜号>/api/...`（子站 Nginx 反代）。

## 鉴权与访问范围

- 除标了「公开」的，都要会话：`Authorization: Bearer <令牌>`。令牌由 `POST api/auth/login`（本地维护账号 `maint`）或 `POST api/auth/sso`（子站票据换）取得，30 分钟不动失效。没有 / 过期 → **401**；只读账号做维护操作 → 403。
- **LAN1（摄像机网口）进来的一律 403**，连首页和登录都不给（`install.sh --lan1 <网口>` → `EG_HTTP_DENY_ON`，或 `local.yaml http.denyOn`；按网口现有地址判）。
- 实时画面的信令（WHEP）与 HLS 也走 agent，同一套会话鉴权；mediamtx 的 WebRTC / HLS 端口只听本机，浏览器不直连。WebRTC 媒体 UDP（`local.yaml video.webrtcUdp`，缺省 8189）对外，只认经 WHEP 协商出的 ICE 凭据：没有协商过的 STUN / 随机包一概不回（ui:verify 前实测）。

## 单柜界面用的（eg-ui-v2 新增 ★）

| 接口 | 用途 | 说明 |
|---|---|---|
| `GET api/status` | 外壳、设备清单 | 本机、柜、本机总线、各下挂设备（种类 `sam` / `meter` / `pm` / `camera`、质量码、是否整台失效） |
| `GET api/live/<设备>` | 各卡片的实时值 | 最新遥测（值、时间戳）、属性、质量码 `q`。页面上 `q` 标了 invalid 的量显示「—」 |
| ★ `GET api/history?device=&keys=a,b&hours=24&points=288&agg=AVG` | 趋势（近 24 h） | 从 EG 本地 TB 取（本地只留 7 天），`hours / points` 为一桶取 `agg`（AVG / MAX / MIN / SUM / COUNT）；`agg=NONE` 原样取（弧光脉冲 `uv.pulse`）。设备只认本机清单，key 只许字母数字点下划线、一次 ≤ 12 个；`hours ≤ 168`。回 `{ device, from, to, intervalMs, agg, series: { key: [[ts, v], …] } }` |
| `GET api/video/status` | 测温区定义与画面尺寸 | `measure.regions`：R1–R3 的类型与坐标（热像画面像素，`frame.w / h`）；页面按 contain 缩放后的实际画面区域画框，最热（`ir.hot`）标黄 |
| ★ `GET api/video/recording` | 循环录像覆盖与断档 | 两路子码流各自的最旧 / 最新一段、是否在录、`gaps`（相邻两段空出 > 1.5 s，最多 20 个）。证据页显示 |
| ★ `POST api/stream/<路径>/whep`；`PATCH` / `DELETE api/stream/<路径>/whep/<会话>` | 双光实况（WebRTC） | 反代到本机 mediamtx WebRTC（`video.webrtc`）。`<路径>` 只认本柜四路 `<柜号>`、`<柜号>-sub`、`<柜号>-ir`、`<柜号>-ir-sub`（别的 404）；方法不对 405。会话地址改写成相对路径，经子站反代也对 |
| ★ `GET api/stream/<路径>/index.m3u8`（及分片） | 双光实况（HLS 兜底） | WebRTC 连不通（UDP 被挡）时用；反代到本机 mediamtx HLS（`video.hls`），hls.js 每个请求带会话 |
| `GET api/alarms?limit=` | 事件与录像：本地事件 | EG 本地 TB 告警在事件库里的记录（发生 / 恢复、级别、明细、是否待送子站） |
| `GET api/alarms/timing?eventId=` | 事件时延 | 每一版：发生 → 钩子 → 排队 → 第一次 POST → 子站回执（毫秒） |
| `GET api/evidence?limit=` | 事件与录像：关联证据 | 证据清单（按 `eventId` 与事件关联；双光视频、抓图、录波） |
| `GET api/evidence/<id>/file` | 录像回放、下载 | 会话或子站服务票据；支持 Range；本地已清 410 |
| `GET api/catalog` | 单位、标签 | 点表目录（按设备种类）；页面上的单位一律取这里，点表里没有的通道显示「待确认」 |

「设备与通信」下的原有管理页用的接口（`components`、`diag`、`logs/<组件>`、`raw/<设备>`、`audit`、`config`、`config/local`、`auth/*`）不变。

## 开发用开关（现场不用）

| 环境变量 | 作用 |
|---|---|
| `EG_PASSIVE=1` | **旁观模式**：只收本机总线、不发任何数据（派生量、质量码、EG 自身指标、dev.link 都不发），不做证据；本机总线用一次性会话。只用于开发机上与正在跑的 agent 并排验新接口。**发布件的 compose 与 install.sh 里没有它**；生产模式（`NODE_ENV=production`）下看到会连打三条醒目的错误日志 |
| `EG_MTX_WEBRTC` / `EG_MTX_HLS` | agent 反代实时画面的上游（缺省取 `local.yaml video.webrtc` / `video.hls`）；开发样机的 mediamtx 在容器里，映射到 127.0.0.1:18889 / 18888 |

## 自检

`pnpm ui:verify`（`EG_AGENT_URL`、可选 `EG_LAN1_URL`）：历史接口的数据与参数校验；事件、证据、证据文件没会话 401；WHEP / HLS 没会话 401、别的路径 404、方法不对 405、路径穿越拿不到别的接口；给了 `EG_LAN1_URL` 时首页、登录、带合法会话的历史和流反代全部 403。
