#!/usr/bin/env bash
# EG 安装 / 升级 / 回退（在 EG 上、部署目录里跑，可反复跑）。步骤说明见 docs/EG部署手册.md。
#
#   sudo bash install.sh [--lan1 <网口>]   装 / 升级：没有 Docker 先装离线包、导入镜像、起本地 TB；config/eg.yaml 齐了就起全部
#   sudo bash install.sh --status          只看状态
#   sudo bash install.sh --rollback        回到上一个装好的版本（镜像还在本机）
#   sudo bash install.sh --rollback --restore-tb   本地 TB 升过补丁（如 4.2.2.5 → 4.2.2.6）时的回退：用升级前的本地库备份恢复
#
# --lan1：摄像机网口名（如 enp2s0）。管理页对从它进来的请求一律 403（I5-2），记在 .env 里，以后不用再给。
#   网口必须存在；本机只有一个对外网口时拒绝（那样唯一的网口也会被挡住，管理页谁都打不开），确实要这样加 --force。
# 升级在原安装目录（/opt/lsa-eg）里跑：在别的目录跑、而本机已装在别处时拒绝（会生成另一份 .env 把本地库按新口令重建），--force 才另装。
# --sp-key <子站公钥文件或公钥串>：给子站 provision-eg.sh 用的隧道账号 lsa-sp 授权（可反复给、不重复加）。
#   lsa-sp 没有口令、没有 shell，authorized_keys 带 restrict,port-forwarding,permitopen="127.0.0.1:18080"：
#   只能从子站开隧道到本机的本地 TB（18080），别的都不行。部署完用 --drop-sp-key 删掉（以后要再建实体重新 --sp-key）。
# --drop-sp-key：删掉隧道账号 lsa-sp（连同它的 authorized_keys），别的不动。
# 给过 --lan1 时同时加 LAN1 防火墙（nftables 表 inet lsa_eg：摄像机网只出不进，22 / 80 / 8554 都连不上，开机自起）；
#   --fw-off 关掉并记住，--fw-on 重新打开；--status 显示它；回退到不管它的老版本时自动清掉。
# 软件看门狗（I13，X26A 没有硬件看门狗）：装时启用 softdog + systemd RuntimeWatchdogSec（系统卡死 60 s 没喂狗就重启）；
#   --watchdog-off 关掉并记住，--watchdog-on 重新打开；--status 显示它。本机有硬件看门狗时直接用它、不加载 softdog。
# 转换程序（I11）：发布件带了它的镜像（CONV_IMAGE.txt）、串口也在时启用 compose 里的 conv 服务；
#   --conv-serial <设备>（缺省 /dev/ttyS1；USB 转 485 给 /dev/ttyUSB0 会自动换成 /dev/serial/by-id 的稳定名字记住；路径里不能有「:」「#」空格）、
#   --conv-off 关掉并记住、--conv-on 重新打开；--status 列出可选串口。
# 本地 TB 升级（0.17）：只做同一补丁线（只差第 4 位，如 4.2.2.5 → 4.2.2.6）—— 不跑 TB 的升级脚本（TB 官方：同补丁线 DO NOT run the upgrade script，
#   跑了报「database version … is not supported for upgrade」停在半路），先把本地库（含遥测）备份到 backups/，换镜像起，TB 启动时自己补数据，
#   起来后核对库里 tb_schema_settings.schema_version 变成新版本（最多约 2 分钟）。降级、跨小版本直接拒绝。
#   备份要的空间不够时拒绝；确实不要备份加 --no-tb-backup（那样回不去旧版 TB）。
# 只支持 Ubuntu Server 24.04（离线包 debs/ 按它做）：别的系统在装之前就报错退出（X26A 出厂 22.04 桌面版要先改装，部署手册 §2a）。
# 装完与 --status 都会列「安全提醒」：初始口令文件还在、lsa-sp 还在、SSH 允许口令登录等（只提醒，不替你改系统配置）。
#
# 分两轮是因为本地 TB 的设备、告警规则由子站跑 provision:eg 建（经 SSH 隧道连这台 EG 的 127.0.0.1:18080），
# 它同时把本地 TB 账号写进 eg.yaml —— 所以：第一轮起本地 TB → 子站 provision:eg → 拷回 eg.yaml → 第二轮起全部。
set -euo pipefail
cd "$(dirname "$0")"
DC='docker compose'
LAN1=''
SPKEY=''
MODE='install'
FORCE=0
CONV_SERIAL=''
RESTORE_TB=0
TB_BACKUP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --status) MODE='status' ;;
    --rollback) MODE='rollback' ;;
    --lan1) LAN1="${2:?--lan1 后面给网口名}"; shift ;;
    --force) FORCE=1 ;;
    --sp-key) SPKEY="${2:?--sp-key 后面给子站公钥（文件或公钥串）}"; shift ;;
    --drop-sp-key) MODE='drop-sp' ;;
    --fw-off) MODE='fw-off' ;;
    --fw-on) MODE='fw-on' ;;
    --watchdog-off) MODE='wd-off' ;;
    --watchdog-on) MODE='wd-on' ;;
    --conv-serial) CONV_SERIAL="${2:?--conv-serial 后面给串口设备，如 /dev/ttyS1}"; shift ;;
    --conv-off) MODE='conv-off' ;;
    --conv-on) MODE='conv-on' ;;
    --restore-tb) RESTORE_TB=1 ;;
    --no-tb-backup) TB_BACKUP=0 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done
# 串口路径进 .env、再进 compose 的 devices 短写法「宿主机:容器」：带「:」会被拆错，带「#」「空格」会弄坏 .env 的写入 —— 安装时直接拒绝（EG 0.5.1）
case "$CONV_SERIAL" in
  *:* | *'#'* | *' '* | *'	'*)
    echo "--conv-serial 的路径里有「:」「#」或空格：$CONV_SERIAL" >&2
    echo "  compose 的设备映射会把它拆错。改用 /dev/serial/by-id/ 下不带这些字符的名字，或者直接给 /dev/ttyUSB0（会自动换成 by-id）" >&2
    exit 2 ;;
esac

# ---------- LAN1（摄像机网）防火墙：只出不进 ----------
# --lan1 时装：LAN1 进来的只放已建立 / 相关连接的回包（EG 主动拉摄像机的 RTSP / HTTP 回包），其余一律丢 —— 22、80、8554 都连不上。
# 拉摄像机一律 RTSP over TCP（mtx.ts rtspTransport: tcp、抓帧 -rtsp_transport tcp），不用 ONVIF 组播发现，所以不需要摄像机主动进来。
# input 管宿主机网络上的服务（sshd、agent、mediamtx），forward 管 Docker 发布到容器的端口（DNAT 后走 forward、不经 input）；
# 优先级 filter - 10，比 Docker 的 iptables-nft 规则先判。单独一张表 inet lsa_eg，不碰系统其它规则。
# 持久化：systemd 单元 lsa-eg-fw.service 开机 nft -f 加载。--fw-off 关掉并记住（.env EG_LAN1_FW=off），--fw-on 重新打开。
FW_NFT=/etc/lsa-eg/lan1-fw.nft
FW_UNIT=/etc/systemd/system/lsa-eg-fw.service
fw_status() {
  local nic; nic="$(grep -E '^EG_LAN1=' .env 2>/dev/null | cut -d= -f2- || true)"
  if [ "$(id -u)" != 0 ]; then echo "LAN1 防火墙：要 sudo 才看得到"; return 0; fi
  if nft list table inet lsa_eg >/dev/null 2>&1; then
    # 没有计数行时 grep 返回 1，pipefail 下赋值会让脚本退出：|| true（0.13 验收后通扫 set -e 写法）
    local n; n="$(nft list chain inet lsa_eg input 2>/dev/null | grep -oE 'counter packets [0-9]+' | awk '{s+=$3} END {print s+0}' || true)"
    echo "LAN1 防火墙：开（$(nft list chain inet lsa_eg input | grep -oE 'iifname "[^"]+"' | head -1 | cut -d'"' -f2) 只出不进；开机自起 $(systemctl is-enabled lsa-eg-fw.service 2>/dev/null)；已丢弃入站 $n 个包）"
  elif [ -n "$nic" ]; then
    echo "LAN1 防火墙：没开（摄像机网 $nic 上 22 / 80 / 8554 都能连；sudo bash install.sh --fw-on 打开）"
  else
    echo "LAN1 防火墙：没开（没给 --lan1）"
  fi
}
fw_apply() {
  local nic="$1"
  command -v nft >/dev/null 2>&1 || { echo "!! 没有 nft 命令：摄像机网 $nic 上只有管理页 403 这一道（装 nftables 后重跑）" >&2; return 0; }
  mkdir -p "$(dirname "$FW_NFT")"
  cat > "$FW_NFT" <<EOF
#!/usr/sbin/nft -f
# LSA-9600EG（install.sh --lan1 写）：摄像机网 $nic 只出不进。不要手改，重跑 install.sh 会重写；关掉用 install.sh --fw-off
table inet lsa_eg
delete table inet lsa_eg
table inet lsa_eg {
  chain input {
    type filter hook input priority filter - 10; policy accept;
    iifname "$nic" ct state established,related accept
    iifname "$nic" counter drop comment "LAN1 新入站一律丢（22 / 80 / 8554 …）"
  }
  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    iifname "$nic" ct state established,related accept
    iifname "$nic" counter drop comment "LAN1 进 Docker 发布端口的也丢"
  }
}
EOF
  cat > "$FW_UNIT" <<EOF
[Unit]
Description=LSA-9600EG：摄像机网 LAN1 只出不进（nftables 表 inet lsa_eg）
Before=network-pre.target docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $FW_NFT
ExecStop=/usr/sbin/nft delete table inet lsa_eg

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable lsa-eg-fw.service >/dev/null 2>&1
  systemctl restart lsa-eg-fw.service
  nft list table inet lsa_eg >/dev/null 2>&1 && echo "LAN1 防火墙已开：摄像机网 $nic 只出不进（22 / 80 / 8554 从 $nic 都连不上；EG 主动拉摄像机照常）" ||
    echo "!! LAN1 防火墙没加载上（systemctl status lsa-eg-fw）" >&2
}
fw_remove() {
  if [ -f "$FW_UNIT" ]; then systemctl disable --now lsa-eg-fw.service >/dev/null 2>&1 || true; rm -f "$FW_UNIT"; systemctl daemon-reload; fi
  rm -f "$FW_NFT"
  if command -v nft >/dev/null 2>&1; then nft delete table inet lsa_eg 2>/dev/null || true; fi
  true
}

# ---------- 软件看门狗（I13） ----------
# X26A 没有硬件看门狗：系统卡死（内核或 systemd 不响应）时没人重启它。systemd 每 RuntimeWatchdogSec / 2 喂一次 /dev/watchdog，
# 卡死超过 RuntimeWatchdogSec 没喂，softdog 就重启整机；关机 / 重启卡住超过 RebootWatchdogSec 也强制重启。来电自启与 RTC 已有。
# 有硬件看门狗（/sys/class/watchdog/*/identity 不是 Software Watchdog）就直接用它，不加载 softdog。
WD_MOD=/etc/modules-load.d/lsa-eg-softdog.conf
WD_SD=/etc/systemd/system.conf.d/lsa-eg-watchdog.conf
wd_status() {
  if [ "$(id -u)" != 0 ]; then echo "看门狗：要 sudo 才看得到"; return 0; fi
  local dev='' rt
  for d in /sys/class/watchdog/watchdog*; do [ -e "$d/identity" ] && { dev="$(cat "$d/identity")"; break; }; done
  rt="$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || true)"
  if [ -f "$WD_SD" ] && [ -n "$dev" ] && [ -n "$rt" ] && [ "$rt" != 0 ] && [ "$rt" != infinity ]; then
    echo "看门狗：开（$dev；systemd 每 $rt 内没喂就重启）"
  elif grep -q '^EG_WATCHDOG=off' .env 2>/dev/null; then
    echo "看门狗：已关（--watchdog-off；系统卡死不会自动重启。打开：sudo bash install.sh --watchdog-on）"
  else
    echo "看门狗：没开（${dev:-没有看门狗设备}；重跑 sudo bash install.sh 会打开）"
  fi
}
wd_apply() {
  local hw='' d
  for d in /sys/class/watchdog/watchdog*; do
    [ -e "$d/identity" ] && [ "$(cat "$d/identity")" != 'Software Watchdog' ] && hw="$(cat "$d/identity")"
  done
  if [ -z "$hw" ]; then
    if ! modprobe softdog 2>/dev/null; then echo '!! 加载不了 softdog 内核模块：系统卡死时不会自动重启' >&2; return 0; fi
    echo softdog > "$WD_MOD"
  else
    rm -f "$WD_MOD"
  fi
  mkdir -p "$(dirname "$WD_SD")"
  cat > "$WD_SD" <<'EOF'
# LSA-9600EG（install.sh 写）：systemd 喂看门狗，系统卡死 60 s 没喂就重启整机；关机 / 重启卡住 10 min 也强制重启。
# 不要手改，重跑 install.sh 会重写；关掉用 sudo bash install.sh --watchdog-off
[Manager]
RuntimeWatchdogSec=60s
RebootWatchdogSec=10min
EOF
  systemctl daemon-reexec
  echo "看门狗已开：${hw:-softdog（软件看门狗）}，系统卡死 60 s 自动重启"
}
wd_remove() {
  local had=0
  [ -f "$WD_SD" ] && { rm -f "$WD_SD"; had=1; }
  rm -f "$WD_MOD"
  # systemd 关掉看门狗时会正常关闭设备（写 magic close），之后才能卸 softdog
  [ "$had" = 1 ] && systemctl daemon-reexec
  modprobe -r softdog 2>/dev/null || true
  true
}

# ---------- 串口（转换程序用，EG 0.5.1） ----------
# 可选的 485 口：真串口 ttyS*（/sys/class/tty 下有 device，且 UART 类型 type 不是 0 —— 没有硬件的 ttyS 也有 device 链接，
# 只是 type 为 0，Hyper-V 虚拟机上 32 个全是这样）；USB 转 485 列 /dev/serial/by-id 的稳定名字与它现在指向的设备，
# 没有 by-id 的 ttyUSB / ttyACM 单列并提醒（芯片没有序列号，重启或多插 USB 设备后号可能变）
serial_list() {
  local t n ty l d found
  for t in /sys/class/tty/ttyS*; do
    [ -e "$t/device" ] || continue
    ty="$(cat "$t/type" 2>/dev/null || echo 0)"
    [ "$ty" != 0 ] && echo "  /dev/$(basename "$t")（真串口，UART 类型 $ty）"
  done
  for l in /dev/serial/by-id/*; do
    [ -e "$l" ] && echo "  $l → $(readlink -f "$l")"
  done
  for d in /dev/ttyUSB* /dev/ttyACM*; do
    [ -e "$d" ] || continue
    found=''
    for l in /dev/serial/by-id/*; do [ "$(readlink -f "$l" 2>/dev/null || true)" = "$d" ] && found=1; done
    [ -n "$found" ] || echo "  $d（没有 by-id 名字：芯片没有序列号，重启后设备号可能变，建议换带序列号的模块）"
  done
  true
}
# ttyUSB / ttyACM 换成指向它的 /dev/serial/by-id 名字（找不到原样返回）
serial_byid() {
  local l real
  real="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$real" in /dev/ttyUSB* | /dev/ttyACM*) ;; *) echo "$1"; return 0 ;; esac
  for l in /dev/serial/by-id/*; do
    [ -e "$l" ] || continue
    case "$l" in *:* | *'#'* | *' '*) continue ;; esac
    if [ "$(readlink -f "$l")" = "$real" ]; then echo "$l"; return 0; fi
  done
  echo "$1"
}
conv_status() {
  local ser state
  ser="$(grep -E '^EG_CONV_SERIAL=' .env 2>/dev/null | cut -d= -f2- || true)"; ser="${ser:-/dev/ttyS1}"
  state='没启用'
  grep -q '^COMPOSE_PROFILES=conv' .env 2>/dev/null && state='启用'
  grep -q '^EG_CONV=off' .env 2>/dev/null && state='已关（--conv-off）'
  echo "转换程序：$state；串口 $ser$([ -e "$ser" ] && [ -L "$ser" ] && echo "（→ $(readlink -f "$ser")）")$([ -e "$ser" ] || echo '（不存在）')"
  # 0.17 转换程序保险（eg-agent）：自动重启过的话说出来
  if [ -f config/conv-guard.json ]; then
    local n last
    n="$(sed -n 's/.*"restarts":\([0-9]*\).*/\1/p' config/conv-guard.json)"
    last="$(sed -n 's/.*"detail":"\([^"]*\)".*/\1/p' config/conv-guard.json)"
    [ "${n:-0}" -gt 0 ] 2>/dev/null && echo "  eg-agent 自动重启过转换程序 $n 次；最近一次：${last:-?}"
  fi
  echo "可选串口（--conv-serial <设备>）："
  serial_list
}

# 0.17 上送子站被拒（eg-agent 写 config/uplink-state.json：CONNACK 码与原因；连上后清空）
uplink_status() {
  [ -f config/uplink-state.json ] || return 0
  grep -q '"refused":null' config/uplink-state.json && return 0
  local code reason count
  code="$(sed -n 's/.*"code":\([0-9]*\).*/\1/p' config/uplink-state.json)"
  reason="$(sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' config/uplink-state.json)"
  count="$(sed -n 's/.*"count":\([0-9]*\).*/\1/p' config/uplink-state.json)"
  [ -n "$code" ] || return 0
  echo "!! 子站拒绝上送连接：CONNACK $code ${reason:-?}（连续 ${count:-?} 次；eg-agent 在退避重试，最长每 60 s 一次）" >&2
  case "$code" in 4|5|134|135) echo "   查 config/eg.yaml 的 station.token 与子站上这台 EG 的设备 / 令牌" >&2 ;; esac
}

status() {
  $DC ps --format 'table {{.Name}}\t{{.Status}}'
  [ -f .installed/VERSION ] && echo "已装版本：$(cat .installed/VERSION)"
  [ -f .previous/VERSION ] && echo "可回退到：$(cat .previous/VERSION)"
  local tbv bk
  tbv="$(tb_db_version)"
  [[ "$tbv" =~ ^[0-9]+$ ]] && echo "本地 TB：$(tb_num_ver "$tbv")"
  bk="$(ls -1t "$TB_BACKUPS"/tb-*.dump 2>/dev/null | head -1 || true)"
  [ -n "$bk" ] && echo "本地库备份（补丁升级前）：$bk —— 回到旧版 TB 用 --rollback --restore-tb"
  fw_status
  wd_status
  conv_status
  uplink_status
  true
}
# 安全提醒（只提醒，不改系统配置：自动关 SSH 口令登录可能把维护人员锁在外面）
security_notes() {
  local msg=()
  [ -f config/initial-password.txt ] && msg+=('本地维护账号 maint 的初始口令文件还在（config/initial-password.txt）：登录管理页改掉口令后删除它')
  id lsa-sp >/dev/null 2>&1 && msg+=('隧道账号 lsa-sp 还在：子站 provision-eg.sh 跑完后可删 —— sudo bash install.sh --drop-sp-key（以后要再建实体重新 --sp-key）')
  if command -v sshd >/dev/null 2>&1 && sshd -T 2>/dev/null | grep -x 'passwordauthentication yes' >/dev/null; then  # 不用 -q：提前退出会让 sshd 收 SIGPIPE，pipefail 下判成假
    msg+=('SSH 允许口令登录：维护账号改用密钥登录后建议关掉（/etc/ssh/sshd_config.d/ 下写 PasswordAuthentication no，再 systemctl reload ssh）')
  fi
  grep -q '^EG_PASSIVE=.' .env 2>/dev/null && msg+=('.env 里有 EG_PASSIVE：那是开发用的旁观模式，现场要删掉')
  if grep -q '^EG_LAN1=.' .env 2>/dev/null && [ "$(id -u)" = 0 ] && ! nft list table inet lsa_eg >/dev/null 2>&1; then
    msg+=('LAN1 防火墙没开：摄像机网上 22 / 80 / 8554 都能连（只有管理页 403）—— sudo bash install.sh --fw-on')
  fi
  [ "${#msg[@]}" -gt 0 ] || return 0
  echo
  echo '安全提醒：'
  local m
  for m in "${msg[@]}"; do echo "  - $m"; done
}
[ "$MODE" = 'status' ] && { status; security_notes; exit 0; }
[ "$(id -u)" = 0 ] || { echo '要用 sudo 跑' >&2; exit 1; }
if [ "$MODE" = 'drop-sp' ]; then
  if id lsa-sp >/dev/null 2>&1; then
    pkill -u lsa-sp 2>/dev/null || true   # 子站隧道正开着的话断掉
    userdel -r lsa-sp 2>/dev/null || userdel lsa-sp
    echo '已删除隧道账号 lsa-sp（以后要让子站再建本地实体：sudo bash install.sh --sp-key <子站公钥>）'
  else
    echo '没有隧道账号 lsa-sp，不用删'
  fi
  exit 0
fi

# .env 里设一项（有就改、没有就加）
env_set() {
  if grep -q "^$1=" .env 2>/dev/null; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi
}
if [ "$MODE" = 'fw-off' ]; then
  fw_remove; env_set EG_LAN1_FW off
  echo 'LAN1 防火墙已关并记住（以后重跑 install.sh 也不再加；要重新打开：sudo bash install.sh --fw-on）'
  exit 0
fi
if [ "$MODE" = 'wd-off' ]; then
  wd_remove; env_set EG_WATCHDOG off
  echo '看门狗已关并记住（系统卡死不会自动重启；以后重跑 install.sh 也不再开；要重新打开：sudo bash install.sh --watchdog-on）'
  exit 0
fi
if [ "$MODE" = 'wd-on' ]; then
  env_set EG_WATCHDOG on; wd_apply; exit 0
fi
if [ "$MODE" = 'fw-on' ]; then
  nic="$(grep -E '^EG_LAN1=' .env 2>/dev/null | cut -d= -f2- || true)"
  [ -n "$nic" ] || { echo '没给过 --lan1，不知道哪个是摄像机网口：sudo bash install.sh --lan1 <网口>' >&2; exit 1; }
  env_set EG_LAN1_FW on; fw_apply "$nic"; exit 0
fi
# 本地 TB 的版本（compose.yaml 里 tb-node 的缺省标签）
tb_version() { grep -o 'tb-node:\${TB_VERSION:-[^}]*}' "$1" | head -1 | sed 's/.*:-//; s/}//'; }
# TB 版本号 ↔ 库里 tb_schema_settings.schema_version 的数字（4.2.2.6 ↔ 4002002006；与子站 scripts/up.sh 同）
tb_ver_num() {
  local v="${1%%-*}" a b c d
  IFS=. read -r a b c d <<< "$v" || true
  echo $(( ${a:-0} * 1000000000 + 10#${b:-0} * 1000000 + 10#${c:-0} * 1000 + 10#${d:-0} ))
}
tb_num_ver() { local n="$1"; echo "$((n / 1000000000)).$((n / 1000000 % 1000)).$((n / 1000 % 1000)).$((n % 1000))"; }
tb_db_version() { $DC exec -T postgres psql -U postgres -d thingsboard -tAc 'select schema_version from tb_schema_settings limit 1' 2>/dev/null | tr -d '[:space:]' || true; }
# 补丁升级前的本地库备份（含遥测，pg_dump 自定义格式）：只留最近一份 —— 回退只回一步
TB_BACKUPS=backups
tb_backup() {  # $1 = 库里现在的版本（数字）
  local from f need avail
  from="$(tb_num_ver "$1")"
  mkdir -p "$TB_BACKUPS" && chmod 700 "$TB_BACKUPS"
  f="$TB_BACKUPS/tb-$from-$(date +%Y%m%d-%H%M%S).dump"
  need="$($DC exec -T postgres psql -U postgres -d thingsboard -tAc 'select pg_database_size(current_database())' | tr -d '[:space:]' || true)"
  avail="$(df -PB1 "$TB_BACKUPS" | awk 'NR==2{print $4}')"
  # 自定义格式是压缩的，通常是库大小的几分之一；按库大小留足，宁可多要
  if [ "${need:-0}" -gt "${avail:-0}" ]; then
    echo "✗ 本地 TB 升级前要备份本地库（约 $(( ${need:-0} / 1048576 )) MB），$(pwd -P)/$TB_BACKUPS 所在盘只剩 $(( ${avail:-0} / 1048576 )) MB。" >&2
    echo "  先腾空间（sudo bash diskcheck.sh 看各部分占用）再跑；确实不要备份加 --no-tb-backup（那样回不去旧版 TB）" >&2
    return 1
  fi
  echo "先备份本地 TB 的库（含遥测，约 $(( ${need:-0} / 1048576 )) MB）→ $f ..."
  if ! $DC exec -T postgres pg_dump -U postgres -Fc thingsboard > "$f.part"; then
    rm -f "$f.part"
    echo '✗ 本地库备份失败，没有升级本地 TB（上面是 pg_dump 的报错）' >&2
    return 1
  fi
  mv "$f.part" "$f"
  find "$TB_BACKUPS" -maxdepth 1 -name 'tb-*.dump' ! -name "$(basename "$f")" -delete
  echo "✓ 备份好了：$f（$(( $(stat -c %s "$f") / 1048576 )) MB）"
}
# 用备份恢复本地库（回退到旧版 TB 时）：停 TB → 删库重建 → pg_restore。备份之后本地 TB 新写的数据会丢（子站那边是全的）
tb_restore() {  # $1 = 备份文件
  echo "停本地 TB，用 $1 恢复本地库 ..."
  $DC stop tb >/dev/null
  $DC exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qc 'drop database if exists thingsboard with (force)' -c 'create database thingsboard'
  $DC exec -T postgres pg_restore -U postgres -d thingsboard --no-owner < "$1"
  echo "✓ 本地库已恢复（库里记的版本 $(tb_num_ver "$(tb_db_version)")）"
}
# 部署文件（升级时整个发布件覆盖过来的那些）
DEPLOY_FILES='compose.yaml mosquitto.conf install.sh diskcheck.sh VERSION IMAGES.txt extensions CONV_IMAGE.txt'

# ---------- 转换程序（I11）：镜像在、串口在才启用 conv 服务 ----------
conv_setup() {
  local img='' ser
  # grep 没匹配时返回 1：set -e + pipefail 下赋值语句会让整个 install.sh 悄悄退出（0.4.0 在 0.13 验收里踩到：.env 里还没有 EG_CONV_SERIAL）—— 都加 || true
  [ -f CONV_IMAGE.txt ] && img="$(grep -v '^#' CONV_IMAGE.txt | head -1 | tr -d '[:space:]' || true)"
  [ -n "$CONV_SERIAL" ] && env_set EG_CONV_SERIAL "$CONV_SERIAL"
  ser="$(grep -E '^EG_CONV_SERIAL=' .env 2>/dev/null | cut -d= -f2- || true)"; ser="${ser:-/dev/ttyS1}"
  # USB 转 485（ttyUSB / ttyACM）换成 /dev/serial/by-id 的稳定名字记住：ttyUSB 号在重启、多插 USB 设备后可能变（EG 0.5.1）；
  # Docker 每次起容器时把它解析成当时的实际设备
  case "$ser" in
    /dev/ttyUSB* | /dev/ttyACM*)
      local byid
      byid="$(serial_byid "$ser")"
      if [ "$byid" != "$ser" ]; then
        echo "串口 $ser 改记成稳定路径 $byid（ttyUSB 号在重启、多插 USB 设备后可能变）"
        ser="$byid"
        env_set EG_CONV_SERIAL "$ser"
      elif [ -e "$ser" ]; then
        echo "!! 提醒：$ser 在 /dev/serial/by-id 下没有对应的名字 —— 芯片没有序列号，重启后设备号可能变，建议换带序列号的模块（部署手册 §2a）" >&2
      fi ;;
  esac
  local off=''
  if [ -z "$img" ]; then off='发布件里没有转换程序镜像（按同事自己的方式部署，连 127.0.0.1:1884 就行）'
  elif grep -q '^EG_CONV=off' .env 2>/dev/null; then off='已关（--conv-off；打开：sudo bash install.sh --conv-on）'
  elif ! docker image inspect "$img" >/dev/null 2>&1; then off="!! 发布件说有镜像 $img，但本机没有（导入失败？）"
  elif [ ! -e "$ser" ]; then off="!! 串口 $ser 不存在：样机没有 485 时用 USB 转 485 —— sudo bash install.sh --conv-serial /dev/ttyUSB0（可选的见下）"
  fi
  if [ -n "$off" ]; then
    env_set COMPOSE_PROFILES ''
    docker rm -f lsa-eg-conv >/dev/null 2>&1 || true
    echo "转换程序：不起 —— $off"
    case "$off" in *串口*) echo '可选串口：'; serial_list ;; esac
    return 0
  fi
  env_set EG_CONV_IMAGE "$img"
  env_set EG_CONV_SERIAL "$ser"
  env_set EG_DIALOUT_GID "$(getent group dialout | cut -d: -f3)"
  env_set COMPOSE_PROFILES conv
  mkdir -p config/conv config/conv-data
  echo "转换程序：$img，串口 $ser（容器里 /dev/ttyS1），连本机总线 127.0.0.1:1884"
}
if [ "$MODE" = 'conv-off' ]; then
  env_set EG_CONV off; conv_setup; exit 0
fi
if [ "$MODE" = 'conv-on' ]; then
  env_set EG_CONV on; conv_setup
  grep -q '^COMPOSE_PROFILES=conv' .env && $DC up -d conv
  exit 0
fi

# ---------- 回退 ----------
if [ "$MODE" = 'rollback' ]; then
  [ -f .previous/VERSION ] || { echo '没有上一个版本可回退（.previous/ 不存在）' >&2; exit 1; }
  prev="$(cat .previous/VERSION)"
  docker image inspect "lsa-eg-app:$prev" >/dev/null 2>&1 || { echo "本机没有镜像 lsa-eg-app:$prev（被清掉了？）" >&2; exit 1; }
  # 本地 TB 版本不同（0.17 起同一补丁线可以升）：看库里记的版本 ——
  #   库 = 要回到的版本（新版 TB 没起来过 / 没补库）：直接回；
  #   库比要回到的新（已补成新版，往旧版回）：旧 TB 起不来（库只升不降），要用升级前的备份恢复（--restore-tb）；
  #   库比要回到的旧（回退之后再 --rollback 回新版）：同升级 —— 先备份、换镜像起、等库里版本变过来
  prev_tb="$(tb_version .previous/compose.yaml)"
  TB_PATCH=''
  if [ "$prev_tb" != "$(tb_version compose.yaml)" ]; then
    $DC up -d --wait postgres >/dev/null 2>&1
    have="$(tb_db_version)"
    want="$(tb_ver_num "$prev_tb")"
    if [[ "$have" =~ ^[0-9]+$ ]] && [ $((have / 1000)) != $((want / 1000)) ]; then
      echo "✗ 本地 TB 的库是 $(tb_num_ver "$have")，$prev 用的是 $prev_tb：跨了小版本，不能这样回退" >&2
      exit 1
    elif [[ "$have" =~ ^[0-9]+$ ]] && [ "$have" -lt "$want" ]; then
      echo "本地 TB 从 $(tb_num_ver "$have") 回到 $prev 的 $prev_tb：同一补丁线，换镜像起（TB 启动时自己补数据）"
      if [ "$TB_BACKUP" = 1 ]; then tb_backup "$have" || exit 1; fi
      TB_PATCH="$want"
    elif [ "$have" != "$want" ]; then
      bk="$(ls -1t "$TB_BACKUPS"/tb-"$prev_tb"-*.dump 2>/dev/null | head -1 || true)"
      docker image inspect "thingsboard/tb-node:$prev_tb" >/dev/null 2>&1 || { echo "✗ 本机没有旧版 TB 镜像 thingsboard/tb-node:$prev_tb，回不去" >&2; exit 1; }
      if [ -z "$bk" ]; then
        echo "✗ 本地 TB 的库已是 $(tb_num_ver "${have:-0}")，$prev 用的是 $prev_tb：要用升级前的本地库备份恢复，但 $TB_BACKUPS/ 里没有 tb-$prev_tb-*.dump（升级时加了 --no-tb-backup？）" >&2
        exit 1
      fi
      if [ "$RESTORE_TB" != 1 ]; then
        echo "本地 TB 的库已是 $(tb_num_ver "${have:-0}")，回到 $prev（TB $prev_tb）要用升级前的备份恢复本地库：$bk" >&2
        echo "  备份之后本地 TB 新写的遥测、告警会丢（子站那边是全的，本地页近期曲线会缺这一段）。" >&2
        echo "  确认就跑：sudo bash install.sh --rollback --restore-tb" >&2
        exit 1
      fi
      tb_restore "$bk"
      [ "$(tb_db_version)" = "$want" ] || { echo "✗ 恢复后库里记的版本是 $(tb_num_ver "$(tb_db_version)")，不是 $prev_tb" >&2; exit 1; }
    else
      echo "本地 TB 的库还是 $prev_tb（新版 TB 没补过库）：直接回退"
    fi
  fi
  echo "回退到 $prev ..."
  rm -rf .rollback-tmp && mkdir .rollback-tmp
  for f in $DEPLOY_FILES; do [ -e "$f" ] && cp -a "$f" .rollback-tmp/; done
  for f in $DEPLOY_FILES; do [ -e ".previous/$f" ] && { rm -rf "$f"; cp -a ".previous/$f" .; }; done
  [ -e .previous/CONV_IMAGE.txt ] || rm -f CONV_IMAGE.txt
  env_set EG_APP_IMAGE "lsa-eg-app:$prev"
  conv_setup
  $DC up -d --remove-orphans
  if [ -n "$TB_PATCH" ]; then
    $DC up -d --wait tb
    for _ in $(seq 1 40); do [ "$(tb_db_version)" = "$TB_PATCH" ] && break; sleep 3; done
    [ "$(tb_db_version)" = "$TB_PATCH" ] || { echo "✗ 本地 TB 已换成 $prev_tb，但库里记的还是 $(tb_num_ver "$(tb_db_version)")：docker logs lsa-eg-tb | grep -i SystemPatchApplier" >&2; exit 1; }
    echo "✓ 本地 TB 的库已升到 $prev_tb"
  fi
  rm -rf .installed && mv .previous .installed && mv .rollback-tmp .previous
  # 回到的版本不管 LAN1 防火墙（早于它）：把规则清掉，与那个版本一致；它也管的话留着
  grep -q 'lsa-eg-fw' install.sh || { fw_remove; echo '（回到的版本不管 LAN1 防火墙，规则已清掉）'; }
  grep -q 'lsa-eg-watchdog' install.sh || { wd_remove; echo '（回到的版本不管看门狗，已关掉）'; }
  echo; status
  exit 0
fi

# ---------- 0. 系统：只支持 Ubuntu Server 24.04 ----------
os_id="$( . /etc/os-release 2>/dev/null; echo "${ID:-?}" )"
os_ver="$( . /etc/os-release 2>/dev/null; echo "${VERSION_ID:-?}" )"
os_name="$( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-未知系统}" )"
if [ "$os_id" != ubuntu ] || [ "$os_ver" != 24.04 ]; then
  echo "!! 本机系统是「$os_name」。EG 只支持 Ubuntu Server 24.04 LTS：发布件里的离线包（Docker、chrony 等）按 24.04 做，别的系统装不上。" >&2
  echo "   X26A 出厂是 Ubuntu 22.04 桌面版：请先按《EG 部署手册》§2a「改装 Ubuntu Server 24.04」改装，再跑本脚本。" >&2
  exit 1
fi

# ---------- 1. Docker 与 chrony（没有就装发布件里的离线包） ----------
if ! command -v docker >/dev/null || ! command -v chronyd >/dev/null; then
  ls debs/*.deb >/dev/null 2>&1 || { echo '没有 docker / chrony，发布件里也没有离线包 debs/（pack:eg -- --debs）' >&2; exit 1; }
  echo '装离线包（Docker、chrony）...'
  # 与 chrony 冲突的 systemd-timesyncd 先卸（卸载不用联网）；再 dpkg 一次装全部（同一批里自己排依赖顺序）。
  # 不用 apt-get install ./debs/*.deb：机器上留着装系统时的软件源索引时，apt 会拿索引里的记录去找包（虚拟样机上报「Pathname to install is not absolute」）
  installed() { dpkg-query -W -f '${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
  if installed systemd-timesyncd; then DEBIAN_FRONTEND=noninteractive apt-get remove -y systemd-timesyncd; fi
  # 只装本机没有、或比本机新的（debs/ 是在干净容器里下的，比服务器版多出的那些不重装、不降级）
  todo=()
  for d in debs/*.deb; do
    pkg="$(dpkg-deb -f "$d" Package)"; ver="$(dpkg-deb -f "$d" Version)"
    cur="$(dpkg-query -W -f '${Status} ${Version}' "$pkg" 2>/dev/null | awk '$3=="installed"{print $4}' || true)"
    if [ -z "$cur" ] || dpkg --compare-versions "$ver" gt "$cur"; then todo+=("$d"); fi
  done
  [ ${#todo[@]} -eq 0 ] || DEBIAN_FRONTEND=noninteractive dpkg -i "${todo[@]}"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
$DC version >/dev/null 2>&1 || { echo '没有 docker compose 插件' >&2; exit 1; }

# 系统日志封顶（容器日志在 compose.yaml 里各自 10 MB × 3）
if [ ! -f /etc/systemd/journald.conf.d/lsa-eg.conf ]; then
  mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nSystemMaxUse=200M\nSystemMaxFileSize=20M\n' > /etc/systemd/journald.conf.d/lsa-eg.conf
  systemctl restart systemd-journald || true
fi

# ---------- 2. 版本切换：上一次装好的留作回退 ----------
VERSION="$(cat VERSION 2>/dev/null || echo latest)"
if [ -f .installed/VERSION ] && [ "$(cat .installed/VERSION)" != "$VERSION" ]; then
  echo "升级：$(cat .installed/VERSION) → $VERSION（旧版留作回退：install.sh --rollback）"
  rm -rf .previous && mv .installed .previous
fi

# ---------- 3. 镜像（离线） ----------
# 本机镜像与 IMAGES.txt 逐个对得上（tag 在、ID 一致）才算导入过：版本号没变、镜像变了（重打）时照样重导
images_ok() {
  local img id
  [ -f IMAGES.txt ] || return 1
  while read -r img _ id; do
    case "$img" in ''|'#'*) continue ;; esac
    [ "$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null || true)" = "$id" ] || return 1
  done < IMAGES.txt
}
for f in images-*.tar.gz; do
  [ -f "$f" ] || continue
  [ -f ".loaded-$f" ] && [ "$(cat ".loaded-$f")" = "$VERSION" ] && images_ok && continue
  echo "导入镜像 $f（几分钟）..."
  gunzip -c "$f" | docker load >/dev/null
  echo "$VERSION" > ".loaded-$f"
done
# 镜像清单（pack:eg 写的）逐个核对：tag 在、ID 对得上
if [ -f IMAGES.txt ]; then
  bad=0
  while read -r img _ id; do
    case "$img" in ''|'#'*) continue ;; esac
    got="$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null || echo 没有)"
    [ "$got" = "$id" ] || { echo "镜像 $img 不对：应为 $id，本机 $got" >&2; bad=1; }
  done < IMAGES.txt
  [ "$bad" = 0 ] || exit 1
fi

# ---------- 4. .env（本地库口令等，只生成一次） ----------
# 这台已经装在别的目录时拒绝：compose 项目名固定 lsa-eg、数据卷跟着项目名，在另一个目录跑会生成另一份 .env（新的本地库口令），
# 把正在跑的本地库 / TB 按新口令重建 → TB 连不上库反复重启（现场流程验收踩到）。升级要把新发布件拷进原目录再跑。
if [ ! -f .env ] && [ "$FORCE" != 1 ]; then
  old="$(docker inspect lsa-eg-postgres --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)"
  [ -z "$old" ] && [ -f /opt/lsa-eg/.env ] && old=/opt/lsa-eg
  if [ -n "$old" ] && [ "$(readlink -f "$old")" != "$(pwd -P)" ]; then
    echo "这台 EG 已经装在 $old（本地库口令在那里的 .env），不要在 $(pwd -P) 另装。" >&2
    echo "升级：sudo cp -a $(pwd -P)/. $old/ && sudo bash $old/install.sh，或用一键安装文件 --role eg。确实要另装加 --force" >&2
    exit 1
  fi
fi
if [ ! -f .env ]; then
  pg="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"   # sete-ok：head 在最前、定长读，不会 SIGPIPE
  cat > .env <<EOF
# 这台 EG 的本地配置（install.sh 生成）—— 含本地库口令，不外传
EG_PG_PASSWORD=$pg
EOF
  chmod 600 .env
  echo '已生成 .env'
fi
env_set EG_APP_IMAGE "lsa-eg-app:$VERSION"
sed -i '/^EG_AGENT_IMAGE=/d' .env
if [ -n "$LAN1" ]; then
  [ -e "/sys/class/net/$LAN1" ] || { echo "没有网口 $LAN1（本机：$(ls /sys/class/net | tr '\n' ' ')）" >&2; exit 1; }
  # 对外网口：物理网卡（有 device 链接），不算 lo、docker、网桥、veth
  nics=$(for n in /sys/class/net/*; do if [ -e "$n/device" ]; then basename "$n"; fi; done | wc -l)
  if [ "$nics" -le 1 ] && [ "$FORCE" != 1 ]; then
    echo "本机只有 $nics 个物理网口，--lan1 $LAN1 会把唯一的网口也挡掉（管理页谁都打不开）。单网口的机器不要给 --lan1；确实要这样加 --force" >&2
    exit 1
  fi
  env_set EG_LAN1 "$LAN1"
fi
grep -q '^EG_LAN1=.' .env || echo '（提示：没给 --lan1：管理页在摄像机网口上也能打开，只能靠防火墙挡）'
lan1_now="$(grep -E '^EG_LAN1=' .env | cut -d= -f2- || true)"
if [ -n "$lan1_now" ] && ! grep -q '^EG_LAN1_FW=off' .env; then fw_apply "$lan1_now"; fi
grep -q '^EG_WATCHDOG=off' .env || wd_apply
conv_setup
mkdir -p config/gateway/config config/mediamtx recordings

# ---------- 子站 provision-eg.sh 的隧道账号（--sp-key） ----------
if [ -n "$SPKEY" ]; then
  key="$SPKEY"; [ -f "$SPKEY" ] && key="$(head -1 "$SPKEY")"
  echo "$key" | grep -Eq '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) [A-Za-z0-9+/=]+' || { echo "--sp-key 不像 SSH 公钥：$key" >&2; exit 1; }
  id lsa-sp >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/lsa-sp --shell /usr/sbin/nologin lsa-sp
  install -d -m 700 -o lsa-sp -g lsa-sp /var/lib/lsa-sp/.ssh
  ak=/var/lib/lsa-sp/.ssh/authorized_keys
  touch "$ak"
  body="$(echo "$key" | awk '{print $1" "$2}')"
  if ! grep -qF "$body" "$ak"; then
    echo "restrict,port-forwarding,permitopen=\"127.0.0.1:18080\" $key" >> "$ak"
    echo "已给子站公钥授权：lsa-sp 只能开隧道到本机 127.0.0.1:18080"
  fi
  chown lsa-sp:lsa-sp "$ak"; chmod 600 "$ak"
fi

# ---------- 5. 本地 TB：库是空的先建库；已有库按版本判断（0.17：同一补丁线换镜像起，不跑升级脚本） ----------
$DC up -d --wait postgres
TB_PATCH=''
tb_want="$(tb_ver_num "$(tb_version compose.yaml)")"
if ! $DC exec -T postgres psql -U postgres -d thingsboard -tAc "select 1 from information_schema.tables where table_name='tb_user'" | grep -q 1; then
  echo '首次安装：建本地 TB 的库（约 1 分钟）...'
  $DC --profile install run --rm tb-install
else
  tb_have="$(tb_db_version)"
  if [[ "$tb_have" =~ ^[0-9]+$ ]] && [ "$tb_have" -gt "$tb_want" ]; then
    echo "✗ 本地 TB 的库是 $(tb_num_ver "$tb_have")，这个发布件的 TB 是 $(tb_version compose.yaml)，更旧：TB 不能降级。" >&2
    echo "  回到上一个版本用 sudo bash install.sh --rollback（会提示怎么用升级前的备份恢复）" >&2
    exit 1
  elif [[ "$tb_have" =~ ^[0-9]+$ ]] && [ "$tb_have" -lt "$tb_want" ] && [ $((tb_have / 1000)) != $((tb_want / 1000)) ]; then
    echo "✗ 本地 TB 的库是 $(tb_num_ver "$tb_have")，这个发布件的 TB 是 $(tb_version compose.yaml)：跨了小版本，本发布件只做同一补丁线的升级（不跑 TB 的库升级脚本）。" >&2
    echo "  这台先回到上一个版本：sudo bash install.sh --rollback" >&2
    exit 1
  elif [[ "$tb_have" =~ ^[0-9]+$ ]] && [ "$tb_have" -lt "$tb_want" ]; then
    TB_PATCH="$tb_want"
    echo "本地 TB 从 $(tb_num_ver "$tb_have") 升到 $(tb_version compose.yaml)：同一补丁线，不跑升级脚本，换镜像起（TB 启动时自己补数据）"
    if [ "$TB_BACKUP" = 1 ]; then tb_backup "$tb_have" || exit 1
    else echo "！ --no-tb-backup：没备份本地库，补库后回不去 $(tb_num_ver "$tb_have")" >&2; fi
  fi
fi
$DC up -d mosquitto tb
echo '等本地 TB 起来（首次约 1–2 分钟）...'
$DC up -d --wait tb
if [ -n "$TB_PATCH" ]; then
  # 同一补丁线：新 TB 起来后自己把库里的版本记成新的（日志 SystemPatchApplier「Version increased from …」），等它一会儿
  for _ in $(seq 1 40); do [ "$(tb_db_version)" = "$TB_PATCH" ] && break; sleep 3; done
  tb_now="$(tb_db_version)"
  if [ "$tb_now" != "$TB_PATCH" ]; then
    echo "✗ 本地 TB 已换成 $(tb_version compose.yaml)，但库里记的还是 $(tb_num_ver "${tb_now:-0}")：docker logs lsa-eg-tb | grep -i SystemPatchApplier 看原因" >&2
    echo "  回到上一个版本：sudo bash install.sh --rollback（库没变时直接回；变了会提示用备份恢复）" >&2
    exit 1
  fi
  echo "✓ 本地 TB 的库已升到 $(tb_num_ver "$tb_now")（补丁升级，TB 启动时自己补的）"
fi

# ---------- 6. eg.yaml 齐了（带本地 TB 账号 tb:）才起其余 ----------
if [ ! -f config/eg.yaml ] || ! grep -q '^tb:' config/eg.yaml; then
  cat <<EOF

本地 TB 已起。下一步（手册 §4）：
  1. 给子站授权开隧道（没给过的话）：把子站主机的 SSH 公钥拷过来，sudo bash install.sh --sp-key <公钥文件>
     （建只能转发到本机 18080 的账号 lsa-sp，没有 shell）
  2. 在子站主机上（/opt/lsa9600sp/lsa9600sp-backend）：
       scripts/provision-eg.sh --cabinet <柜号> --ssh lsa-sp@<这台 EG 的 LAN2 地址> [--ssh-key <私钥>] --hook http://host.docker.internal/hooks/alarm --sp <子站地址>
     可先加 --plan 只读核对一遍。它在容器里开隧道连这台 EG 的 127.0.0.1:18080，子站主机不用装 Node
  3. 在子站主机上出这台的配置包：scripts/pack-eg.sh --sp <子站地址> --only <柜号>
     → dist/eg/<柜号>/eg.yaml 与 sp-ca.pem（上送走 mqtts 8883）
  4. 把这两个文件拷到这里的 /opt/lsa-eg/config/（用维护账号，lsa-sp 拷不了文件），再跑一次 sudo bash install.sh
EOF
  exit 0
fi
[ -f config/sp-ca.pem ] || echo '（提示：config/ 里没有 sp-ca.pem —— 子站用自签证书时，上送与事件会因证书不受信而连不上）'

# 对时：chrony 跟子站主机（eg.yaml sp.host）
sp_host="$(awk '/^sp:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="host:"{gsub(/["'\'']/,"",$2);print $2;exit}' config/eg.yaml)"
if [ -n "$sp_host" ] && [ -d /etc/chrony ]; then
  mkdir -p /etc/chrony/sources.d
  echo "server $sp_host iburst prefer" > /etc/chrony/sources.d/lsa-eg.sources
  # X26A 没有 RTC 电池：断电后开机时钟是错的，子站又可能比 EG 晚起来 —— 缺省的 makestep 1 3 只在头 3 次更新里跳，
  # 之后差几分钟也只慢慢追（几小时），这期间子站下发配置 / 单点登录的票据会因时钟差被拒。改成任何时候差 > 1 s 就跳。
  # 要改 chrony.conf 本身那一行：conf.d 在文件开头被引入，后面的 makestep 1 3 会盖掉 conf.d 里写的（Ubuntu 24.04 实测）
  # chrony 不认行尾注释（「Too many arguments for makestep」，chronyd 起不来 —— 无 AVX 样机上踩到），说明写在上一行
  if grep -q '^makestep ' /etc/chrony/chrony.conf; then
    sed -i 's/^makestep .*/makestep 1 -1/' /etc/chrony/chrony.conf
  else
    echo 'makestep 1 -1' >> /etc/chrony/chrony.conf
  fi
  grep -q '^# LSA-9600EG makestep' /etc/chrony/chrony.conf ||
    sed -i '/^makestep /i # LSA-9600EG makestep：install.sh 改为 1 -1（没有 RTC 电池，差 > 1 s 随时跳到子站时间）' /etc/chrony/chrony.conf
  systemctl enable chrony >/dev/null 2>&1 || true
  systemctl restart chrony >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet chrony; then
    echo '!! chrony 没起来（sudo journalctl -u chrony 看原因）：这台 EG 不对时，时钟差 > 60 s 后子站下发配置、单点登录会被拒' >&2
  fi
fi

# 先生成 IoT Gateway 与 mediamtx 的配置（agent / video 每次启动也会生成；先生成一次，免得它们先起来拿默认配置）
RUN="$DC run --rm --no-deps"
$RUN agent node --import @swc-node/register/esm-register src/gateway/cli.ts
$RUN video node --import @swc-node/register/esm-register src/render.ts
$DC up -d --remove-orphans
# eg.yaml / sp-ca.pem 换过（改设备清单 §5b、换令牌、换证书）：compose 不看挂载文件的内容，镜像没变时容器不会重建，
# agent / video 还拿着旧配置（agentBootId 也不变，子站据它判断「重新部署过」）—— 跟上次装好时比，变了就重启这三个
# 没有 sp-ca.pem（开发用明文 MQTT）时 cat 返回 1，set -e + pipefail 下会悄悄退出：分开拼、缺的跳过
cfg_sum="$( { cat config/eg.yaml; cat config/sp-ca.pem 2>/dev/null || true; } | sha256sum | cut -c1-64)"
# 升级时 .installed 已挪成 .previous（上面第 2 步），就跟 .previous 里记的比 —— 不然每次升级都误报「变了」（0.11 验收发现）
# 新装、或从不记这个哈希的老版本升级时两个都没有：|| true，否则 set -e 下会悄悄退出（0.3.4 起的回归，0.13 验收里查出）
last_sum="$(cat .installed/config.sha256 2>/dev/null || cat .previous/config.sha256 2>/dev/null || true)"
if [ "$last_sum" != "$cfg_sum" ]; then
  echo "config/eg.yaml（或 sp-ca.pem）与上次装好时不同：重启 agent / video / gateway，读新配置"
  $DC restart agent video gateway >/dev/null
fi

# 装好了：部署文件留一份，下次升级时作回退用
rm -rf .installed && mkdir .installed
for f in $DEPLOY_FILES; do [ -e "$f" ] && cp -a "$f" .installed/; done
echo "$VERSION" > .installed/VERSION
echo "$cfg_sum" > .installed/config.sha256
# 更早的 lsa-eg-app 镜像（既不是现在的也不是可回退的）清掉
keep="lsa-eg-app:$VERSION lsa-eg-app:$(cat .previous/VERSION 2>/dev/null || echo -)"
for img in $(docker image ls lsa-eg-app --format '{{.Repository}}:{{.Tag}}'); do
  case " $keep " in *" $img "*) ;; *) docker image rm "$img" >/dev/null 2>&1 || true ;; esac
done

echo
status
echo
echo "装好了。本地管理页：http://<这台 EG 的 LAN2 地址>/（本地维护账号 maint，初始口令在 config/initial-password.txt，登录后改掉并删掉这个文件）"
echo "磁盘容量 / 写入量：sudo bash diskcheck.sh"
security_notes
