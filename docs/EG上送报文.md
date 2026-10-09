# EG → 子站报文（样例 + 字段表）

版本 v1.0（2026-10-08，阶段 A13）。适用 EG 0.3.0 起；老 EG 少的字段已逐项注明。

用途：子站后端据此生成 JSON Schema，并用文中样例做校验。

**权威来源**
- 事件、证据、回执这几种 HTTP 报文，以子站 DTO 为准；本文给的是 EG 实际发出的形状和真实样例。
- 遥测与属性走 TB 网关 MQTT 接口，没有 DTO，以本文为准。
- 背景约定见：后端库 `docs/EG独立TB调整方案.md` §8.1–8.3、`docs/G5证据约定.md`、本库 `docs/EG内部MQTT格式.md`（同事 → EG 的总线格式）。

**样例来源**：全部取自 2026-10-08 虚拟样机。遥测是 AH12 总线上的真实读数；事件和证据取自 AH11 的 events.db / evidence.db；回执是 `verify:a11` 的结果。

## 0. 通道总览

| # | 报文 | 方向与地址 | 鉴权 | 送达语义 |
|---|---|---|---|---|
| 1 | 遥测 / 属性 | EG → 子站 TB，MQTT（现场 mqtts 8883）。主题：子设备用 `v1/gateway/*`，EG 自身用 `v1/devices/me/*` | MQTT 用户名 = 子站上 EG-<柜号> 网关设备的令牌 | QoS 1，PUBACK 后才从 outbox 删（至少一次）。子站 TB 按「设备 + key + 源时间戳」覆盖写，重发无害 |
| 2 | 告警事件 | EG → 子站 `POST /ext/eg/<柜号>/events` | 头 `X-EG-Token` | 回执逐条 accepted / duplicate 才删；按 eventId + revision 去重 |
| 3 | 证据索引 | EG → 子站 `POST /ext/eg/<柜号>/evidence` | 头 `X-EG-Token` | 同事件，按 evidenceId + revision |
| 4 | 证据文件 | EG → 子站 `PUT /ext/eg/<柜号>/evidence/<evidenceId>/file` | `X-EG-Token`，另带头 `X-Sha256` | 子站回 stored 且 sha256 一致才算 UPLOADED；失败整份重传（不分段续传，已定：用户 2026-10-08 拍板） |
| 5 | 配置回执 | 子站 `PUT <EG>/api/config` 的响应体 | 子站带 `X-EG-Ticket`（服务票据） | 200：APPLIED / FAILED / PENDING；票据不对：401 |
| 6 | 证据锁定回执 | 子站 `PUT <EG>/api/evidence/lock` 的响应体 | 同上 | 见 G5 证据约定 §8.7，本文不重复 |

时间一律是 **Unix 毫秒整数**（UTC 时刻；页面显示按北京时间）。设备名 = 子站 TB 设备名，也就是 A12 的 deviceId，如 `SAM-AH12-A`。

## 1. 遥测与属性（MQTT，TB 网关接口）

### 1.1 主题与载荷形状

| 主题 | 谁的 | 载荷 |
|---|---|---|
| `v1/gateway/connect` | 子设备上线声明（每次连上、每台一次） | `{"device":"SAM-AH12-A"}` |
| `v1/gateway/telemetry` | 子设备遥测 | `{ "<设备名>": [ { "ts": <毫秒>, "values": { "<key>": <值>, … } }, … ], … }` |
| `v1/gateway/attributes` | 子设备客户端属性 | `{ "<设备名>": { "<key>": <值>, … }, … }` |
| `v1/devices/me/telemetry` | EG 自身遥测 | `[ { "ts": <毫秒>, "values": { … } }, … ]` |
| `v1/devices/me/attributes` | EG 自身客户端属性 | `{ "<key>": <值>, … }` |

**切批**：一次发布 ≤ 500 个样本且 ≤ 48 KB（子站 TB 单条 MQTT 上限 64 KB）。

**补传**：断网期间积压的数据按源时间从旧到新、限速补发；连上以后新来的实时数据优先发。补传的报文与实时报文格式相同，只靠 ts 区分。

**能力过滤（阶段 A）**：一台设备匹配到的能力全都不是 confirmed 时，这台设备不 connect、也不上送。设备里个别 pending 的 key 照常送，由子站按能力挡掉。

样例（AH12，节选）：

```json
// v1/gateway/telemetry
{
  "SAM-AH12-A": [ { "ts": 1791455400000, "values": { "us.amp": 7.2, "us.cnt": 1, "uv.int": 2, "env.t": 27.5, "env.rh": 45 } } ],
  "PM-AH12":    [ { "ts": 1791455400000, "values": { "el.Ua": 5766, "el.Ia": 269, "el.P": 4481, "el.PF": 0.942, "el.F": 50, "el.Ep": 12821331, "el.THDu": 1.9, "el.load_pct": 44.4 } } ],
  "CAM-AH12":   [ { "ts": 1791455400000, "values": { "ir.max": 48.3, "ir.R2.max": 47.7, "ir.R2.rise": 20.3, "ir.dmax": 0.8, "ir.hot": 2 } } ]
}
// v1/devices/me/telemetry
[ { "ts": 1791455400000, "values": { "eg.state": "online", "eg.cpu": 12.2, "eg.mem": 51, "eg.uplink": "ok", "eg.buf_depth": 0, "eg.time_sync": "synced", "eg.lost": "[]" } } ]
// v1/gateway/attributes
{ "SAM-AH12-A": { "cab": "AH12", "room": "断路器室", "port": "LAN1", "proto": "HTTP · 192.168.10.120", "fw": "v2.1.0", "deviceId": "SAM-AH12-A" } }
// v1/devices/me/attributes（每次连上子站）
{ "hostBootId": "6f0c…", "agentBootId": "b21d…" }
```

### 1.2 子设备遥测 key

设备前缀取设备名中第一个「-」之前的部分。值是数，标了「串」的是字符串。

| 前缀 | key | 类型 / 单位 | 来源 | 说明 |
|---|---|---|---|---|
| SAM | `env.t`、`env.rh` | 数，℃、%RH | 同事程序 | 柜内温湿度（能力 envTH） |
| SAM | `us.amp` | 数，dBμV | 同事程序 | 局放幅值，**已换算**；寄存器 258 → 25.8。EG 不换算（能力 pdAmplitude） |
| SAM | `us.cnt`、`us.type`、`us.level` | 数 | 同事程序 | 局放次数 / 类型码 / 等级（production 下为 pending） |
| SAM | `uv.int` | 数 a.u. | 同事程序 | 弧光强度（arcIntensity，pending） |
| SAM | `uv.pulse` | **串**（JSON 对象 `{"peak":数,"ms":数}`：峰值、持续毫秒） | 同事程序 | 弧光脉冲，事件型：检测到放电立即发一条，同时带 uv.int = 峰值（arcEvents，pending）。《EG 内部 MQTT 格式》§3 |
| SAM | `tev.*`、`smoke.*`、`sw.*` | 数 | 同事程序 | 地电波（unsupported）、烟雾、开关位置（pending）；目前没有点 |
| PM / PM2 | `el.Ua` `el.Ub` `el.Uc` `el.Ia` `el.Ib` `el.Ic` `el.P` `el.Q` `el.S` `el.PF` `el.F` `el.Ep` | 数，V / A / kW / kvar / kVA / — / Hz / kWh | 同事程序 | 电表基础量（meterBasic） |
| PM / PM2 | `el.load_pct` | 数，% | **EG 派生**：max(Ia, Ib, Ic) ÷ attrs.rated × 100 | 负荷率 |
| PM / PM2 | `el.THDu` `el.THDi`、`el.hu.*` `el.hi.*`、`el.dmd*` | 数 | 同事程序 | THD、谐波、需量（pending） |
| PM6 | `pm.0.3` `pm.0.5` `pm.1.0` `pm.2.5` `pm.5.0` `pm.10` | 数 | 同事程序 | 六路颗粒物（production 下 unsupported，整台不送） |
| CAM | `ir.max` `ir.min` `ir.max_x` `ir.max_y` | 数，℃ / 像素 | eg-video | 全画面 |
| CAM | `ir.R<n>.max` `.min` `.max_x` `.max_y` | 数 | eg-video | 测温区 n |
| CAM | `ir.R<n>.rise` | 数 ℃ | **EG 派生**：ir.R<n>.max − 本柜 SAM 的 env.t（两者源时间差 ≤ 15 s 才出值，可为负；出不来时 q 标它） | 区域温升 |
| CAM | `ir.rmax` `ir.rise` `ir.dmax` `ir.hot` | 数 | **EG 派生** | 各区最高温的最大值、各区温升的最大值、各区最高温的极差、温升最高的区号 1–3；与 ir.R<n>.max 同一时间戳 |
| CAM | `cam.online` | 数 0–4 | eg-video | 四路里通的路数（每 60 s DESCRIBE 一次） |
| CAM | `cam.fps` `cam.bitrate` | 数 | eg-video | |
| CAM | `cam.vis` `cam.ir` | 串 OK / DEGRADED / FAIL | eg-video | 可见光、热像各自的主子码流：都通 / 通一路 / 都不通（阶段 A §13） |
| CAM | `cam.rest` | 串 OK / FAIL | eg-video | 测温接口；纯 RTSP 驱动不发 |
| CAM | `cam.alarm` | 串 | eg-video | 摄像机原生报警状态，原样 |
| 任意 | `q` | 串（JSON 对象：`{"<key>":"invalid"|"stale"|"warmup"|"calibrating"}`） | 同事程序报 + EG 看护合并 | 质量码，只列出有问题的 key；全好时为 `"{}"`。合并优先级 invalid > calibrating / warmup > stale |
| 任意 | `dev.comm` | 串 ONLINE / DEGRADED / OFFLINE / UNKNOWN | 同事程序报，没报时 EG 兜底 | §13 下挂设备通信状态 |
| 任意 | `dev.last_ok` `dev.last_try` | 数，毫秒 | 同上（last_try 只有同事程序报） | |
| 任意 | `dev.fails` | 数 | 同上 | EG 兜底时 = 错过的周期数 |
| 任意 | `dev.err` | 串 | 同上 | 如 `TIMEOUT`；恢复后清空为 `""` |
| 任意 | `dev.link` | 数 0 / 1 | EG | = `dev.comm != OFFLINE`；EG-devlost 规则看它 |

能力不启用的设备整台不上送（含它的 `q`、`dev.*`）。

### 1.3 EG 自身遥测（`v1/devices/me/telemetry`，每 5 s）

| key | 类型 | 说明 |
|---|---|---|
| `eg.state` | 串 online / degraded | degraded = 有能力启用的下挂设备 dev.comm = OFFLINE |
| `eg.cpu` `eg.mem` `eg.ssd` | 数 % | |
| `eg.temp` | 数 ℃ | 读得到才发 |
| `eg.lat` `eg.loss` | 数 ms、% | 到子站的延迟、丢包 |
| `eg.up_kbps` | 数 | 上行速率 |
| `eg.uptime_s` `eg.agent_up_s` | 数 s | 主机运行时长、agent 运行时长 |
| `eg.clk_offset` | 数 ms | 与对时源的差；测不出不发 |
| `eg.time_sync` | 串 synced / unsynced / unknown | synced = 5 min 内测成功且偏差 < 500 ms（阶段 A） |
| `eg.uplink` | 串 ok / backfill / down | backfill = 连着、正在补传 |
| `eg.buf_depth` | 数 | outbox 待送条数 |
| `eg.oldest_unsent` | 数 ms | 最旧未送的源时间；没有积压时不发 |
| `eg.backfill_pct` | 数 % | 补传进度 |
| `eg.outbox_full` | 布尔 | 接近容量上限，或刚丢过数据 |
| `eg.lost` | 串（JSON 数组 `[{"from":ms,"to":ms,"n":条数}, …]`） | 丢过的遥测区间，段数多了会折叠；只增不减。累计丢弃数 = 各段 n 之和，子站按它变大建「缓存溢出」告警 |
| `eg.evid_pending` | 数 | 待上传的证据数 |
| `eg.evid_full` | 布尔 | 数据盘超 fullWater |
| `eg.rec_ok` | 布尔 | 循环录像正常 |

### 1.4 客户端属性

| 设备 | key | 说明 |
|---|---|---|
| 子设备 | eg.yaml `devices[].attrs` 原样：`cab` `room` `port` `proto` `rated` `voltage` `channels` `sub` `regions` … | 由子站生成；A12 起加 `deviceId`（= 设备名）。同事程序报的同名项（`fw`、实际 `proto`）会覆盖 |
| CAM | `ir.regions`（串，JSON）、`ir.regionsVer` | 测温区配置，变了才发 |
| EG | eg.yaml `eg.attrs` 原样：`cab` `ip` `ipUp` `fw` `pt` `sn` … | A12 起加 `stationId`；`cfgWant` 不报（那是子站自己的量） |
| EG | `cfg` | 实际生效的配置版本 |
| EG | `agent`、`egAgentVersion` | eg-agent 版本，如 `0.3.0-<提交号>`（0.2.0 起带提交号） |
| EG | `tbVersion` | EG 本地 TB 版本，如 `4.2.2.5` |
| EG | `hostBootId`、`agentBootId` | 重启识别：每次连上子站发一次 |
| EG | `caps.actual` | 串（JSON 对象 `{"<能力>":"ok"|"nodata"|"absent"}`）。阶段 A，只在下发过能力后才有；变化时 / 连上时 / 每小时发 |

## 2. 告警事件 `POST /ext/eg/<柜号>/events`

请求体：

```json
{
  "bootId": "b21d9c0e…",
  "batchId": "4c1f0a9e2b7d3a11",
  "events": [
    {
      "eventId": "29b43ae2-5be0-41c1-a0b5-b42ddaa68cc2",
      "revision": 2,
      "device": "SAM-AH11-B",
      "type": "弧光异常",
      "severity": "CRITICAL",
      "state": "CLEARED",
      "occurredAt": 1791450355592,
      "clearedAt": 1791450355855,
      "details": { "rule": "UV 弧光脉冲", "key": "uv.int", "value": 450, "threshold": 200, "src": "EG", "cls": "dev", "unit": "", "ruleVersion": "c-0928-1" }
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `bootId` | 串 | agent 这次启动的 id（同 agentBootId） |
| `batchId` | 串（16 位十六进制） | 这一批的 id，仅用于排查 |
| `events[].eventId` | 串 UUID | = EG 本地 TB 告警 id，重启不变 |
| `events[].revision` | 整数 ≥ 1 | 状态、级别或恢复时刻变了才 + 1；测量值变化不算 |
| `events[].device` | 串 | 设备名（含 EG 自身 `EG-<柜号>`） |
| `events[].type` | 串 | 告警类型：过温、绝对超温、区域温差、局放异常、弧光异常、柜内湿度高、过载、烟气、设备失联。老 EG 可能还发旧名「环境」。另有 EG 自身设备的「证据未上传即被清理」（0.3.2 起，MAJOR，details 带 n / oldest / ids / disk / text；盘降到 highWater 以下自动恢复） |
| `events[].severity` | 串 CRITICAL / MAJOR / MINOR / WARNING / INDETERMINATE | TB 级别 |
| `events[].state` | 串 ACTIVE / CLEARED | |
| `events[].occurredAt` | 整数毫秒 | 发生时刻；恢复那一版也带着 |
| `events[].clearedAt` | 整数毫秒或 null | ACTIVE 时为 null |
| `events[].details` | 对象 | 本地规则的明细：`rule`、`key`、`value`、`threshold`、`unit`、`src` = "EG"、`cls`（dev / com，「设备失联」为 com）、`ruleVersion`（= 生效配置版本），另有 TB 原样带的字段。本地删除导致的恢复带 `reason` |

一批最多 50 条；同一 eventId 在一批里只送最新一版。断网期间发生又恢复的，补传时只送一条 CLEARED。

回执（子站）：

```json
{ "results": [ { "eventId": "29b43ae2-…", "revision": 2, "status": "accepted" } ] }
```

`status` 取 accepted / duplicate / rejected；rejected 时带 `reason`、`retryable`。EG 的处理：accepted / duplicate 删掉；rejected 且不可重试的记审计后丢；其余退避重试。HTTP 非 2xx 一律退避重试，事件不丢。

## 3. 证据

### 3.1 索引 `POST /ext/eg/<柜号>/evidence`

```json
{
  "bootId": "b21d9c0e…",
  "batchId": "9a0e…",
  "items": [
    {
      "evidenceId": "EV-AH11-20261008170525-video-visible-d3dd",
      "revision": 4,
      "eventId": "29b43ae2-5be0-41c1-a0b5-b42ddaa68cc2",
      "requestId": null,
      "groupId": "8d22fbac84fa",
      "cabinetId": "AH11",
      "gatewayId": "EG-AH11",
      "channelId": "visible",
      "kind": "video",
      "requestedStart": 1791450325592,
      "requestedEnd": 1791450415592,
      "actualStart": 1791450325593,
      "actualEnd": 1791450415592,
      "status": "UPLOADED",
      "location": "both",
      "sizeBytes": 21402662,
      "codec": "h264",
      "sha256": "2252cac836e55c09f08358c9cec0f303b8114afa8f71dd64b1b99352298ed3d5",
      "important": true,
      "pairOffsetMs": 0,
      "createdAt": 1791450355770,
      "expiresAt": 1792055223708,
      "missingReason": null
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `evidenceId` | 串 | `EV-<柜号>-<窗口起点，北京时间 yyyyMMddHHmmss>-<kind>-<channel>-<4 位十六进制>` |
| `revision` | 整数 | 状态变一次 + 1；子站取大的 |
| `eventId` / `requestId` | 串或 null | 告警触发的带 eventId；子站锁定请求来的带 requestId；两者都可能有 |
| `groupId` | 串 | 同一次触发的一组（视频×2、抓图×2、录波） |
| `cabinetId` `gatewayId` | 串 | |
| `channelId` | 串 visible / ir / data | data = 录波 |
| `kind` | 串 video / image / wave | |
| `requestedStart` `requestedEnd` | 整数毫秒 | 请求窗口 |
| `actualStart` `actualEnd` | 整数毫秒或 null | 实际裁出的（按关键帧可外扩）；没做出来为 null |
| `status` | 串 RECORDING / READY / UPLOADED / EXPIRED / MISSING / DELETED | |
| `location` | 串 edge / station / both / none | 文件在哪 |
| `sizeBytes` `codec` `sha256` | 数 / 串 / 串，或 null | READY 后才有 |
| `important` | 布尔 | 重要 = 自动上传文件 |
| `pairOffsetMs` | 整数或 null | 双光实际起点差 |
| `createdAt` `expiresAt` | 整数毫秒 / 整数或 null | 本地副本到期时刻；要上传、还没确认归档的到期也不删（0.3.0 起） |
| `missingReason` | 串或 null | expired（早于循环覆盖）、disk_full、gap（断流缺口）等；没做出来、或部分缺失时给 |

时间字段一律是整数（子站按 bigint 入库）。回执形状同事件：`{"results":[{"evidenceId","revision","status","reason?","retryable?"}]}`。

### 3.2 文件 `PUT /ext/eg/<柜号>/evidence/<evidenceId>/file`

- 头：`Content-Type: video/mp4 | image/jpeg | application/json`（录波是 JSON），`X-EG-Token`，`X-Sha256: <64 位十六进制>`。
- 体：文件全文。不分段，失败后整份重发（已定，不做断点续传）。
- 子站回 `{"stored": true, "sha256": "<子站算的>"}`，与 X-Sha256 一致才算 UPLOADED；不一致子站回 400。

## 4. 配置回执（`PUT <EG>/api/config` 的响应，HTTP 200）

| 字段 | 类型 | 何时有 | 说明 |
|---|---|---|---|
| `version` | 串 | 总有 | 请求体的 version；版本号本身不合法时原样带回 |
| `status` | 串 APPLIED / FAILED / PENDING | 总有 | PENDING = 本地 TB 暂未就绪、已排队；EG 自己重试，生效后报 cfg 属性 |
| `changed` | 整数 | APPLIED | 实际改了几个设备配置；0 = 与现状一致或重复下发 |
| `ignored` | 串数组 | 有不认识的 EG-* 规则时 | 这台 EG 不认识、跳过的规则 id（子站比 EG 新） |
| `error` | 串 | FAILED / PENDING | 给人看的原因 |
| `errorCode` | 串 | FAILED / PENDING（A11，0.3.0 起） | 见下表 |
| `retryable` | 布尔 true | PENDING | |
| `requestId` | 串 | 请求体带了字符串 requestId（≤ 128 字）时（A11，0.3.0 起） | 原样带回；没带就没有这个字段 |

| errorCode | 含义 | 子站怎么办 |
|---|---|---|
| `BAD_REQUEST` | 格式或字段不对（含 rules、caps、capKeys、devComm、extras 的形状） | 修子站生成逻辑，重发无用 |
| `BAD_VERSION` | 版本号不合法（要求 1–64 位字母、数字、`.` `_` `-`） | 同上 |
| `BAD_THRESHOLD` | 阈值表为空、缺 key、负数，温升上上限 ≤ 上限，或生成设备配置时阈值缺项 | 改阈值 |
| `DEVICES_MISMATCH` | body.devices 与本机 eg.yaml 不同 | 重新生成 eg.yaml 部署到 EG |
| `LOCAL_NOT_READY` | 本地 TB 暂未就绪（只出现在 PENDING） | 等 EG 报 cfg，不用重发 |
| `LOCAL_NOT_CONFIGURED` | eg.yaml 没有本地 TB 账号，或本地 TB 没 provision | 现场处理，不可重试 |
| `INTERNAL` | 其余（读写本地 TB 非暂时性失败、已改回等） | 看 error |
| `UNKNOWN_RULE` | 保留，目前不用（不认识的规则照旧跳过、列进 ignored） | — |

样例：

```json
{ "version": "c-1008-3", "status": "APPLIED", "changed": 2, "requestId": "5d7c0f3e-…" }
{ "version": "a11-x", "status": "FAILED", "error": "温升上上限（1）要大于上限（50）", "errorCode": "BAD_THRESHOLD", "requestId": "0b9e…" }
{ "version": "c-1008-4", "status": "PENDING", "retryable": true, "error": "本地 TB 暂未就绪，已排队自动重试：…", "errorCode": "LOCAL_NOT_READY", "requestId": "e2a1…" }
{ "version": "c-1008-5", "status": "APPLIED", "changed": 1, "ignored": ["EG-new"], "requestId": "…" }
```

## 5. 票据不对（HTTP 401，配置下发与证据锁定都一样）

```json
{ "code": "TICKET_TIME", "message": "票据时间在未来（两边时钟差太大？）" }
{ "code": "TICKET_INVALID", "message": "票据已用过" }
```

| code | 何时 |
|---|---|
| `TICKET_TIME` | 票据已过期，或签发时间在未来；EG 容忍两边时钟差 60 s。子站应提示对时，不要定死成失败 |
| `TICKET_INVALID` | 没带票据、格式不对、签名不对、不是本柜的、角色不对、已用过 |

0.3.0 以前的 EG 一律回 `code: "bad_ticket"`，时间问题只能看 message 文字。

## 6. 兼容

- **老子站**：不带 requestId 时，回执里没有 requestId 字段；多出来的 errorCode 字段老子站忽略。
- **老 EG**（0.2.x 及以前）：没有 requestId / errorCode；401 的 code 是 `bad_ticket`。1676946 及以前的 EG 还没有 caps.actual、dev.comm、cam.vis 等阶段 A 的 key，告警类型可能是旧名「环境」。
- **Schema 建议**：遥测 values 只校验已知 key 的类型（新 key 会随能力扩充出现），对象一律允许附加字段。
