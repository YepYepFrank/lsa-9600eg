# P6 验收清单（EG 0.7.0 + 子站 0.18.0，舱室 EG 方案 v0.5 §6）

> 2026-10-18 起草（EG 会话）。0.18 测试离线包不打（用户 10-18 定），0.6.x 回归与真子站拆柜实跑都放 P6 用正式发布件一起跑。
> 环境：子站沙箱 + 裸 EG 沙箱（同 0.17.4 的 itsp / iteg，`deploy/test/it-lib.sh`），全程不联网；openssh / sudo 的 deb 用之前批准下载的那份。
> 「谁」一列：EG = EG 会话做并记结果；后端 = 后端会话（子站 dind）；两边 = EG 会话在沙箱里跑、后端核对子站侧。

## 0. 出包前（EG 会话）

| # | 项 | 怎么做 / 过的标准 |
|---|---|---|
| 0.1 | 版本号 0.7.0 | 同 #48 的 5 处（根 / admin-web / agent / video 的 package.json、attrs.service.ts 兜底）；PR 合后从 main 出 |
| 0.2 | 发布件 | `pack:eg -- --images --conv lsa-eg-conv:1.1.1-p6`（p6 断网已建，sha256:32c31757…）；deb 从上一版 `dist/eg-*/debs` 拷 |
| 0.3 | 一键安装文件 | `bundle-all.mjs --sp <子站 0.18.0 离线包> --eg <dist/eg-0.7.0-…> --tag r1`（普通 + kiosk）；两遍安全扫描无密钥；`.sha256` 核对 |
| 0.4 | 离线自检 | `pnpm -r typecheck`；`pnpm unit:verify`（24 项）；conv-guard / devcomm / conv-expect / conv-bus / mqtt-keep / pulse / warmup 回归；`bash deploy/test/join-egs-test.sh`（26 项） |

## 1. 全新安装（EG）

| # | 项 | 过的标准 |
|---|---|---|
| 1.1 | `fresh-install.sh <r1 .run> AH07`（照旧一柜一台，schema 1） | 两轮都过、7 个容器一分钟不重启、`--status` rc 0；`/api/status` 单元号 AH07；clientId `tb-gateway-AH07` |
| 1.2 | `fresh-install.sh <r1 .run> AH07-A`（舱室单元，schema 2；子站要有这个单元） | 同上；单元号 AH07-A、有舱室名；clientId `tb-gateway-AH07-A`；本地页标题「… · 断路器室」 |
| 1.3 | `fresh-install.sh <r1 kiosk .run> AH07` | 同 1.1；`--kiosk` 两种拒绝 |

## 2. 从 0.17.4 r1 升级（EG）

| # | 项 | 过的标准 |
|---|---|---|
| 2.1 | `upgrade-eg.sh <0.17.4 r1> <0.18 r1> AH07` | 升级 rc 0、TB 不变不多备份、数据与 cfg 都在、7 个容器一分钟不重启、`--status` rc 0；`--rollback` 回到 0.6.3 数据一致；再升级正常 |
| 2.2 | `upgrade-eg.sh <0.17.2 r1> <0.18 r1> AH07` | 同上（多一个起点；uid 迁移在 0.17.4 已验，这里只看不回退） |
| 2.3 | 已用 join-key 接入的 EG 批量升级（子站 `upgrade-egs.sh --only <单元号>`） | 表头「单元」；成功；升级后 hello `entry=4`、`unit=` 对 |

## 3. 0.6.x EG 接 0.18 子站（两边）

子站 0.18、这面柜照旧一柜一台（legacyEg）、EG 停在 0.6.3（0.17.4 r1 装的）。

| # | 项 | 过的标准 |
|---|---|---|
| 3.1 | 子站从 0.17.4 升到 0.18 后，0.6.3 的 EG 不动 | 上送、告警事件、证据、配置下发（caps / meters / offCabs 的柜号键与 0.17 一字不差）都照常；网关页在线、配置 APPLIED；平台无空洞 |
| 3.2 | 子站下发新版本配置（改一个阈值） | 0.6.3 EG 回执 APPLIED，没有 DEVICES_MISMATCH / BAD_REQUEST |
| 3.3 | 单点登录（子站「打开 EG 管理页」） | 票据 `c` = 柜号，0.6.3 认 |
| 3.4 | 视频拉流 | 子站按柜号路径 `<柜号>[-sub\|-ir\|-ir-sub]` 拉得到 |
| 3.5 | `join-egs.sh --unit AH09 --eg <0.6.3 的 EG>`（重跑） | 预检按 cabinet= 当照旧一柜一台；各步跳过 / 照做，成功 |
| 3.6 | `join-egs.sh --unit AH09-A --eg <0.6.3 的 EG>` | 预检拒绝「接舱室单元要 EG 0.7.0 起」 |

## 4. 一键加柜按单元（EG，子站 0.18）

| # | 项 | 过的标准 |
|---|---|---|
| 4.1 | `--unit <单元号>`：待接入的 0.7.0 EG | 6 步全过；provision `--unit`、pack `--only <单元号>`；子站 eg-list 上送正常、配置生效；隧道已撤 |
| 4.2 | `--unit` 重跑 | 建实体跳过（隧道已撤）、配置 same、不重启 |
| 4.3 | `--unit` 接到已接在别的单元的 EG | 拒绝；加 `--force` 改接（入口 apply-config 带 force） |
| 4.4 | `--cabinet <已拆的柜> --eg A=…,B=…` | 两个单元依次接上；一台故意没授权时另一台照样接上、汇总给重来命令 |
| 4.5 | `--from-file 清单 --plan` | 逐台结论，不改任何东西 |
| 4.6 | conv 参数随接入（`--conv-serial … --sensors …`） | 转换程序起来；conv.bus 在子站上是这个单元的 |

## 5. 拆柜实跑（两边，含断数窗口）

一面照旧一柜一台、0.6.3 EG 在线的柜（如 AH07），拆成 AH07-A / AH07-B：原来那台升到 0.7.0、补一次 `install.sh --join-key` 后改作 A，另一台裸 EG 装 0.7.0 待接入作 B。子站侧另开探针每 1 s 记这面柜的实时值时间戳，平台侧记 plat 上 AH07 的时序。

| # | 项 | 过的标准 |
|---|---|---|
| 5.1 | `join-egs.sh --split AH07 --eg A=…,B=… --plan` | 两台都能接；什么都不改（model.site.yaml sha 不变、没跑 up.sh） |
| 5.2 | 一台不能接（B 装成 0.6.3）时 `--split` | 整个不开始，model.site.yaml 不变 |
| 5.3 | `join-egs.sh --split AH07 --eg A=…,B=…` | 备份 model.site.yaml（日志目录）、legacyEg 只去掉 AH07、unitIndex 不动；up.sh 成功；后端核对：EG-AH07-A/B 建好、SAM / 电表 / 颗粒物改挂、旧 EG-AH07 归档、旧令牌作废；两单元都接上 |
| 5.4 | 断数窗口 | 汇总报的窗口（up.sh 开始 → 最后一台上送正常）与子站探针、平台时序对得上；记下秒数写进发布说明 |
| 5.5 | 拆后检查 | 网关页每个单元在线；`check.sh`「舱室单元」「配置下发」正常；`conv.bus`、`eg.n / eg.on / eg.nv` 对；EG 本地页标题带舱室 |
| 5.6 | 拆后再跑 `--cabinet AH07` | 两台都「已接入本单元：重跑」，各步跳过、不重启 |

## 6. 回滚

| # | 项 | 谁 | 过的标准 |
|---|---|---|---|
| 6.1 | 子站 0.18 → 0.17.4（没有柜拆过） | 后端 | 子站回滚流程走通；0.6.3 / 0.7.0（schema 1）的 EG 照常上送；数据一致 |
| 6.2 | 子站 0.18 → 0.17.4（有柜已拆成单元） | 后端 | 按后端定的口径：拒绝或给出明确提示（拆了的柜 0.17.4 不认 EG-<柜>-<字母>） |
| 6.3 | EG 0.7.0 → 0.6.3：照旧一柜一台（schema 1） | EG | `install.sh --rollback` 照常（同 2.1） |
| 6.4 | **EG 刚拆柜、接成单元（schema 2）后回滚到 0.6.3：应被拒** | EG | `install.sh --rollback` 拒绝（rc 1）：「本机已接成舱室单元（EG-AH07-A，eg.yaml schema 2），要回到的 0.6.3-… 读不了 schema 2」，并说清怎么办（子站先把这面柜恢复成照旧一柜一台、再发照旧一柜一台的 eg.yaml）；什么都没改（容器、版本、config 不变）。由 install.sh 的 `rollback_schema_guard` 做（本 PR） |
| 6.5 | EG 0.7.0 → 0.7.0 重装 / 0.7.x 之间回滚（schema 2） | EG | 放行 |

> 6.2 / 6.4 的「刚拆柜、还没有记录时回滚」：EG 侧理解为「本机已是舱室单元的 schema 2 配置，旧的照旧一柜一台配置（及其令牌）已经没有、也作废了」时回滚到 0.6.x —— 拒绝。子站侧（拆柜后、子站上没有旧 legacy 记录时回 0.17.4）由后端定口径，P6 一起核。

## 7. 结果怎么记

- 每项 ✓ / ✗ 与用时记进 EG 库 `docs/评审记录.md` 与 0.18.0 发布说明的「验收」「VM 实跑」两节；断数窗口写秒数。
- 沙箱用完拆掉（`it_down`），测试 .run 不进 bundle 目录。
