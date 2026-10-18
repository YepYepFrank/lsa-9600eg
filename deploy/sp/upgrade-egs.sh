#!/bin/bash
# LSA-9600SP 子站主机上一条命令批量升级 EG（0.17.2）。在子站主机上用 root 跑：
#
#   sudo bash upgrade-egs.sh --keygen                       生成子站的升级 key（只一次），打印每台 EG 上要执行的授权命令
#   sudo bash upgrade-egs.sh --run <新 .run> --plan [--all | --only AH03,AH05]
#                                                           只看要做什么：每台 EG 在不在线、当前版本 → 目标版本、会不会升、不升的原因（不改任何东西）
#   sudo bash upgrade-egs.sh --run <新 .run> --all | --only AH03,AH05 [--canary AH05] [--parallel 2] [--force]
#                                                           升级：先升 canary（缺省清单里第一台），核对通过后其余按并发上限依次升；
#                                                           任何一台失败就不再开新的，打印那台的回退命令。--force：已经是目标版本的也重装
#                                                           --skip-offline：连不上的 EG 跳过（缺省有一台连不上就整批不开始）
#   跳过（不算失败）：子站上标了未接入 / 停用、没有地址、已是该版本、比目标版本新（不降级）、这台正在做别的维护（lsa-sp 隧道开着、有安装在跑）
#   --only / --canary 给单元号（0.18.0 舱室 EG：EG-AH01-A 的单元号 AH01-A；照旧一柜一台的单元号 = 柜号，如 AH03），一台 EG 一项
#   sudo bash upgrade-egs.sh --resume <批次>                 断开以后续查 / 接着做（EG 上的升级任务不受子站断开影响）
#   sudo bash upgrade-egs.sh --list                         列出做过的批次与结果
#
# 安全：EG 上的专用账号 lsa-upg 只认这台子站、只能进 EG 的升级入口（交安装文件、开始、查进度），不能执行别的命令；
#   EG 上授权：sudo bash /opt/lsa-eg/install.sh --upgrade-key '<--keygen 打印的公钥>'，撤销 --drop-upgrade-key。
#   key 在 /opt/lsa9600sp/keys/（root 600）：持这把 key 的人能让 EG 装他给的任意安装文件，不要拷走。
# 每台的流程：拷安装文件（EG 上核对 sha256 与空间）→ 开始（EG 自己在后台做，失败自动回退）→ 每 10 s 查进度 →
#   EG 自查（版本、7 个容器、本地 TB、连上子站）→ 子站核对（子站 TB 上 EG 报的版本、上送、配置版本没丢）→ 删掉 EG 上的拷贝。
# 日志：/var/log/lsa9600sp/eg-upgrade/<批次>/（run.log、summary.tsv、每台一份 <单元号>.log）。
set -uo pipefail
SP=/opt/lsa9600sp
SP_ENV="$SP/lsa9600sp-backend/docker/.env"
KEYDIR="$SP/keys"
KEY="$KEYDIR/eg-upgrade_ed25519"
KH="$KEYDIR/eg-upgrade.known_hosts"
LOGROOT=/var/log/lsa9600sp/eg-upgrade
POLL_S=10
JOB_TIMEOUT_S=3600
SP_CHECK_S=180
TERMINAL=' done rolled-back rollback-failed check-failed failed '

RUN='' SEL='' CANARY='' PAR=2 PLAN=0 FORCE=0 MODE='' SKIP_OFFLINE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keygen) MODE=keygen ;;
    --run) RUN="${2:?--run 后面给新的一键安装文件}"; MODE="${MODE:-run}"; shift ;;
    --all) SEL=all ;;
    --only) SEL="${2:?--only AH03,AH05}"; shift ;;
    --canary) CANARY="${2:?--canary AH03}"; shift ;;
    --parallel) PAR="${2:?--parallel 2}"; shift ;;
    --plan) PLAN=1 ;;
    --force) FORCE=1 ;;
    --skip-offline) SKIP_OFFLINE=1 ;;
    --resume) MODE=resume; BATCH="${2:?--resume <批次>（--list 看有哪些）}"; shift ;;
    --list) MODE=list ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { sed -n '2,25p' "$0"; exit 2; }
[ "$(id -u)" = 0 ] || { echo '要 root：sudo bash upgrade-egs.sh …' >&2; exit 1; }
[[ "$PAR" =~ ^[1-9][0-9]?$ ]] || { echo "--parallel 要 1–99：$PAR" >&2; exit 2; }

ts() { date '+%F %T'; }
envget() { grep -E "^$1=" "$SP_ENV" 2>/dev/null | tail -1 | cut -d= -f2-; }
sshx() {  # sshx <EG 地址> <命令>：用升级 key 连 lsa-upg；EG 那边不管发什么都只进升级入口
  local h="$1"; shift
  ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KH" \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o LogLevel=ERROR "lsa-upg@$h" "$*"
}
kv() { sed -n "s/^$1=//p" <<< "$2" | tail -1; }
run_eg_version() {  # 安装文件里 EG 发布件的版本（只读负载里的 tar，不执行）
  local skip
  skip="$(grep -a -n -m1 '^__LSA_PAYLOAD_BELOW__$' "$1" | cut -d: -f1 || true)"
  [ -n "$skip" ] || return 1
  tail -n +"$((skip + 1))" "$1" | tar -xO --occurrence=1 lsa9600sp-bundle/eg/VERSION 2>/dev/null | head -1 | tr -d '[:space:]'
}

# ---------- EG 清单 ----------
# 每行（TSV）：单元号（0.18.0 舱室 EG；照旧一柜一台的 = 柜号） EG设备名 地址 EG报的版本 本地TB版本 配置版本 上送 上送多少秒前 跳过原因(-) 状态 上送正常(true/false) 配置已生效(true/false/-)
# 0.17.2 起用子站后端的 eg-list（lsa-ext 里的 bin/eg-list.mjs，只认容器里本机发的请求）：地址按 egUrl > EXT_EG_URLS > model.yaml 推好，
#   状态 online / offline / backfill / degraded / never / disabled，skip（未接入 / 停用），uplinkOk，cfgApplied（期望 = 生效且 APPLIED）。
#   退出码 3 = 扩展服务刚起、还没读全：照样输出，但调用方当成预检不过。老子站没有 eg-list 时直接查子站 TB（只认 egUrl 属性）。
eg_list() {
  if [ -n "${EG_LIST_CMD:-}" ]; then eval "$EG_LIST_CMD"; return; fi
  local json rc=0
  if [ -n "${EG_LIST_JSON_CMD:-}" ] || docker exec lsa-ext test -f bin/eg-list.mjs 2>/dev/null; then
    if [ -n "${EG_LIST_JSON_CMD:-}" ]; then json="$(eval "$EG_LIST_JSON_CMD")" || rc=$?
    else json="$(docker exec lsa-ext node bin/eg-list.mjs --json)" || rc=$?; fi
    if [ "$rc" != 0 ] && [ "$rc" != 3 ]; then
      # 退出码 2 = 扩展服务不通 / 出错：退回直接查子站 TB，但「未接入」只有扩展服务判得出（后端答复）
      echo "!! eg-list 不可用（退出码 $rc）：改直接查子站 TB —— 地址只认 egUrl，「未接入」判不出、只认「停用」（egDisabled）" >&2
      json=''
    fi
  fi
  if [ -n "${json:-}" ]; then
    docker exec -i lsa-ext node -e '
let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
  const o = JSON.parse(s), v = x => (x === undefined || x === null || x === "" ? "-" : String(x).replace(/\s/g, ""))
  for (const e of o.egs || []) {
    let host = ""; try { host = e.egUrl ? new URL(e.egUrl).hostname : "" } catch {}
    console.log([e.code, e.eg, v(host), v(e.version), v(e.tbVersion), v(e.cfgActual), v(e.uplink), v(e.uplinkAgeS), v(e.skip), v(e.state), String(!!e.uplinkOk), e.cfgApplied === undefined ? "-" : String(!!e.cfgApplied)].join("\t"))
  }
})' <<< "$json" || return 2
    return "$rc"
  fi
  docker exec -i -e TBU="$(envget TB_TENANT_USER)" -e TBP="$(envget TB_TENANT_PASSWORD)" lsa-ext node - <<'JS'
const T = 'http://tb:8080'
const j = async (u, o = {}) => { const r = await fetch(T + u, o); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json() }
;(async () => {
  const tok = (await j('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.TBU || 'admin@lsa9600sp.local', password: process.env.TBP }) })).token
  const H = { headers: { 'x-authorization': 'Bearer ' + tok } }
  const devs = (await j('/api/tenant/devices?pageSize=1000&page=0&textSearch=EG-', H)).data.filter(d => /^EG-/.test(d.name))
  for (const d of devs.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const id = d.id.id
    const attr = async s => Object.fromEntries((await j(`/api/plugins/telemetry/DEVICE/${id}/values/attributes/${s}`, H)).map(a => [a.key, a.value]))
    const c = await attr('CLIENT_SCOPE').catch(() => ({}))
    const s = await attr('SERVER_SCOPE').catch(() => ({}))
    const tel = await j(`/api/plugins/telemetry/DEVICE/${id}/values/timeseries?keys=eg.uplink`, H).catch(() => ({}))
    const up = (tel['eg.uplink'] || [])[0]
    let host = ''
    try { host = s.egUrl ? new URL(s.egUrl).hostname : '' } catch {}
    // 停用 = SERVER 属性 egDisabled（后端答复）；「未接入」由扩展服务按 lastConnectTime / lastActivityTime 判，这里判不出
    const skip = s.egDisabled === true ? '停用' : '-'
    const age = up ? Math.round((Date.now() - up.ts) / 1000) : null
    const ok = !!up && up.value === 'ok' && age <= 120
    const v = x => (x === undefined || x === null || x === '' ? '-' : String(x).replace(/\s/g, ''))
    console.log([d.name.replace(/^EG-/, ''), d.name, v(host), v(c.agent), v(c.tbVersion), v(c.cfg), v(up && up.value), v(age), skip, up ? (ok ? 'online' : 'offline') : 'never', String(ok), '-'].join('\t'))
  }
})().catch(e => { console.error('取 EG 清单失败：' + e.message); process.exit(1) })
JS
}
# 版本关系：same（完全一样）/ eq（同版本号、不同构建，重打）/ lt（当前比目标旧）/ gt（当前比目标新）
vrel() {
  [ "$1" = "$2" ] && { echo same; return 0; }
  local a="${1%%-*}" b="${2%%-*}"
  [ "$a" = "$b" ] && { echo eq; return 0; }
  if [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)" = "$a" ]; then echo lt; else echo gt; fi
}
zh_state() {
  case "$1" in online) echo 在线 ;; offline) echo 离线 ;; degraded) echo 降级 ;; backfill) echo 补传中 ;; never) echo 从没连过 ;; disabled) echo 停用 ;; *) echo '?' ;; esac
}

# ---------- --keygen ----------
if [ "$MODE" = keygen ]; then
  install -d -m 700 "$KEYDIR"
  if [ -f "$KEY" ]; then echo "已有升级 key：$KEY（不重新生成；要换就先删掉它，再到各 EG 上重新授权）"
  else ssh-keygen -q -t ed25519 -N '' -C "lsa9600sp-eg-upgrade@$(hostname)" -f "$KEY" && echo "已生成升级 key：$KEY"; fi
  chmod 600 "$KEY"
  echo
  echo '到每台 EG 上用维护账号执行（授权只认这台子站来的连接，地址缺省取 EG 的 eg.yaml；要改加 --upgrade-from <子站地址>）：'
  echo "  sudo bash /opt/lsa-eg/install.sh --upgrade-key '$(cat "$KEY.pub")'"
  echo '撤销：sudo bash /opt/lsa-eg/install.sh --drop-upgrade-key'
  exit 0
fi

# ---------- --list ----------
if [ "$MODE" = list ]; then
  [ -d "$LOGROOT" ] || { echo '还没做过批量升级'; exit 0; }
  for d in "$LOGROOT"/*/; do
    b="$(basename "$d")"
    n_ok="$(cat "$d"/*.result 2>/dev/null | awk -F'\t' '$5=="成功"' | wc -l)"; n_all="$(wc -l < "$d/plan.tsv" 2>/dev/null || echo 0)"
    echo "$b  目标 $(sed -n 's/^to=//p' "$d/meta" 2>/dev/null)  成功 $n_ok / $n_all$([ -f "$d/STOP" ] && echo '  （中途停下）')"
  done
  exit 0
fi

# ---------- 批次 ----------
if [ "$MODE" = resume ]; then
  BD="$LOGROOT/$BATCH"
  [ -f "$BD/meta" ] || { echo "没有批次 $BATCH（--list 看有哪些）" >&2; exit 1; }
  RUN="$(sed -n 's/^run=//p' "$BD/meta")"; SHA="$(sed -n 's/^sha=//p' "$BD/meta")"; SIZE="$(sed -n 's/^size=//p' "$BD/meta")"  # sete-ok：上面已核对 meta 存在，本脚本不用 set -e
  TO="$(sed -n 's/^to=//p' "$BD/meta")"; PAR="$(sed -n 's/^parallel=//p' "$BD/meta")"; CANARY="$(sed -n 's/^canary=//p' "$BD/meta")"  # sete-ok
  rm -f "$BD/STOP.resume"
else
  [ -f "$RUN" ] || { echo "没有安装文件：$RUN" >&2; exit 1; }
  [ -n "$SEL" ] || { echo '要给 --all 或 --only AH03,AH05' >&2; exit 2; }
  [ -f "$KEY" ] || { echo "没有升级 key（$KEY）：先 sudo bash upgrade-egs.sh --keygen，再到各 EG 上授权" >&2; exit 1; }
  RUN="$(readlink -f "$RUN")"
  TO="$(run_eg_version "$RUN" || true)"
  [ -n "$TO" ] || { echo "$RUN 不是 LSA-9600 的一键安装文件，或者里面没有 EG 发布件" >&2; exit 1; }
  echo "安装文件：$RUN（EG $TO），算 sha256 …"
  SHA="$(sha256sum "$RUN" | cut -d' ' -f1)"; SIZE="$(stat -c %s "$RUN")"
  [ ! -f "$RUN.sha256" ] || [ "$(cut -d' ' -f1 "$RUN.sha256")" = "$SHA" ] || { echo "!! $RUN 和旁边的 .sha256 对不上：文件坏了？" >&2; exit 1; }
fi

# ---------- 清单 + 预检 ----------
lrc=0
LIST="$(eg_list)" || lrc=$?
[ "$lrc" = 0 ] || [ "$lrc" = 3 ] || { echo '取不到 EG 清单（子站的 lsa-ext 在跑吗？）' >&2; exit 1; }
declare -A HOST=() CUR=() CFG=() SKIP=() STATE=()
ORDER=()
while IFS=$'\t' read -r cab name host ver tbv cfg up age skip state upok cfgok; do
  [ -n "$cab" ] || continue
  HOST[$cab]="$host"; CUR[$cab]="$ver"; CFG[$cab]="$cfg"; SKIP[$cab]="${skip:--}"; STATE[$cab]="${state:-?}"
  ORDER+=("$cab")
done <<< "$LIST"

if [ "$MODE" = resume ]; then
  mapfile -t TARGETS < <(cut -f1 "$BD/plan.tsv")
else
  TARGETS=()
  if [ "$SEL" = all ]; then TARGETS=("${ORDER[@]}")
  else
    IFS=, read -r -a want <<< "$SEL"
    for c in "${want[@]}"; do
      [ -n "${HOST[$c]+x}" ] || { echo "子站上没有 EG-$c" >&2; exit 1; }
      TARGETS+=("$c")
    done
  fi
  [ -z "$CANARY" ] || [[ " ${TARGETS[*]} " == *" $CANARY "* ]] || { echo "--canary $CANARY 不在要升的清单里" >&2; exit 1; }
fi

printf '\n目标 EG %s（安装文件 %s，sha256 %s…）\n' "$TO" "$(basename "$RUN")" "${SHA:0:12}"
[ "$lrc" = 3 ] && echo '!! 子站扩展服务刚启动、EG 状态还没读全（eg-list 退出码 3）：等一两分钟再跑'
printf '\n%-8s %-8s %-36s %-6s %s\n' 单元 在线 '版本（当前 → 目标）' 动作 原因
GO=() BAD=0 NOADDR=() n_skip=0
[ "$lrc" = 3 ] && BAD=1
need_mb=$(( (SIZE * 2) / 1024 / 1024 + 1536 ))
row() { printf '%-8s %-8s %-36s %-6s %s\n' "$1" "$2" "$3 → $TO" "$4" "$5"; }
for c in "${TARGETS[@]}"; do
  h="${HOST[$c]:--}"; cur="${CUR[$c]:--}"; on="$(zh_state "${STATE[$c]:-?}")"
  if [ "${SKIP[$c]:--}" != - ]; then row "$c" "$on" "$cur" 跳过 "子站上标了「${SKIP[$c]}」"; n_skip=$((n_skip + 1)); continue; fi
  if [ "$h" = - ]; then NOADDR+=("$c"); continue; fi
  if [ "$MODE" != resume ] && [ "$FORCE" != 1 ]; then
    case "$(vrel "$cur" "$TO")" in
      same) row "$c" "$on" "$cur" 跳过 '已是该版本（要重装加 --force）'; n_skip=$((n_skip + 1)); continue ;;
      gt) row "$c" "$on" "$cur" 跳过 '比目标版本新：不降级（回退用 install.sh --rollback）'; n_skip=$((n_skip + 1)); continue ;;
    esac
  fi
  out="$(sshx "$h" hello 2>&1)"; rc=$?
  if [ $rc != 0 ] || ! grep -q '^entry=' <<< "$out"; then
    if grep -q 'Permission denied' <<< "$out"; then why="连不上升级入口：没授权（EG 上 sudo bash install.sh --upgrade-key …；授权只认这台子站的地址）"
    else why="连不上：$(tr '\n' ' ' <<< "$out" | cut -c1-60)（EG 开着吗、22 口通吗）"; fi
    if [ "$SKIP_OFFLINE" = 1 ]; then row "$c" "$on" "$cur" 跳过 "$why"; n_skip=$((n_skip + 1))
    else row "$c" "$on" "$cur" '!!' "$why（--skip-offline 可跳过它）"; BAD=1; fi
    continue
  fi
  free="$(kv free_mb "$out")"; cur="$(kv eg_version "$out")"; maint="$(kv maint "$out")"
  if [ "$MODE" != resume ] && [ "$FORCE" != 1 ]; then
    case "$(vrel "$cur" "$TO")" in
      same) row "$c" "$on" "$cur" 跳过 '已是该版本（要重装加 --force）'; n_skip=$((n_skip + 1)); continue ;;
      gt) row "$c" "$on" "$cur" 跳过 '比目标版本新：不降级'; n_skip=$((n_skip + 1)); continue ;;
    esac
  fi
  if [ "$MODE" != resume ] && [ "$(kv running "$out")" = 1 ]; then row "$c" "$on" "$cur" 跳过 '在维护：EG 上有升级任务正在跑'; n_skip=$((n_skip + 1)); continue; fi
  if [ "$MODE" != resume ] && [ -n "$maint" ]; then row "$c" "$on" "$cur" 跳过 "在维护：$maint"; n_skip=$((n_skip + 1)); continue; fi
  if [ "$MODE" != resume ] && [ "${free:-0}" -lt "$need_mb" ]; then row "$c" "$on" "$cur" '!!' "空间不够：剩 ${free} MB，要约 $need_mb MB"; BAD=1; continue; fi
  note=''; [ "$(vrel "$cur" "$TO")" = eq ] && note='同版本号、不同构建（重打；构建号分不出新旧，确认是要装的那个）'
  [ "$MODE" = resume ] && note='续查 / 接着做'
  row "$c" "$on" "$cur" 升级 "$note"; GO+=("$c")
done
[ ${#NOADDR[@]} -eq 0 ] || printf '\n没有地址、跳过 %s 台（子站上没有这台 EG 的地址：provision-eg.sh --eg-url，或网关页「子站连它」改）：%s\n' "${#NOADDR[@]}" "${NOADDR[*]}"
printf '\n合计：升级 %s 台，跳过 %s 台%s\n' "${#GO[@]}" "$(( n_skip + ${#NOADDR[@]} ))" "$([ "$BAD" = 1 ] && echo '，有 !! 项')"
[ "$PLAN" = 1 ] && { echo '（--plan：只看，没做任何改动）'; exit "$BAD"; }
[ "$BAD" = 0 ] || { echo; echo '预检有问题（上面 !! 那几行），整批不开始。' >&2; exit 1; }
[ ${#GO[@]} -gt 0 ] || { echo; echo '没有要升的。'; exit 0; }

if [ "$MODE" != resume ]; then
  BATCH="$(date +%Y%m%d-%H%M%S)"; BD="$LOGROOT/$BATCH"
  mkdir -p "$BD"
  [ -n "$CANARY" ] || CANARY="${GO[0]}"
  printf 'run=%s\nsha=%s\nsize=%s\nto=%s\nparallel=%s\ncanary=%s\n' "$RUN" "$SHA" "$SIZE" "$TO" "$PAR" "$CANARY" > "$BD/meta"
  for c in "${GO[@]}"; do printf '%s\t%s\t%s\t%s\n' "$c" "${HOST[$c]}" "${CUR[$c]}" "${CFG[$c]}"; done > "$BD/plan.tsv"
fi
exec > >(tee -a "$BD/run.log") 2>&1
exec 3>&1   # 每台的结果行写这里（屏幕 + run.log）；每台的过程写它自己的 <单元号>.log
echo "== $(ts) 批次 $BATCH：${#GO[@]} 台，canary $CANARY，并发 $PAR；日志 $BD"

# ---------- 每台 ----------
plan_cfg() { awk -F'\t' -v c="$1" '$1==c { print $4 }' "$BD/plan.tsv"; }
plan_from() { awk -F'\t' -v c="$1" '$1==c { print $3 }' "$BD/plan.tsv"; }
result() {  # result <单元号> <结果> <原因>：写一行，失败就让后面的不再开
  local c="$1" r="$2" why="$3" s=$(( $(date +%s) - T0 ))
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$c" "$(plan_from "$c")" "$TO" "$s" "$r" "$why" > "$BD/$c.result"
  echo "$(ts) [$c] $r：$why（${s} s）" >&3
  [ "$r" = 成功 ] || touch "$BD/STOP"
}
up_one() {
  local c="$1" h="${HOST[$1]}" log="$BD/$1.log" out ph job st t_end ok row
  T0=$(date +%s)
  exec >> "$log" 2>&1
  echo "== $(ts) $c（$h）→ $TO"
  if [ -f "$BD/$c.job" ]; then job="$(cat "$BD/$c.job")"; echo "续查 EG 上的任务 $job"
  else
    echo "拷安装文件（$SIZE 字节）…"
    out="$(sshx "$h" "put $SHA $SIZE" < "$RUN" 2>&1)"
    echo "$out"
    grep -q "^OK put $SHA" <<< "$out" || { result "$c" 失败 "拷安装文件没成功：$(tail -1 <<< "$out")"; return; }
    out="$(sshx "$h" "start $SHA" 2>&1)"
    echo "$out"
    grep -q '^OK start ' <<< "$out" || { result "$c" 失败 "EG 没开始升级：$(tail -1 <<< "$out")"; sshx "$h" "drop $SHA" >/dev/null 2>&1; return; }
    job="$(awk '/^OK start / { print $3 }' <<< "$out")"
    echo "$job" > "$BD/$c.job"
  fi
  # 查进度：SSH 断了就重连再查（EG 上的任务照跑）
  t_end=$(( $(date +%s) + JOB_TIMEOUT_S )); ph=''
  while [ "$(date +%s)" -lt "$t_end" ]; do
    if st="$(sshx "$h" status 2>&1)"; then
      [ "$(kv job "$st")" = "$job" ] || { echo "EG 上最近的任务不是 $job：$(kv job "$st")"; }
      ph="$(kv phase "$st")"
      started="$(kv started "$st")"; [[ "$started" =~ ^[0-9]+$ ]] && [ "$started" -lt "$T0" ] && T0="$started"
      echo "$(ts) $ph"
      [[ "$TERMINAL" == *" $ph "* ]] && break
    else
      echo "$(ts) 查不到进度（SSH：$(tail -1 <<< "$st")），${POLL_S} s 后重连"
    fi
    sleep "$POLL_S"
  done
  echo '--- EG 上的任务日志（最后 40 行）'; sshx "$h" "log 40" 2>&1 || true
  case "$ph" in
    done) ;;
    rolled-back) result "$c" 失败 "安装没成功，EG 已自动回退到 $(sshx "$h" hello 2>/dev/null | sed -n 's/^eg_version=//p')（$(kv reason "$st")）"; return ;;
    rollback-failed) result "$c" 失败 "安装没成功、自动回退也没成功：$(kv reason "$st")"; return ;;
    check-failed) result "$c" 失败 "装完了但 EG 自查不过：$(kv reason "$st")"; return ;;
    failed) result "$c" 失败 "$(kv reason "$st")"; sshx "$h" "drop $SHA" >/dev/null 2>&1; return ;;
    *) result "$c" 失败 "${JOB_TIMEOUT_S} s 还没做完（最后状态 ${ph:-查不到}）：之后 --resume $BATCH 续查"; return ;;
  esac
  # 子站核对：子站上这台报的版本 = 目标、上送正常（uplinkOk）、配置生效（eg-list 的 cfgApplied；没有 eg-list 时看配置版本和升级前一样）。
  # EG 升级后子站会自动重发一次配置（0.14 起），所以要等一会儿（最多 SP_CHECK_S）
  ok=''; t_end=$(( $(date +%s) + SP_CHECK_S )); sig="$(kv sig "$st")"
  while [ "$(date +%s)" -lt "$t_end" ]; do
    line="$(eg_list 2>/dev/null | awk -F'\t' -v c="$c" '$1==c')"
    IFS=$'\t' read -r _ _ _ ver tbv cfg up age _ state upok cfgok <<< "$line" || true
    echo "$(ts) 子站看到：版本 ${ver:-?}，本地 TB ${tbv:-?}，配置 ${cfg:-?}（生效 ${cfgok:-?}），上送 ${up:-?}（${age:-?} s 前，正常 ${upok:-?}）"
    if [ "$ver" = "$TO" ] && [ "$upok" = true ]; then
      if [ "$cfgok" = true ]; then ok=1; break; fi
      if [ "$cfgok" = - ] && { [ "$(plan_cfg "$c")" = - ] || [ "$cfg" = "$(plan_cfg "$c")" ]; }; then ok=1; break; fi
    fi
    sleep 15
  done
  sshx "$h" "drop $SHA" >/dev/null 2>&1 || true
  signote=''; [ "$sig" = unsigned ] && signote='；安装文件未验签（下一版起要求签名）'
  if [ -n "$ok" ]; then result "$c" 成功 "本地 TB ${tbv}，配置 ${cfg} 生效，上送正常${signote}"
  else result "$c" 失败 "EG 自查通过，但子站核对不过（版本 ${ver:-?} / 上送正常 ${upok:-?}、${age:-?} s 前 / 配置 ${cfg:-?} 生效 ${cfgok:-?}，升级前 $(plan_cfg "$c")）"; fi
}
todo=()
for c in "${GO[@]}"; do [ -f "$BD/$c.result" ] || todo+=("$c"); done
if [ -f "$BD/STOP" ] && [ "$MODE" = resume ]; then echo '这一批之前有失败、已经停下：只续查已经开始的，不再开新的'; fi
# canary 先做，做完核对通过才往下
for c in "${todo[@]}"; do
  [ "$c" = "$CANARY" ] || continue
  if [ -f "$BD/STOP" ] && [ ! -f "$BD/$c.job" ]; then break; fi
  echo "== $(ts) canary $CANARY"
  ( up_one "$CANARY" )
done
# 其余按并发上限；任何一台失败（STOP）就不再开新的，已经在升的做完（只等自己起的这些进程：stdout 经过 tee，裸 wait 会等不到头）
pids=()
running_n() { local n=0 p; for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && n=$((n + 1)); done; echo "$n"; }
for c in "${todo[@]}"; do
  [ "$c" != "$CANARY" ] || continue
  if [ -f "$BD/STOP" ] && [ ! -f "$BD/$c.job" ]; then continue; fi
  while [ "$(running_n)" -ge "$PAR" ]; do sleep 2; done
  if [ -f "$BD/STOP" ] && [ ! -f "$BD/$c.job" ]; then continue; fi
  echo "== $(ts) 开始 $c"
  ( up_one "$c" ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done

# ---------- 汇总 ----------
: > "$BD/summary.tsv"
echo
echo "== $(ts) 汇总（批次 $BATCH，目标 EG $TO）"
printf '%-8s %-18s %-8s %-6s %s\n' 单元 原版本 耗时s 结果 说明
fails=0
while IFS=$'\t' read -r c _ _ _; do
  if [ -f "$BD/$c.result" ]; then
    IFS=$'\t' read -r _ from to s r why < "$BD/$c.result" || true
    cat "$BD/$c.result" >> "$BD/summary.tsv"
  else
    from="$(plan_from "$c")"; s='-'; r='没做'; why='前面有失败，停下了（修好后 --resume '"$BATCH"' 接着做）'
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$c" "$from" "$TO" - "$r" "$why" >> "$BD/summary.tsv"
  fi
  [ "$r" = 成功 ] || fails=$((fails + 1))
  printf '%-8s %-18s %-8s %-6s %s\n' "$c" "$from" "$s" "$r" "$why"
  if [ "$r" = 失败 ]; then
    rb='sudo bash /opt/lsa-eg/install.sh --rollback'
    grep -q -- '--restore-tb' <<< "$why" && rb+=' --restore-tb'
    case "$why" in *已自动回退*) ;; *) echo "         回退（在 $c 上用维护账号）：$rb    任务日志：$BD/$c.log" ;; esac
  fi
done < "$BD/plan.tsv"
echo "日志：$BD"
[ "$fails" = 0 ]
