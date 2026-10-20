#!/bin/bash
# LSA-9600 现场批量装 EG（S19 起）：厂家按《出厂预装手册》v1.1 交货的新 EG（Ubuntu Server 24.04、维护账号 lsaadmin、
# LAN2 临时 192.168.1.250/24、主机名 lsaeg-<SN>）一台台上架时，在子站主机（或 Linux / WSL 维护笔记本）上连续做：
#
#   sudo bash field-install-egs.sh --plan <分配表> --run <一键安装文件 .run> [--join-key '<一行>'] [--parallel 3] [--yes]
#       等 192.168.1.250 上出现一台 → 认 SN、按分配表改 LAN2 正式地址（netplan，180 s 连不回来自动换回）→ 在正式地址连回来核对
#       → 立刻等下一台；改好地址的在后台：推 .run（续传、核 sha256）→ .run --role eg --lan1 <LAN1> --join-key … --yes → 核对「待接入」。
#       q 回车结束（等后台做完、出汇总和 join 清单）。--count N：做满 N 台就结束；--once：只做 .250 上这一台（前台做完）
#   sudo bash field-install-egs.sh --plan <分配表> --readdress-only       只改地址（安装文件还没到时）；之后 --resume 再装
#   sudo bash field-install-egs.sh --plan <分配表> --run <.run> --resume  不等新机，把改好地址、还没装完的接着做
#   sudo bash field-install-egs.sh --plan <分配表> --status               全表现状
#   --redo <SN>：这台重新做（清掉记录与主机密钥，换机或重装系统后用）
#
# 分配表：每台一行「SN  LAN2地址/前缀  网关  单元号  LAN1网口」，# 开头注释，空格 / 制表符 / 逗号分隔；网关、单元号、LAN1 网口可写 -
#   （网关整表一样时用 --gw）。LAN1 网口：表里有就用（抄《出厂记录表》），没有就自动认 —— 持有 .250 的是 LAN2，另一个 en* 口就是 LAN1；
#   两者对不上就停。LAN1 缺省配 192.168.100.1/24（每台都一样，接摄像机），--lan1-addr none 不配。
# 口令：开头问一次 lsaadmin 的口令，只在内存里（SSH 用 SSH_ASKPASS 从环境变量取，sudo -S 从管道喂），不落盘、不往 EG 上放 key。
# 主机密钥：第一次在 .250 上记下，按 HostKeyAlias=lsaeg-<SN> 钉住，正式地址上严格核对（同一把密钥 = 同一台）。
# join-key：在子站主机上不给就自动取 join-egs.sh --keygen 那一行；笔记本上要给。
# 要能到 192.168.1.250：子站主机不在这一段时 --temp-ip 192.168.1.251/24 [--temp-dev <网口>] 临时加地址（退出时删），或自己 ip addr add。
# 状态与日志：/var/log/lsa9600sp/eg-field/（不是 root 时 ~/.lsa9600/eg-field/，--state-dir 可改）：每台 <SN>/state、<SN>/log，每次 run-<时间>.log，
#   join-list.txt（单元号 地址，给 join-egs.sh --from-file … --plan）。方案：docs/EG现场批量安装方案.md
set -uo pipefail
export LC_ALL=C.UTF-8
SP=/opt/lsa9600sp
TEMP_CIDR="${LSA_FIELD_TEMP:-192.168.1.250/24}"
TEMP_IP="${TEMP_CIDR%/*}"
REVERT_S="${LSA_FIELD_REVERT_S:-180}"         # 改地址后多久连不回来就自动换回
RECONNECT_S="${LSA_FIELD_RECONNECT_S:-90}"    # 等正式地址上连回来
POLL_S="${LSA_FIELD_POLL_S:-10}"
INSTALL_TIMEOUT_S="${LSA_FIELD_INSTALL_TIMEOUT_S:-2700}"
TCP_CMD="${LSA_FIELD_TCP:-}"                  # 测试替身：<命令> <地址> <端口>，0 = 通

PLAN='' ONCE=0 RUN='' JOINKEY='' GW_ALL='' LAN1_ADDR='192.168.100.1/24' PAR=3 YES=0 MODE=loop ONE_SN='' COUNT=0
SD='' TEMP_ADD='' TEMP_DEV='' SETTIME='' KEEP_RUN=0 REDO=''
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="${2:?--plan 后面给分配表}"; shift ;;
    --run) RUN="${2:?--run 后面给一键安装文件}"; shift ;;
    --join-key) JOINKEY="${2:?--join-key 后面给子站 join-egs.sh --keygen 打印的那一行}"; shift ;;
    --gw) GW_ALL="${2:?--gw 后面给网关}"; shift ;;
    --lan1-addr) LAN1_ADDR="${2:?--lan1-addr 192.168.100.1/24 或 none}"; shift ;;
    --parallel) PAR="${2:?--parallel 3}"; shift ;;
    --yes | -y) YES=1 ;;
    --once) ONCE=1 ;;
    --sn) ONE_SN="${2:?--sn 后面给整机 SN}"; shift ;;
    --count) COUNT="${2:?--count N}"; shift ;;
    --readdress-only) MODE=readdress ;;
    --resume) MODE=resume ;;
    --status) MODE=status ;;
    --redo) REDO="${2:?--redo 后面给 SN}"; shift ;;
    --state-dir) SD="${2:?}"; shift ;;
    --temp-ip) TEMP_ADD="${2:?--temp-ip 192.168.1.251/24}"; shift ;;
    --temp-dev) TEMP_DEV="${2:?}"; shift ;;
    --set-time) SETTIME=1 ;;
    --no-set-time) SETTIME=0 ;;
    --keep-run) KEEP_RUN=1 ;;
    -h | --help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
die() { echo "错误：$*" >&2; exit 1; }
ts() { date '+%F %T'; }
kv() { sed -n "s/^$1=//p" <<< "$2" | tail -1; }
[ -n "$PLAN" ] || die '要给 --plan <分配表>（--help 看格式）'
[ -f "$PLAN" ] || die "没有分配表：$PLAN"
[[ "$PAR" =~ ^[1-9]$ ]] || die "--parallel 要 1–9：$PAR"
[[ "$COUNT" =~ ^[0-9]+$ ]] || die "--count 要是数字：$COUNT"
[ -z "$ONE_SN" ] || [ "$ONCE" = 1 ] || die '--sn 只能和 --once 一起用（主机名不是 lsaeg-<SN> 的那一台单独做）'
[ "$LAN1_ADDR" = none ] || [[ "$LAN1_ADDR" =~ ^[0-9]+(\.[0-9]+){3}/[0-9]{1,2}$ ]] || die "--lan1-addr 不对：$LAN1_ADDR"
if [ -z "$SD" ]; then if [ "$(id -u)" = 0 ]; then SD=/var/log/lsa9600sp/eg-field; else SD="$HOME/.lsa9600/eg-field"; fi; fi
mkdir -p "$SD" && chmod 700 "$SD" || die "建不了状态目录 $SD"
ON_SP=0; [ -d "$SP" ] && [ "$(id -u)" = 0 ] && ON_SP=1
[ -n "$SETTIME" ] || SETTIME="$ON_SP"

# ---------- 分配表 ----------
declare -A P_ADDR=() P_GW=() P_UNIT=() P_LAN1=()
P_ORDER=()
is_ip() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line="${line%%#*}"; line="${line//$'\r'/}"; line="$(tr ',\t' '  ' <<< "$line")"
  read -r sn addr gw unit lan1 _ <<< "$line" || true
  [ -n "${sn:-}" ] || continue
  [[ "$sn" =~ ^[A-Za-z0-9-]{1,40}$ ]] || die "分配表第 $n 行 SN 不对：$sn"
  [[ "${addr:-}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "分配表第 $n 行（$sn）LAN2 地址要写成 地址/前缀，如 192.168.10.31/24：${addr:-空}"
  gw="${gw:--}"; [ "$gw" = - ] && [ -n "$GW_ALL" ] && gw="$GW_ALL"
  [ "$gw" = - ] || is_ip "$gw" || die "分配表第 $n 行（$sn）网关不对：$gw"
  unit="${unit:--}"; [ "$unit" = - ] || [[ "$unit" =~ ^[A-Za-z0-9-]{1,20}$ ]] || die "分配表第 $n 行（$sn）单元号不对：$unit"
  lan1="${lan1:--}"; [ "$lan1" = - ] || [[ "$lan1" =~ ^[A-Za-z0-9._-]{1,15}$ ]] || die "分配表第 $n 行（$sn）LAN1 网口名不对：$lan1"
  [ -z "${P_ADDR[$sn]+x}" ] || die "分配表里 SN $sn 出现了两次"
  [ "${addr%/*}" != "$TEMP_IP" ] || die "分配表第 $n 行（$sn）的地址就是出厂临时地址 $TEMP_IP：不能分给正式设备"
  P_ADDR[$sn]="$addr"; P_GW[$sn]="$gw"; P_UNIT[$sn]="$unit"; P_LAN1[$sn]="$lan1"; P_ORDER+=("$sn")
done < "$PLAN"
[ ${#P_ORDER[@]} -gt 0 ] || die "分配表 $PLAN 里一台都没有"
dup="$(for s in "${P_ORDER[@]}"; do echo "${P_ADDR[$s]%/*}"; done | sort | uniq -d | head -1 || true)"
[ -z "$dup" ] || die "分配表里地址 $dup 分给了两台"
dup="$(for s in "${P_ORDER[@]}"; do [ "${P_UNIT[$s]}" = - ] || echo "${P_UNIT[$s]}"; done | sort | uniq -d | head -1 || true)"
[ -z "$dup" ] || die "分配表里单元号 $dup 写了两次"
# 站内网段还没定（2026-10-20）：要是最后就在出厂临时地址那一段，提醒一句（.250 本身分配表已经不许用；每台改地址前还会查 .250 有没有重复）
TEMP_NET="${TEMP_IP%.*}."
for s in "${P_ORDER[@]}"; do
  if [[ "${P_ADDR[$s]}" == "$TEMP_NET"* ]]; then
    echo "！ 分配表的正式地址在 ${TEMP_NET}x，和出厂临时地址 $TEMP_IP 同一段：$TEMP_IP 不能留给任何设备（摄像机出厂也是 ${TEMP_NET}x，要先改到 LAN1 网段）；"
    echo "  建议上架装软件时新机接单独的交换机（或笔记本直连），不接已上线设备的站内网；脚本每台改地址前查 $TEMP_IP 有没有重复"
    break
  fi
done

# ---------- 每台的状态（<SN>/state，键=值）----------
stf() { echo "$SD/$1/state"; }
st_get() { sed -n "s/^$2=//p" "$(stf "$1")" 2>/dev/null | tail -1; }
st_set() {  # st_set <SN> <键> <值> …（成对）
  local sn="$1" f; shift
  mkdir -p "$SD/$sn"; f="$(stf "$sn")"; touch "$f"
  while [ $# -ge 2 ]; do
    grep -v "^$1=" "$f" > "$f.tmp" || true
    printf '%s=%s\n' "$1" "${2//$'\n'/ }" >> "$f.tmp"; mv "$f.tmp" "$f"
    shift 2
  done
}
zh_phase() {
  case "$1" in
    '') echo 没做 ;; readdressing) echo 改地址中 ;; readdressed) echo 地址已改 ;; pushing) echo 推送中 ;;
    installing) echo 安装中 ;; pending) echo 待接入 ;; joined) echo 已接入 ;; failed-a) echo 改地址失败 ;; failed-b) echo 安装失败 ;; *) echo "$1" ;;
  esac
}
status_table() {
  local s ph
  printf '%-16s %-10s %-20s %-10s %s\n' SN 单元 LAN2地址 阶段 说明
  for s in "${P_ORDER[@]}"; do
    ph="$(st_get "$s" phase)"
    printf '%-16s %-10s %-20s %-10s %s\n' "$s" "${P_UNIT[$s]}" "${P_ADDR[$s]}" "$(zh_phase "$ph")" "$(st_get "$s" note)"
  done
}
write_join_list() {
  local s f="$SD/join-list.txt" k=0
  { echo "# 单元号 EG地址（field-install-egs.sh $(ts) 写；子站上 sudo bash $SP/join-egs.sh --from-file $f --plan 先预检）"
    for s in "${P_ORDER[@]}"; do
      case "$(st_get "$s" phase)" in pending | joined) ;; *) continue ;; esac
      if [ "${P_UNIT[$s]}" = - ]; then echo "# $s ${P_ADDR[$s]%/*}  （分配表没写单元号）"; else echo "${P_UNIT[$s]} ${P_ADDR[$s]%/*}"; k=$((k + 1)); fi
    done; } > "$f"
  echo "$k"
}

if [ -n "$REDO" ]; then
  [ -n "${P_ADDR[$REDO]+x}" ] || die "--redo $REDO：分配表里没有这台"
  rm -rf "${SD:?}/$REDO"; echo "已清掉 $REDO 的记录与主机密钥，这台重新做"
fi
if [ "$MODE" = status ]; then status_table; exit 0; fi

# ---------- 安装文件、join-key ----------
SHA='' SIZE=0 RUNNAME='' SPADDR=''
if [ "$MODE" != readdress ]; then
  [ -n "$RUN" ] || die '要给 --run <一键安装文件 .run>'
  [ -f "$RUN" ] || die "没有安装文件：$RUN"
  RUN="$(readlink -f "$RUN")"; RUNNAME="$(basename "$RUN")"
  [[ "$RUNNAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "安装文件名只能是字母、数字和 ._-：$RUNNAME"
  grep -a -q -m1 '^__LSA_PAYLOAD_BELOW__$' "$RUN" || die "$RUN 不是 LSA-9600 的一键安装文件"
  SIZE="$(stat -c %s "$RUN")"
  cache="$SD/.sha-$RUNNAME"
  if [ -f "$cache" ] && [ "$(cut -d' ' -f2 "$cache")" = "$SIZE" ] && [ "$(cut -d' ' -f3 "$cache")" = "$(stat -c %Y "$RUN")" ]; then
    SHA="$(cut -d' ' -f1 "$cache")"
  else
    echo "算安装文件的 sha256（$((SIZE / 1024 / 1024)) MB）…"
    SHA="$(sha256sum "$RUN" | cut -d' ' -f1)"
    echo "$SHA $SIZE $(stat -c %Y "$RUN")" > "$cache"
  fi
  if [ -f "$RUN.sha256" ] && [ "$(cut -d' ' -f1 "$RUN.sha256")" != "$SHA" ]; then die "$RUNNAME 和旁边的 .sha256 对不上：文件坏了？"; fi
  signers="${LSA_RELEASE_SIGNERS:-$SP/release-signers}"
  if [ -f "$RUN.sig" ] && [ -s "$signers" ] && command -v ssh-keygen >/dev/null; then
    ssh-keygen -Y verify -f "$signers" -I lsa9600-release -n lsa9600-release -s "$RUN.sig" < "$RUN" >/dev/null 2>&1 ||
      die "$RUNNAME 签名校验不过：不是发布方签的，或者文件 / .sig 被改过"
    echo "签名：已验（$signers）"
  fi
  if [ -z "$JOINKEY" ] && [ "$ON_SP" = 1 ] && [ -f "$SP/join-egs.sh" ]; then
    JOINKEY="$(bash "$SP/join-egs.sh" --keygen 2>/dev/null | sed -n 's/^ *\(LSAJOIN1 .*\)$/\1/p' | head -1 || true)"
    [ -n "$JOINKEY" ] && echo "join-key：取自本机 join-egs.sh --keygen"
  fi
  [ -n "$JOINKEY" ] || die "要给 --join-key '<子站 join-egs.sh --keygen 打印的那一行>'"
  read -r -a jw <<< "$JOINKEY" || true
  [ "${#jw[@]}" = 7 ] && [ "${jw[0]}" = LSAJOIN1 ] || die 'join-key 格式不对：应是一行「LSAJOIN1 <子站地址> <隧道公钥> <升级公钥> <校验>」'
  [ "$(printf '%s' "${jw[*]:0:6}" | sha256sum | cut -c1-8)" = "${jw[6]}" ] || die 'join-key 校验不对：粘贴不完整或抄错了'
  SPADDR="${jw[1]}"
  JOINKEY_B64="$(printf '%s' "$JOINKEY" | base64 -w0)"
fi

# ---------- 口令（只在内存）与 SSH ----------
CTL="$(mktemp -d "${TMPDIR:-/tmp}/lsa-field.XXXXXX")" || die '建不了临时目录'
chmod 700 "$CTL"
printf '#!/bin/sh\nprintf "%%s\\n" "$LSA_FIELD_PW"\n' > "$CTL/askpass"; chmod 700 "$CTL/askpass"
export SSH_ASKPASS="$CTL/askpass" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-:0}"
TEMP_ADDED=''
cleanup() {
  local s
  for s in "$CTL"/cm-*; do [ -S "$s" ] && ssh -o ControlPath="$s" -O exit x >/dev/null 2>&1; done
  rm -rf "$CTL"
  [ -n "$TEMP_ADDED" ] && ip addr del "$TEMP_ADD" dev "$TEMP_DEV" 2>/dev/null && echo "已删掉临时地址 $TEMP_ADD（$TEMP_DEV）"
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM
has_tty() { { : < /dev/tty; } 2>/dev/null; }
ask_pw() {
  if [ -n "${LSA_EG_PW:-}" ] && [ "${1:-}" != again ]; then export LSA_FIELD_PW="$LSA_EG_PW"; unset LSA_EG_PW; return 0; fi
  has_tty || die '没有终端，问不了口令'
  local p=''
  read -r -s -p "EG 维护账号 lsaadmin 的口令（不显示、不保存）：" p < /dev/tty || true
  echo > /dev/tty
  [ -n "$p" ] || die '没输口令'
  export LSA_FIELD_PW="$p"
}
ask_pw

# sshx <别名> <地址> <命令>：别名 new<N> = 第一次在 .250 上连（记下主机密钥到临时文件）；别名 = SN 时按这台钉住的主机密钥严格核对
sshx() {
  local a="$1" h="$2" kh strict hka; shift 2
  if [[ "$a" == new* ]]; then kh="$CTL/kh-$a"; strict=accept-new; hka="lsa-field-$a"
  else kh="$SD/$a/known_hosts"; strict=yes; hka="lsaeg-$a"; fi
  ssh -o ControlMaster=auto -o ControlPath="$CTL/cm-$a-$h" -o ControlPersist=600 \
    -o HostKeyAlias="$hka" -o UserKnownHostsFile="$kh" -o StrictHostKeyChecking="$strict" -o HashKnownHosts=no -o GlobalKnownHostsFile=/dev/null \
    -o PreferredAuthentications=publickey,keyboard-interactive,password -o NumberOfPasswordPrompts=1 \
    -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o LogLevel=ERROR "lsaadmin@$h" "$@"
}
ssh_close() { ssh -o ControlPath="$CTL/cm-$1-$2" -O exit x >/dev/null 2>&1 || true; rm -f "$CTL/cm-$1-$2"; }

# 在 EG 上用 sudo 跑的那段：每次临时传过去（base64 进命令行）、跑完删掉；口令从管道喂给 sudo -S（-k：不用缓存，每次都读）
HELPER="$(cat <<'HELPER_EOF'
set -uo pipefail
R="${LSA_FIELD_ROOT:-}"            # 只给沙箱测试用（假 EG 的根目录）；真机上为空
ST="$R/var/lib/lsa-field"
RD="$R/var/tmp/lsa-field"
mkdir -p "$ST" && chmod 700 "$ST"
has_systemd() { [ -d /run/systemd/system ] && command -v systemd-run >/dev/null; }
# bg <单元名> <延时秒> <脚本>：后台跑，SSH 断了照跑（有 systemd 用 systemd-run，没有用 setsid nohup）
bg() {
  if has_systemd; then
    if [ "$2" -gt 0 ]; then systemd-run --quiet --collect --unit "$1" --on-active="${2}s" /bin/bash "$3"
    else systemd-run --quiet --collect --unit "$1" /bin/bash "$3"; fi
  else setsid nohup bash -c "sleep $2; exec bash '$3'" > /dev/null 2>&1 < /dev/null & fi
}
verb="${1:-}"; shift || true
case "$verb" in
  probe)
    echo "hostname=$(hostname 2>/dev/null || cat "$R/etc/hostname")"
    echo "machine_id=$(cat "$R/etc/machine-id" 2>/dev/null || true)"
    ( . "$R/etc/os-release" 2>/dev/null; echo "os_id=${ID:-?}"; echo "os_ver=${VERSION_ID:-?}"; echo "os_name=${PRETTY_NAME:-?}" )
    echo "arch=$(uname -m)"
    echo "epoch=$(date +%s)"
    echo "free_kb=$(df -Pk "$R/var/tmp" | awk 'NR == 2 { print $4 }')"
    echo "eg_version=$(cat "$R/opt/lsa-eg/VERSION" 2>/dev/null || true)"
    [ -f "$R/opt/lsa-eg/config/eg.yaml" ] && echo joined=1 || echo joined=0
    echo "join_sp=$(sed -n 's/.*"sp" *: *"\([^"]*\)".*/\1/p' "$R/opt/lsa-eg/config/join.json" 2>/dev/null | head -1)"
    ip -br link 2>/dev/null | while read -r name _ mac flags; do
      name="${name%%@*}"
      case "$name" in lo | docker* | veth* | br-* | virbr* | tailscale* | wg*) continue ;; esac
      c=0; [[ "$flags" == *LOWER_UP* ]] && c=1
      a="$(ip -br -4 addr show dev "$name" 2>/dev/null | awk '{ for (i = 3; i <= NF; i++) printf "%s%s", (i > 3 ? "," : ""), $i }')"
      echo "nic=$name|$mac|$c|$a"
    done || true ;;
  readdress)   # readdress <令牌> <LAN2> <地址/前缀> <网关|-> <LAN1> <LAN1地址|-> <换回秒数>
    tok="$1" l2="$2" a2="$3" gw="$4" l1="$5" a1="$6" rs="$7"
    np="$R/etc/netplan"
    mkdir -p "$np"
    [ -d "$ST/netplan.orig" ] || { mkdir -p "$ST/netplan.orig" && cp -a "$np/." "$ST/netplan.orig/"; }
    bk="$ST/netplan.prev-$tok"; rm -rf "$bk"; mkdir -p "$bk"; cp -a "$np/." "$bk/"
    {
      echo "# LSA-9600EG 网口（field-install-egs.sh $(date '+%F %T') 写；出厂原文件在 /var/lib/lsa-field/netplan.orig/）"
      echo 'network:'
      echo '  version: 2'
      echo '  ethernets:'
      echo "    $l2:"
      echo '      dhcp4: false'
      echo "      addresses: [$a2]"
      [ "$gw" = - ] || echo "      routes: [{to: default, via: $gw}]"
      echo '      optional: true'
      echo "    $l1:"
      echo '      dhcp4: false'
      if [ "$a1" != - ]; then echo "      addresses: [$a1]"; echo '      ignore-carrier: true'; fi
      echo '      optional: true'
    } > "$ST/new-$tok.yaml"
    rm -f "$np"/*.yaml
    install -m 600 "$ST/new-$tok.yaml" "$np/50-lsa-eg.yaml"
    if ! out="$(netplan generate 2>&1)"; then
      rm -f "$np"/*.yaml; cp -a "$bk/." "$np/"
      echo "ERR netplan generate 不过（已恢复原文件）：$(tr '\n' ' ' <<< "$out" | cut -c1-200)"; exit 3
    fi
    printf '%s\n' '#!/bin/bash' "[ -f '$ST/confirmed-$tok' ] && exit 0" "rm -f '$np'/*.yaml; cp -a '$bk/.' '$np/'; netplan apply" \
      "echo \"\$(date '+%F %T') 改地址 $tok 没确认，已换回原来的网口配置\" >> '$ST/revert.log'" > "$ST/revert-$tok.sh"
    printf '%s\n' '#!/bin/bash' 'netplan apply' > "$ST/apply-$tok.sh"
    bg "lsa-field-revert-$tok" "$rs" "$ST/revert-$tok.sh" || { echo 'ERR 定不了自动换回（systemd-run 失败），没改地址'; rm -f "$np"/*.yaml; cp -a "$bk/." "$np/"; exit 3; }
    bg "lsa-field-apply-$tok" 2 "$ST/apply-$tok.sh"
    echo "OK readdress $tok" ;;
  confirm)
    touch "$ST/confirmed-$1"
    has_systemd && systemctl stop "lsa-field-revert-$1.timer" > /dev/null 2>&1
    echo "OK confirm $1" ;;
  settime)
    date -s "@$1" > /dev/null && { command -v hwclock > /dev/null && hwclock -w 2> /dev/null; true; } && echo "OK settime $(date '+%F %T')" ;;
  install)     # install <安装文件名> <sha256> <LAN1> <join-key 的 base64>
    run="$RD/$1" sha="$2" l1="$3" jk="$(base64 -d <<< "$4")" force=''
    # 只给沙箱用：容器里没有物理网口，install.sh 不加 --force 不收 --lan1（deploy/test/field-install-real.sh）
    [ "${LSA_FIELD_RUN_FORCE:-}" = 1 ] && force=' --force'
    if [ -f "$ST/install.pid" ] && kill -0 "$(cat "$ST/install.pid")" 2> /dev/null; then echo 'OK install running'; exit 0; fi
    if [ "$(cat "$ST/install.rc" 2> /dev/null)" = 0 ] && [ "$(cat "$ST/install.sha" 2> /dev/null)" = "$sha" ]; then echo 'OK install already'; exit 0; fi
    [ -f "$run" ] || { echo "ERR 没有 $run"; exit 3; }
    [ "$(sha256sum "$run" | cut -d' ' -f1)" = "$sha" ] || { echo 'ERR 安装文件 sha256 不对'; exit 3; }
    printf '%s\n' '#!/bin/bash' "echo \$\$ > '$ST/install.pid'" \
      "LSA_TMP='$R/var/tmp' bash '$run' --role eg --lan1 $(printf %q "$l1") --join-key $(printf %q "$jk") --yes$force >'$ST/install.log' 2>&1 < /dev/null" \
      "echo \$? > '$ST/install.rc.tmp'; mv '$ST/install.rc.tmp' '$ST/install.rc'; rm -f '$ST/install.pid'" > "$ST/install-job.sh"
    rm -f "$ST/install.rc"; echo "$sha" > "$ST/install.sha"; date +%s > "$ST/install.started"
    bg "lsa-field-install-$(date +%s)" 0 "$ST/install-job.sh" || { echo 'ERR 起不了安装任务'; exit 3; }
    echo 'OK install started' ;;
  istatus)
    echo "elapsed=$(( $(date +%s) - $(cat "$ST/install.started" 2> /dev/null || date +%s) ))"
    if [ -f "$ST/install.pid" ] && kill -0 "$(cat "$ST/install.pid")" 2> /dev/null; then echo state=running
    elif [ -f "$ST/install.rc" ]; then echo state=done; echo "rc=$(cat "$ST/install.rc")"
    elif [ -f "$ST/install.started" ] && [ $(( $(date +%s) - $(cat "$ST/install.started") )) -lt 30 ]; then echo state=running
    else echo state=none; fi
    echo "last=$(tail -n 1 "$ST/install.log" 2> /dev/null | cut -c1-150)" ;;
  ilog) tail -n "${1:-60}" "$ST/install.log" 2> /dev/null ;;
  verify)
    [ -f "$R/opt/lsa-eg/install.sh" ] || { echo 'ERR /opt/lsa-eg/install.sh 不在：没装上'; exit 3; }
    out="$(cd "$R/opt/lsa-eg" && bash install.sh --status 2>&1 < /dev/null)"
    echo "join_line=$(grep -m1 '接入：' <<< "$out" || true)"
    echo "eg_version=$(cat "$R/opt/lsa-eg/VERSION" 2> /dev/null || true)" ;;
  cleanup) rm -f "$RD/$1"; rmdir "$RD" 2> /dev/null; echo 'OK cleanup' ;;
  *) echo "ERR 不认识：$verb"; exit 2 ;;
esac
HELPER_EOF
)"
HELPER_B64="$(printf '%s\n' "$HELPER" | base64 -w0)"
rsudo() {  # rsudo <别名> <地址> <动作> [参数…]
  local a="$1" h="$2" q; shift 2
  q="$(printf '%q ' "$@")"
  printf '%s\n' "$LSA_FIELD_PW" | sshx "$a" "$h" "f=\$(mktemp) && echo $HELPER_B64 | base64 -d > \$f && sudo -k -S -p '' bash \$f $q; rc=\$?; rm -f \$f; exit \$rc"
}
tcp_open() {
  if [ -n "$TCP_CMD" ]; then $TCP_CMD "$1" "$2"; return; fi
  timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}
flush_arp() { [ "$(id -u)" = 0 ] && command -v ip >/dev/null && ip neigh flush to "$TEMP_IP" >/dev/null 2>&1; return 0; }
# dup_temp <这台 LAN2 的 MAC>：打印 .250 上别的 MAC（没有就空）。看本机 ARP 表（连之前清过，连上后就是应答的那台）；
# 有 arping（iputils，要 root）再广播问 3 次。两样都没有就不查
dup_temp() {
  local mine="$1" seen dev
  command -v ip >/dev/null || return 0
  seen="$(ip neigh show "$TEMP_IP" 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "lladdr") print tolower($(i + 1)) }' || true)"
  if [ "$(id -u)" = 0 ] && command -v arping >/dev/null; then
    dev="$(ip route get "$TEMP_IP" 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }' || true)"
    [ -z "$dev" ] || seen="$seen
$(timeout 6 arping -c 3 -w 4 -I "$dev" "$TEMP_IP" 2>/dev/null | grep -o '\[[0-9A-Fa-f:]*\]' | tr -d '[]' | tr 'A-F' 'a-f' || true)"
  fi
  grep -v -x -e "$mine" -e '' <<< "$seen" | sort -u | tr '\n' ' ' | sed 's/ $//' || true
}
auth_fail() { grep -q -e 'Permission denied' -e 'incorrect password' -e 'Sorry, try again' <<< "$1"; }

# ---------- 会话日志 ----------
SESSION="$SD/run-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$SESSION") 2>&1
exec 3>&1
ev() { local sn="$1"; shift; echo "$(ts) [$sn] $*" >&3; [ -d "$SD/$sn" ] && echo "$(ts) $*" >> "$SD/$sn/log"; return 0; }
echo "== $(ts) field-install-egs.sh：分配表 $PLAN（${#P_ORDER[@]} 台），状态 $SD"
[ -n "$RUN" ] && echo "   安装文件 $RUNNAME（sha256 ${SHA:0:16}…），join-key 子站 $SPADDR，后台并发 $PAR"
echo "   LAN1 地址 $LAN1_ADDR；改地址 ${REVERT_S} s 连不回来自动换回；EG 时钟差 > 60 s $([ "$SETTIME" = 1 ] && echo 校成本机时间 || echo 只提醒)"

# ---------- 阶段 A：在 .250 上认机器、改地址（一次一台）----------
NEWN=0 CUR_SN=''
declare -A HOLD=()
stage_a() {
  local a o rc host sn line nics l2='' l1='' cand=() mid key f s other d tok want addr gw l2mac dupmac
  NEWN=$((NEWN + 1)); a="new$NEWN"; CUR_SN=''
  flush_arp
  o="$(rsudo "$a" "$TEMP_IP" probe 2>&1)"; rc=$?
  if [ "$rc" != 0 ] && auth_fail "$o" && has_tty; then
    echo "$(ts) 登录 / sudo 不过（口令不对？）：再输一次"; ask_pw again
    ssh_close "$a" "$TEMP_IP"; o="$(rsudo "$a" "$TEMP_IP" probe 2>&1)"; rc=$?
  fi
  if [ "$rc" != 0 ] || ! grep -q '^hostname=' <<< "$o"; then
    echo "$(ts) [$TEMP_IP] 连不上 / 读不了：$(tail -2 <<< "$o" | tr '\n' ' ' | cut -c1-160)"; ssh_close "$a" "$TEMP_IP"; return 1
  fi
  host="$(kv hostname "$o")"; sn="${ONE_SN:-${host#lsaeg-}}"
  if [ -z "${P_ADDR[$sn]+x}" ]; then
    echo "$(ts) [$TEMP_IP] 主机名 $host：SN「$sn」不在分配表里（网口 $(grep '^nic=' <<< "$o" | cut -d'|' -f1,2 | sed 's/^nic=//' | tr '\n' ' ')）—— 补进分配表，或 --once --sn <SN>"
    ssh_close "$a" "$TEMP_IP"; return 1
  fi
  CUR_SN="$sn"; mkdir -p "$SD/$sn"
  if [ -n "${HOLD[$sn]:-}" ]; then
    echo "$(ts) [$sn] 又回到 $TEMP_IP 了（刚才改地址后连不回来、已自动换回）：不自动重做 —— 查清后输入 r 回车重做"; ssh_close "$a" "$TEMP_IP"; return 1
  fi
  ev "$sn" "在 $TEMP_IP 上：主机名 $host，$(kv os_name "$o")，machine-id $(kv machine_id "$o" | cut -c1-12)"
  grep '^nic=' <<< "$o" | sed 's/^nic=/  网口 /' >> "$SD/$sn/log"
  # 主机密钥：这次在 .250 上看到的 vs 这台以前钉住的；和别的 SN 一样 = 克隆没换主机密钥
  key="$(awk 'NF >= 3 { print $2, $3; exit }' "$CTL/kh-$a" 2>/dev/null)"
  [ -n "$key" ] || { ev "$sn" "!! 没拿到主机密钥"; ssh_close "$a" "$TEMP_IP"; return 1; }
  if [ -f "$SD/$sn/known_hosts" ]; then
    if [ "$(awk '{ print $2, $3; exit }' "$SD/$sn/known_hosts")" != "$key" ]; then
      ev "$sn" "!! 主机密钥和上次记下的不一样：换了机器 / 重装了系统？确认后 --redo $sn 重新做"; st_set "$sn" note '主机密钥变了（--redo 重做）'; ssh_close "$a" "$TEMP_IP"; return 1
    fi
  else echo "lsaeg-$sn $key" > "$SD/$sn/known_hosts"; chmod 600 "$SD/$sn/known_hosts"; fi
  for f in "$SD"/*/known_hosts; do
    other="$(basename "$(dirname "$f")")"
    [ "$other" != "$sn" ] && [ "$(awk '{ print $2, $3; exit }' "$f")" = "$key" ] &&
      ev "$sn" "！ 主机密钥和 $other 一样：克隆后没换主机密钥（手册 §8 第 3 步）。照常继续，建议之后在这台上重新生成"
  done
  mid="$(kv machine_id "$o")"
  if [ "$(st_get "$sn" phase)" = pending ] || [ "$(st_get "$sn" phase)" = joined ]; then
    if [ -n "$(st_get "$sn" machine_id)" ] && [ "$(st_get "$sn" machine_id)" != "$mid" ]; then
      ev "$sn" "!! 主机名 $host 和已经做完的 $sn 一样，但不是同一台（machine-id 不同）：克隆后没改主机名？在这台上改好主机名再来"
    else ev "$sn" "这台已经做过（$(zh_phase "$(st_get "$sn" phase)")），怎么又在 $TEMP_IP 上？不重做（确实要重做 --redo $sn）"; fi
    ssh_close "$a" "$TEMP_IP"; return 1
  fi
  # 系统
  if [ "$(kv os_id "$o")" != ubuntu ] || [ "$(kv os_ver "$o")" != 24.04 ] || [ "$(kv arch "$o")" != x86_64 ]; then
    ev "$sn" "!! 系统是 $(kv os_name "$o")（$(kv arch "$o")）：只支持 Ubuntu Server 24.04 x86_64，退回厂家"; st_set "$sn" phase failed-a note '系统不对'; ssh_close "$a" "$TEMP_IP"; return 1
  fi
  # 网口：持有 .250 的是 LAN2，另一个 en*/eth* 口是 LAN1
  while IFS='|' read -r line _ _ addrs; do
    line="${line#nic=}"
    [[ ",$addrs," == *",$TEMP_IP/"* ]] && l2="$line"
    case "$line" in en* | eth*) cand+=("$line") ;; esac
  done < <(grep '^nic=' <<< "$o")
  [ -n "$l2" ] || { ev "$sn" "!! 找不到持有 $TEMP_IP 的网口"; ssh_close "$a" "$TEMP_IP"; return 1; }
  # 临时地址查重：本机 ARP 表里 .250 的 MAC 要就是这台 LAN2 的（两台同时接着、或站内网就是 192.168.1.x 时有别的机器占着 .250 → 停下）
  l2mac="$(grep "^nic=$l2|" <<< "$o" | cut -d'|' -f2 | tr 'A-F' 'a-f' || true)"
  dupmac="$(dup_temp "$l2mac")"
  if [ -n "$dupmac" ]; then
    ev "$sn" "!! $TEMP_IP 上不止这一台（还有 MAC $dupmac；这台 LAN2 是 $l2mac）：一次只接一台新机，查清后 r 重做"
    st_set "$sn" note "临时地址 $TEMP_IP 有重复（$dupmac）"; ssh_close "$a" "$TEMP_IP"; return 1
  fi
  for s in "${cand[@]}"; do [ "$s" != "$l2" ] && l1="${l1:+$l1 }$s"; done
  want="${P_LAN1[$sn]}"
  if [ "$want" != - ]; then
    [ "$want" != "$l2" ] || { ev "$sn" "!! 分配表的 LAN1 网口 $want 正是持有 $TEMP_IP 的口（LAN2）：LAN1 / LAN2 插反了，或记录表写错了"; st_set "$sn" phase failed-a note 'LAN1/LAN2 对不上'; ssh_close "$a" "$TEMP_IP"; return 1; }
    grep -q "^nic=$want|" <<< "$o" || { ev "$sn" "!! 分配表的 LAN1 网口 $want 这台上没有（有：${cand[*]}）"; st_set "$sn" phase failed-a note "没有网口 $want"; ssh_close "$a" "$TEMP_IP"; return 1; }
    l1="$want"
  elif [ "$(wc -w <<< "$l1")" != 1 ]; then
    ev "$sn" "!! 认不出 LAN1（除了 LAN2 $l2 还有：${l1:-没有}）：在分配表第 5 列写明 LAN1 网口"; st_set "$sn" phase failed-a note '认不出 LAN1'; ssh_close "$a" "$TEMP_IP"; return 1
  fi
  addr="${P_ADDR[$sn]}"; gw="${P_GW[$sn]}"
  # 正式地址上已经有别的机器
  if tcp_open "${addr%/*}" 22 || tcp_open "${addr%/*}" 80; then
    ev "$sn" "!! ${addr%/*} 上已经有机器应答（22 / 80 口）：地址冲突，先查清"; st_set "$sn" phase failed-a note '正式地址被占'; ssh_close "$a" "$TEMP_IP"; return 1
  fi
  d=$(( $(kv epoch "$o") - $(date +%s) ))
  st_set "$sn" hostname "$host" machine_id "$mid" lan2 "$l2" lan1 "$l1" addr "$addr" gw "$gw" \
    macs "$(grep '^nic=' <<< "$o" | cut -d'|' -f1,2 | sed 's/^nic=//' | tr '\n' ' ')"
  echo
  echo "  SN $sn → LAN2 $l2 改成 $addr（网关 $gw），LAN1 $l1 配 $LAN1_ADDR，单元 ${P_UNIT[$sn]}；EG 时钟差 ${d} s"
  if [ "$YES" != 1 ] && has_tty; then
    local ans=''
    read -r -p "  回车开始改地址，s 跳过这台：" ans < /dev/tty || true
    if [ "$ans" = s ]; then ev "$sn" "跳过（操作员）"; ssh_close "$a" "$TEMP_IP"; return 1; fi
  fi
  if [ "${d#-}" -gt 60 ]; then
    if [ "$SETTIME" = 1 ]; then o="$(rsudo "$a" "$TEMP_IP" settime "$(date +%s)" 2>&1)"; ev "$sn" "时钟差 ${d} s：已校成本机时间（$(tail -1 <<< "$o")）"
    else ev "$sn" "！ EG 时钟差 ${d} s（子站主机上跑或 --set-time 会自动校）"; fi
  fi
  tok="$(date +%s)$RANDOM"
  o="$(rsudo "$a" "$TEMP_IP" readdress "$tok" "$l2" "$addr" "$gw" "$l1" "$( [ "$LAN1_ADDR" = none ] && echo - || echo "$LAN1_ADDR")" "$REVERT_S" 2>&1)"
  if ! grep -q "^OK readdress $tok" <<< "$o"; then
    ev "$sn" "!! 改地址没成功：$(tail -1 <<< "$o")"; st_set "$sn" phase failed-a note "改地址没成功：$(tail -1 <<< "$o" | cut -c1-80)"; ssh_close "$a" "$TEMP_IP"; return 1
  fi
  ssh_close "$a" "$TEMP_IP"
  st_set "$sn" phase readdressing note "令牌 $tok"
  ev "$sn" "netplan 已写，2 s 后生效；等它在 ${addr%/*} 上连回来（最多 ${RECONNECT_S} s）"
  local t_end=$(( $(date +%s) + RECONNECT_S )) up=0
  while [ "$(date +%s)" -lt "$t_end" ]; do
    sleep 3
    tcp_open "${addr%/*}" 22 && { up=1; break; }
  done
  if [ "$up" = 1 ]; then
    o="$(rsudo "$sn" "${addr%/*}" probe 2>&1)"
    if [ "$(kv hostname "$o")" = "$host" ] && grep -q "^nic=$l2|.*[|,]${addr}\(,\|$\)" <<< "$o"; then
      o="$(rsudo "$sn" "${addr%/*}" confirm "$tok" 2>&1)"
      if grep -q "^OK confirm" <<< "$o"; then
        st_set "$sn" phase readdressed note "LAN2 $l2 ${addr}，LAN1 $l1"
        ev "$sn" "地址已改好：${addr}（同一把主机密钥、同一台），撤掉了自动换回"
        CUR_SN="$sn"; return 0
      fi
      ev "$sn" "!! 撤自动换回没成功（$(tail -1 <<< "$o")）：${REVERT_S} s 后它会换回 $TEMP_IP"
    else ev "$sn" "!! ${addr%/*} 上连上的不是这台 / 地址不对：$(tail -2 <<< "$o" | tr '\n' ' ' | cut -c1-160)"; fi
  else ev "$sn" "!! ${RECONNECT_S} s 内在 ${addr%/*} 上连不回来（网关 / 前缀 / 交换机网段不对？）"; fi
  HOLD[$sn]=1
  st_set "$sn" phase failed-a note "改地址后连不回来：EG 在令牌 $tok 下 ${REVERT_S} s 后自动换回 $TEMP_IP，修好分配表后重做"
  ev "$sn" "这台会在改地址后 ${REVERT_S} s 自动换回 $TEMP_IP；查清后等它回到 $TEMP_IP 再按 r 重做"
  return 1
}

# ---------- 阶段 B：在正式地址上推 .run、装、核对（后台，一台一个子 shell）----------
stage_b() {
  local sn="$1" h o rc rsz need tries=0 t0 t_end st ph jl free_kb
  exec >> "$SD/$sn/log" 2>&1
  h="$(st_get "$sn" addr)"; h="${h%/*}"
  fail() { st_set "$sn" phase failed-b note "$1"; ev "$sn" "!! $1"; exit 1; }
  B_SN="$sn"; trap 'case "$(st_get "$B_SN" phase)" in pending | joined | failed-b) ;; *) st_set "$B_SN" phase failed-b note "安装段意外退出（看 $SD/$B_SN/log）"; ev "$B_SN" "!! 安装段意外退出（看 $SD/$B_SN/log），--resume 重来" ;; esac' EXIT
  ev "$sn" "开始安装（$h）"
  o="$(rsudo "$sn" "$h" probe 2>&1)" || fail "连不上 $h：$(tail -1 <<< "$o")"
  [ "$(kv hostname "$o")" = "$(st_get "$sn" hostname)" ] || fail "$h 上的主机名是 $(kv hostname "$o")，不是 $(st_get "$sn" hostname)"
  free_kb="$(kv free_kb "$o")"; [[ "$free_kb" =~ ^[0-9]+$ ]] || free_kb=0
  # 推送：按已收字节续传，断了重试（最多 3 次），推完核 sha256
  st_set "$sn" phase pushing note "推送 $RUNNAME"
  while :; do
    tries=$((tries + 1))
    rsz="$(sshx "$sn" "$h" "d=\${LSA_FIELD_ROOT:-}/var/tmp/lsa-field; mkdir -p \$d && chmod 700 \$d && stat -c %s \$d/$RUNNAME 2>/dev/null || echo 0" 2>&1 | tail -1)"
    [[ "$rsz" =~ ^[0-9]+$ ]] || { [ "$tries" -lt 3 ] && { sleep 5; continue; }; fail "查 EG 上已收多少没成功：$rsz"; }
    if [ "$rsz" -gt "$SIZE" ]; then sshx "$sn" "$h" "rm -f \${LSA_FIELD_ROOT:-}/var/tmp/lsa-field/$RUNNAME"; rsz=0; fi
    if [ "$rsz" = 0 ]; then
      need=$(( SIZE / 1024 * 2 + 1536 * 1024 ))
      [ "$free_kb" -ge "$need" ] || fail "EG 的 /var/tmp 只剩 $(( free_kb / 1024 )) MB，要约 $(( need / 1024 )) MB"
    fi
    if [ "$rsz" -lt "$SIZE" ]; then
      ev "$sn" "推送 $RUNNAME：$([ "$rsz" -gt 0 ] && echo "从 $((rsz / 1024 / 1024)) MB 处续传，")还有 $(( (SIZE - rsz) / 1024 / 1024 )) MB"
      t0=$(date +%s)
      tail -c +"$((rsz + 1))" "$RUN" | sshx "$sn" "$h" "cat >> \${LSA_FIELD_ROOT:-}/var/tmp/lsa-field/$RUNNAME"; rc=$?
      if [ "$rc" != 0 ]; then
        [ "$tries" -lt 3 ] || fail "推送断了 3 次（最后：退出码 $rc）：之后 --resume 续传"
        ev "$sn" "推送断了（退出码 $rc），5 s 后续传"; sleep 5; ssh_close "$sn" "$h"; continue
      fi
      ev "$sn" "推送完（$(( $(date +%s) - t0 )) s），核 sha256"
    fi
    o="$(sshx "$sn" "$h" "sha256sum \${LSA_FIELD_ROOT:-}/var/tmp/lsa-field/$RUNNAME" 2>&1 | tail -1)"
    [ "${o%% *}" = "$SHA" ] && break
    sshx "$sn" "$h" "rm -f \${LSA_FIELD_ROOT:-}/var/tmp/lsa-field/$RUNNAME"
    [ "$tries" -lt 3 ] || fail "EG 上收到的 sha256 一直不对（${o:0:16}…）"
    ev "$sn" "EG 上的 sha256 不对（${o:0:16}…），删掉重推"
  done
  ev "$sn" "安装文件已到（sha256 对）"
  # 装：EG 上后台跑（SSH 断了照装），每 POLL_S 查一次
  o="$(rsudo "$sn" "$h" install "$RUNNAME" "$SHA" "$(st_get "$sn" lan1)" "$JOINKEY_B64" 2>&1)"
  grep -q '^OK install' <<< "$o" || fail "EG 上没开始装：$(tail -1 <<< "$o")"
  st_set "$sn" phase installing note '安装中'
  case "$o" in *already*) ev "$sn" "这个安装文件已经装过，直接核对" ;; *running*) ev "$sn" "EG 上安装已在跑，接着查" ;; *) ev "$sn" "EG 上开始装：--role eg --lan1 $(st_get "$sn" lan1) --join-key …" ;; esac
  t_end=$(( $(date +%s) + INSTALL_TIMEOUT_S )); ph=''
  while [ "$(date +%s)" -lt "$t_end" ]; do
    if st="$(rsudo "$sn" "$h" istatus 2>&1)"; then
      ph="$(kv state "$st")"
      echo "$(ts) $ph $(kv elapsed "$st") s：$(kv last "$st")"
      [ "$ph" = running ] || break
    else echo "$(ts) 查不到进度（$(tail -1 <<< "$st")），${POLL_S} s 后再查"; ssh_close "$sn" "$h"; fi
    sleep "$POLL_S"
  done
  echo "--- EG 上安装输出（最后 80 行）"; rsudo "$sn" "$h" ilog 80 2>&1 || true; echo '---'
  [ "$ph" = done ] || fail "${INSTALL_TIMEOUT_S} s 还没装完（${ph:-查不到}）：EG 上 sudo bash /opt/lsa-eg/install.sh --status；之后 --resume 续查"
  [ "$(kv rc "$st")" = 0 ] || fail "安装失败（退出码 $(kv rc "$st")）：输出在 $SD/$sn/log；修好后 --resume 重装"
  o="$(rsudo "$sn" "$h" verify 2>&1)"
  jl="$(kv join_line "$o")"
  echo "核对：$jl（EG $(kv eg_version "$o")）"
  if [[ "$jl" == *待接入*"$SPADDR"* ]] || [[ "$jl" == *已接入* ]]; then :; else fail "装完了但不是待接入：${jl:-install.sh --status 里没有「接入：」}"; fi
  tcp_open "$h" 80 || ev "$sn" "！ 待接入页（$h:80）连不上：浏览器打开看看"
  [ "$KEEP_RUN" = 1 ] || rsudo "$sn" "$h" cleanup "$RUNNAME" >/dev/null 2>&1 || true
  ssh_close "$sn" "$h"
  case "$jl" in *已接入*) st_set "$sn" phase joined note "EG $(kv eg_version "$o")，已接入（以前接过）" ;;
    *) st_set "$sn" phase pending note "EG $(kv eg_version "$o")，待接入子站 $SPADDR" ;; esac
  ev "$sn" "完成：$(zh_phase "$(st_get "$sn" phase)")（EG $(kv eg_version "$o")）"
}

# ---------- 后台队列 ----------
QUEUE=() PIDS=() TOUCHED=() SESSION_FAIL=0
# 退出码：这一次做过的（阶段 A 失败的、进过后台安装的）有失败就是 1；分配表里别的台以前的失败不算
rc_final() { local s; [ "$SESSION_FAIL" = 0 ] || return 1; for s in "${TOUCHED[@]}"; do case "$(st_get "$s" phase)" in failed-*) return 1 ;; esac; done; return 0; }
running_n() { local n=0 p; for p in "${PIDS[@]}"; do kill -0 "$p" 2>/dev/null && n=$((n + 1)); done; echo "$n"; }
pump() {
  while [ ${#QUEUE[@]} -gt 0 ] && [ "$(running_n)" -lt "$PAR" ]; do
    ( stage_b "${QUEUE[0]}" ) &
    TOUCHED+=("${QUEUE[0]}"); PIDS+=($!); QUEUE=("${QUEUE[@]:1}")
  done
}
unfinished() { local s; for s in "${P_ORDER[@]}"; do case "$(st_get "$s" phase)" in readdressed | pushing | installing | failed-b) echo "$s" ;; esac; done; }
summary() {
  local p k
  [ "$MODE" = readdress ] || { while [ ${#QUEUE[@]} -gt 0 ] || [ "$(running_n)" -gt 0 ]; do pump; sleep 2; done; for p in "${PIDS[@]}"; do wait "$p" 2>/dev/null; done; }
  echo; echo "== $(ts) 汇总（分配表 $PLAN）"; status_table
  k="$(write_join_list)"
  echo; echo "join 清单：$SD/join-list.txt（$k 台待接入、有单元号）"
  [ "$MODE" = readdress ] && echo "下一步装软件：sudo bash $0 --plan $PLAN --run <.run> --resume"
  echo "下一步接入（子站主机上）：sudo bash $SP/join-egs.sh --from-file $SD/join-list.txt --plan   然后逐台 join-egs.sh --unit <单元号> --eg <地址>"
  echo "日志：$SESSION；每台 $SD/<SN>/log"
}

# ---------- --resume ----------
if [ "$MODE" = resume ]; then
  mapfile -t QUEUE < <(unfinished)
  [ ${#QUEUE[@]} -gt 0 ] || { echo '没有要续做的（--status 看全表）'; exit 0; }
  echo "续做 ${#QUEUE[@]} 台：${QUEUE[*]}"
  summary
  rc_final; exit $?
  exit 0
fi

# ---------- 能到 .250 吗 ----------
if [ -n "$TEMP_ADD" ]; then
  [ "$(id -u)" = 0 ] && command -v ip >/dev/null || die '--temp-ip 要 root 和 ip 命令'
  [ -n "$TEMP_DEV" ] || TEMP_DEV="$(ip -o -4 addr show 2>/dev/null | awk -v a="$SPADDR" '$4 ~ "^" a "/" { print $2; exit }' || true)"
  [ -n "$TEMP_DEV" ] || die "--temp-ip 要加在哪个网口上？用 --temp-dev <接站内交换机的网口> 给"
  if ip -o -4 addr show dev "$TEMP_DEV" | grep -q " ${TEMP_ADD%/*}/"; then echo "临时地址 $TEMP_ADD 已在 $TEMP_DEV 上"
  else ip addr add "$TEMP_ADD" dev "$TEMP_DEV" || die "加不上临时地址 $TEMP_ADD（$TEMP_DEV）"; TEMP_ADDED=1; echo "已在 $TEMP_DEV 上临时加 $TEMP_ADD（退出时删）"; fi
elif command -v ip >/dev/null; then
  r="$(ip route get "$TEMP_IP" 2>/dev/null | head -1 || true)"
  if [ -z "$r" ] || [[ "$r" == *" via "* ]]; then
    die "本机到 $TEMP_IP 没有直连路由（${r:-没有路由}）：本机在 ${TEMP_CIDR%.*}.x 段加个地址，例如
  sudo ip addr add 192.168.1.251/24 dev <接站内交换机的网口>      （或本脚本加 --temp-ip 192.168.1.251/24 [--temp-dev <网口>]）"
  fi
fi

# 上次改好地址还没装完的：先在后台接着做
if [ "$MODE" != readdress ]; then
  mapfile -t QUEUE < <(unfinished)
  [ ${#QUEUE[@]} -eq 0 ] || echo "$(ts) 上次没装完的 ${#QUEUE[@]} 台在后台接着做：${QUEUE[*]}"
fi

# ---------- 主循环：等 .250 上出现下一台 ----------
DONE_A=0 WAIT_GONE=0 SAID=''
all_done() { local s; for s in "${P_ORDER[@]}"; do case "$(st_get "$s" phase)" in pending | joined) ;; readdressed | pushing | installing) [ "$MODE" = readdress ] || return 1 ;; *) return 1 ;; esac; done; return 0; }
while :; do
  [ "$MODE" = readdress ] || pump
  if all_done; then echo "$(ts) 分配表里的都做完了"; break; fi
  if [ "$COUNT" -gt 0 ] && [ "$DONE_A" -ge "$COUNT" ]; then echo "$(ts) 已做满 $COUNT 台"; break; fi
  if tcp_open "$TEMP_IP" 22; then
    if [ "$WAIT_GONE" = 0 ]; then
      SAID=''
      if stage_a; then
        DONE_A=$((DONE_A + 1))
        [ "$MODE" = readdress ] || QUEUE+=("$CUR_SN")
        [ "$ONCE" = 1 ] && break
      else
        SESSION_FAIL=1
        [ "$ONCE" = 1 ] && break
        WAIT_GONE=1; echo "$(ts) 这台先不做：拔掉它（或修好后在这里输入 r 回车重做）；q 回车结束"
      fi
      continue
    fi
  else
    [ "$WAIT_GONE" = 1 ] && echo "$(ts) $TEMP_IP 上的那台已拿走"
    WAIT_GONE=0
    [ "$ONCE" = 1 ] && { echo "$(ts) $TEMP_IP 上没有机器"; SESSION_FAIL=1; break; }
    if [ "$SAID" != wait ]; then echo "$(ts) 等下一台出现在 $TEMP_IP …（LAN2 接交换机、上电即可；q 回车结束）$([ "$MODE" = readdress ] || echo "  后台：$(running_n) 台在装、${#QUEUE[@]} 台排队")"; SAID=wait; fi
  fi
  cmd=''
  if has_tty && [ -t 0 ]; then read -r -t 2 cmd < /dev/tty || true; else sleep 2; fi
  case "$cmd" in q) echo "$(ts) 结束：不再等新机"; break ;; r) WAIT_GONE=0; SAID=''; HOLD=() ;; esac
done
summary
rc_final; exit $?
exit 0
