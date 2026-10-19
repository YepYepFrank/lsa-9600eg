# 子站主机上批量升级 EG（0.17.2 起；0.18.1 起验发布签名）

> **0.18.0 舱室 EG**：一个电气舱室一台 EG，`--only` / `--canary` 给**单元号**（`EG-AH01-A` 的单元号 `AH01-A`）；照旧一柜一台的单元号就是柜号（`AH03`），用法不变。表头「单元」即单元号。

> 给子站部署手册用的一节（子站部署手册「批量升级 EG」指向这里）。脚本 `/opt/lsa9600sp/upgrade-egs.sh`，由一键安装文件 `--role sp` 装上；EG 侧的授权与安全见 EG 部署手册 §6c。

## 1. 一次性准备

1. 在子站主机上生成升级 key（只一次）：
   ```bash
   sudo bash /opt/lsa9600sp/upgrade-egs.sh --keygen
   ```
   key 放在 `/opt/lsa9600sp/keys/`（root，600）。这条命令会打印要在每台 EG 上执行的授权命令。
2. 到每台 EG 上用维护账号执行打印出来的那条（EG 要已经是 0.17.2（EG 0.6.2）或更新）：
   ```bash
   sudo bash /opt/lsa-eg/install.sh --upgrade-key 'ssh-ed25519 AAAA… lsa9600sp-eg-upgrade@<子站主机名>'
   ```
   授权后，这把 key 只认子站主机来的连接，而且只能把安装文件交给 EG 自己升级、查进度，执行不了别的命令。
3. EG 清单和地址从子站取。
   - 0.17.2 起用子站后端的 `eg-list`（`docker exec lsa-ext node bin/eg-list.mjs --json`）：地址按 egUrl > EXT_EG_URLS > model.yaml 推好。
   - 老子站没有 eg-list 时直接查子站 TB，只认 `EG-<柜号>` 的 `egUrl` 属性（provision-eg.sh `--ssh` / `--eg-url` 时写上的）。
   - 没有地址的 EG 会跳过，并在计划里列出来。

## 2. 跑

```bash
# 先看计划：每台的当前版本 → 目标版本、连不连得上、空间够不够（只看，不改任何东西）
sudo bash /opt/lsa9600sp/upgrade-egs.sh --run <新的 .run> --all --plan

# 升级：先升 canary，通过核对后，其余按并发上限（缺省 2）依次升
sudo bash /opt/lsa9600sp/upgrade-egs.sh --run <新的 .run> --all --canary AH05
sudo bash /opt/lsa9600sp/upgrade-egs.sh --run <新的 .run> --only AH03,AH05 --parallel 1
```

- **`--plan` 的表**：每台一行，柜号、在不在线、当前版本 → 目标版本、动作（升级 / 跳过 / !!）、原因；没有地址的合成一行。最后一行是合计：
  ```
  柜号   在线   版本（当前 → 目标）        动作 原因
  AH07     在线   0.6.2-it2 → 0.6.2-it2              跳过 在维护：lsa-sp 隧道开着（子站在建本地实体或改设备清单）
  AH08     在线   0.6.2-it2 → 0.6.2-it3              升级
  AH09     离线   0.6.1-233658b → 0.6.2-it3          !!   连不上：…（EG 开着吗、22 口通吗）（--skip-offline 可跳过它）
  合计：升级 1 台，跳过 1 台，有 !! 项
  ```
- **跳过**（不算失败）：
  - 子站上标了「未接入 / 停用」；
  - 没有地址；
  - **已是该版本**（要重装加 `--force`）；
  - **比目标版本新**：不降级，回退用 install.sh --rollback；
  - **在维护**：这台的 lsa-sp 隧道开着（子站在建实体 / 改设备清单），或者有人在跑 install.sh / 一键安装文件，或者已经有升级任务在跑。
  - 另外，版本号相同、构建号不同的算「重打」，照样升；但构建号分不出新旧，表里会提醒确认。
- **!!，整批不开始**：
  - 连不上或没授权（加 `--skip-offline` 改成跳过）；
  - 空间不够；
  - 子站扩展服务刚启动、EG 状态还没读全（等一两分钟再跑）。
- **验签（0.18.1 起，详见 §7）**：`--run` 旁边有 `<run>.sig` 就自动一起用。子站先用 `/opt/lsa9600sp/release-signers` 验一遍，**签名不对整批不开始**（`--plan` 也报 !!）；EG 是 0.18.1 起的入口就把 .sig 也传过去，EG 再验一遍，不对就拒绝、不装。表里多一列「验签」：
  - `EG 验`：EG 会验（入口 5，有发布公钥）；
  - `子站验`：EG 还是老入口（从 0.18.1 之前升到 0.18.1 的这一次），只有子站验过；
  - `未签名`：安装文件旁边没有 .sig —— 过渡期照升，汇总写「安装文件未验签」；下一版起不升；
  - `未验`：子站和 EG 都没有发布公钥，谁也验不了。
  - 表头上面一行「签名：」写子站验的结果（已验 + key 指纹 / 没有签名 / !! 子站验不了）。
- **每台的流程**：
  1. 拷安装文件，EG 收完核对 sha256；有 .sig 且 EG 是新入口就再拷签名；EG 开始前验签；
  2. EG 在后台自己升级；
  3. 子站每 10 s 查一次进度；
  4. EG 自查：版本、7 个容器、本地 TB、连上子站；
  5. 子站核对：子站 TB 上这台报的版本是目标版本、上送正常、配置版本和升级前一样；
  6. 删掉 EG 上的拷贝。
- **任何一台失败就不再开新的**；已经在升的会做完。汇总里给出失败那台的原因和回退命令。
- 安装文件本身失败时，EG 会自动回退，汇总里写「已自动回退」。

## 3. 结果和日志

每台一行结果，最后汇总成一张表：

```
柜号   原版本          耗时s  结果 说明
AH07     0.6.2-it1          115      成功 本地 TB 4.2.2.6，配置 c-1016-1 照旧，上送正常
AH08     0.6.2-it1          22       失败 安装没成功，EG 已自动回退到 0.6.2-it1（…）
AH09     0.6.2-it1          -        没做 前面有失败，停下了（修好后 --resume 20261016-071929 接着做）
```

日志在 `/var/log/lsa9600sp/eg-upgrade/<批次>/`：`run.log`（整批）、`summary.tsv`、每台一份 `<柜号>.log`（含 EG 上的任务日志）。`--list` 列出做过的批次。

## 4. 断开了怎么办

EG 上的升级是后台任务，不跟着 SSH 走：子站主机重启、脚本被打断、网络断了，EG 都会照样做完；失败的话会自己回退。

恢复以后续查：

```bash
sudo bash /opt/lsa9600sp/upgrade-egs.sh --resume <批次>
```

已经开始的那几台只查结果、做子站核对。还没开始的，如果这一批之前没有失败，就接着升。

## 5. 回退

- **EG 已自动回退**（安装文件失败）：不用做什么，查清原因（看 `<柜号>.log`）后重跑。
- **装完了但核对不过**（比如上送没连上）：EG 不会自动回退，因为可能是子站或网络的问题。先查原因；确认要回退时，在那台 EG 上用维护账号执行汇总里给出的命令：
  ```bash
  sudo bash /opt/lsa-eg/install.sh --rollback      # 本地 TB 版本变了时，汇总里会写 --rollback --restore-tb
  ```

## 6. 安全

- 持这把 key 的人能让 EG 装他给的任意安装文件，等于 root。key 只放在子站主机 root 下，不要拷走。
- 不用了就到各 EG 上撤销：`sudo bash /opt/lsa-eg/install.sh --drop-upgrade-key`。
- 0.18.1 起安装文件带发布签名：持这把 key 的人只能让 EG 装发布方签过的安装文件（过渡期没签名的照样能装、汇总写「未验签」；下一版起强制）。见 §7。

## 7. 发布签名（0.18.1 起）

**为什么**：升级 key 只防得住「拿 key 在 EG 上乱执行命令」，防不住「拿 key 让 EG 装一个改过的安装文件」。签名以后，EG 只装发布方签过的安装文件。

**发布件**：每个一键安装文件旁边多一个同名的 `.sig`，和 `.sha256` 一起拷：

```
LSA-9600SP-0.18.1-<日期>-r1-offline.run
LSA-9600SP-0.18.1-<日期>-r1-offline.run.sha256
LSA-9600SP-0.18.1-<日期>-r1-offline.run.sig      ← 0.18.1 起
```

- 签名：ed25519，`ssh-keygen -Y sign`，身份与命名空间都是 `lsa9600-release`。Ubuntu 24.04 自带 ssh-keygen，子站、EG 上都不用装别的。
- 发布公钥：EG 库 `deploy/eg/release-signers`（allowed_signers 格式）。随 EG 发布件装到 `/opt/lsa-eg/release-signers`，随一键安装文件 `--role sp` 装到 `/opt/lsa9600sp/release-signers`。
- 手工核对（子站或 EG 上）：
  ```bash
  ssh-keygen -Y verify -f /opt/lsa9600sp/release-signers -I lsa9600-release -n lsa9600-release \
    -s LSA-9600SP-…-offline.run.sig < LSA-9600SP-…-offline.run
  # Good "lsa9600-release" signature for lsa9600-release with ED25519 key SHA256:… 就对
  ```

**谁验、验不过怎么办**：

| 情况 | 子站 upgrade-egs.sh | EG（入口 5） | 汇总 |
|---|---|---|---|
| 有 .sig、签名对 | 签名行「已验」 | 验过才装，state `sig=ok` | 成功 …；已验签（EG） |
| 有 .sig、EG 还是老入口（升到 0.18.1 的这一次） | 「已验」，验签列「子站验」 | 收不了 .sig，不验 | 成功 …；子站已验签，EG 是老入口没验 |
| 安装文件或 .sig 被改过、不是发布方签的 | **!! 整批不开始**（`--plan` 也是） | 子站没拦住时（子站没有公钥）EG 拒绝、删掉收到的文件 | 失败：EG 没开始升级：签名校验不过 … |
| 没有 .sig | 照升，签名行「没有签名」 | 照装，state `sig=unsigned` | 成功 …；安装文件未验签 |

**过渡期**：

- **0.18.1**：有 .sig 必验（不对就拒）；没 .sig 允许，汇总写「未验签」。EG 想提前强制：`/opt/lsa-eg/.env` 加 `EG_UPG_SIG_REQUIRED=1`。
- **下一版起**：强制 —— 没签名、没公钥都不升。
- 要用签名，子站先用 0.18.1 起的一键安装文件 `--role sp` 升级（带来新的 upgrade-egs.sh 和发布公钥），再批量升 EG。

**私钥（打包机）**：

- 只在打包机上：缺省 `~/.lsa9600/release-sign/lsa9600-release_ed25519`（Windows：`C:\Users\<打包账号>\.lsa9600\release-sign\`，ACL 只给打包账号）。**不进任何仓库、不进包**（bundle-all 打包前后都扫，见到 `*_ed25519` / `id_*` 一律失败）。
- 出包：`pnpm bundle -- --sp … --eg …` 出完 .run 自动签（`scripts/sign-release.mjs`），签完马上用仓库里的 `deploy/eg/release-signers` 验一遍，私钥和公钥对不上就失败、不留 .sig。私钥换了位置用 `--sign-key <路径>` 或 `LSA_RELEASE_SIGN_KEY`；测试包不签用 `--no-sign`。
- 老的 .run 补签：`node scripts/sign-release.mjs <run>`。
- **备份**：私钥另存一份离线介质（U 盘、保险柜），丢了只能换 key。
- **换 key / 私钥泄露**：
  1. 生成新 key（`ssh-keygen -t ed25519 -N '' -C lsa9600-release-<年份> -f …`），把新公钥**加一行**到 `deploy/eg/release-signers`（旧的先留着；泄露时给旧那行加 `valid-before="<日期>"` 或直接删）；
  2. 用**旧 key** 签下一版（EG 上还是旧公钥，只认旧 key）；这一版装上以后 EG 有了新公钥；
  3. 再下一版起用新 key 签，删掉旧公钥那行。
  - 泄露时：旧 key 签的东西 EG 都会认，所以尽快出一版只含新公钥的发布件，用旧 key 签、逐台升上去（或现场手工 `--role eg` 装）。

