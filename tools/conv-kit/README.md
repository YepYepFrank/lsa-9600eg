# LSA-9600EG 转换程序测试套件

> **给谁用**：把各传感器数据转成 MQTT 的同事。
> **干什么**：在你自己的电脑（Windows / Ubuntu）上装一个和 EG 上**一模一样**的本机总线（Mosquitto，`127.0.0.1:1884`），再用检查工具 `lsa_check.py` 逐条检查你的程序发的消息对不对 —— 不用等 EG 硬件、不用装子站。
> **依据**：《EG 内部 MQTT 格式 v0.4》（同目录 `EG内部MQTT格式.md`）。检查工具的点表 `spec.json` 由 EG 的点表目录（`@lsa/points`）导出，**两者不一致时以检查工具为准**，并请告诉我们。

| 文件 | 用途 |
|---|---|
| `install.sh` | Ubuntu / Debian 一键装总线（有 Docker 用容器，没有就 apt 装） |
| `install.ps1` | Windows 一键装总线（有 Docker Desktop 用容器，没有就用本机 Mosquitto） |
| `compose.yaml`、`mosquitto/mosquitto.conf` | 容器方式的编排与配置，与 EG 上的 `lsa-eg-mosquitto` 同版本（2.1.2）、同配置 |
| `lsa_check.py` | 检查工具（只要 Python 3.8+，不用 pip 装任何东西） |
| `spec.json` | 检查工具用的点表 |
| `images/eclipse-mosquitto-2.1.2.tar` | （离线包才有）Mosquitto 镜像，没外网时用 |
| `EG内部MQTT格式.md` | 格式说明（v0.3） |

---

## 1. 装总线

三选一。装完脚本会**自动自检**（发 6 s 示范数据、收一遍），看到「自检通过」就好了。

### 1.1 Ubuntu / Debian（推荐，与 EG 同系统）

```bash
sudo bash install.sh
```

- 有 Docker（`docker info` 能用、带 `docker compose`）就起容器 `lsa-conv-mosquitto`（镜像 `eclipse-mosquitto:2.1.2`，与 EG 一致）；
- 没有 Docker 就 `apt` 装系统的 `mosquitto`，加一份配置 `/etc/mosquitto/conf.d/lsa-conv-kit.conf`（听 `127.0.0.1:1884`）。

可选参数：`--lan`（听 0.0.0.0，见 1.4）、`--docker` / `--native`（指定方式）、`--port 1885`（1884 被占时）、`--status`、`--uninstall`。

### 1.2 Windows

PowerShell 里（不用管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

- Docker Desktop 在跑就起容器（同上）；
- 否则用本机的 Mosquitto：没装会用 `winget` 装（`EclipseFoundation.Mosquitto`；没有 winget 就从 <https://mosquitto.org/download/> 装 Windows 版），然后在后台起一个 `mosquitto.exe`，配置与数据在本目录 `data\`。**这种方式重启电脑后要再跑一次脚本。**
  如果装 Mosquitto 时它注册的 Windows 服务占了端口：`Stop-Service mosquitto`（或换 `-Port 1885`）。

可选参数：`-Lan`、`-Docker` / `-Native`、`-Port 1885`、`-Status`、`-Uninstall`。

检查工具要 Python 3.8+：`winget install Python.Python.3.12`，或 <https://www.python.org/downloads/>。下文的 `python3` 在 Windows 上换成 `py -3`。

### 1.3 已经是一台装好的 EG

EG 上总线本来就在（容器 `lsa-eg-mosquitto`，`127.0.0.1:1884`），**不用装**（`install.sh` 也会认出来直接退出）。直接按 EG 的设备清单检查：

```bash
python3 lsa_check.py --eg-yaml /opt/lsa-eg/config/eg.yaml
```

在 EG 上检查时，eg-agent / eg-video 自己发的消息（带 MQTT 5 用户属性 `src=eg-agent` / `eg-video`）会被自动略过，只看你的。

### 1.4 转换程序在另一台机器上（`--lan`）

比如总线装在 Ubuntu 测试机上、转换程序在你的 Windows 笔记本上调试：装的时候加 `--lan`（Windows 加 `-Lan`），总线就听 `0.0.0.0:1884`，你的程序连 `mqtt://<测试机 IP>:1884`。

- 检查工具在哪台跑都行；两台机器时钟不同步时加 `--lan`，不报「采样到到达超过 3 s」。
- **正式 EG 上总线只听 127.0.0.1**，转换程序必须跑在 EG 本机上。联调完记得去掉 `--lan` 重装。

### 1.5 手工安装（不想用脚本时）

任何 Mosquitto 2.x，加这几行配置即可（与 EG 等价）：

```
listener 1884 127.0.0.1
allow_anonymous true
persistence true
max_queued_messages 50000
```

---

## 2. 让转换程序连上

| 项 | 值（与 EG 上完全一样） |
|---|---|
| 地址 | `mqtt://127.0.0.1:1884` |
| 账号 | 不鉴权 |
| 协议 | MQTT 3.1.1 或 5 |
| QoS | **1** |
| retain | **不要用** |
| clientId | 固定且唯一，如 `lsa-conv-AH03` |
| keepalive | 30 s；断开后 3 s 内重连 |
| 主题 | `lsa/<设备名>/telemetry`、`lsa/<设备名>/attributes` |
| 载荷 | `{"ts": <采样时刻毫秒>, "values": {…}}` |

设备名、各设备发哪些 key、周期，见 `EG内部MQTT格式.md` §3–§6b。

---

## 3. 用检查工具

```bash
# 最简单：按设备名前缀自动认设备，一直检查到 Ctrl+C，结束时出汇总
python3 lsa_check.py

# 指定柜号与柜型：还会检查「该有的设备一台不少」（mv 中压开关柜 SAM-A/B；tr 干式变压器 SAM-A/B/C；lv 低压柜 SAM-A）
python3 lsa_check.py --cab AH03 --group mv

# 跑 5 分钟出报告（把这个文件发给我们）
python3 lsa_check.py --cab AH03 --group mv --duration 300 --report 自检报告.md
```

运行时**每类问题只在第一次出现时打印一行**（带那条消息原文），之后只计数；结束时打印汇总表（每台设备的消息数、key 数、平均延迟、快档最大间隔、状态，以及全部问题和次数）。

| 级别 | 含义 |
|---|---|
| **错误** | 数据会丢、会错、或子站不认：必须改 |
| **注意** | 能用，但会被标陈旧 / 无效、或口径不对：应该改 |
| **建议** | §9 里希望你配合的（如 `dev.last_try` 等通信状态） |

结论「通过」= 没有「错误」。退出码：通过 0、不通过 1（可以放进你的自动测试）。

它检查的（对应格式说明的章节）：

- **连接与主题**（§2–§3）：QoS 是不是 1、有没有用 retain、主题与设备名对不对、设备在不在清单里、有没有冒发摄像机 `CAM-*`；
- **载荷**（§4）：是不是合法 JSON、有没有 `ts` / `values`、`ts` 是毫秒（不是秒 / 微秒）、`ts` 是采样时刻（到达时延 > 3 s 报）、`ts` 不往回走、同一时刻有没有拆成好几条；
- **量**（§5–§6b）：key 在不在点表里、类型（数值不能发成字符串、JSON 字符串要能解析、谐波要 30 个数、`uv.pulse` 要有 peak / ms、`q` 的取值、`dev.err` 的取值）、枚举（`sw.cb`、`eg.power`）、合理范围（功率因数、频率、湿度等）、不该你发的量（`el.load_pct`、`eg.*`、`dev.comm`、`dev.link`、`cam.*`）、已退役的量（SAM 的 `ir.*`）；
- **成组**：三相电流同一条、弧光脉冲同时带 `uv.int`、`el.Ep` 单调不减、南向统计五个一起发、PM2.5 ≤ PM5.0 ≤ PM10；
- **周期**（§4–§5）：每个该发的量有没有按周期来 —— 超过 3 个周期没来报「陈旧」、超过 max(30 s, 5 个周期) 报「无效」，与 EG 的看护口径一致；一直没来的报「缺」。

其他参数：`--raw` 逐条打印收到的消息；`--quiet` 实时只打印错误；`--every 60` 每分钟打一次汇总；`--host` / `--port` 换总线地址；`--pm2` 有第二块电表。

> 「快档最大间隔」明显大于 2 s，或频繁报「陈旧」，多半是串口轮询一圈太慢（设备多、波特率低、超时设得长），不是格式问题。

### 3.1 看看对的长什么样 / 试试检查工具

```bash
python3 lsa_check.py demo --cab AH03 --group mv            # 发一套正确的示范数据（2 s 一轮），另开一个窗口跑检查
python3 lsa_check.py demo --cab AH03 --group mv --verbose  # 同时打印发出的每一条，可以照着写
python3 lsa_check.py demo --cab AH03 --bad                 # 故意发常见错误：数值发成字符串、ts 用秒、QoS 0、retain、拆条、电能倒退……
```

示范数据就是按格式说明发的，可以对照你的程序。**注意：别和你的程序同时发同一个柜号**，否则会混在一起。

### 3.2 清掉残留的 retain

用 retain 发过的消息会一直存在总线上（EG 重启后会被当成新数据再收一遍）。改掉程序后清一次：

```bash
python3 lsa_check.py clear-retained
```

---

## 4. 常见问题

| 现象 | 处理 |
|---|---|
| 装的时候说端口 1884 被占用 | Linux：`ss -ltnp \| grep :1884`；Windows：`Get-NetTCPConnection -LocalPort 1884`。是旧的 Mosquitto 服务就停掉，或 `--port 1885`（转换程序也跟着改，正式 EG 上仍是 1884） |
| 检查工具「连不上 127.0.0.1:1884」 | 总线没起：`install.sh --status` / `install.ps1 -Status`；容器方式看 `docker logs lsa-conv-mosquitto` |
| 一直报「ts 比本机时间快」或「采样到到达超过 3 s」 | 转换程序与检查工具不在一台机器、时钟不同步时加 `--lan`；同一台机器上就是 `ts` 用错了（用了发送时刻 / 旧缓存）或程序堵了 |
| 报「陈旧」「无效」 | 数值没变也要按周期发（§4）；采不到的量直接不发这个 key，不要发 0 或重复上次的值 |
| 报 key「不在点表里」 | 拼写 / 大小写（`el.Ia` 不是 `el.IA`）；点表以 `spec.json` 为准 |
| Windows 控制台中文乱码 | 用 Windows Terminal，或先 `chcp 65001` |

## 5. 卸载

```bash
sudo bash install.sh --uninstall                                  # Linux
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall    # Windows
```

容器方式连同数据卷一起删；apt 方式只删本套件的配置（`mosquitto` 包留着）；Windows 本机方式停掉 `mosquitto.exe` 并删 `data\`。
