#!/bin/bash
# LSA-9600SP 子站主机上一条命令接 EG（0.17.4 一键加柜；0.18.0 起按舱室单元）。在子站主机上用 root 跑：
#
#   sudo bash join-egs.sh --keygen [--sp-addr <子站地址>]
#       生成隧道 key（升级 key 有就复用，和 upgrade-egs.sh 同一把），打印 join-key —— EG 上装软件时带上：
#       sudo bash LSA-9600SP-<版本>.run --role eg --lan1 <网口> --join-key '<这一行>'
#   sudo bash join-egs.sh --unit AH05-A --eg <EG 的 LAN2 地址> [--conv auto | --conv-serial … --sensors … --addr … --dev … --baud …] [--plan] [--force] [--replaced]
#       接一台：预检 → 建实体（provision-eg，走隧道）→ 打配置（pack-eg）→ 推送、生效 → 等它在线、配置生效 → 转换程序 → 撤隧道授权。
#       单元号 = EG 名去掉 EG-（舱室单元 AH05-A；照旧一柜一台的柜单元号就是柜号 AH05）
#   sudo bash join-egs.sh --cabinet AH05 --eg AH05-A=<地址>,AH05-B=<地址> [--plan]
#       这面柜的全部单元依次接（--eg 按单元给地址，键可以只写字母：A=…,B=…；没给的单元用子站记的地址）。照旧一柜一台的柜 = 一台，--eg <地址> 即可
#   sudo bash join-egs.sh --split AH05 --eg A=<地址>,B=<地址> [--plan]
#       拆柜（照旧一柜一台 → 舱室单元，子站部署手册 §5b 的推荐顺序，一条命令走完、断数窗口最短）：
#       先逐台预检要接的 EG（0.7.0 起、待接入，或者就是这面柜原来那台）→ 备份 tb/model.site.yaml、从 legacyEg 去掉这面柜 → up.sh --prod
#       （provision 建 EG-<柜>-A/B…、改挂设备、旧 EG 归档、旧令牌作废 —— 从这一刻起这面柜断数）→ 马上逐台接入 → 汇总断数多久
#   sudo bash join-egs.sh --from-file <清单> --plan
#       一次预检一批（清单每行「单元号 EG地址」，# 开头是注释）；真接入一台一台做
#
# 每一步都可以重跑：建实体、打配置是幂等的；配置和 EG 上现在的一样就跳过、不重启；转换程序、撤隧道也一样。
# 一台失败就停在那一台的那一步，说清用什么命令重来；--cabinet / --split 接着做后面的单元，最后汇总。日志：/var/log/lsa9600sp/eg-join/<单元号>-<时间>/。
# 预检看 EG hello 的 unit=（0.18.0，舱室 EG 方案 §3.2）：待接入（没有 unit）放行；就是这个单元（重装）放行；是别的单元拒绝、--force 才放；
# 只报 cabinet= 的老 EG（0.6.x）当照旧一柜一台，单元号 = 柜号。舱室单元（AH05-A）要 EG 0.7.0 起（老 EG 读不了 eg.yaml schema 2）。
# 换 EG 沿用旧地址（0.8.2）：子站钉着旧机的 SSH 主机密钥，预检认出「主机密钥变了」会提示加 --replaced；
#   加了 --replaced（不是 --plan）就在接入前清掉这个地址的两份旧密钥（升级入口 keys/eg-upgrade.known_hosts、provision 的 tb/provision/out/known_hosts），
#   新旧指纹记到 /var/log/lsa9600sp/eg-join-hostkey.log；只在确认旧机已经换下时用（主机密钥变了也可能是有人冒充）。没加不自动清。
set -uo pipefail
export LC_ALL=C.UTF-8   # 截短提示用 ${x:0:N}：按字符截，不把中文截成半个字
SP=/opt/lsa9600sp
SP_B="$SP/lsa9600sp-backend"
SP_ENV="$SP_B/docker/.env"
SITE_MODEL="$SP_B/tb/model.site.yaml"
KEYDIR="$SP/keys"
UPKEY="$KEYDIR/eg-upgrade_ed25519"
TUNKEY="$KEYDIR/eg-tunnel_ed25519"
KH="$KEYDIR/eg-upgrade.known_hosts"
SPADDR_FILE="$KEYDIR/join-sp-addr"
LOGROOT=/var/log/lsa9600sp/eg-join
POLL_S=10
APPLY_TIMEOUT_S=1800
ONLINE_TIMEOUT_S=180
SPLIT_LIST_TIMEOUT_S=300
TERMINAL=' done rolled-back rollback-failed check-failed failed '

MODE='' TARGET='' EGARG='' PLAN=0 FORCE=0 REPLACED=0 LIST='' SPADDR=''
CONV='' CSER='' CSEN='' CADDR='' CDEV='' CBAUD=''
while [ $# -gt 0 ]; do
  case "$1" in
    --keygen) MODE=keygen ;;
    --sp-addr) SPADDR="${2:?--sp-addr 后面给子站地址}"; shift ;;
    --unit) TARGET="${2:?--unit 后面给单元号}"; MODE=unit; shift ;;
    --cabinet) TARGET="${2:?--cabinet 后面给柜号}"; MODE=cabinet; shift ;;
    --split) TARGET="${2:?--split 后面给柜号}"; MODE=split; shift ;;
    --eg) EGARG="${2:?--eg 后面给 EG 的 LAN2 地址（或 单元=地址,…）}"; shift ;;
    --from-file) LIST="${2:?--from-file 后面给清单文件}"; MODE=batch; shift ;;
    --plan) PLAN=1 ;;
    --force) FORCE=1 ;;
    --replaced) REPLACED=1 ;;
    --conv) CONV="${2:?--conv auto}"; shift ;;
    --conv-serial) CSER="${2:?}"; shift ;;
    --sensors) CSEN="${2:?}"; shift ;;
    --addr) CADDR="${2:?}"; shift ;;
    --dev) CDEV="${2:?}"; shift ;;
    --baud) CBAUD="${2:?}"; shift ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { sed -n '2,25p' "$0"; exit 2; }
[ "$(id -u)" = 0 ] || { echo '要 root：sudo bash join-egs.sh …' >&2; exit 1; }

ts() { date '+%F %T'; }
# 换 EG 沿用旧地址（0.8.2）：子站记的主机密钥两份 —— 升级入口 / 隧道用的、provision 隧道用的
PROV_KH="$SP_B/tb/provision/out/known_hosts"
HOSTKEY_LOG=/var/log/lsa9600sp/eg-join-hostkey.log
hostkey_changed() { grep -q 'REMOTE HOST IDENTIFICATION HAS CHANGED' <<< "$1"; }  # sete-ok：判断函数
# forget_hostkey <地址> <单元号>：确认主机密钥真的变了才清（--replaced 加在正常接入上不误清）；返回 0 清了 / 1 没变不用清
forget_hostkey() {
  local h="$1" u="$2" out old new f
  out="$(sshx "$h" hello 2>&1)"
  hostkey_changed "$out" || return 1
  old="$(ssh-keygen -F "$h" -l -f "$KH" 2>/dev/null | awk '!/^#/ { print $2; exit }')"
  new="$(ssh-keyscan -T 10 -t ed25519 "$h" 2>/dev/null | ssh-keygen -lf - 2>/dev/null | awk '{ print $2; exit }')"
  for f in "$KH" "$PROV_KH"; do [ -f "$f" ] && ssh-keygen -R "$h" -f "$f" >/dev/null 2>&1; done
  mkdir -p "$(dirname "$HOSTKEY_LOG")"
  printf '%s\tby=%s\tunit=%s\teg=%s\told=%s\tnew=%s\t--replaced：清掉两份旧主机密钥（%s、%s）\n' "$(ts)" "${SUDO_USER:-root}" "$u" "$h" "${old:--}" "${new:--}" "$KH" "$PROV_KH" >> "$HOSTKEY_LOG"
  echo "  --replaced：$h 的 SSH 主机密钥变了（旧 ${old:-?} → 新 ${new:-?}），清掉子站记的两份旧密钥，记在 $HOSTKEY_LOG"
  return 0
}
stamp() { date +%Y%m%d-%H%M%S; }
envget() { grep -E "^$1=" "$SP_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
kv() { sed -n "s/^$1=//p" <<< "$2" | tail -1; }
sp_addr() { [ -n "$SPADDR" ] && { echo "$SPADDR"; return; }; [ -f "$SPADDR_FILE" ] && { cat "$SPADDR_FILE"; return; }; envget SP_HOST_IP; }
sshx() {  # 升级入口（lsa-upg）：EG 那边不管发什么都只进 lsa-eg-upgrade
  local h="$1"; shift
  ssh -i "$UPKEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KH" \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o LogLevel=ERROR "lsa-upg@$h" "$*"
}
# 隧道账号能不能认上：lsa-sp 没有 shell，认上了也只回「not available」（退出码 1）；没授权是 Permission denied（255）
tunnel_ok() {
  local out rc
  out="$(ssh -i "$TUNKEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KH" -o ConnectTimeout=10 -o LogLevel=ERROR "lsa-sp@$1" true 2>&1)"; rc=$?
  [ "$rc" != 255 ] && ! grep -q 'Permission denied' <<< "$out"  # sete-ok：判断函数，返回 1 就是认不上
}
# 单元号：舱室单元「柜号-字母」（AH05-A）；照旧一柜一台的单元号 = 柜号
is_unit_code() { [[ "$1" =~ ^.+-[A-Z]$ ]]; }  # sete-ok：判断函数

# ---- 子站 eg-list（0.18.0 起一台 EG 一行，code = 单元号、cabCode = 柜号；老子站一柜一行、没有 cabCode）----
#   eglist_rows：每台一行 TSV —— 单元号 柜号 状态 版本 上送正常 配置生效 地址 地址来源
#   返回 0 有；3 扩展服务刚起、还没读全；2 eg-list 不可用。EG_LIST_JSON_CMD 可换取数命令（沙箱测试用）
eglist_rows() {
  local json rc=0
  if [ -n "${EG_LIST_JSON_CMD:-}" ]; then json="$(eval "$EG_LIST_JSON_CMD" 2>/dev/null)" || rc=$?
  else json="$(docker exec lsa-ext node bin/eg-list.mjs --json 2>/dev/null)" || rc=$?; fi
  [ "$rc" = 0 ] || [ "$rc" = 3 ] || return 2
  [ "$rc" = 3 ] && return 3
  docker exec -i lsa-ext node -e '
let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
  let o; try { o = JSON.parse(s) } catch { process.exit(2) }
  for (const e of o.egs || []) {
    let host = ""; try { host = e.egUrl ? new URL(e.egUrl).hostname : "" } catch {}
    console.log([e.code, e.cabCode || e.code, e.state || "-", e.version || "-", String(!!e.uplinkOk), String(!!e.cfgApplied), host || "-", e.egUrlSource || "-"].join("\t"))
  }
})' <<< "$json" || return 2
}
# 这个单元的一行（不含单元号以外的匹配）；返回 4 = 子站没有这个单元
eglist_row() {
  local rows rc=0
  rows="$(eglist_rows)" || rc=$?
  [ "$rc" = 0 ] || return "$rc"
  awk -F'\t' -v c="$1" '$1 == c { print; f = 1 } END { exit f ? 0 : 4 }' <<< "$rows"
}
# 这面柜的全部单元（按 eg-list 的顺序）
units_of() {
  local rows rc=0
  rows="$(eglist_rows)" || rc=$?
  [ "$rc" = 0 ] || return "$rc"
  awk -F'\t' -v c="$1" '$2 == c { print $1 }' <<< "$rows"
}

# ---- --eg：一个地址，或「单元号=地址,…」（键可以只写字母 A=…）----
addr_for() {  # addr_for <单元号> <这次一共几台>
  local u="$1" n="$2" item k v
  if [[ "$EGARG" == *=* ]]; then
    IFS=',' read -r -a items <<< "$EGARG"
    for item in "${items[@]}"; do
      k="${item%%=*}"; v="${item#*=}"
      if [ "$k" = "$u" ] || [ "$k" = "${u##*-}" ]; then echo "$v"; return; fi
    done
  elif [ -n "$EGARG" ] && [ "$n" = 1 ]; then echo "$EGARG"
  fi
}
check_eg_arg() {
  local item v
  [ -n "$EGARG" ] || return 0
  IFS=',' read -r -a items <<< "$EGARG"
  for item in "${items[@]}"; do
    v="${item#*=}"
    [[ "$v" =~ ^[A-Za-z0-9.:-]+$ ]] || { echo "EG 地址不对：$item" >&2; exit 2; }
    if [[ "$item" == *=* ]]; then [[ "${item%%=*}" =~ ^[A-Za-z0-9-]{1,20}$ ]] || { echo "--eg 的单元不对：$item" >&2; exit 2; }; fi
  done
}

# ---------- --keygen ----------
if [ "$MODE" = keygen ]; then
  install -d -m 700 "$KEYDIR"
  for k in "$UPKEY" "$TUNKEY"; do
    if [ -f "$k" ]; then echo "已有 $(basename "$k")（不重新生成）"
    else ssh-keygen -q -t ed25519 -N '' -C "lsa9600sp-$(basename "$k" _ed25519)@$(hostname)" -f "$k" && echo "已生成 $(basename "$k")"; fi
    chmod 600 "$k"
  done
  a="$(sp_addr)"
  [[ "$a" =~ ^[A-Za-z0-9.:-]+$ ]] || { echo "取不到子站地址（docker/.env 的 SP_HOST_IP）：用 --sp-addr <子站站内地址> 给" >&2; exit 1; }
  echo "$a" > "$SPADDR_FILE"
  read -r t1 t2 _ < "$TUNKEY.pub" || true; read -r u1 u2 _ < "$UPKEY.pub" || true
  body="LSAJOIN1 $a $t1 $t2 $u1 $u2"
  sum="$(printf '%s' "$body" | sha256sum | cut -c1-8)"
  echo
  echo "join-key（只有公钥，可以随便传；EG 上整行加引号）："
  echo
  echo "  $body $sum"
  echo
  echo "EG 上（库房或现场，一次）："
  echo "  sudo bash LSA-9600SP-<版本>.run --role eg --lan1 <摄像机网口> --join-key '$body $sum'"
  echo "然后在这台子站上：sudo bash $0 --unit <单元号，如 AH05-A> --eg <那台 EG 的 LAN2 地址>"
  exit 0
fi

[ -f "$UPKEY" ] && [ -f "$TUNKEY" ] || { echo "没有 key：先 sudo bash $0 --keygen" >&2; exit 1; }
A="$(sp_addr)"
check_eg_arg

# ---------- 预检（一台）：输出 key=value，ok=1 才能接 ----------
#   preflight <单元号> <EG 地址> [拆柜的柜号]：给了拆柜的柜号 = 拆柜前预检（子站上还没有这个单元，不查 eg-list；这面柜原来那台可以改作单元）
preflight() {
  local u="$1" h="$2" split="${3:-}" row rc st ver upok cfg host cab hello j jun jsp want_entry=3
  echo "unit=$u"; echo "eg=$h"
  if [ -z "$split" ]; then
    row="$(eglist_row "$u")"; rc=$?
    if [ "$rc" = 4 ]; then
      echo 'ok=0'
      if [ -n "$(units_of "$u" 2>/dev/null)" ]; then echo "why=柜 $u 已经拆成舱室单元（$(units_of "$u" | tr '\n' ' ')）：按单元接（--unit <单元号> 或 --cabinet $u）"
      elif is_unit_code "$u"; then echo "why=子站上没有单元 $u：这面柜还照旧一柜一台（model.site.yaml 的 legacyEg）就先拆柜（--split ${u%-*}），或者单元号写错了"
      else echo "why=柜号 $u 不在子站的 model.yaml 里：先在 model.yaml 加柜，再跑 up.sh"; fi
      return
    fi
    if [ "$rc" = 3 ]; then echo 'ok=0'; echo 'why=子站扩展服务刚起、还没读全：过一两分钟再跑'; return; fi
    if [ "$rc" != 0 ] || [ -z "$row" ]; then echo 'ok=0'; echo 'why=子站 eg-list 不可用（lsa-ext 在跑吗？）'; return; fi
    IFS=$'\t' read -r _ cab st ver upok cfg host _ <<< "$row"
    echo "cabinet=$cab"; echo "sp_state=$st"; echo "sp_version=$ver"
    [ "$cab" != "$u" ] && want_entry=4
    # 这个单元已经有别的 EG 在线
    if [[ "$st" =~ ^(online|degraded|backfill)$ ]] && [ "$host" != - ] && [ "$host" != "$h" ] && [ "$FORCE" != 1 ]; then
      echo 'ok=0'; echo "why=单元 $u 已经有别的 EG（$host）在线：确认要换加 --force"; return
    fi
  else
    echo "cabinet=$split"; want_entry=4
  fi
  hello="$(sshx "$h" hello 2>&1)"; rc=$?
  if [ "$rc" != 0 ] || ! grep -q '^entry=' <<< "$hello"; then
    echo 'ok=0'
    if hostkey_changed "$hello" && [ "$REPLACED" = 1 ]; then echo "why=EG 的 SSH 主机密钥跟子站记的不一样：加了 --replaced，真接入时会先清掉这个地址的旧密钥再预检（--plan 只看不改，不清）"
    elif hostkey_changed "$hello"; then echo "why=EG 的 SSH 主机密钥跟子站记的不一样：如果是换了新机（沿用旧地址），加 --replaced 重跑（接入前清掉这个地址的旧密钥、记日志）；没换机就先查清楚，可能有人冒充"
    elif grep -q 'Permission denied' <<< "$hello"; then echo "why=升级入口没授权：EG 装的时候没带 --join-key，或者带的是别的子站的"
    else hello="$(tr '\n' ' ' <<< "$hello")"; echo "why=连不上 EG：${hello:0:80}（EG 开着吗、地址对吗、22 口通吗）"; fi
    return
  fi
  if ! [ "$(kv entry "$hello")" -ge "$want_entry" ] 2>/dev/null; then
    echo 'ok=0'
    if [ "$want_entry" = 4 ]; then echo "why=EG 版本太老（$(kv eg_version "$hello")，入口 $(kv entry "$hello")）：接舱室单元要 EG 0.7.0 起，先升级"
    else echo "why=EG 版本太老（入口 $(kv entry "$hello")，要 0.17.4 起）：先升级"; fi
    return
  fi
  j="$(kv joined "$hello")"; jsp="$(kv join_sp "$hello")"
  # 已接入的是哪个单元：EG 0.7.0 报 unit=；0.6.x 只报 cabinet=，当照旧一柜一台（单元号 = 柜号）
  jun="$(kv unit "$hello")"; [ -n "$jun" ] || jun="$(kv cabinet "$hello")"
  echo "eg_version=$(kv eg_version "$hello")"; echo "eg_joined=$j"; echo "eg_unit=$jun"
  if [ -n "$jsp" ] && [ "$jsp" != "$A" ]; then echo 'ok=0'; echo "why=这台 EG 授权的是子站 $jsp，不是本机 $A"; return; fi
  [ "$(kv running "$hello")" = 1 ] && { echo 'ok=0'; echo 'why=EG 上有任务正在跑'; return; }
  [ -n "$(kv maint "$hello")" ] && [ "$j" = 0 ] && { echo 'ok=0'; echo "why=EG 在维护：$(kv maint "$hello")"; return; }
  local reuse=0 again=0
  if [ "$j" = 1 ]; then
    if [ "$jun" = "$u" ]; then again=1
    elif [ -n "$split" ] && [ "$jun" = "$split" ]; then reuse=1        # 拆柜：这面柜原来那台改作单元
    elif [ "$FORCE" = 1 ]; then echo "force=1"
    else echo 'ok=0'; echo "why=这台 EG 已接入单元 $jun，不能直接接成 $u（确认要改接加 --force）"; return; fi
  fi
  echo "reuse=$reuse"
  if [ "$again" = 1 ]; then echo 'ok=1'; echo "why=已接入本单元：重跑（各步已做的会跳过）"
  elif tunnel_ok "$h"; then
    echo 'ok=1'
    if [ "$reuse" = 1 ]; then echo "why=这面柜原来那台（单元 $jun），隧道与升级入口都认得上：拆柜后改作 $u"
    elif [ "$j" = 1 ]; then echo "why=--force：这台原来接在单元 $jun，改接 $u"
    else echo 'why=待接入，隧道与升级入口都认得上'; fi
  else echo 'ok=0'; echo "why=隧道账号认不上（EG 的 --join-key 是别的子站的？或者接入后已经撤了：EG 上重跑 install.sh --join-key '<本子站那一行>'）"; fi
}

# 转换程序参数：只拼成 conv 的选项（EG 的入口再按白名单校验一遍）
CONVCMD=''
if [ -n "$CONV$CSER$CSEN$CADDR$CDEV$CBAUD" ]; then
  [ -z "$CONV" ] || [ "$CONV" = auto ] || { echo '--conv 只认 auto（其余用 --conv-serial / --sensors / --addr / --dev / --baud）' >&2; exit 2; }
  CONVCMD='conv'
  [ -n "$CSER" ] && CONVCMD+=" --serial $CSER"
  [ -n "$CSEN" ] && CONVCMD+=" --sensors $CSEN"
  [ -n "$CADDR" ] && CONVCMD+=" --addr $CADDR"
  [ -n "$CDEV" ] && CONVCMD+=" --dev $CDEV"
  [ -n "$CBAUD" ] && CONVCMD+=" --baud $CBAUD"
fi

# ---------- 接一台（在子 shell 里跑：哪一步失败就 exit 1，不影响后面的单元）----------
#   join_one <单元号> <EG 地址> [拆柜的柜号]
join_one() {
  local U="$1" EGH="$2" SPLIT="${3:-}" PF isunit forceword='' out job t_end ph st row ver upok cfg host okl src PKG PSHA PSIZE last rc
  local -a files
  declare -A RES=()
  local STEPS=(provision pack apply online conv tunnel)
  declare -A ZH=([provision]='建实体（provision-eg，走隧道）' [pack]='打配置包（pack-eg）' [apply]='推送并生效配置' [online]='等子站看到在线、配置生效' [conv]='转换程序' [tunnel]='撤隧道授权')
  summary() {
    echo; echo "== $(ts) 汇总：单元 $U ← EG $EGH"
    local i=0 s
    for s in "${STEPS[@]}"; do i=$((i + 1)); echo "  $i. ${ZH[$s]}：${RES[$s]:-没做}"; done
  }
  stop() {  # stop <步骤> <原因> <怎么重来>
    RES[$1]="失败：$2"; summary
    echo; echo "停在「${ZH[$1]}」：$2" >&2
    echo "修好后原样重跑（前面已做完的会跳过）：sudo bash $0 --unit $U --eg $EGH${CONVCMD:+ …（同样的转换程序参数）}" >&2
    [ -n "${3:-}" ] && echo "提示：$3" >&2
    exit 1
  }

  if [ "$REPLACED" = 1 ]; then
    if [ "$PLAN" = 1 ]; then echo "  --replaced：--plan 只看不改，不清旧主机密钥（真接入时才清）"
    elif ! forget_hostkey "$EGH" "$U"; then echo "  --replaced：$EGH 的主机密钥没变，不用清"; fi
  fi
  echo "== $(ts) 预检：单元 $U ← EG $EGH（子站 $A）"
  PF="$(preflight "$U" "$EGH")"   # 拆柜时 up.sh 已经跑过：子站上有这个单元了，照常预检
  sed 's/^/  /' <<< "$PF"
  if [ "$(kv ok "$PF")" != 1 ]; then
    # 拆柜：这面柜原来那台已接在柜号上（单元号 = 柜号），子站这会儿已经没有那个单元 —— 照拆柜预检的口径再看一次
    if [ -n "$SPLIT" ]; then PF="$(preflight "$U" "$EGH" "$SPLIT")"; sed 's/^/  （按拆柜）/' <<< "$PF"; fi
    [ "$(kv ok "$PF")" = 1 ] || { echo; echo "预检不过：$(kv why "$PF")" >&2; exit 1; }
  fi
  [ "$(kv cabinet "$PF")" != "$U" ] && isunit=1 || isunit=0
  { [ "$(kv force "$PF")" = 1 ] || [ "$(kv reuse "$PF")" = 1 ]; } && forceword=' force'

  # 1. 建实体：已接入本单元（重跑）时隧道可能已经撤了 —— 实体当初建过，跳过
  if [ "$(kv eg_joined "$PF")" = 1 ] && [ "$(kv eg_unit "$PF")" = "$U" ] && ! tunnel_ok "$EGH"; then
    RES[provision]='跳过（已接入本单元，隧道已撤；实体当初建过）'
  else
    echo "== $(ts) 1. 建实体"
    # 舱室单元按单元号（provision-eg.sh --unit，0.18.0）；照旧一柜一台的照旧 --cabinet（老子站也认）
    local which='--cabinet'; [ "$isunit" = 1 ] && which='--unit'
    local plog="$BD/provision-$U.log" sysf="$SP_B/tb/provision/out/eg/$U/tb-sysadmin.json" stale
    prov() {
      (cd "$SP_B" && bash scripts/provision-eg.sh "$which" "$U" --ssh "lsa-sp@$EGH" --ssh-key "$TUNKEY" \
        --hook http://host.docker.internal/hooks/alarm --sp "$A" --eg-url "http://$EGH" < /dev/null) 2>&1 | tee "$plog"
      return "${PIPESTATUS[0]}"
    }
    if prov; then RES[provision]='完成'
    # 0.19.0 r2（换机，EG部署包会话旁见）：子站还留着这个单元旧 EG 的系统管理员口令（tb-sysadmin.json），新 EG 的本地 TB 还是出厂口令，
    # provision 按旧口令登录 401。只在这台 EG 还「待接入」时：旧文件挪开、改用出厂口令再试一次（provision 第 1b 步会重新生成口令文件）
    elif [ "$(kv eg_joined "$PF")" = 0 ] && [ -f "$sysf" ] && grep -q '系统管理员 .*登录不上（TB 401' "$plog"; then
      stale="$sysf.stale-$(date +%Y%m%d-%H%M%S)"; mv -f "$sysf" "$stale"
      echo "  这台 EG 还在「待接入」，子站存的系统管理员口令登录不上（401）：多半换过机 —— 改用出厂口令再试一次"
      if prov; then
        rm -f "$stale"
        echo "  换过机，已改用出厂口令：本地 TB 系统管理员口令已重新生成（$sysf），旧口令文件作废"
        RES[provision]='完成（换过机，已改用出厂口令）'
      else
        mv -f "$stale" "$sysf"
        stop provision 'provision-eg.sh 改用出厂口令也没成功（看上面的输出；旧口令文件已放回）' 'EG 的本地 TB 要起来了（待接入页上「本地 TB 已起」）'
      fi
    else stop provision 'provision-eg.sh 没成功（看上面的输出）' 'EG 的本地 TB 要起来了（待接入页上「本地 TB 已起」）'; fi
  fi

  # 2. 打配置包
  echo "== $(ts) 2. 打配置包"
  (cd "$SP_B" && bash scripts/pack-eg.sh --sp "$A" --only "$U" < /dev/null) || stop pack 'pack-eg.sh 没成功' "子站证书的 SAN 里要有 $A（scripts/gen-certs.sh --san）"
  src="$SP_B/dist/eg/$U"
  [ -f "$src/eg.yaml" ] || stop pack "$src/eg.yaml 没生成"
  PKG="$BD/config-$U.tgz"
  files=(eg.yaml); [ -f "$src/sp-ca.pem" ] && files+=(sp-ca.pem)
  tar -czf "$PKG" -C "$src" "${files[@]}" && chmod 600 "$PKG"
  PSHA="$(sha256sum "$PKG" | cut -d' ' -f1)"; PSIZE="$(stat -c %s "$PKG")"
  RES[pack]="完成（${files[*]}，$PSIZE 字节）"

  # 3. 推送、生效（EG 后台做：失败自己换回旧配置）。改接别的单元（--force、拆柜改作单元）带 force
  echo "== $(ts) 3. 推送并生效配置${forceword:+（改接，带 force）}"
  out="$(sshx "$EGH" "put-config $PSHA $PSIZE" < "$PKG" 2>&1)"; echo "$out"
  grep -q "^OK put-config $PSHA" <<< "$out" || stop apply "推送没成功：$(tail -1 <<< "$out")"
  out="$(sshx "$EGH" "apply-config $PSHA$forceword" < /dev/null 2>&1)"; echo "$out"
  if grep -q '^OK apply-config same' <<< "$out"; then RES[apply]='跳过（EG 上已经是这份配置）'
  elif grep -q '^OK apply-config ' <<< "$out"; then
    job="$(awk '/^OK apply-config / { print $3 }' <<< "$out")"
    t_end=$(( $(date +%s) + APPLY_TIMEOUT_S )); ph=''
    while [ "$(date +%s)" -lt "$t_end" ]; do
      if st="$(sshx "$EGH" status < /dev/null 2>&1)"; then
        ph="$(kv phase "$st")"; echo "$(ts) $ph"
        [ "$(kv job "$st")" = "$job" ] && [[ "$TERMINAL" == *" $ph "* ]] && break
      else echo "$(ts) 查不到进度（SSH），${POLL_S} s 后重连"; fi
      sleep "$POLL_S"
    done
    echo '--- EG 上的任务日志（最后 30 行）'; sshx "$EGH" "log 30" < /dev/null 2>&1 || true
    case "$ph" in
      done) RES[apply]="完成（$(kv install_s "$st") s 装、$(kv check_s "$st") s 核对）" ;;
      rolled-back) stop apply "EG 上换配置没成功、已自动换回：$(kv reason "$st")" ;;
      *) stop apply "换配置没做完（${ph:-查不到}）：$(kv reason "$st")" "EG 上：sudo bash /opt/lsa-eg/install.sh --status" ;;
    esac
  else stop apply "EG 没开始换配置：$(tail -1 <<< "$out")"; fi

  # 4. 等子站看到它在线、配置生效
  echo "== $(ts) 4. 等子站看到它在线、配置生效（最多 ${ONLINE_TIMEOUT_S} s）"
  t_end=$(( $(date +%s) + ONLINE_TIMEOUT_S )); okl='' up_at=''
  while [ "$(date +%s)" -lt "$t_end" ]; do
    row="$(eglist_row "$U" || true)"
    IFS=$'\t' read -r _ _ st ver upok cfg host _ <<< "$row" || true
    echo "$(ts) 子站看到：状态 ${st:-?}，版本 ${ver:-?}，上送 ${upok:-?}，配置生效 ${cfg:-?}，地址 ${host:-?}"
    # 第一次看到上送正常的时刻（拆柜断数窗口按它算，0.7.1）；没看到之前 5 s 查一次，之后等配置生效 15 s 一次
    if [ "$upok" = true ] && [ -z "$up_at" ]; then up_at=$(date +%s); echo "uplink_at=$up_at" >> "$BD/state"; fi
    [ "$upok" = true ] && [ "$cfg" = true ] && { okl=1; break; }
    if [ -z "$up_at" ]; then sleep 5; else sleep 15; fi
  done
  [ -n "$okl" ] && RES[online]="完成（$st，$ver）" || stop online '子站没看到它上送正常 / 配置生效' '看网关页这台的「上送」「配置」；EG 上 sudo bash /opt/lsa-eg/install.sh --status'
  echo "online_at=$(date +%s)" >> "$BD/state"

  # 5. 转换程序（给了才做）
  if [ -n "$CONVCMD" ]; then
    echo "== $(ts) 5. 转换程序：$CONVCMD"
    out="$(sshx "$EGH" "$CONVCMD" < /dev/null 2>&1)"; rc=$?
    echo "$out" | tail -15
    [ "$rc" = 0 ] || stop conv "$(tail -1 <<< "$out")" '不急的话可以先不管转换程序，之后单独重跑带转换程序参数的这条命令'
    # install-conv.sh 最后一行「→ …」是它的诊断提示（串口打不开、从站没回等），不算失败：照原样带上
    last="$(grep -E '^→' <<< "$out" | tail -1 || true)"; last="${last#→ }"; RES[conv]="已启用${last:+；提示：${last:0:70}}"
  else RES[conv]='没要（没给 --conv 等参数）'; fi

  # 6. 撤隧道授权（升级授权留着）
  echo "== $(ts) 6. 撤隧道授权（升级授权留着）"
  out="$(sshx "$EGH" drop-tunnel < /dev/null 2>&1)"; echo "$out"
  if grep -q '^已删除隧道账号' <<< "$out"; then RES[tunnel]='完成（隧道账号 lsa-sp 已删；升级授权留着）'
  elif grep -q '不用删' <<< "$out"; then RES[tunnel]='完成（本来就没有隧道账号；升级授权留着）'
  else RES[tunnel]="没撤掉：$(tail -1 <<< "$out")（EG 上 sudo bash /opt/lsa-eg/install.sh --drop-sp-key）"; fi
  summary
  echo; echo "单元 $U 接入完成。以后升级：sudo bash $SP/upgrade-egs.sh --run <新 .run> --only $U"
}

# 跑一台：日志目录、tee；返回 join_one 的退出码
run_one() {  # run_one <单元号> <EG 地址> [拆柜的柜号]
  BD="$LOGROOT/$1-$(stamp)"
  mkdir -p "$BD"
  ( join_one "$@" ) 2>&1 | tee -a "$BD/run.log"
  return "${PIPESTATUS[0]}"
}

# 多台的结果表
declare -a DONE_U=() DONE_H=() DONE_R=()
note() { DONE_U+=("$1"); DONE_H+=("$2"); DONE_R+=("$3"); }
table() {
  local i
  echo '单元       EG地址           结果'   # 中文一个字占两格、printf 按字节算，所以表头手写
  for i in "${!DONE_U[@]}"; do printf '%-10s %-16s %s\n' "${DONE_U[$i]}" "${DONE_H[$i]}" "${DONE_R[$i]}"; done
}

# ---------- 一批预检 ----------
if [ "$MODE" = batch ]; then
  [ "$PLAN" = 1 ] || { echo '--from-file 只做预检（加 --plan）；真接入用 --unit / --cabinet' >&2; exit 2; }
  [ -f "$LIST" ] || { echo "没有清单文件：$LIST" >&2; exit 1; }
  echo '单元号     EG地址           能接  结论'   # 和下面 %-10s %-16s %-6s 对齐（表头手写）
  n=0 ok=0
  while read -r c h _; do
    [ -n "${c:-}" ] && [ "${c:0:1}" != '#' ] || continue
    [ -n "${h:-}" ] || { printf '%-10s %-16s %-6s %s\n' "$c" - 否 '清单这一行没给 EG 地址'; n=$((n + 1)); continue; }
    out="$(preflight "$c" "$h" < /dev/null)"   # ssh 会吃掉 stdin（清单）
    printf '%-10s %-16s %-6s %s\n' "$c" "$h" "$([ "$(kv ok "$out")" = 1 ] && echo 能 || echo 否)" "$(kv why "$out")"
    n=$((n + 1)); [ "$(kv ok "$out")" = 1 ] && ok=$((ok + 1))
  done < "$LIST"
  echo; echo "合计：$n 台，能接 $ok 台（只做了预检，没改任何东西；接入：sudo bash $0 --unit <单元号> --eg <地址>）"
  [ "$ok" = "$n" ]; exit $?
fi

[[ "$TARGET" =~ ^[A-Za-z0-9-]{1,20}$ ]] || { echo "单元号 / 柜号不对：$TARGET" >&2; exit 2; }

# ---------- 接一台 ----------
if [ "$MODE" = unit ]; then
  [ -n "$EGARG" ] && [[ "$EGARG" != *=* ]] || { echo '要给 --unit <单元号> --eg <EG 地址>' >&2; exit 2; }
  if [ "$PLAN" = 1 ]; then
    echo "== $(ts) 预检：单元 $TARGET ← EG $EGARG（子站 $A）"
    PF="$(preflight "$TARGET" "$EGARG")"; sed 's/^/  /' <<< "$PF"
    [ "$(kv ok "$PF")" = 1 ] || { echo; echo "预检不过：$(kv why "$PF")" >&2; exit 1; }
    echo; echo '（--plan：只做了预检，没改任何东西）'; exit 0
  fi
  run_one "$TARGET" "$EGARG"; exit $?
fi

# ---------- 一面柜的全部单元 ----------
if [ "$MODE" = cabinet ]; then
  mapfile -t UNITS < <(units_of "$TARGET" || true)
  if [ "${#UNITS[@]}" = 0 ]; then echo "子站上没有柜 $TARGET（eg-list 里没有它的单元）：柜号写错，或者 eg-list 不可用" >&2; exit 1; fi
  echo "柜 $TARGET：${#UNITS[@]} 个单元（${UNITS[*]}）"
  rc_all=0
  for u in "${UNITS[@]}"; do
    h="$(addr_for "$u" "${#UNITS[@]}")"
    if [ -z "$h" ]; then
      row="$(eglist_row "$u" || true)"; IFS=$'\t' read -r _ _ st _ _ _ host srcx <<< "$row" || true
      if [ "${host:--}" != - ]; then h="$host"; echo "（单元 $u 没在 --eg 里给地址：用子站记的 $h，来源 $srcx）"
      else note "$u" - '跳过：没给地址（--eg 单元=地址）'; continue; fi
    fi
    if [ "$PLAN" = 1 ]; then
      PF="$(preflight "$u" "$h")"; note "$u" "$h" "$([ "$(kv ok "$PF")" = 1 ] && echo 能接 || echo 不能接)：$(kv why "$PF")"
      [ "$(kv ok "$PF")" = 1 ] || rc_all=1
    elif run_one "$u" "$h"; then note "$u" "$h" '接入完成'
    else note "$u" "$h" "失败（日志 $BD；重来：sudo bash $0 --unit $u --eg $h）"; rc_all=1; fi
  done
  echo; echo "== $(ts) 柜 $TARGET 汇总"; table
  [ "$PLAN" = 1 ] && echo '（--plan：只做了预检，没改任何东西）'
  exit "$rc_all"
fi

# ---------- 拆柜 ----------
# model.site.yaml 的 legacyEg：块式「- AH01」与流式「[AH01, AH02]」都认（同后端 lib-check.sh）
legacy_list() {
  awk '/^legacyEg:/{l=1; if ($0 ~ /\[/) {sub(/^legacyEg: *\[/, ""); sub(/\].*/, ""); gsub(/[ "'\'']/, ""); k=split($0, a, ","); for (i = 1; i <= k; i++) if (a[i] != "") print a[i]; l=0}; next} /^[^ #-]/{l=0} l && /^ *- /{sub(/^ *- */, ""); gsub(/["'\'' ]/, ""); print}' "$1" 2>/dev/null || true
}
# 去掉一面柜：写到 $2（流式改写那一行；块式删那一项，删空了写成 legacyEg: []）
legacy_remove() {  # legacy_remove <文件> <输出> <柜号>
  awk -v c="$3" '
    function clean(x) { gsub(/["'\'' ]/, "", x); return x }
    /^legacyEg:/ {
      if ($0 ~ /\[/) {
        s = $0; sub(/^legacyEg: *\[/, "", s); sub(/\].*/, "", s); k = split(s, a, ","); out = ""
        for (i = 1; i <= k; i++) { v = clean(a[i]); if (v != "" && v != c) out = out (out == "" ? "" : ", ") v }
        print "legacyEg: [" out "]"; next
      }
      blk = 1; head = $0; n = 0; next
    }
    blk && /^ *- / { v = $0; sub(/^ *- */, "", v); v = clean(v); if (v != c) items[++n] = $0; next }
    blk && /^ *#/ { items[++n] = $0; next }
    blk { flush(); blk = 0 }
    { print }
    function flush() { if (n == 0) print "legacyEg: []"; else { print head; for (i = 1; i <= n; i++) print items[i] } }
    END { if (blk) flush() }
  ' "$1" > "$2"
}

if [ "$MODE" = split ]; then
  CAB="$TARGET"
  [[ "$EGARG" == *=* ]] || { echo '拆柜要按单元给地址：--split AH05 --eg A=<地址>,B=<地址>（键可以写全 AH05-A）' >&2; exit 2; }
  [ -f "$SITE_MODEL" ] || { echo "没有 $SITE_MODEL（0.18.0 起 up.sh 生成）：子站是 0.18.0 吗？" >&2; exit 1; }
  if ! legacy_list "$SITE_MODEL" | grep -qx "$CAB"; then
    if [ -n "$(units_of "$CAB" 2>/dev/null | grep -v "^$CAB\$" || true)" ]; then echo "柜 $CAB 已经拆过（单元 $(units_of "$CAB" | tr '\n' ' ')）：接单元用 --cabinet $CAB 或 --unit" >&2
    else echo "柜 $CAB 不在 $SITE_MODEL 的 legacyEg 里（不是照旧一柜一台的柜，没什么可拆）" >&2; fi
    exit 1
  fi
  # 要接的单元：--eg 里的键（字母补成 柜号-字母）
  declare -a SU=() SH=()
  IFS=',' read -r -a items <<< "$EGARG"
  for item in "${items[@]}"; do
    k="${item%%=*}"; v="${item#*=}"
    [[ "$k" == *-* ]] || k="$CAB-$k"
    [[ "$k" =~ ^${CAB}-[A-Z]$ ]] || { echo "拆柜 $CAB 的单元要写成 $CAB-<大写字母> 或 <大写字母>：$item" >&2; exit 2; }
    SU+=("$k"); SH+=("$v")
  done
  [ "$(printf '%s\n' "${SU[@]}" | sort | uniq -d)" = '' ] || { echo '--eg 里同一个单元给了两次' >&2; exit 2; }
  [ "$(printf '%s\n' "${SH[@]}" | sort | uniq -d)" = '' ] || { echo '--eg 里同一个地址给了两个单元' >&2; exit 2; }
  # 这面柜原来那台（照旧一柜一台，单元号 = 柜号）
  old="$(eglist_row "$CAB" || true)"; IFS=$'\t' read -r _ _ ost _ _ _ ohost _ <<< "$old" || true
  echo "== $(ts) 拆柜预检：柜 $CAB（原来那台 EG-$CAB：${ost:-?}，${ohost:--}）→ ${SU[*]}"
  bad=0
  for i in "${!SU[@]}"; do
    PF="$(preflight "${SU[$i]}" "${SH[$i]}" "$CAB")"
    printf '  %-10s %-16s %s：%s\n' "${SU[$i]}" "${SH[$i]}" "$([ "$(kv ok "$PF")" = 1 ] && echo 能接 || echo 不能接)" "$(kv why "$PF")"
    [ "$(kv ok "$PF")" = 1 ] || bad=1
  done
  if [ "${ohost:--}" != - ] && ! printf '%s\n' "${SH[@]}" | grep -qx "$ohost"; then
    echo "  ！ 原来那台（$ohost）不在 --eg 里：拆柜后它的令牌作废、上送被拒。之后要么改作某个单元（EG 上 install.sh --join-key 再 --unit 接），要么停用"
  fi
  echo
  echo "拆柜会：备份 $SITE_MODEL → 从 legacyEg 去掉 $CAB → up.sh --prod（建 EG-$CAB-A/B…、改挂设备、旧 EG-$CAB 归档、旧令牌作废，从这一刻起这面柜断数）→ 马上逐台接入 ${SU[*]}"
  [ "$bad" = 0 ] || { echo; echo '预检有不能接的：先处理好再拆（还什么都没改）' >&2; exit 1; }
  [ "$PLAN" = 1 ] && { echo; echo '（--plan：只做了预检，没改任何东西）'; exit 0; }

  RUN="$LOGROOT/split-$CAB-$(stamp)"; mkdir -p "$RUN"
  cp -p "$SITE_MODEL" "$RUN/model.site.yaml.before"
  legacy_remove "$SITE_MODEL" "$RUN/model.site.yaml.after" "$CAB"
  if legacy_list "$RUN/model.site.yaml.after" | grep -qx "$CAB" || [ "$(legacy_list "$RUN/model.site.yaml.before" | grep -vx "$CAB" | sort)" != "$(legacy_list "$RUN/model.site.yaml.after" | sort)" ]; then
    echo "改 legacyEg 没改对（别的柜也变了或没去掉 $CAB）：没动 $SITE_MODEL，改后的样子在 $RUN/model.site.yaml.after" >&2; exit 1
  fi
  T0=$(date +%s)
  echo "== $(ts) 拆柜：model.site.yaml 去掉 legacyEg 的 $CAB（原文件备份 $RUN/model.site.yaml.before）"
  cat "$RUN/model.site.yaml.after" > "$SITE_MODEL"   # 原地写（compose 绑定挂载的是这个文件，不能换 inode）
  echo "== $(ts) up.sh --prod（这面柜从现在起断数，直到各单元接上）"
  if ! (cd "$SP_B" && bash scripts/up.sh --prod < /dev/null) 2>&1 | tee "$RUN/up.log"; then
    echo "up.sh 没成功（日志 $RUN/up.log）。model.site.yaml 已改（原来的在 $RUN/model.site.yaml.before）；修好后重跑 up.sh --prod，再 sudo bash $0 --cabinet $CAB --eg $EGARG" >&2
    exit 1
  fi
  echo "== $(ts) 等子站 eg-list 列出 $CAB 的单元（最多 ${SPLIT_LIST_TIMEOUT_S} s）"
  t_end=$(( $(date +%s) + SPLIT_LIST_TIMEOUT_S )); NEW=()
  while [ "$(date +%s)" -lt "$t_end" ]; do
    mapfile -t NEW < <(units_of "$CAB" 2>/dev/null | grep -v "^$CAB\$" || true)
    [ "${#NEW[@]}" -gt 0 ] && break
    sleep 10
  done
  [ "${#NEW[@]}" -gt 0 ] || { echo "子站 eg-list 一直没列出 $CAB 的单元：看 check.sh 的「舱室单元」；之后 sudo bash $0 --cabinet $CAB --eg $EGARG" >&2; exit 1; }
  echo "柜 $CAB 拆成：${NEW[*]}"
  rc_all=0 last_online='' last_up='' ups=()
  for u in "${NEW[@]}"; do
    h="$(addr_for "$u" "${#NEW[@]}")"
    [ -n "$h" ] || { note "$u" - '没接（--eg 里没给，子站上显示「未接入」）'; continue; }
    if run_one "$u" "$h" "$CAB"; then
      note "$u" "$h" '接入完成'; last_online="$(sed -n 's/^online_at=//p' "$BD/state" 2>/dev/null | tail -1)"
      t="$(sed -n 's/^uplink_at=//p' "$BD/state" 2>/dev/null | tail -1 || true)"
      if [ -n "$t" ]; then
        ups+=("$u $(( t - T0 )) s")
        if [ -z "$last_up" ] || [ "$t" -gt "$last_up" ]; then last_up="$t"; fi
      fi
    else note "$u" "$h" "失败（日志 $BD；重来：sudo bash $0 --unit $u --eg $h）"; rc_all=1; fi
  done
  for i in "${!SU[@]}"; do printf '%s\n' "${NEW[@]}" | grep -qx "${SU[$i]}" || { note "${SU[$i]}" "${SH[$i]}" '子站上没有这个单元（model.yaml 的 units 里没有？），没接'; rc_all=1; }; done
  echo; echo "== $(ts) 拆柜 $CAB 汇总（日志 $RUN）"; table
  # 断数窗口（0.7.1）：up.sh 开始（旧令牌作废）→ 最后一台第一次上送正常；各台恢复上送的时刻、全部配置生效另报
  if [ "$rc_all" = 0 ] && [ -n "$last_up" ]; then
    echo "断数窗口：$(( last_up - T0 )) s（up.sh 开始 → 最后一台第一次上送正常；各台：${ups[*]}，按顺序一台一台接）"
    [ -n "$last_online" ] && echo "全部配置生效：$(( last_online - T0 )) s（配置生效不影响上送，只是晚一点）"
  else echo "断数窗口：还没结束（有单元没接上）。从 $(date -d "@$T0" '+%F %T') 起"; fi
  echo "拆完的标准：网关页每个单元都在线、check.sh 的「舱室单元」与「配置下发」都正常（子站部署手册 §5b）"
  exit "$rc_all"
fi
