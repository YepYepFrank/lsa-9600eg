#!/bin/bash
# LSA-9600SP 子站主机上一条命令批量升级 EG（0.17.3）。在子站主机上用 root 跑：
#
#   sudo bash upgrade-egs.sh --keygen                       生成子站的升级 key（只一次），打印每台 EG 上要执行的授权命令
#   sudo bash upgrade-egs.sh --run <新 .run> --plan [--all | --only AH03,AH05]
#                                                           只看要做什么：每台 EG 当前版本 → 目标版本、连得上没有、空间够不够（不改任何东西）
#   sudo bash upgrade-egs.sh --run <新 .run> --all | --only AH03,AH05 [--canary AH05] [--parallel 2] [--force]
#                                                           升级：先升 canary（缺省清单里第一台），核对通过后其余按并发上限依次升；
#                                                           任何一台失败就不再开新的，打印那台的回退命令。--force：已经是目标版本的也重装
#   sudo bash upgrade-egs.sh --resume <批次>                 断开以后续查 / 接着做（EG 上的升级任务不受子站断开影响）
#   sudo bash upgrade-egs.sh --list                         列出做过的批次与结果
#
# 安全：EG 上的专用账号 lsa-upg 只认这台子站、只能进 EG 的升级入口（交安装文件、开始、查进度），不能执行别的命令；
#   EG 上授权：sudo bash /opt/lsa-eg/install.sh --upgrade-key '<--keygen 打印的公钥>'，撤销 --drop-upgrade-key。
#   key 在 /opt/lsa9600sp/keys/（root 600）：持这把 key 的人能让 EG 装他给的任意安装文件，不要拷走。
# 每台的流程：拷安装文件（EG 上核对 sha256 与空间）→ 开始（EG 自己在后台做，失败自动回退）→ 每 10 s 查进度 →
#   EG 自查（版本、7 个容器、本地 TB、连上子站）→ 子站核对（子站 TB 上 EG 报的版本、上送、配置版本没丢）→ 删掉 EG 上的拷贝。
# 日志：/var/log/lsa9600sp/eg-upgrade/<批次>/（run.log、summary.tsv、每台一份 <柜号>.log）。
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

RUN='' SEL='' CANARY='' PAR=2 PLAN=0 FORCE=0 MODE=''
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
    --resume) MODE=resume; BATCH="${2:?--resume <批次>（--list 看有哪些）}"; shift ;;
    --list) MODE=list ;;
    -h | --help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { sed -n '2,23p' "$0"; exit 2; }
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

# ---------- EG 清单：子站后端的 eg-list（有就用）；没有就直接查子站 TB ----------
# 每行（TSV）：柜号 EG设备名 地址 EG报的版本 本地TB版本 配置版本 上送 上送多少秒前 停用
eg_list() {
  if [ -n "${EG_LIST_CMD:-}" ]; then eval "$EG_LIST_CMD"; return; fi
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
    const off = s.egDisabled === true || s.disabled === true || s.egState === 'disabled' || s.egState === 'never' ? 1 : 0
    const v = x => (x === undefined || x === null || x === '' ? '-' : String(x).replace(/\s/g, ''))
    console.log([d.name.replace(/^EG-/, ''), d.name, v(host), v(c.agent), v(c.tbVersion), v(c.cfg), v(up && up.value), up ? Math.round((Date.now() - up.ts) / 1000) : '-', off].join('\t'))
  }
})().catch(e => { console.error('取 EG 清单失败：' + e.message); process.exit(1) })
JS
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
  RUN="$(sed -n 's/^run=//p' "$BD/meta")"; SHA="$(sed -n 's/^sha=//p' "$BD/meta")"; SIZE="$(sed -n 's/^size=//p' "$BD/meta")"
  TO="$(sed -n 's/^to=//p' "$BD/meta")"; PAR="$(sed -n 's/^parallel=//p' "$BD/meta")"; CANARY="$(sed -n 's/^canary=//p' "$BD/meta")"
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
LIST="$(eg_list)" || { echo '取不到 EG 清单（子站的 lsa-ext 在跑吗？）' >&2; exit 1; }
declare -A HOST=() CUR=() CFG=() ROW=()
ORDER=()
while IFS=$'\t' read -r cab name host ver tbv cfg up age off; do
  [ -n "$cab" ] || continue
  HOST[$cab]="$host"; CUR[$cab]="$ver"; CFG[$cab]="$cfg"; ROW[$cab]="$off"
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
printf '%-8s %-16s %-18s %-8s %s\n' 柜号 地址 当前版本 空间MB 计划
GO=() BAD=0
need_mb=$(( (SIZE * 2) / 1024 / 1024 + 1536 ))
for c in "${TARGETS[@]}"; do
  h="${HOST[$c]:--}"; cur="${CUR[$c]:--}"; plan='' free='-'
  if [ "${ROW[$c]:-0}" = 1 ]; then plan='跳过：子站上标了未接入 / 停用'
  elif [ "$h" = - ]; then plan='跳过：子站上没有这台的地址（egUrl）'
  elif [ "$MODE" != resume ] && [ "$cur" = "$TO" ] && [ "$FORCE" != 1 ]; then plan='跳过：已经是目标版本（--force 重装）'
  else
    out="$(sshx "$h" hello 2>&1)"; rc=$?
    if [ $rc != 0 ] || ! grep -q '^entry=' <<< "$out"; then
      if grep -q 'Permission denied' <<< "$out"; then hint='EG 上授权过吗？sudo bash install.sh --upgrade-key …；授权只认这台子站的地址'
      else hint='网络 / SSH 不通：EG 开着吗、22 口通吗'; fi
      plan="!! 连不上升级入口：$(tr '\n' ' ' <<< "$out" | cut -c1-80)（$hint）"; BAD=1
    else
      free="$(kv free_mb "$out")"; cur="$(kv eg_version "$out")"
      if [ "$(kv running "$out")" = 1 ] && [ "$MODE" != resume ]; then plan='!! EG 上有升级任务正在跑'; BAD=1
      elif [ "$MODE" != resume ] && [ "${free:-0}" -lt "$need_mb" ]; then plan="!! 空间不够（要约 $need_mb MB）"; BAD=1
      elif [ "$MODE" != resume ] && [ "$cur" = "$TO" ] && [ "$FORCE" != 1 ]; then plan='跳过：已经是目标版本（--force 重装）'
      else plan="升级 → $TO"; GO+=("$c"); fi
    fi
  fi
  printf '%-8s %-16s %-18s %-8s %s\n' "$c" "$h" "$cur" "$free" "$plan"
done
[ "$PLAN" = 1 ] && { echo; echo '（--plan：只看，没做任何改动）'; exit "$BAD"; }
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
exec 3>&1   # 每台的结果行写这里（屏幕 + run.log）；每台的过程写它自己的 <柜号>.log
echo "== $(ts) 批次 $BATCH：${#GO[@]} 台，canary $CANARY，并发 $PAR；日志 $BD"

# ---------- 每台 ----------
plan_cfg() { awk -F'\t' -v c="$1" '$1==c { print $4 }' "$BD/plan.tsv"; }
plan_from() { awk -F'\t' -v c="$1" '$1==c { print $3 }' "$BD/plan.tsv"; }
result() {  # result <柜号> <结果> <原因>：写一行，失败就让后面的不再开
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
  # 子站核对：子站 TB 上 EG 报的版本 = 目标、上送 ok 且 2 分钟内、配置版本没丢（和升级前一样）
  ok=''; t_end=$(( $(date +%s) + SP_CHECK_S ))
  while [ "$(date +%s)" -lt "$t_end" ]; do
    row="$(eg_list 2>/dev/null | awk -F'\t' -v c="$c" '$1==c')"
    IFS=$'\t' read -r _ _ _ ver tbv cfg up age _ <<< "$row"
    echo "$(ts) 子站看到：版本 ${ver:-?}，本地 TB ${tbv:-?}，配置 ${cfg:-?}，上送 ${up:-?}（${age:-?} s 前）"
    if [ "$ver" = "$TO" ] && [ "$up" = ok ] && [[ "$age" =~ ^[0-9]+$ ]] && [ "$age" -le 120 ] && { [ "$(plan_cfg "$c")" = - ] || [ "$cfg" = "$(plan_cfg "$c")" ]; }; then ok=1; break; fi
    sleep 15
  done
  sshx "$h" "drop $SHA" >/dev/null 2>&1 || true
  if [ -n "$ok" ]; then result "$c" 成功 "本地 TB ${tbv}，配置 ${cfg} 照旧，上送正常"
  else result "$c" 失败 "EG 自查通过，但子站核对不过（版本 ${ver:-?} / 上送 ${up:-?} ${age:-?} s 前 / 配置 ${cfg:-?}，升级前 $(plan_cfg "$c")）"; fi
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
printf '%-8s %-18s %-8s %-6s %s\n' 柜号 原版本 耗时s 结果 说明
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
