# 子站一条命令批量升级 EG · 方案（草稿，待协调确认）

> 2026-10-16。在子站主机上一条命令把多台 EG 升到新的一键安装文件（.run）。页面上的远程升级以后再说。
> 原则：子站拿到的不是「能在 EG 上执行任意命令」的账号，而是「只能把一个指定的 .run 交给 EG 自己升级、查进度」的钥匙。

## 1. 安全模型

| 项 | 做法 |
|---|---|
| 账号 | EG 上新建专用账号 **`lsa-upg`**，不复用 `lsa-sp`：`lsa-sp` 是建实体用的隧道账号，部署完就删，两者用途和生命周期不同。`lsa-upg` 不设口令（锁定），home 是 `/var/lib/lsa-upg` |
| 授权 | `sudo bash install.sh --upgrade-key <子站公钥>`。authorized_keys 写成：`restrict,from="<子站地址>",command="sudo -n /usr/local/sbin/lsa-eg-upgrade" <公钥>`<br>- `restrict`：不给终端，不转发端口、X11、agent<br>- `from`：缺省取 eg.yaml 里的子站地址，可用 `--upgrade-from` 改<br>- `command=`：不管子站发什么命令，都只进升级入口；子站发的命令行放在 `SSH_ORIGINAL_COMMAND` 里，由入口自己解析 |
| 提权 | `/etc/sudoers.d/lsa-upg` 只有一行：`lsa-upg ALL=(root) NOPASSWD: /usr/local/sbin/lsa-eg-upgrade`。入口脚本 root 所有、755，由 install.sh 从发布件安装，`visudo -c` 检查过才落盘 |
| 入口只认这几个动作 | `put <sha256> <字节数>`：从 stdin 收 .run 到 `/var/lib/lsa-upg/incoming/<sha256>.run`。收之前查磁盘余量，收完核对 sha256 和名字一致，不一致删掉并拒绝<br>`start <sha256>`：文件在、sha 对、是 LSA 的安装文件（makeself 自检、带 EG 发布件、版本不低于现装版本）才开始；同一时间只允许一个任务（flock）<br>`status`、`log [行数]`：读进度和日志<br>`drop <sha256>`：删拷贝<br>其它一律拒绝，并记进 `/var/log/lsa-upg.log` 和 agent 审计 |
| 撤销 | `--drop-upgrade-key` 删账号、key、sudoers 条目。`--status` 和装完时的「安全提醒」里，`lsa-upg` 在就提示 |
| 剩余风险（要说清） | 拿到这把 key 的人，**能让 EG 装任意一个他构造的 .run**，等于 root。上面这些限制只能防「拿 key 随便执行命令」，防不了「恶意安装包」。缓解：key 只放子站主机 root 下（600）；`from=` 限定子站地址；不用时撤销。**彻底的办法（建议下一步）**：给 .run 加签名。出包时用发布私钥 `ssh-keygen -Y sign` 签名，EG 用随发布件预置的公钥 `ssh-keygen -Y verify` 校验，不在 sha256 清单上做文章 |

## 2. EG 侧：脱离 SSH 也能做完

- `start` 用 `systemd-run --unit lsa-eg-upgrade --collect` 起后台任务；没有 systemd 时用 `setsid nohup`。之后立刻返回任务号。SSH 断了，任务照跑。
- 任务阶段写进 `/var/lib/lsa-upg/state`（`verify → disk → install → check → done | failed | rolled-back`），日志写 `/var/lib/lsa-upg/jobs/<任务号>.log`。
- 升级本身：`<.run> --role eg --yes`，在原安装目录里升级，配置不动，复用现有的升级 / 备份 / 回退逻辑。
- **安装失败**（.run 非 0 退出，或装完容器起不来）：自动执行 `install.sh --rollback`；TB 版本变了的话加 `--restore-tb`。状态记成 rolled-back，不会停在半路。
- **装完但核对不过**（比如上送没连上）：**不自动回退**，因为可能是子站或网络的问题。状态记成 check-failed，由子站停下来，打印回退命令。
- EG 上自己能核对的：VERSION、7 个容器 running 且 1 分钟内没重启、本地 TB 版本、上送状态（`config/uplink-state.json`）。
- 做完删掉 .run 拷贝；`incoming/` 里只留最近一次。

## 3. 子站侧：`upgrade-egs.sh`

```
upgrade-egs.sh --run <新 .run> [--all | --only AH03,AH05] [--canary AH05] [--parallel 2] [--plan]
upgrade-egs.sh --keygen        # 生成子站升级 key，打印每台 EG 要执行的授权命令
upgrade-egs.sh --resume <批次>  # 断开以后续查（EG 上的任务不受影响）
```

1. **清单**：从子站取每台 EG 的柜号、egUrl 和当前版本，「未接入 / 停用」的跳过，已经是目标版本的跳过。请后端在 lsa-ext 里加一个只读命令，例如 `eg-list --json`，顺带给出配置下发状态，供核对 APPLIED 用。`--plan` 只列出要做什么（含每台的预检），不改任何东西。
2. **预检**（全部 EG 一起做）：SSH 能连上、入口版本对、磁盘够。有一台不过，就整批不开始。
3. **canary 先升**，等它通过核对。然后其余的按并发上限（缺省 2）依次升。**任何一台失败就不再开新的**，已经在升的做完；打印失败那台的状态和回退命令：`sudo bash /opt/lsa-eg/install.sh --rollback [--restore-tb]`，EG 已经自己回退的就说已回退。
4. **每台**：`put` → `start` → 每 10 s `status` 一次（SSH 断了就重连再查）→ 子站侧再核对一遍：子站 TB 上 EG 版本属性对、上送连上（eg.uplink=ok）、配置 APPLIED → `drop`。
5. **结果**：每台一行（柜号、旧 → 新版本、耗时、结果、原因），最后汇总成表。日志放 `/var/log/lsa9600sp/eg-upgrade/<批次>/`（summary.tsv 加每台一份）。
6. ssh 沿用 provision-eg.sh 的做法：在子站已有的容器里跑 ssh 客户端，主机上不用装；私钥只读挂进去。
7. **放在哪**：脚本在 EG 库 `deploy/sp/upgrade-egs.sh`，由一键安装包带上，`--role sp` 时装到子站目录。子站要改的地方（`eg-list` 命令、安装时拷脚本）和后端对。

## 4. 验证与文档

- **环境**：现有的子站沙箱 itsp，加两台 EG 沙箱（iteg = AH07，新加一台 AH08）。用 0.17.1 r2 → 0.17.2 的 .run 测：
  - 正常批量升级；
  - canary 失败时停下（用一个坏 .run，或者让 canary 的核对过不去）；
  - 升到一半断掉 SSH（iptables 拦掉），`--resume` 续查；
  - 没授权的 key 被拒（以及授权过的 key 想执行任意命令也被拒）；
  - sha256 不对被拒。
- **⚠ 需要下载（要用户批准）**：沙箱用的精简 ubuntu:24.04 没有 sshd 和 ssh 客户端，本机镜像和 EG 的离线 deb 里也都没有。需要 openssh-server / openssh-client 及依赖的 noble deb，约 2–3 MB，只装进测试沙箱，不进产品包。真 X26A 和子站主机（Ubuntu Server）本来就有 sshd / ssh。
- **文档**：EG 部署手册加一节（授权 / 撤销、入口能做什么、怎么回退），子站部署手册加一节（keygen、plan、跑、续查、读结果）。

## 5. 工作量与时间

EG 入口 + install.sh 授权约 0.5 天；upgrade-egs.sh 约 0.5 天；后端的 `eg-list` 命令（后端做）；沙箱验证约 0.5 天。排在 W1 / W2 / conv 接入之后，**赶 0.17.2 偏紧，倾向进 0.17.3**。

**待协调定**：① 专用账号 `lsa-upg`，不复用 `lsa-sp`；② 这一版先不做签名，签名放下一步（还是这次一起做）；③ 测试用的 openssh deb 下载；④ 进 0.17.2 还是 0.17.3（2026-10-16 协调定：做完测完，直接进 0.17.2 / EG 0.6.2）。
