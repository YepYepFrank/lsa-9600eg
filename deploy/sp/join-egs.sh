#!/bin/bash
# LSA-9600SP 子站主机上一条命令加柜（0.17.4 一键加柜）。在子站主机上用 root 跑：
#
#   sudo bash join-egs.sh --keygen [--sp-addr <子站地址>]
#       生成隧道 key（升级 key 有就复用，和 upgrade-egs.sh 同一把），打印 join-key —— EG 上装软件时带上：
#       sudo bash LSA-9600SP-<版本>.run --role eg --lan1 <网口> --join-key '<这一行>'
#   sudo bash join-egs.sh --cabinet AH05 --eg <EG 的 LAN2 地址> [--conv auto | --conv-serial … --sensors … --addr … --dev … --baud …] [--plan] [--force]
#       接入一台：预检 → 建实体（provision-eg，走隧道）→ 打配置（pack-eg）→ 推送、生效 → 等它在线、配置生效 → 转换程序 → 撤隧道授权
#   sudo bash join-egs.sh --from-file <清单> --plan
#       一次预检一批（清单每行「柜号 EG地址」，# 开头是注释）；真接入仍然一台一台做
#
# 每一步都可以重跑：建实体、打配置是幂等的；配置和 EG 上现在的一样就跳过、不重启；转换程序、撤隧道也一样。
# 失败就停在那一步，说清从哪一步、用什么命令重来。日志：/var/log/lsa9600sp/eg-join/<柜号>-<时间>/。
# --cabinet 要是 model.yaml 里有的柜（页面加柜是另一件事）；这个柜已经有别的 EG 在线时要 --force。
set -uo pipefail
export LC_ALL=C.UTF-8   # 截短提示用 ${x:0:N}：按字符截，不把中文截成半个字
SP=/opt/lsa9600sp
SP_B="$SP/lsa9600sp-backend"
SP_ENV="$SP_B/docker/.env"
KEYDIR="$SP/keys"
UPKEY="$KEYDIR/eg-upgrade_ed25519"
TUNKEY="$KEYDIR/eg-tunnel_ed25519"
KH="$KEYDIR/eg-upgrade.known_hosts"
SPADDR_FILE="$KEYDIR/join-sp-addr"
LOGROOT=/var/log/lsa9600sp/eg-join
POLL_S=10
APPLY_TIMEOUT_S=1800
ONLINE_TIMEOUT_S=180
TERMINAL=' done rolled-back rollback-failed check-failed failed '

MODE='' CAB='' EGH='' PLAN=0 FORCE=0 LIST='' SPADDR=''
CONV='' CSER='' CSEN='' CADDR='' CDEV='' CBAUD=''
while [ $# -gt 0 ]; do
  case "$1" in
    --keygen) MODE=keygen ;;
    --sp-addr) SPADDR="${2:?--sp-addr 后面给子站地址}"; shift ;;
    --cabinet) CAB="${2:?--cabinet 后面给柜号}"; MODE="${MODE:-join}"; shift ;;
    --eg) EGH="${2:?--eg 后面给 EG 的 LAN2 地址}"; shift ;;
    --from-file) LIST="${2:?--from-file 后面给清单文件}"; MODE=batch; shift ;;
    --plan) PLAN=1 ;;
    --force) FORCE=1 ;;
    --conv) CONV="${2:?--conv auto}"; shift ;;
    --conv-serial) CSER="${2:?}"; shift ;;
    --sensors) CSEN="${2:?}"; shift ;;
    --addr) CADDR="${2:?}"; shift ;;
    --dev) CDEV="${2:?}"; shift ;;
    --baud) CBAUD="${2:?}"; shift ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { sed -n '2,17p' "$0"; exit 2; }
[ "$(id -u)" = 0 ] || { echo '要 root：sudo bash join-egs.sh …' >&2; exit 1; }

ts() { date '+%F %T'; }
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
# 子站 eg-list（按 model.yaml 的柜列）：这个柜一行 TSV —— 柜号 状态 版本 上送正常 配置生效 地址
#   返回 0 有；4 model.yaml 里没有这个柜；3 扩展服务刚起、还没读全；2 eg-list 不可用。EG_LIST_JSON_CMD 可换取数命令（沙箱测试用）
eglist_row() {
  local json rc=0
  if [ -n "${EG_LIST_JSON_CMD:-}" ]; then json="$(eval "$EG_LIST_JSON_CMD" 2>/dev/null)" || rc=$?
  else json="$(docker exec lsa-ext node bin/eg-list.mjs --json 2>/dev/null)" || rc=$?; fi
  [ "$rc" = 0 ] || [ "$rc" = 3 ] || return 2
  [ "$rc" = 3 ] && return 3
  docker exec -i lsa-ext node -e '
let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
  let o; try { o = JSON.parse(s) } catch { process.exit(2) }
  const e = (o.egs || []).find(x => x.code === process.argv[1]); if (!e) process.exit(4)
  let host = ""; try { host = e.egUrl ? new URL(e.egUrl).hostname : "" } catch {}
  console.log([e.code, e.state || "-", e.version || "-", String(!!e.uplinkOk), String(!!e.cfgApplied), host || "-"].join("\t"))
})' "$1" <<< "$json"
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
  echo "然后在这台子站上：sudo bash $0 --cabinet <柜号> --eg <那台 EG 的 LAN2 地址>"
  exit 0
fi

[ -f "$UPKEY" ] && [ -f "$TUNKEY" ] || { echo "没有 key：先 sudo bash $0 --keygen" >&2; exit 1; }
A="$(sp_addr)"

# ---------- 预检（一台）：输出 key=value，ok=1 才能接 ----------
preflight() {  # preflight <柜号> <EG 地址>
  local c="$1" h="$2" row st ver upok cfg host hello j jcab jsp
  echo "cabinet=$c"; echo "eg=$h"
  row="$(eglist_row "$c")"; local rc=$?
  if [ "$rc" = 4 ]; then echo 'ok=0'; echo "why=柜号 $c 不在子站的 model.yaml 里：先在 model.yaml 加柜，再跑 up.sh"; return; fi
  if [ "$rc" = 3 ]; then echo 'ok=0'; echo 'why=子站扩展服务刚起、还没读全：过一两分钟再跑'; return; fi
  if [ "$rc" != 0 ] || [ -z "$row" ]; then echo 'ok=0'; echo 'why=子站 eg-list 不可用（lsa-ext 在跑吗？）'; return; fi
  IFS=$'\t' read -r _ st ver upok cfg host <<< "$row"
  echo "sp_state=$st"; echo "sp_version=$ver"
  # 这个柜已经有别的 EG 在线
  if [[ "$st" =~ ^(online|degraded|backfill)$ ]] && [ "$host" != - ] && [ "$host" != "$h" ] && [ "$FORCE" != 1 ]; then
    echo 'ok=0'; echo "why=柜 $c 已经有别的 EG（$host）在线：确认要换加 --force"; return
  fi
  hello="$(sshx "$h" hello 2>&1)"; rc=$?
  if [ "$rc" != 0 ] || ! grep -q '^entry=' <<< "$hello"; then
    echo 'ok=0'
    if grep -q 'Permission denied' <<< "$hello"; then echo "why=升级入口没授权：EG 装的时候没带 --join-key，或者带的是别的子站的"
    else hello="$(tr '\n' ' ' <<< "$hello")"; echo "why=连不上 EG：${hello:0:80}（EG 开着吗、地址对吗、22 口通吗）"; fi
    return
  fi
  [ "$(kv entry "$hello")" -ge 3 ] 2>/dev/null || { echo 'ok=0'; echo "why=EG 版本太老（入口 $(kv entry "$hello")，要 0.17.4 起）：先升级"; return; }
  j="$(kv joined "$hello")"; jcab="$(kv cabinet "$hello")"; jsp="$(kv join_sp "$hello")"
  echo "eg_version=$(kv eg_version "$hello")"; echo "eg_joined=$j"; echo "eg_cabinet=$jcab"
  if [ "$j" = 1 ] && [ "$jcab" != "$c" ]; then echo 'ok=0'; echo "why=这台 EG 已接入柜 $jcab，不能直接接成 $c"; return; fi
  if [ -n "$jsp" ] && [ "$jsp" != "$A" ]; then echo 'ok=0'; echo "why=这台 EG 授权的是子站 $jsp，不是本机 $A"; return; fi
  [ "$(kv running "$hello")" = 1 ] && { echo 'ok=0'; echo 'why=EG 上有任务正在跑'; return; }
  [ -n "$(kv maint "$hello")" ] && [ "$j" = 0 ] && { echo 'ok=0'; echo "why=EG 在维护：$(kv maint "$hello")"; return; }
  if [ "$j" = 1 ]; then echo 'ok=1'; echo "why=已接入本柜：重跑（各步已做的会跳过）"
  elif tunnel_ok "$h"; then echo 'ok=1'; echo 'why=待接入，隧道与升级入口都认得上'
  else echo 'ok=0'; echo 'why=隧道账号认不上（EG 的 --join-key 是别的子站的？或者已经撤了：EG 上重跑 --join-key）'; fi
}

# ---------- 一批预检 ----------
if [ "$MODE" = batch ]; then
  [ "$PLAN" = 1 ] || { echo '--from-file 只做预检（加 --plan）；真接入一台一台做：--cabinet … --eg …' >&2; exit 2; }
  [ -f "$LIST" ] || { echo "没有清单文件：$LIST" >&2; exit 1; }
  echo '柜号     EG地址           能接  结论'   # 和下面 %-8s %-16s %-6s 对齐（中文一个字占两格、printf 按字节算，所以表头手写）
  n=0 ok=0
  while read -r c h _; do
    [ -n "${c:-}" ] && [ "${c:0:1}" != '#' ] || continue
    [ -n "${h:-}" ] || { printf '%-8s %-16s %-6s %s\n' "$c" - 否 '清单这一行没给 EG 地址'; n=$((n + 1)); continue; }
    out="$(preflight "$c" "$h" < /dev/null)"   # ssh 会吃掉 stdin（清单）
    printf '%-8s %-16s %-6s %s\n' "$c" "$h" "$([ "$(kv ok "$out")" = 1 ] && echo 能 || echo 否)" "$(kv why "$out")"
    n=$((n + 1)); [ "$(kv ok "$out")" = 1 ] && ok=$((ok + 1))
  done < "$LIST"
  echo; echo "合计：$n 台，能接 $ok 台（只做了预检，没改任何东西；接入：sudo bash $0 --cabinet <柜号> --eg <地址>，一台一台来）"
  [ "$ok" = "$n" ]; exit $?
fi

# ---------- 接入一台 ----------
[ -n "$CAB" ] && [ -n "$EGH" ] || { echo '要给 --cabinet <柜号> --eg <EG 地址>' >&2; exit 2; }
[[ "$CAB" =~ ^[A-Za-z0-9-]{1,16}$ ]] || { echo "柜号不对：$CAB" >&2; exit 2; }
[[ "$EGH" =~ ^[A-Za-z0-9.:-]+$ ]] || { echo "EG 地址不对：$EGH" >&2; exit 2; }
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

echo "== $(ts) 预检：柜 $CAB ← EG $EGH（子站 $A）"
PF="$(preflight "$CAB" "$EGH")"
sed 's/^/  /' <<< "$PF"
if [ "$(kv ok "$PF")" != 1 ]; then echo; echo "预检不过：$(kv why "$PF")" >&2; exit 1; fi
[ "$PLAN" = 1 ] && { echo; echo '（--plan：只做了预检，没改任何东西）'; exit 0; }

BD="$LOGROOT/$CAB-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BD"
exec > >(tee -a "$BD/run.log") 2>&1
declare -A RES=()
STEPS=(provision pack apply online conv tunnel)
declare -A ZH=([provision]='建实体（provision-eg，走隧道）' [pack]='打配置包（pack-eg）' [apply]='推送并生效配置' [online]='等子站看到在线、配置生效' [conv]='转换程序' [tunnel]='撤隧道授权')
summary() {
  echo; echo "== $(ts) 汇总：柜 $CAB ← EG $EGH（日志 $BD）"
  local i=0 s
  for s in "${STEPS[@]}"; do i=$((i + 1)); echo "  $i. ${ZH[$s]}：${RES[$s]:-没做}"; done
}
stop() {  # stop <步骤> <原因> <怎么重来>
  RES[$1]="失败：$2"; summary
  echo; echo "停在「${ZH[$1]}」：$2" >&2
  echo "修好后原样重跑（前面已做完的会跳过）：sudo bash $0 --cabinet $CAB --eg $EGH${CONVCMD:+ …（同样的转换程序参数）}" >&2
  [ -n "${3:-}" ] && echo "提示：$3" >&2
  exit 1
}

# 1. 建实体：已接入本柜（重跑）时隧道可能已经撤了 —— 实体当初建过，跳过
if [ "$(kv eg_joined "$PF")" = 1 ] && ! tunnel_ok "$EGH"; then
  RES[provision]='跳过（已接入本柜，隧道已撤；实体当初建过）'
else
  echo "== $(ts) 1. 建实体"
  if (cd "$SP_B" && bash scripts/provision-eg.sh --cabinet "$CAB" --ssh "lsa-sp@$EGH" --ssh-key "$TUNKEY" \
      --hook http://host.docker.internal/hooks/alarm --sp "$A" --eg-url "http://$EGH" < /dev/null); then RES[provision]='完成'
  else stop provision 'provision-eg.sh 没成功（看上面的输出）' 'EG 的本地 TB 要起来了（待接入页上「本地 TB 已起」）'; fi
fi

# 2. 打配置包
echo "== $(ts) 2. 打配置包"
(cd "$SP_B" && bash scripts/pack-eg.sh --sp "$A" --only "$CAB" < /dev/null) || stop pack 'pack-eg.sh 没成功' "子站证书的 SAN 里要有 $A（scripts/gen-certs.sh --san）"
src="$SP_B/dist/eg/$CAB"
[ -f "$src/eg.yaml" ] || stop pack "$src/eg.yaml 没生成"
PKG="$BD/config-$CAB.tgz"
files=(eg.yaml); [ -f "$src/sp-ca.pem" ] && files+=(sp-ca.pem)
tar -czf "$PKG" -C "$src" "${files[@]}" && chmod 600 "$PKG"
PSHA="$(sha256sum "$PKG" | cut -d' ' -f1)"; PSIZE="$(stat -c %s "$PKG")"
RES[pack]="完成（${files[*]}，$PSIZE 字节）"

# 3. 推送、生效（EG 后台做：失败自己换回旧配置）
echo "== $(ts) 3. 推送并生效配置"
out="$(sshx "$EGH" "put-config $PSHA $PSIZE" < "$PKG" 2>&1)"; echo "$out"
grep -q "^OK put-config $PSHA" <<< "$out" || stop apply "推送没成功：$(tail -1 <<< "$out")"
out="$(sshx "$EGH" "apply-config $PSHA" 2>&1)"; echo "$out"
if grep -q '^OK apply-config same' <<< "$out"; then RES[apply]='跳过（EG 上已经是这份配置）'
elif grep -q '^OK apply-config ' <<< "$out"; then
  job="$(awk '/^OK apply-config / { print $3 }' <<< "$out")"
  t_end=$(( $(date +%s) + APPLY_TIMEOUT_S )); ph=''
  while [ "$(date +%s)" -lt "$t_end" ]; do
    if st="$(sshx "$EGH" status 2>&1)"; then
      ph="$(kv phase "$st")"; echo "$(ts) $ph"
      [ "$(kv job "$st")" = "$job" ] && [[ "$TERMINAL" == *" $ph "* ]] && break
    else echo "$(ts) 查不到进度（SSH），${POLL_S} s 后重连"; fi
    sleep "$POLL_S"
  done
  echo '--- EG 上的任务日志（最后 30 行）'; sshx "$EGH" "log 30" 2>&1 || true
  case "$ph" in
    done) RES[apply]="完成（$(kv install_s "$st") s 装、$(kv check_s "$st") s 核对）" ;;
    rolled-back) stop apply "EG 上换配置没成功、已自动换回：$(kv reason "$st")" ;;
    *) stop apply "换配置没做完（${ph:-查不到}）：$(kv reason "$st")" "EG 上：sudo bash /opt/lsa-eg/install.sh --status" ;;
  esac
else stop apply "EG 没开始换配置：$(tail -1 <<< "$out")"; fi

# 4. 等子站看到它在线、配置生效
echo "== $(ts) 4. 等子站看到它在线、配置生效（最多 ${ONLINE_TIMEOUT_S} s）"
t_end=$(( $(date +%s) + ONLINE_TIMEOUT_S )); okl=''
while [ "$(date +%s)" -lt "$t_end" ]; do
  row="$(eglist_row "$CAB" || true)"
  IFS=$'\t' read -r _ st ver upok cfg host <<< "$row" || true
  echo "$(ts) 子站看到：状态 ${st:-?}，版本 ${ver:-?}，上送 ${upok:-?}，配置生效 ${cfg:-?}，地址 ${host:-?}"
  [ "$upok" = true ] && [ "$cfg" = true ] && { okl=1; break; }
  sleep 15
done
[ -n "$okl" ] && RES[online]="完成（$st，$ver）" || stop online '子站没看到它上送正常 / 配置生效' '看网关页这台的「上送」「配置」；EG 上 sudo bash /opt/lsa-eg/install.sh --status'

# 5. 转换程序（给了才做）
if [ -n "$CONVCMD" ]; then
  echo "== $(ts) 5. 转换程序：$CONVCMD"
  out="$(sshx "$EGH" "$CONVCMD" 2>&1)"; rc=$?
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
echo; echo "柜 $CAB 接入完成。以后升级：sudo bash $SP/upgrade-egs.sh --run <新 .run> --only $CAB"
