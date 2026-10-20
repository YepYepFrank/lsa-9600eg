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
# --upgrade-key <子站公钥文件或公钥串> [--upgrade-from <子站地址>]（0.17.2）：给子站 upgrade-egs.sh 批量升级授权。
#   建专用账号 lsa-upg（锁口令），authorized_keys 带 restrict,from="<子站地址>",command="sudo -n /usr/local/sbin/lsa-eg-upgrade …"：
#   不管子站发什么都只进升级入口（只能交安装文件、开始升级、查进度，见 lsa-eg-upgrade 开头）；sudoers 只放行这个入口。
#   子站地址缺省取 eg.yaml 的 station.mqtt。注意：持这把 key 的人能让 EG 装他给的任意安装文件（等于 root），不用时撤销。
# --drop-upgrade-key：删掉 lsa-upg、它的 key 与 sudoers 条目、升级入口（升级日志 /var/log/lsa-upg.log 留着）。
# --join-key '<子站 join-egs.sh --keygen 打印的一行>'（0.17.4 一键加柜）：等于 --sp-key 加 --upgrade-key，两把 key 的 from= 都锁到子站地址；
#   记 config/join.json。还没有 eg.yaml 时是「待接入」：起只读的待接入页（80 口，各网口 IP / MAC、授权的子站），等子站 join-egs.sh。
#   已接入别的子站时拒绝，要加 --force 才换。格式：LSAJOIN1 <子站地址> <隧道公钥> <升级公钥> <校验（前面内容 sha256 的前 8 位）>
# 给过 --lan1 时同时加 LAN1 防火墙（nftables 表 inet lsa_eg：摄像机网只出不进，22 / 80 / 8554 都连不上，开机自起）；
#   --fw-off 关掉并记住，--fw-on 重新打开；--status 显示它；回退到不管它的老版本时自动清掉。
# 摄像机对时（0.7.x，S19）：缺省给 LAN1 上的摄像机当 NTP 服务器 —— chrony allow LAN1 网段，防火墙只对 local.yaml 里的摄像机地址放行 UDP 123；
#   --cam-ntp-off 关掉并记住，--cam-ntp-on 重新打开（改了摄像机地址也用它重新放行）；--status 显示它。摄像机那边把 NTP 服务器设成 EG 的 LAN1 地址
# 软件看门狗（I13，X26A 没有硬件看门狗）：装时启用 softdog + systemd RuntimeWatchdogSec（系统卡死 60 s 没喂狗就重启）；
#   --watchdog-off 关掉并记住，--watchdog-on 重新打开；--status 显示它。本机有硬件看门狗时直接用它、不加载 softdog。
# 转换程序（EG 0.6.2 起只走 install-conv.sh 这一套）：发布件带它的镜像（CONV_IMAGE.txt、images-conv.tar.gz），install.sh 只负责导入，缺省不启用；
#   现场用 sudo bash install-conv.sh 启用（生成配置、选串口、起、停、诊断，见硬件联调步骤）。启用过的，升级 / 回退时换成新镜像接着跑。
#   老参数 --conv-on / --conv-off / --conv-serial <设备> 转给 install-conv.sh（同 install-conv.sh / --off / --serial）。
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
JOINKEY=''
UPGKEY=''
UPGFROM=''
MODE='install'
FORCE=0
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
    --upgrade-key) UPGKEY="${2:?--upgrade-key 后面给子站的升级公钥（文件或公钥串）}"; MODE='upg-key'; shift ;;
    --upgrade-from) UPGFROM="${2:?--upgrade-from 后面给子站地址（多个用逗号分开）}"; shift ;;
    --drop-upgrade-key) MODE='drop-upg' ;;
    --join-key) JOINKEY="${2:?--join-key 后面给子站 join-egs.sh --keygen 打印的那一行}"; shift ;;
    --fw-off) MODE='fw-off' ;;
    --fw-on) MODE='fw-on' ;;
    --cam-ntp-off) MODE='cam-ntp-off' ;;
    --cam-ntp-on) MODE='cam-ntp-on' ;;
    --watchdog-off) MODE='wd-off' ;;
    --watchdog-on) MODE='wd-on' ;;
    # 0.6.2：转换程序只走 install-conv.sh
    --conv-serial) exec bash ./install-conv.sh --serial "${2:?--conv-serial 后面给串口设备，如 /dev/ttyUSB0}" ;;
    --conv-off) exec bash ./install-conv.sh --off ;;
    --conv-on) exec bash ./install-conv.sh ;;
    --restore-tb) RESTORE_TB=1 ;;
    --no-tb-backup) TB_BACKUP=0 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done

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
  local nic="$1" ntp='' h
  command -v nft >/dev/null 2>&1 || { echo "!! 没有 nft 命令：摄像机网 $nic 上只有管理页 403 这一道（装 nftables 后重跑）" >&2; return 0; }
  mkdir -p "$(dirname "$FW_NFT")"
  # 摄像机对时：只放行摄像机地址到本机 UDP 123（chronyd 在宿主机上，走 input）
  if cam_ntp_on; then
    for h in $(cam_hosts); do ntp+="    iifname \"$nic\" ip saddr $h udp dport 123 accept comment \"摄像机对时\""$'\n'; done
  fi
  cat > "$FW_NFT" <<EOF
#!/usr/sbin/nft -f
# LSA-9600EG（install.sh --lan1 写）：摄像机网 $nic 只出不进（摄像机对时的 UDP 123 例外）。不要手改，重跑 install.sh 会重写；关掉用 install.sh --fw-off
table inet lsa_eg
delete table inet lsa_eg
table inet lsa_eg {
  chain input {
    type filter hook input priority filter - 10; policy accept;
    iifname "$nic" ct state established,related accept
${ntp}    iifname "$nic" counter drop comment "LAN1 新入站一律丢（22 / 80 / 8554 …）"
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
# ---------- 摄像机对时（0.7.x，S19）：EG 在 LAN1 上给摄像机当 NTP 服务器 ----------
# 录像、抓拍画面上叠的 OSD 时间是摄像机自己的钟（出厂 1970 年）。EG 上送的测温、报警、录像分段、证据都用 EG 的钟，不受它影响 ——
# 对时只为证据画面上的时间跟子站一致。缺省开（.env EG_CAM_NTP=off 才关）：
#   chrony 对 LAN1 网段 allow，加 local stratum 12（EG 一时没对上子站也照常给时间：摄像机始终跟 EG 一致，EG 的钟才是证据的准）；
#   LAN1 防火墙只对摄像机地址（local.yaml camera 段里 restv1 / onvif / rtsp 的主机）放行 UDP 123
CAM_NTP_CONF=/etc/chrony/conf.d/lsa-eg-cam.conf
cam_ntp_on() { ! grep -q '^EG_CAM_NTP=off' .env 2>/dev/null; }
cam_hosts() {  # local.yaml camera 段里各地址的主机（只认 IPv4 字面地址），去重
  [ -f config/local.yaml ] || return 0
  awk '/^camera:/{f=1;next} f&&/^[^ ]/{f=0} f' config/local.yaml |
    grep -oE '(https?|rtsp)://([^/@ "]*@)?[0-9]{1,3}(\.[0-9]{1,3}){3}' | sed -E 's#^[a-z]+://([^@]*@)?##' | sort -u || true
}
lan1_cidr() {  # 网口的第一个 IPv4 → 网段（192.168.1.250/24 → 192.168.1.0/24）；没有地址为空
  local a p i n=0 m; local -a o
  a="$(ip -4 -o addr show dev "$1" 2>/dev/null | awk '{print $4; exit}' || true)"
  [ -n "$a" ] || return 0
  p="${a#*/}"; a="${a%/*}"
  IFS=. read -r -a o <<< "$a"
  for i in 0 1 2 3; do n=$(( (n << 8) | o[i] )); done
  m=$(( p == 0 ? 0 : (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF ))
  n=$(( n & m ))
  echo "$(( (n >> 24) & 255 )).$(( (n >> 16) & 255 )).$(( (n >> 8) & 255 )).$(( n & 255 ))/$p"
}
cam_ntp_apply() {  # $1 = LAN1 网口（空 = 没给过 --lan1）；改了 chrony 配置返回前不重启，调用方负责
  local nic="$1" cidr
  [ -d /etc/chrony ] || return 0
  if ! cam_ntp_on || [ -z "$nic" ]; then rm -f "$CAM_NTP_CONF"; return 0; fi
  cidr="$(lan1_cidr "$nic")"
  if [ -z "$cidr" ]; then
    rm -f "$CAM_NTP_CONF"; echo "（摄像机对时：LAN1 $nic 还没有 IPv4 地址，先不开；配好地址后重跑 sudo bash install.sh --cam-ntp-on）"; return 0
  fi
  mkdir -p /etc/chrony/conf.d
  printf '# LSA-9600EG（install.sh 写）：给 LAN1 上的摄像机对时。关掉：sudo bash install.sh --cam-ntp-off\nallow %s\nlocal stratum 12\n' "$cidr" > "$CAM_NTP_CONF"
}
cam_ntp_status() {
  local nic hosts
  nic="$(grep -E '^EG_LAN1=' .env 2>/dev/null | cut -d= -f2- || true)"
  if ! cam_ntp_on; then echo '摄像机对时：关（sudo bash install.sh --cam-ntp-on 打开）'; return 0; fi
  [ -n "$nic" ] || { echo '摄像机对时：没开（没给过 --lan1，不知道哪个是摄像机网口）'; return 0; }
  hosts="$(cam_hosts | tr '\n' ' ')"
  if [ ! -f "$CAM_NTP_CONF" ]; then
    # 待接入（还没有 eg.yaml）：install.sh 走不到对时那一步，接入子站后自动打开（0.7.1 改措辞，出厂手册 7.1 那一行）
    if [ ! -f config/eg.yaml ]; then
      echo "摄像机对时：待接入，接入子站后自动打开（LAN1 $nic${hosts:+；防火墙已为摄像机 ${hosts% } 放行}）"
    elif [ -z "$(lan1_cidr "$nic")" ]; then
      echo "摄像机对时：没开（LAN1 $nic 没有 IPv4 地址：netplan 里配好地址后 sudo bash install.sh --cam-ntp-on）"
    else
      echo "摄像机对时：没开（sudo bash install.sh --cam-ntp-on 打开）"
    fi
    return 0
  fi
  echo "摄像机对时：开（chrony $(sed -n 's/^allow //p' "$CAM_NTP_CONF")；摄像机 NTP 服务器填本机 LAN1 地址）"
  if [ -z "$hosts" ]; then
    echo '  ！ local.yaml 里还没有摄像机地址：防火墙没给它放行 UDP 123 —— 管理页「视频与测温」填好地址后 sudo bash install.sh --cam-ntp-on'
  elif [ "$(id -u)" = 0 ] && nft list table inet lsa_eg >/dev/null 2>&1; then
    local miss='' h
    for h in $hosts; do nft list chain inet lsa_eg input 2>/dev/null | grep -q "ip saddr $h udp dport 123" || miss+="$h "; done
    if [ -n "$miss" ]; then echo "  ！ 摄像机地址 ${miss% } 没放行（改过地址？）—— sudo bash install.sh --cam-ntp-on"; else echo "  防火墙放行：${hosts% } → UDP 123"; fi
  fi
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
# 开机加载 softdog 用 systemd 单元 lsa-eg-softdog.service 显式 modprobe（0.17.1）：Ubuntu 的 /lib/modprobe.d/blacklist_linux_*.conf
# 有「blacklist softdog」，/etc/modules-load.d 里写它开机会被拒（systemd-modules-load：Module 'softdog' is deny-listed），
# 以前装时 modprobe 能用、一重启就没了（10-15 宿主机意外重启后在 AH12、AH09 上发现）。显式按名字 modprobe 不受 blacklist 限制；
# systemd 每次喂狗前设备没打开就会再去打开，所以模块比 PID 1 晚加载也照样接上。
WD_MOD=/etc/modules-load.d/lsa-eg-softdog.conf
WD_UNIT=/etc/systemd/system/lsa-eg-softdog.service
WD_SD=/etc/systemd/system.conf.d/lsa-eg-watchdog.conf
wd_status() {
  if [ "$(id -u)" != 0 ]; then echo "看门狗：要 sudo 才看得到"; return 0; fi
  local dev='' rt held=0
  for d in /sys/class/watchdog/watchdog*; do [ -e "$d/identity" ] && { dev="$(cat "$d/identity")"; break; }; done
  rt="$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || true)"
  # systemd（PID 1）真的打开着看门狗设备才算在喂
  ls -l /proc/1/fd 2>/dev/null | grep '/dev/watchdog' >/dev/null && held=1  # 不用 -q：pipefail 下 grep 提前退出会让 ls 吃 SIGPIPE、整句判假
  if [ -f "$WD_SD" ] && [ -n "$dev" ] && [ "$held" = 1 ] && [ -n "$rt" ] && [ "$rt" != 0 ] && [ "$rt" != infinity ]; then
    echo "看门狗：开（$dev；systemd 每 $rt 内没喂就重启）"
  elif [ -f "$WD_SD" ] && ! grep -q '^EG_WATCHDOG=off' .env 2>/dev/null; then
    local why='没有看门狗设备（softdog 没加载）'
    [ -n "$dev" ] && why="$dev 没被 systemd 打开"
    echo "!! 看门狗：配置在，但$why —— 系统卡死不会自动重启；重跑 sudo bash install.sh" >&2
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
  # 老版本写的 modules-load.d 不起作用（blacklist），删掉
  rm -f "$WD_MOD"
  if [ -z "$hw" ]; then
    if ! modprobe softdog 2>/dev/null; then echo '!! 加载不了 softdog 内核模块：系统卡死时不会自动重启' >&2; return 0; fi
    cat > "$WD_UNIT" <<'EOF'
# LSA-9600EG（install.sh 写）：开机加载软件看门狗 softdog。Ubuntu 默认 blacklist 它，modules-load.d 加载不了，这里显式 modprobe。
# 不要手改，重跑 install.sh 会重写；关掉用 sudo bash install.sh --watchdog-off
[Unit]
Description=LSA-9600EG 软件看门狗（加载 softdog）
DefaultDependencies=no
Before=sysinit.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/modprobe softdog

[Install]
WantedBy=sysinit.target
EOF
    systemctl daemon-reload
    systemctl enable lsa-eg-softdog.service >/dev/null 2>&1 || echo '!! lsa-eg-softdog.service 没能设成开机自启：重启后看门狗不生效' >&2
  else
    systemctl disable lsa-eg-softdog.service >/dev/null 2>&1 || true
    rm -f "$WD_UNIT"
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
  if [ -f "$WD_UNIT" ]; then
    systemctl disable lsa-eg-softdog.service >/dev/null 2>&1 || true
    rm -f "$WD_UNIT"
    systemctl daemon-reload
  fi
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
# 启用的传感器的 device 都要在 eg.yaml 的设备清单里（对不上的数据进不了本地 TB、也不上送）
conv_check_devices() {
  [ -d config/conv/sensors ] && [ -f config/eg.yaml ] || return 0
  local names f dev en bad=()
  names=" $(awk '/^devices:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  - name:/{print $3}' config/eg.yaml | tr '\n' ' ') "
  for f in config/conv/sensors/*.yaml; do
    [ -f "$f" ] || continue
    en="$(awk '$1=="enabled:"{print $2;exit}' "$f")"
    [ "$en" = true ] || continue
    dev="$(awk '$1=="device:"{gsub(/"/,"",$2);print $2;exit}' "$f")"
    case "$names" in *" $dev "*) ;; *) bad+=("$(basename "$f") 的 device「${dev:-空}」") ;; esac
  done
  if [ ${#bad[@]} -gt 0 ]; then
    echo "!! 转换程序配置的设备名和 eg.yaml 对不上（这些数据不会进本地 TB、不会上送）：${bad[*]}" >&2
    echo "   eg.yaml 里的设备：$names；改 config/conv/sensors/*.yaml 的 device 后 docker restart lsa-eg-conv" >&2
  fi
  true
}

# 启用过 = .env 里 EG_CONV=on（install-conv.sh 写的）；兼容 0.6.1 以前由 install.sh 自己起的（COMPOSE_PROFILES=conv、没关过）
conv_wanted() {
  grep -q '^EG_CONV=on' .env 2>/dev/null && return 0
  grep -q '^COMPOSE_PROFILES=conv' .env 2>/dev/null && ! grep -q '^EG_CONV=off' .env 2>/dev/null
}
conv_status() {
  local ser state
  ser="$(grep -E '^EG_CONV_SERIAL=' .env 2>/dev/null | cut -d= -f2- || true)"; ser="${ser:-/dev/ttyS1}"
  state='没启用（启用：sudo bash install-conv.sh）'
  conv_wanted && state='启用'
  grep -q '^EG_CONV=off' .env 2>/dev/null && state='已关（install-conv.sh --off）'
  echo "转换程序：$state；串口 $ser$([ -e "$ser" ] && [ -L "$ser" ] && echo "（→ $(readlink -f "$ser")）")$([ -e "$ser" ] || echo '（不存在）')"
  # 0.17 转换程序保险（eg-agent）：自动重启过的话说出来
  if [ -f config/conv-guard.json ]; then
    local n last
    n="$(sed -n 's/.*"restarts":\([0-9]*\).*/\1/p' config/conv-guard.json)"
    last="$(sed -n 's/.*"detail":"\([^"]*\)".*/\1/p' config/conv-guard.json)"
    [ "${n:-0}" -gt 0 ] 2>/dev/null && echo "  eg-agent 自动重启过转换程序 $n 次；最近一次：${last:-?}"
  fi
  if [ "$state" = 启用 ]; then
    local h
    h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' lsa-eg-conv 2>/dev/null || true)"
    [ -n "$h" ] && echo "  健康检查：$h（最近 2 分钟有没有数据发出或进缓存）"
    conv_check_devices
    # 0.18.0 舱室 EG：拆柜后本机换了单元，转换程序要跟着重启才换 clientId（同事程序启动时读 eg.yaml）
    local started cid want
    started="$(docker inspect -f '{{.State.StartedAt}}' lsa-eg-conv 2>/dev/null || true)"
    cid="$([ -n "$started" ] && docker logs --since "$started" lsa-eg-conv 2>&1 | sed -n 's/.*MQTT 连接成功.*(client_id=\([^)]*\)).*/\1/p' | tail -1 || true)"
    want="$(eg_unit_get code)"; want="lsa-conv-${want:-$(eg_cab)}"
    if [ -n "$cid" ] && [ "$cid" != "$want" ]; then
      echo "  ！ 转换程序还按旧单元跑（clientId $cid，应为 $want）：eg.yaml 换过单元（拆柜？）—— sudo bash install-conv.sh --rebind"
    fi
  fi
  echo "可选串口（sudo bash install-conv.sh --serial <设备>）："
  serial_list
  echo "  详细（各路传感器、最近采集）：sudo bash install-conv.sh --status"
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
  cam_ntp_status
  wd_status
  conv_status
  uplink_status
  join_status
  upg_status
  true
}
# ---------- 子站批量升级（0.17.2）：专用账号 lsa-upg + 固定入口 ----------
UPG_AK=/var/lib/lsa-upg-ssh/.ssh/authorized_keys
upg_from_now() { sed -n 's/.*from="\([^"]*\)".*/\1/p' "$UPG_AK" 2>/dev/null | head -1 || true; }
# 升级入口与任务脚本装到 /usr/local/sbin（先写新文件再改名：正在跑的升级任务读的是旧文件，不能原地覆盖）
upg_install_entry() {
  local f
  for f in lsa-eg-upgrade lsa-eg-upgrade-job; do
    [ -f "$f" ] || { echo "!! 发布件里没有 $f" >&2; return 1; }
    install -m 755 -o root -g root "$f" "/usr/local/sbin/.$f.new"
    mv -f "/usr/local/sbin/.$f.new" "/usr/local/sbin/$f"
  done
}
# 读 join.json / eg.yaml 的小函数（--status 在下面各 MODE 之前就用到，要先定义，同 #25）
key_fp() { echo "$1" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' || true; }
join_get() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" config/join.json 2>/dev/null | head -1 || true; }
eg_sp_host() { sed -n 's#^  mqtt: *mqtts\{0,1\}://\([^:/]*\).*#\1#p' config/eg.yaml 2>/dev/null | head -1 || true; }
eg_cab() { awk '/^cabinet:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="code:"{gsub(/["'\'']/,"",$2);print $2;exit}' config/eg.yaml 2>/dev/null || true; }
# 0.18.0 舱室 EG：eg.yaml 顶层 unit 段（schema 2）的某一项；照旧一柜一台的（schema 1）没有这段
eg_unit_get() { awk -v k="$1:" '/^unit:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1==k{sub(/^[^:]*: */,"");gsub(/["'\'']/,"");print;exit}' config/eg.yaml 2>/dev/null || true; }
eg_name() { awk '/^eg:/{f=1;next} f&&/^[^ ]/{f=0} f&&$1=="name:"{gsub(/["'\'']/,"",$2);print $2;exit}' config/eg.yaml 2>/dev/null || true; }
# 回退前看 eg.yaml 的格式（0.18.0 舱室 EG）：本机已接成舱室单元（schema 2），要回到的版本早于 EG 0.7.0 就读不了 ——
# 回退后 agent 起不来；拆柜后原来照旧一柜一台的令牌也作废了，回不去。rollback_schema_guard <要回到的版本>：能回返回 0，不能就说清并返回 1
rollback_schema_guard() {
  local to="${1%%-*}" schema
  schema="$(sed -n 's/^schema: *//p' config/eg.yaml 2>/dev/null | head -1 || true)"
  [ "${schema:-1}" -ge 2 ] 2>/dev/null || return 0
  [ "$(printf '%s\n%s\n' "$to" 0.7.0 | sort -V | head -1)" = 0.7.0 ] && return 0
  echo "✗ 本机已接成舱室单元（$(eg_name)，eg.yaml schema $schema），要回到的 $1 读不了 schema 2（EG 0.7.0 起才认）：回退后 agent 起不来。" >&2
  echo "  拆柜后这面柜原来的令牌已作废，回到照旧一柜一台也连不上子站。要回退：先在子站把这面柜恢复成照旧一柜一台（子站部署手册 §5b），" >&2
  echo "  再按老办法给本机发照旧一柜一台的 eg.yaml，然后再回退；或者就留在当前版本，用 install.sh --status 看问题" >&2
  return 1
}
# 接入状态（0.17.4 一键加柜；0.18.0 显示单元）：待接入 / 已接入子站 X（EG-AH07-A · 柜 AH07 断路器室）
join_status() {
  local sp cab at
  sp="$(join_get sp)"
  if [ -f config/eg.yaml ]; then
    cab="$(eg_cab)"; at="$(eg_unit_get at)"
    echo "接入：已接入子站 $(eg_sp_host)（$(eg_name) · 柜 ${cab:-?}${at:+ $at}）$([ -n "$sp" ] && echo "，授权的子站 $sp")"
  elif [ -n "$sp" ]; then
    echo "接入：待接入 —— 已授权子站 $sp（$(join_get at)），等子站 join-egs.sh --unit <单元号> --eg <本机地址>；本机待接入页 http://<本机地址>/"
  else
    echo '接入：待接入 —— 还没给子站授权（--join-key，或老办法 --sp-key + 手工拷 eg.yaml）'
  fi
}
upg_status() {
  if id lsa-upg >/dev/null 2>&1; then
    # 授权了但还没跑过任务时没有 state 文件：sed 读不到返回 2，set -e 下 --status 会在这里退出（0.17.2 VM 上测出）
    local ph='' st=/var/lib/lsa-upg/state more=''
    upg_st() { sed -n "s/^$1=//p" "$st" | tail -1 || true; }
    if [ -f "$st" ]; then
      ph="$(upg_st phase)"
      # 换配置（一键加柜，kind=config）：「换配置 <任务号>，柜 <旧> → <新>」；升级：「升级 <任务号>，<旧版本> → <新版本>」
      if [ "$(upg_st kind)" = config ]; then more="（换配置 $(upg_st job)，柜 $(upg_st from | sed 's/^$/待接入/') → $(upg_st to)）"
      else more="（升级 $(upg_st job)，$(upg_st from) → $(upg_st to)）"; fi
    fi
    echo "子站批量升级：已授权（lsa-upg，只认 $(upg_from_now)）；最近一次任务：${ph:-没有}${ph:+$more}"
    # 0.18.1 发布签名：子站传来的安装文件用本机 release-signers 验签（lsa-eg-upgrade 开头）
    local nk fp
    nk="$(awk '!/^[[:space:]]*(#|$)/ { n++ } END { print n + 0 }' release-signers 2>/dev/null || echo 0)"
    if [ "$nk" -gt 0 ] 2>/dev/null; then
      fp="$(grep -v '^[[:space:]]*#' release-signers | awk 'NF { $1 = ""; $2 = ""; print }' | ssh-keygen -lf - 2>/dev/null | awk '{ printf "%s%s", s, $2; s = "、" }' || true)"
      echo "  升级验签：发布公钥 $nk 把（${fp:-?}）；最近一次任务的签名：$( [ -f "$st" ] && upg_st sig | sed 's/^$/（老入口，没记）/' || echo 没有)"
    else
      echo '  升级验签：本机没有发布公钥 release-signers（老发布件装的）—— 子站传来的安装文件验不了签'
    fi
  else
    echo '子站批量升级：没授权（要用时 sudo bash install.sh --upgrade-key <子站升级公钥>）'
  fi
}

# 安全提醒（只提醒，不改系统配置：自动关 SSH 口令登录可能把维护人员锁在外面）
security_notes() {
  local msg=()
  [ -f config/initial-password.txt ] && msg+=('本地维护账号 maint 的初始口令文件还在（config/initial-password.txt）：登录管理页改掉口令后删除它')
  id lsa-sp >/dev/null 2>&1 && msg+=('隧道账号 lsa-sp 还在：子站 provision-eg.sh 跑完后可删 —— sudo bash install.sh --drop-sp-key（以后要再建实体重新 --sp-key）')
  id lsa-upg >/dev/null 2>&1 && msg+=("子站批量升级账号 lsa-upg 已授权（只认 $(upg_from_now)；只能交安装文件给 EG 自己升级，但持子站那把 key 的人能让 EG 装任意安装文件）：不用时 sudo bash install.sh --drop-upgrade-key")
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
# 本地 TB 的辅助函数要在 --status 分支之前定义：status 里要用 tb_db_version（0.17 r1 定义在后面，单独跑 --status 打完「可回退到」就 127 退出）
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
[ "$MODE" = 'status' ] && { status; security_notes; exit 0; }
[ "$(id -u)" = 0 ] || { echo '要用 sudo 跑' >&2; exit 1; }
# 升级授权（--upgrade-key、--join-key 共用）：upg_key_apply <公钥> <子站地址>
# 专用系统账号（lsa-upg、lsa-sp）：uid 取 900–989 里空着的。不能让 useradd 自己挑 —— 新装系统上它给 999，
# 和本地库容器（postgres，uid 999）撞上：宿主机上看本地库的进程就成了这个账号的，pgrep / pkill -u 会误判、误杀本地库
# 老版本（0.17.2 及以前）建的账号已经撞了的，sys_user 迁过来：先 userdel -f 再按新 uid 建（usermod 在同 uid 的本地库进程
# 跑着时会拒绝），home、authorized_keys 原样留下、改属主，from= / command= 不动，授权不丢。
uid_clash() {  # uid_clash <uid>：和本地库容器的 postgres 同 uid，或在 990 以上（useradd 自己挑的范围，容器常用）
  local pg
  pg="$(docker exec lsa-eg-postgres id -u postgres 2>/dev/null || echo 999)"
  [ "$1" = "$pg" ] || [ "$1" -ge 990 ]   # sete-ok：判断函数
}
sys_user() {  # sys_user <账号> <home> <shell>
  local u old='' err
  if id "$1" >/dev/null 2>&1; then
    old="$(id -u "$1")"
    uid_clash "$old" || return 0
    pkill -u "$1" -f '^sshd' 2>/dev/null || true   # 正开着的 SSH 会话断掉（子站会重连）；只认 sshd，不碰同 uid 的本地库
    userdel -f "$1" 2>/dev/null || { echo "!! 账号 $1（uid $old）删不掉，没迁" >&2; return 1; }
    if getent group "$1" >/dev/null; then groupdel "$1" 2>/dev/null || true; fi
  fi
  for u in $(seq 989 -1 900); do
    getent passwd "$u" >/dev/null || getent group "$u" >/dev/null || break
  done
  # home 已在（迁移）时 useradd 只提醒「目录已存在」，不算错
  err="$(useradd --system --uid "$u" --user-group --create-home --home-dir "$2" --shell "$3" "$1" 2>&1)" || { echo "!! 建账号 $1 失败：$err" >&2; return 1; }
  if [ -n "$old" ]; then
    chown -R "$1:$1" "$2"
    echo "账号 $1 的 uid $old 和本地库容器撞了（0.17.2 及以前建的）：已迁到 uid $u，授权不变"
  fi
}
upg_key_apply() {  # upg_key_apply <公钥> <子站地址> [excl]：excl = 只留这一把（--join-key：授权给谁就只认谁）
  local key="$1" from="$2" body sd
  echo "$key" | grep -Eq '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) [A-Za-z0-9+/=]+( [^"]*)?$' || { echo "升级公钥不像 SSH 公钥：$key" >&2; return 1; }
  command -v sudo >/dev/null || { echo '没有 sudo：升级入口靠 sudoers 放行' >&2; return 1; }
  [[ "$from" =~ ^[A-Za-z0-9.:,*/-]+$ ]] || { echo "子站地址不对：$from" >&2; return 1; }
  upg_install_entry || return 1
  # 账号：锁口令；shell 要是 /bin/sh（sshd 用它执行 command=，nologin 会把入口也挡掉）；home 与升级状态目录分开
  sys_user lsa-upg /var/lib/lsa-upg-ssh /bin/sh
  passwd -l lsa-upg >/dev/null 2>&1 || true
  install -d -m 700 -o lsa-upg -g lsa-upg /var/lib/lsa-upg-ssh/.ssh
  body="$(echo "$key" | awk '{print $1" "$2}')"
  touch "$UPG_AK"
  if [ -n "${3:-}" ]; then : > "$UPG_AK.tmp"; else grep -vF "$body" "$UPG_AK" > "$UPG_AK.tmp" || true; fi
  echo "restrict,from=\"$from\",command=\"sudo -n /usr/local/sbin/lsa-eg-upgrade \\\"\$SSH_ORIGINAL_COMMAND\\\"\" $key" >> "$UPG_AK.tmp"
  mv "$UPG_AK.tmp" "$UPG_AK"; chown lsa-upg:lsa-upg "$UPG_AK"; chmod 600 "$UPG_AK"
  sd=/etc/sudoers.d/lsa-upg
  printf '%s\n' '# LSA-9600EG：子站批量升级账号只能跑升级入口（install.sh --upgrade-key / --join-key 写的，--drop-upgrade-key 删）' \
    'Defaults:lsa-upg !requiretty' 'lsa-upg ALL=(root) NOPASSWD: /usr/local/sbin/lsa-eg-upgrade' > "$sd.tmp"
  visudo -cf "$sd.tmp" >/dev/null || { rm -f "$sd.tmp"; echo 'sudoers 条目没通过 visudo 检查，没装' >&2; return 1; }
  chmod 440 "$sd.tmp"; mv "$sd.tmp" "$sd"
  echo "已给子站升级公钥授权：lsa-upg 只认来自 $from 的连接，只能进升级入口（lsa-eg-upgrade）"
}
# 隧道授权（--sp-key、--join-key 共用）：sp_key_apply <公钥> [子站地址] [excl]；给了地址就加 from=（--join-key 都给）；excl 同上
sp_key_apply() {
  local key="$1" from="${2:-}" ak=/var/lib/lsa-sp/.ssh/authorized_keys body opts
  echo "$key" | grep -Eq '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) [A-Za-z0-9+/=]+' || { echo "隧道公钥不像 SSH 公钥：$key" >&2; return 1; }
  sys_user lsa-sp /var/lib/lsa-sp /usr/sbin/nologin
  install -d -m 700 -o lsa-sp -g lsa-sp /var/lib/lsa-sp/.ssh
  touch "$ak"
  body="$(echo "$key" | awk '{print $1" "$2}')"
  opts='restrict,port-forwarding,permitopen="127.0.0.1:18080"'
  [ -n "$from" ] && opts="restrict,from=\"$from\",port-forwarding,permitopen=\"127.0.0.1:18080\""
  # 同一把 key 已有的那行换掉（from= 可能变了）；excl 时别的 key 也都去掉
  if [ -n "${3:-}" ]; then : > "$ak.tmp"; else grep -vF "$body" "$ak" > "$ak.tmp" || true; fi
  echo "$opts $key" >> "$ak.tmp"
  mv "$ak.tmp" "$ak"; chown lsa-sp:lsa-sp "$ak"; chmod 600 "$ak"
  echo "已给子站公钥授权：lsa-sp 只能开隧道到本机 127.0.0.1:18080${from:+，只认来自 $from 的连接}"
}
if [ "$MODE" = 'upg-key' ]; then
  key="$UPGKEY"; [ -f "$UPGKEY" ] && key="$(head -1 "$UPGKEY")"
  from="$UPGFROM"
  [ -n "$from" ] || from="$(eg_sp_host)"
  [ -n "$from" ] || { echo 'eg.yaml 里取不到子站地址：用 --upgrade-from <子站地址> 给' >&2; exit 1; }
  upg_key_apply "$key" "$from" || exit 1
  echo '撤销：sudo bash install.sh --drop-upgrade-key'
  exit 0
fi
if [ "$MODE" = 'drop-upg' ]; then
  if id lsa-upg >/dev/null 2>&1; then
    pkill -u lsa-upg -f '^sshd' 2>/dev/null || true   # 只断 sshd 会话（同上）
    userdel -f -r lsa-upg 2>/dev/null || userdel -f lsa-upg
  fi
  rm -rf /var/lib/lsa-upg-ssh /var/lib/lsa-upg/incoming
  rm -f /etc/sudoers.d/lsa-upg /usr/local/sbin/lsa-eg-upgrade /usr/local/sbin/lsa-eg-upgrade-job
  echo '已撤销子站批量升级：账号 lsa-upg、它的 key、sudoers 条目、升级入口都删了（日志 /var/log/lsa-upg.log 留着）'
  exit 0
fi
if [ "$MODE" = 'drop-sp' ]; then
  if id lsa-sp >/dev/null 2>&1; then
    pkill -u lsa-sp -f '^sshd' 2>/dev/null || true   # 子站隧道正开着的话断掉（只断 sshd 会话：老系统上账号可能和本地库容器同 uid，见 sys_user）
    userdel -f -r lsa-sp 2>/dev/null || userdel -f lsa-sp
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
if [ "$MODE" = 'cam-ntp-off' ] || [ "$MODE" = 'cam-ntp-on' ]; then
  env_set EG_CAM_NTP "${MODE#cam-ntp-}"
  nic="$(grep -E '^EG_LAN1=' .env 2>/dev/null | cut -d= -f2- || true)"
  cam_ntp_apply "$nic"
  systemctl restart chrony >/dev/null 2>&1 || true
  # 防火墙规则跟着重写（开：按 local.yaml 现在的摄像机地址放行；关：去掉）
  if [ -n "$nic" ] && ! grep -q '^EG_LAN1_FW=off' .env; then fw_apply "$nic" >/dev/null; fi
  cam_ntp_status
  exit 0
fi
# 部署文件（升级时整个发布件覆盖过来的那些）
DEPLOY_FILES='compose.yaml mosquitto.conf install.sh diskcheck.sh VERSION IMAGES.txt extensions CONV_IMAGE.txt install-conv.sh conv-kit lsa-eg-upgrade lsa-eg-upgrade-job release-signers'

# ---------- 转换程序（0.6.2）：发布件带镜像、缺省不启用；install-conv.sh 启用过的接着跑（换成本发布件的镜像） ----------
conv_setup() {
  local img='' ser off=''
  # grep 没匹配时返回 1：set -e + pipefail 下赋值语句会让整个 install.sh 悄悄退出（0.4.0 在 0.13 验收里踩到）—— 都加 || true
  [ -f CONV_IMAGE.txt ] && img="$(grep -v '^#' CONV_IMAGE.txt | head -1 | tr -d '[:space:]' || true)"
  [ -n "$img" ] || img="$(grep -E '^EG_CONV_IMAGE=' .env 2>/dev/null | cut -d= -f2- || true)"
  ser="$(grep -E '^EG_CONV_SERIAL=' .env 2>/dev/null | cut -d= -f2- || true)"; ser="${ser:-/dev/ttyS1}"
  # 注意：赋值里的 $(…) 失败会让 set -e 下的 install.sh 直接退出（没有镜像时这里曾让升级与回退都半路停下，批量升级沙箱测出）—— 用 if 拼
  if ! conv_wanted; then off='没启用'; if [ -n "$img" ]; then off+="（发布件带了 $img；现场要用时 sudo bash install-conv.sh）"; fi
  elif [ -z "$img" ]; then off='!! 启用过，但发布件和本机都没有转换程序镜像'
  elif ! docker image inspect "$img" >/dev/null 2>&1; then off="!! 启用过，但本机没有镜像 $img（导入失败？）"
  elif [ ! -e "$ser" ]; then off="!! 启用过，但串口 $ser 不存在（USB 转 485 拔了？）—— 插好后 sudo bash install-conv.sh"
  fi
  if [ -n "$off" ]; then
    env_set COMPOSE_PROFILES ''
    docker rm -f lsa-eg-conv >/dev/null 2>&1 || true
    echo "转换程序：不起 —— $off"
    return 0
  fi
  env_set EG_CONV on
  env_set EG_CONV_IMAGE "$img"
  env_set EG_DIALOUT_GID "$(getent group dialout | cut -d: -f3)"
  env_set COMPOSE_PROFILES conv
  mkdir -p config/conv config/conv-data
  echo "转换程序：$img，串口 $ser（install-conv.sh 启用的，接着跑；看状态 sudo bash install-conv.sh --status）"
  conv_check_devices
}

# ---------- 回退 ----------
if [ "$MODE" = 'rollback' ]; then
  [ -f .previous/VERSION ] || { echo '没有上一个版本可回退（.previous/ 不存在）' >&2; exit 1; }
  prev="$(cat .previous/VERSION)"
  rollback_schema_guard "$prev" || exit 1
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
  # 回到的版本不给摄像机对时（早于 0.7.x）：chrony 的 allow 撤掉（防火墙里那条放行没有 chrony 听也就不起作用，下次那个版本重写规则时去掉）
  if ! grep -q 'lsa-eg-cam.conf' install.sh && [ -f "$CAM_NTP_CONF" ]; then
    rm -f "$CAM_NTP_CONF"; systemctl restart chrony >/dev/null 2>&1 || true; echo '（回到的版本不给摄像机对时，已撤掉）'
  fi
  echo; status
  exit 0
fi

# ---------- --join-key 先核对（装任何东西之前）：格式、校验位、子站地址、换子站要 --force ----------
if [ -n "$JOINKEY" ]; then
  read -r -a jw <<< "$JOINKEY" || true
  [ "${#jw[@]}" = 7 ] && [ "${jw[0]}" = LSAJOIN1 ] || { echo '--join-key 格式不对：应是一行「LSAJOIN1 <子站地址> <隧道公钥> <升级公钥> <校验>」（子站 join-egs.sh --keygen 打印的，整行带引号粘过来）' >&2; exit 1; }
  jsum="$(printf '%s' "${jw[*]:0:6}" | sha256sum | cut -c1-8)"
  [ "$jsum" = "${jw[6]}" ] || { echo '--join-key 校验不对：粘贴不完整或抄错了，回子站重新复制一整行' >&2; exit 1; }
  jsp="${jw[1]}"
  [[ "$jsp" =~ ^[A-Za-z0-9.:-]+$ ]] || { echo "--join-key 里的子站地址不对：$jsp" >&2; exit 1; }
  # 已接入 / 已授权别的子站：要 --force 才换（老办法接入的没有 join.json，看 eg.yaml 里的子站）
  cur_sp="$(join_get sp)"; [ -f config/eg.yaml ] && [ -z "$cur_sp" ] && cur_sp="$(eg_sp_host)"
  if [ -n "$cur_sp" ] && [ "$cur_sp" != "$jsp" ] && [ "$FORCE" != 1 ]; then
    if [ -f config/eg.yaml ]; then echo "!! 这台 EG 已接入子站 $cur_sp（$(eg_name) · 柜 $(eg_cab)），--join-key 是给子站 $jsp 的：要换子站加 --force" >&2
    else echo "!! 这台 EG 已授权给子站 $cur_sp（待接入），--join-key 是给子站 $jsp 的：要换子站加 --force" >&2; fi
    exit 1
  fi
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

# 子站批量升级授权过的：入口换成本发布件的
id lsa-upg >/dev/null 2>&1 && { upg_install_entry || true; }

# ---------- 0.17.4：老版本建的专用账号 uid 撞了本地库容器的，迁到 900–989（授权不变，见 sys_user） ----------
if id lsa-sp >/dev/null 2>&1; then sys_user lsa-sp /var/lib/lsa-sp /usr/sbin/nologin || exit 1; fi
if id lsa-upg >/dev/null 2>&1; then sys_user lsa-upg /var/lib/lsa-upg-ssh /bin/sh || exit 1; fi

# ---------- 子站 provision-eg.sh 的隧道账号（--sp-key） ----------
if [ -n "$SPKEY" ]; then
  key="$SPKEY"; [ -f "$SPKEY" ] && key="$(head -1 "$SPKEY")"
  sp_key_apply "$key" || exit 1
fi

# ---------- 一键加柜（0.17.4）：--join-key = 隧道 + 升级两把 key，from= 都锁到子站 ----------
# 前面（第 0 步之前）已核对过格式、校验位、换子站；这里写授权。只认这一个子站：两个 authorized_keys 都只留这两把
if [ -n "$JOINKEY" ]; then
  sp_key_apply "${jw[2]} ${jw[3]} lsa9600sp-eg-tunnel" "$jsp" excl || exit 1
  upg_key_apply "${jw[4]} ${jw[5]} lsa9600sp-eg-upgrade" "$jsp" excl || exit 1
  umask_old="$(umask)"; umask 077
  printf '{\n  "sp": "%s",\n  "at": "%s",\n  "tunnelFp": "%s",\n  "upgradeFp": "%s"\n}\n' \
    "$jsp" "$(date '+%F %T')" "$(key_fp "${jw[2]} ${jw[3]}")" "$(key_fp "${jw[4]} ${jw[5]}")" > config/join.json
  umask "$umask_old"
  echo "已记下接入授权（config/join.json）：子站 $jsp"
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
  if [ -f config/join.json ]; then
    # 一键加柜：起只读的待接入页（80 口），等子站 join-egs.sh。
    # 换配置失败回到待接入时，上一次起来的 agent 等还在（没有 eg.yaml 起不来、还占着 80 口）：先撤掉
    docker rm -f lsa-eg-agent lsa-eg-video lsa-eg-gateway lsa-eg-mediamtx lsa-eg-conv >/dev/null 2>&1 || true
    $DC --profile pending up -d pending >/dev/null 2>&1 || echo '!! 待接入页没起来（docker logs lsa-eg-pending）' >&2
    cat <<EOF

本地 TB 已起。这台 EG 待接入：已授权子站 $(join_get sp)。
  现场：笔记本接到 LAN2 的交换机上，浏览器打开 http://<这台 EG 的 LAN2 地址>/ 能看到「待接入」和各网口的 IP / MAC。
  子站主机上：sudo bash /opt/lsa9600sp/join-egs.sh --unit <单元号，如 AH07-A> --eg <这台 EG 的 LAN2 地址>（见 EG 部署手册 §4a「一键加柜」；照旧一柜一台的单元号 = 柜号）
  老办法（手工 provision-eg.sh、pack-eg.sh、拷配置）照旧能用，见手册 §4。
EOF
    exit 0
  fi
  cat <<EOF

本地 TB 已起。下一步（手册 §4；0.17.4 起也可以一键加柜：子站 join-egs.sh --keygen 给一行 join-key，这里 sudo bash install.sh --join-key '<那一行>'，见 §4a）：
  1. 给子站授权开隧道（没给过的话）：把子站主机的 SSH 公钥拷过来，sudo bash install.sh --sp-key <公钥文件>
     （建只能转发到本机 18080 的账号 lsa-sp，没有 shell）
  2. 在子站主机上（/opt/lsa9600sp/lsa9600sp-backend）：
       scripts/provision-eg.sh --unit <单元号> --ssh lsa-sp@<这台 EG 的 LAN2 地址> [--ssh-key <私钥>] --hook http://host.docker.internal/hooks/alarm --sp <子站地址>
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
  cam_ntp_apply "$lan1_now"
  systemctl enable chrony >/dev/null 2>&1 || true
  systemctl restart chrony >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet chrony; then
    echo '!! chrony 没起来（sudo journalctl -u chrony 看原因）：这台 EG 不对时，时钟差 > 60 s 后子站下发配置、单点登录会被拒' >&2
  fi
fi

# 待接入页占着 80 口：接入了（有 eg.yaml）就撤掉，让 agent 起来
docker rm -f lsa-eg-pending >/dev/null 2>&1 || true
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
