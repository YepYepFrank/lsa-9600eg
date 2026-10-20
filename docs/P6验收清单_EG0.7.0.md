# P6 验收清单（EG 0.7.0 + 子站 0.18.0，舱室 EG 方案 v0.5 §6）

> 2026-10-18（EG 会话）。这份只管**验收**：拿 P6 的正式发布件（子站 0.18.0 r1 + EG 0.7.0 的两个一键安装文件）逐项跑、逐项记。
> 出包步骤（版本号、`pack:eg`、`bundle-all.mjs`、安全扫描、离线自检）不在这里，照各自的发布说明做。
> 0.18 测试离线包不打（用户 10-18 定）：0.6.x 回归、真子站拆柜、回滚都在这份里用正式发布件一起跑。
>
> - **环境**：子站沙箱 + 裸 EG 沙箱（同 0.17.4 的 itsp / iteg，`deploy/test/it-lib.sh`），全程不联网；openssh / sudo 的 deb 用之前批准下载的那份。VM 不在这份里，要上 VM 另问用户。
> - **「谁」**：EG = EG 会话跑并记；后端 = 后端会话（子站 dind）；两边 = EG 会话在沙箱里跑、后端核对子站侧。
> - **起点发布件**：0.17.4 r1（EG 0.6.3）、0.17.2 r1（EG 0.6.2），都在 `bundle/release-<版本>/`，用前核 `.sha256`。
> - 下文 AH07 = 沙箱里照旧一柜一台（legacyEg）的柜，拆成 AH07-A（断路器室）/ AH07-B；AH08 = 另一面照旧一柜一台的柜，专门做第 7 节「刚拆柜回滚」；AH09 = 一直照旧一柜一台的对照柜。

## 1. 全新安装：柜号、单元号两种（EG）

| # | 项 | 过的标准 |
|---|---|---|
| 1.1 | `fresh-install.sh <0.18 r1 .run> AH07`（柜号：照旧一柜一台，provision `--cabinet`，eg.yaml schema 1） | 两轮都过；7 个容器一分钟不重启；`--status` rc 0；`/api/status` 单元号 AH07、无舱室名；IoT Gateway clientId `tb-gateway-AH07` |
| 1.2 | `fresh-install.sh <0.18 r1 .run> AH07-A`（单元号：舱室单元，provision `--unit`，schema 2；子站上这面柜不在 legacyEg） | 同上；单元号 AH07-A、有舱室名；clientId `tb-gateway-AH07-A`；mediamtx 路径（接了摄像机时）`AH07-A[-sub\|-ir\|-ir-sub]`；本地页标题「… · 断路器室」 |
| 1.3 | `fresh-install.sh <0.18 r1 kiosk .run> AH07` 与 `… AH07-A` | 同 1.1 / 1.2；EG 安装不认 `--kiosk` 的两种拒绝照旧 |

## 2. 升级：从 0.17.4 r1、0.17.2 r1（EG）

| # | 项 | 过的标准 |
|---|---|---|
| 2.1 | `upgrade-eg.sh <0.17.4 r1 .run> <0.18 r1 .run> AH07` | 升级 rc 0；TB 不变、不多备份；数据与 cfg 都在；7 个容器一分钟不重启；`--status` rc 0；eg.yaml 不动（仍 schema 1、单元号 = 柜号）；`--rollback` 回到 0.6.3 数据一致，再升级正常 |
| 2.2 | `upgrade-eg.sh <0.17.2 r1 .run> <0.18 r1 .run> AH07` | 同 2.1；另看 0.17.2 装出的 999 / 996 账号这次迁走（`lsa-sp` / `lsa-upg` 不再是 999），回滚再升级不回退 |
| 2.3 | 子站批量升级：`upgrade-egs.sh --only AH07`（EG 已用 join-key 接入、0.6.3） | 表头「单元」；成功；升级后 hello `entry=4`、`unit=AH07`、`cabinet=AH07` |

## 3. 0.6.x EG 接 0.18 子站（两边）

子站从 0.17.4 r1 升到 0.18 r1，AH07 / AH09 照旧一柜一台，EG 停在 0.6.3（0.17.4 r1 装的）不升。

| # | 项 | 过的标准 |
|---|---|---|
| 3.1 | 子站升级后 0.6.3 EG 不动 | 上送、告警事件、证据、配置下发都照常；caps / meters / offCabs 的键仍是柜号、与 0.17 一字不差；网关页在线、配置 APPLIED；平台时序无空洞 |
| 3.2 | 子站改一个阈值下发新版本配置 | 0.6.3 回执 APPLIED；没有 DEVICES_MISMATCH / BAD_REQUEST |
| 3.3 | 子站「打开 EG 管理页」单点登录 | 票据 `c` = 柜号，0.6.3 认，进得去 |
| 3.4 | 视频拉流 | 子站按 `<柜号>[-sub\|-ir\|-ir-sub]` 拉得到 |
| 3.5 | `join-egs.sh --unit AH09 --eg <0.6.3 的 EG>`（重跑） | 预检按 `cabinet=` 认作照旧一柜一台；各步跳过 / 照做，成功、不重启 |
| 3.6 | `join-egs.sh --unit AH09-A --eg <0.6.3 的 EG>` | 预检拒绝「接舱室单元要 EG 0.7.0 起」；什么都没改 |

## 4. 一键加柜：`--unit` / `--cabinet`（两边，子站 0.18）

| # | 项 | 过的标准 |
|---|---|---|
| 4.1 | `--unit <单元号> --eg <待接入的 0.7.0 EG>` | 6 步全过；provision `--unit`、pack `--only <单元号>`；子站网关页这个单元在线、配置生效；隧道授权已撤 |
| 4.2 | `--unit` 原样重跑 | 「已接入本单元：重跑」；建实体跳过、配置 same、不重启 |
| 4.3 | `--unit` 接到已接在别的单元的 EG | 拒绝、说清它现在是哪个单元；加 `--force` 才改接（入口 `apply-config … force`） |
| 4.4 | `--cabinet <照旧一柜一台的柜> --eg <EG>` | 等同 `--unit <柜号>`，照旧接上（schema 1） |
| 4.5 | `--cabinet <已拆的柜> --eg A=…,B=…` | 各单元依次接上；故意让一台没授权：另一台照样接上，汇总给出那一台的重来命令 |
| 4.6 | `--from-file <清单> --plan` | 逐台结论；不改任何东西（子站文件 sha 不变、EG 不动） |
| 4.7 | 接入时带转换程序参数 `--conv-serial … --sensors …` | 转换程序起来；子站上 `conv.bus` 记在这个单元下 |

## 5. 拆柜：`--split` 与断数窗口（两边）

AH07 照旧一柜一台、0.6.3 EG 在线，拆成 AH07-A / AH07-B：原来那台先升到 0.7.0、在 EG 上补跑一次 `install.sh --join-key '<本子站那一行>'` 后改作 A；另一台裸 EG 装 0.7.0、待接入作 B。原来那台拆前启用转换程序（`install-conv.sh --sim`，整柜：温湿度 → SAM-AH07-A、其余 → SAM-AH07-B），看拆后自动改挂（6.3a）。
**拆之前**：子站侧开探针每 1 s 记 AH07 的最新遥测时间戳；记下 AH07 旧 `eg.yaml` 的令牌（`tb/provision/out/eg/AH07/eg.yaml`）、子站 TB 上 `EG-AH07` 的设备 ID 和 SAM / 电表 / 颗粒物的设备 ID（颗粒物 PM6 0.18.1 起取消，0.18.0 的柜还有），供第 6 节对照。

| # | 项 | 过的标准 |
|---|---|---|
| 5.1 | `join-egs.sh --split AH07 --eg A=…,B=… --plan` | 两台都「能接」；什么都不改：`model.site.yaml` sha 不变、没跑 `up.sh` |
| 5.2 | B 换成 0.6.3 再 `--split` | 预检不过、整个不开始；`model.site.yaml` 不变、AH07 照常上送 |
| 5.3 | `--eg` 里只给 B（原来那台不在里面）再 `--plan` | 提醒「拆柜后它的令牌作废、上送被拒」 |
| 5.4 | `join-egs.sh --split AH07 --eg A=…,B=…` | 备份 `model.site.yaml` 到 `/var/log/lsa9600sp/eg-join/split-AH07-<时间>/`；`up.sh --prod` 成功；两个单元都接上；汇总报断数窗口 |
| 5.5 | **断数窗口** | 汇总报的窗口（`up.sh` 开始 → 最后一台**第一次**上送正常，EG 0.7.1 起的口径；0.7.0 的汇总算到「配置生效」，偏长）与子站探针、平台上 AH07 的时序三者对得上（差不超过 5 s）；秒数写进 0.18.0 发布说明 |
| 5.6 | 拆后运行状态 | 网关页每个单元在线；`check.sh`「舱室单元」「配置下发」正常；`conv.bus`、`eg.n / eg.on / eg.nv` 对；EG 本地页标题带舱室名 |
| 5.7 | 拆后再跑 `join-egs.sh --cabinet AH07 --eg A=…,B=…` | 两台都「已接入本单元：重跑」，各步跳过、不重启 |

## 6. 拆柜以后的核对：eg.yaml、令牌、归档旧 EG（两边）

5.4 跑完马上核，5.7 之后再核一遍（结果应完全一样）。

**EG 侧（A、B 各一遍）**

| # | 项 | 过的标准 |
|---|---|---|
| 6.1 | `/opt/lsa-eg/config/eg.yaml` | `schema: 2`；`unit.code` = AH07-A / AH07-B，`unit.at` 是舱室名，`unit.index` 与子站 `unitIndex` 一致；`eg.name` = `EG-AH07-A` / `EG-AH07-B`；`cabinet.code` 仍是 AH07；`devices` 只有本单元的设备（两台合起来 = 原来 AH07 的全部，不重不漏）；与子站 `tb/provision/out/eg/AH07-A/eg.yaml` sha256 一致 |
| 6.2 | 令牌 | A、B 的令牌各不相同，都不等于拆前记下的 AH07 旧令牌；原来那台（A）的 `config/.join-backup-*` 里留着旧 eg.yaml（schema 1）；eg.yaml 权限 / 属主同 0.17.4（不比原来宽） |
| 6.3 | 身份都换成单元号 | `/api/status` 单元号 AH07-A；hello `unit=AH07-A cabinet=AH07 entry=4`；clientId `tb-gateway-` / `eg-uplink-` / `eg-agent-` / `eg-video-` / `lsa-conv-` 后面都是 AH07-A；mediamtx 路径 `AH07-A…`；新出的证据 `EV-AH07-A-…`、其 `cabinetId` 仍为 AH07；事件走 `/ext/eg/AH07-A/events` |
| 6.3a | 原来那台的转换程序跟着换单元（摸底查出，进 0.7.0） | A 的换配置任务日志有 `conv-rebind：单元 AH07 → AH07-A`；各路传感器、gateway.yaml 都改挂 SAM-AH07-A，从站地址、开关、串口不变；转换程序重启过，日志 `client_id=lsa-conv-AH07-A`；`install.sh --status` 与 `install-conv.sh --status` 都不提示「还按旧单元跑」；子站 SAM-AH07-A 有局放 / 气体 / 弧光数据 |

**子站侧**

| # | 项 | 过的标准 |
|---|---|---|
| 6.4 | 旧令牌作废 | 用拆前记下的 AH07 旧令牌连子站 TB（MQTT）：被拒（未授权）；原来那台若不在 `--eg` 里，它的上送一律被拒、子站无新数据进 `EG-AH07` |
| 6.5 | 旧 EG 归档、不删 | 子站 TB 上 `EG-AH07` 还在、设备 ID 与拆前相同；服务端属性 `archived=true`、有 `archivedAt`、`archivedReason` 写明拆成了哪几个单元；柜 AH07 不再 Contains 它；它拆前的历史遥测、告警都还查得到 |
| 6.6 | 设备改挂 | SAM / 电表 / 颗粒物改挂到 `EG-AH07-A` / `EG-AH07-B` 下；设备 ID 与拆前相同；拆前的历史遥测都在；新数据进同一台设备 |
| 6.7 | 子站文件 | `tb/provision/out/eg/AH07/` 没了，挪成 `out/eg/.archived-AH07-<UTC 时刻>/`（`eg.yaml` 里是作废的旧令牌）；`out/eg/AH07-A/`、`AH07-B/` 在 |
| 6.8 | 不会再打旧令牌 | `pack-eg.sh`（不带 `--only`）不打 `.archived-*`；`pack-eg.sh --only AH07` 打的是 AH07-A、AH07-B 两份 |
| 6.9 | `model.site.yaml` | `legacyEg` 只少了 AH07（AH08 / AH09 还在）；`unitIndex` 里 AH07 原来的序号还在、没被别的柜占，AH07-A / AH07-B 有新序号；别的段不变；与备份逐行比只差这些 |
| 6.10 | 再跑一次 `up.sh --prod` | 幂等：不再多出一个 `.archived-*`，`EG-AH07` 的属性与令牌不再变，A / B 的令牌不变、不断连 |

## 7. 回滚

子站侧（7.1–7.3）的口径已定（协调 10-18，后端 #119）：`rollback.sh` 查四处 —— 库里单元 EG 的事件 / 下发记录、子站 TB 里的 `EG-<柜>-<字母>`、`unitIndex` 里的单元键、`tb/provision/out/eg/.archived-*` —— 任一处说明拆过柜，不带 `--backup` 的回滚一律拒绝；没拆过柜就自动把两张 EG 表的主键改回按柜再回滚。三路都由**后端执行**。

| # | 项 | 谁 | 过的标准 |
|---|---|---|---|
| 7.1 | 子站 0.18 → 0.17.4，没有柜拆过（在第 5 节之前做，或另起一个沙箱） | 后端执行 | 放行：`rollback.sh` 自动把两张 EG 表的主键改回按柜（`rollback-egkey-down.sql`）后回到 0.17.4；0.6.3 EG 与 schema 1 的 0.7.0 EG 照常上送；数据一致；再升到 0.18 正常 |
| 7.2 | 子站 0.18 → 0.17.4，拆过柜、已有记录（第 5 节之后） | 后端执行 | `rollback.sh` 拒绝，列出四处里命中的原因（单元 EG 的事件 / 下发记录、TB 里的单元 EG、`unitIndex` 的单元键、`.archived-*`）；什么都没改（目录、`.env`、容器、库不变）；说清要回只能 `--backup` 整库换回 |
| 7.3 | **子站刚拆柜、还没有记录时回滚，应被拒** | 后端执行 | 拿 AH08：从 `legacyEg` 去掉 AH08、`up.sh --prod`，**不接任何单元 EG**，马上 `rollback.sh`。先确认库里单元 EG 的事件 / 下发记录是 0 行；`rollback.sh` 仍拒绝（靠 TB 里的 `EG-AH08-*`、`unitIndex` 的单元键、`out/eg/.archived-AH08-*` 认出来）；什么都没改；带 `--backup <升级前备份>` 才放行 |
| 7.4 | **EG 刚拆柜、接成单元（schema 2）后回滚到 0.6.x，应被拒** | EG | A 在 5.4 之后马上 `install.sh --rollback`（上一版 0.6.3）：rc 1，提示「本机已接成舱室单元（EG-AH07-A，eg.yaml schema 2），要回到的 0.6.3-… 读不了 schema 2」，并说清怎么办（子站先把这面柜恢复成照旧一柜一台、再发照旧一柜一台的 eg.yaml）；什么都没改（容器、`VERSION`、`config/` 不变，上送不断） |
| 7.5 | EG 0.7.0 → 0.6.3，照旧一柜一台（schema 1） | EG | `install.sh --rollback` 照常，同 2.1 |
| 7.6 | EG 0.7.x 之间回滚 / 重装（schema 2） | EG | 放行 |

> 「刚拆柜、还没有记录时回滚应被拒」指子站侧，即 7.3（后端 #119）。EG 侧 7.4 是同一时刻的另一头：旧的照旧一柜一台配置和令牌已经作废，回 0.6.x 读不了 schema 2，EG 自己也拒（install.sh `rollback_schema_guard`，#55）。

## 8. 结果怎么记

- 每项 ✓ / ✗、用时、关键输出记进 EG 库 `docs/评审记录.md` 与 0.18.0 发布说明的「验收」一节；断数窗口写秒数；第 6 节贴 eg.yaml 的 `unit:` 段、`EG-AH07` 的三个归档属性、`.archived-*` 目录名。
- 有 ✗ 先停：修完从出错那一项所在的节重跑，不跳着记。
- 沙箱用完拆掉（`it_down`）；P3 自测用的测试镜像 `lsa-eg-app:0.7.0-p3test` 与 3.3 GB 测试 .run 在 P6 正式包出来后删掉，从没进 bundle 目录、没发给任何人。
