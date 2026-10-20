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
#   网页入口（0.19.0，子站主机上的执行器 lsa-eg-upgrade-runner 调）：--plan --json 计划只输出 JSON（文字照常进 stderr）；
#     --batch <YYYYMMDD-HHMMSS> 批次号由调用方定；--by <用户> --req <请求号> --source web|cli 写进批次 meta；
#     --expect-sha <sha256> 安装文件不是这个 sha256 就不开始（计划之后被换了）
#   同一时间只跑一个批次：升级 / 续查先拿 /run/lsa9600sp/eg-upgrade.lock，拿不到就报「已有批次在跑」退出（命令行和网页共用）
#
# 安全：EG 上的专用账号 lsa-upg 只认这台子站、只能进 EG 的升级入口（交安装文件、开始、查进度），不能执行别的命令；
#   EG 上授权：sudo bash /opt/lsa-eg/install.sh --upgrade-key '<--keygen 打印的公钥>'，撤销 --drop-upgrade-key。
#   key 在 /opt/lsa9600sp/keys/（root 600）：不要拷走。
# 签名（0.18.1 起）：安装文件旁边的 <run>.sig（发布方 ssh-keygen -Y sign 出的）自动一起用：
#   先在子站用 /opt/lsa9600sp/release-signers 验一遍 —— 签名不对整批不开始（--plan 也报 !!）；
#   EG 入口是 0.18.1 起的（entry ≥ 5）就把 .sig 一起传过去，EG 用它自己装着的发布公钥再验，不对就拒绝、不装。
#   过渡期：没有 .sig 照升，汇总写「未验签」；EG 是老入口（升到 0.18.1 的这一次）收不了 .sig，只有子站验过。下一版起没签名不升。
#   有了签名，持升级 key 的人也只能让 EG 装发布方签过的安装文件（仍然可以装旧一点的签名包，但不降级：版本不比现在的低）。
# 每台的流程：拷安装文件（EG 上核对 sha256 与空间）→ 开始（EG 自己在后台做，失败自动回退）→ 每 10 s 查进度 →
#   EG 自查（版本、7 个容器、本地 TB、连上子站）→ 子站核对（子站 TB 上 EG 报的版本、上送、配置版本没丢）→ 删掉 EG 上的拷贝。
# 日志：/var/log/lsa9600sp/eg-upgrade/<批次>/（meta、plan.tsv、run.log、summary.tsv、每台 <单元号>.log / .phase / .result）。
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
# 发布公钥（一键安装文件 --role sp 装的）与签名身份 / 命名空间（和 EG 的 lsa-eg-upgrade、打包的 sign-release.mjs 一致）
SIGNERS="${LSA_RELEASE_SIGNERS:-$SP/release-signers}"
SIG_ID=lsa9600-release
SIG_NS=lsa9600-release
TERMINAL=' done rolled-back rollback-failed check-failed failed '

LOCK=/run/lsa9600sp/eg-upgrade.lock

RUN='' SEL='' CANARY='' PAR=2 PLAN=0 FORCE=0 MODE='' SKIP_OFFLINE=0 JSON=0 BATCH_ARG='' BY='' REQ='' SOURCE=cli EXPECT_SHA=''
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
    --json) JSON=1 ;;
    --batch) BATCH_ARG="${2:?--batch YYYYMMDD-HHMMSS}"; shift ;;
    --by) BY="${2:?--by <用户>}"; shift ;;
    --req) REQ="${2:?--req <请求号>}"; shift ;;
    --source) SOURCE="${2:?--source web|cli}"; shift ;;
    --expect-sha) EXPECT_SHA="${2:?--expect-sha <sha256>}"; shift ;;
    -h | --help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { sed -n '2,30p' "$0"; exit 2; }
[ "$(id -u)" = 0 ] || { echo '要 root：sudo bash upgrade-egs.sh …' >&2; exit 1; }
[[ "$PAR" =~ ^[1-9][0-9]?$ ]] || { echo "--parallel 要 1–99：$PAR" >&2; exit 2; }
[ "$JSON" = 0 ] || { [ "$MODE" = run ] && [ "$PLAN" = 1 ]; } || { echo '--json 只配 --run … --plan 用' >&2; exit 2; }
[ -z "$BATCH_ARG" ] || [[ "$BATCH_ARG" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo "--batch 要 YYYYMMDD-HHMMSS：$BATCH_ARG" >&2; exit 2; }
[ -z "$REQ" ] || [[ "$REQ" =~ ^[0-9]{8}-[0-9]{6}-[a-z0-9]{6}$ ]] || { echo "--req 格式不对：$REQ" >&2; exit 2; }
[ -z "$BY" ] || [[ "$BY" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || { echo '--by 只许字母、数字、. _ @ -（1–64 个）' >&2; exit 2; }
case "$SOURCE" in web | cli) ;; *) echo "--source 只能 web 或 cli：$SOURCE" >&2; exit 2 ;; esac
[ -z "$EXPECT_SHA" ] || [[ "$EXPECT_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo '--expect-sha 要 64 位小写 hex' >&2; exit 2; }
BY="${BY:-${SUDO_USER:-root}}"; [[ "$BY" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || BY=root
UNIT_RE='^[A-Za-z0-9-]{1,24}$'   # 单元号（来自 eg-list，也就是容器）：不合格的不碰文件系统
WORK="${LSA_EGUP_WORK:-/var/lib/lsa9600sp/eg-upgrade/work}"   # 安装文件的 root 0700 工作拷贝（sha、验签、推给 EG 都用这一份）
ALIVE_S="${LSA_EGUP_ALIVE_S:-30}"   # 批次在跑时每这么多秒 touch 一次 <批次>/.alive（扩展服务 ≤ 90 s 判在跑）
WORKD='' META_ON='' HB=''
on_exit() {
  [ -z "$HB" ] || kill "$HB" 2>/dev/null
  [ -z "$WORKD" ] || rm -rf "$WORKD"
  [ -z "$META_ON" ] || meta_set ended_at "$(now_ms)"
}
trap on_exit EXIT
# 把安装文件（和 .sig）拷进 root 0700 的工作目录：packages/ 组可写，拷完以后 sha、验签、推给 EG 都只认这一份（堵住两次读之间被换）
stage_copy() {
  local src="$1" need
  install -d -m 700 "$WORK" || { echo "建不了工作目录 $WORK" >&2; exit 1; }
  need=$(( $(stat -c %s "$src") / 1024 + 65536 ))
  [ "$(df -Pk "$WORK" | awk 'NR==2 { print $4 }')" -ge "$need" ] || { echo "!! $WORK 所在盘放不下安装文件的拷贝（要约 $((need / 1024)) MB）" >&2; exit 1; }
  WORKD="$(mktemp -d "$WORK/$$.XXXXXX")" || exit 1
  cp --reflink=auto -- "$src" "$WORKD/pkg.run" || { echo "!! 拷不了 $src" >&2; exit 1; }
  if [ -f "$src.sig" ]; then cp -- "$src.sig" "$WORKD/pkg.run.sig" || exit 1; fi
}
# 心跳：批次在跑时每 ALIVE_S 秒 touch <批次>/.alive（不拿批次锁、不进 run.log；主进程没了自己退）
start_heartbeat() {
  touch "$BD/.alive"
  ( exec 9>&- >/dev/null 2>&1; trap - EXIT; while kill -0 "$$" 2>/dev/null; do touch "$BD/.alive"; sleep "$ALIVE_S"; done ) &
  HB=$!
}
# --plan --json：标准输出只给 JSON（fd 4），给人看的文字全进 stderr
if [ "$JSON" = 1 ]; then exec 4>&1 1>&2; fi
now_ms() { date +%s%3N; }
# 批次 meta 改一行（有就换、没有就加）/ 删一行
meta_set() { local f="$BD/meta"; { grep -v "^$1=" "$f" 2>/dev/null; printf '%s=%s\n' "$1" "$2"; } > "$f.tmp" && mv -f "$f.tmp" "$f"; }
meta_del() { local f="$BD/meta"; grep -v "^$1=" "$f" > "$f.tmp" 2>/dev/null; mv -f "$f.tmp" "$f"; }
# 升级 / 续查只许一个批次：拿不到锁就退出（锁跟着进程走，进程没了自动放开；fd 9 子进程都继承，做完才放）
take_lock() {
  mkdir -p "$(dirname "$LOCK")"
  exec 9> "$LOCK"
  flock -n 9 || { echo "已有批次在跑（$LOCK 被占着；--list 看批次，等它做完再来）" >&2; exit 1; }
}
if { [ "$MODE" = run ] && [ "$PLAN" = 0 ]; } || [ "$MODE" = resume ]; then take_lock; fi

ts() { date '+%F %T'; }
envget() { grep -E "^$1=" "$SP_ENV" 2>/dev/null | tail -1 | cut -d= -f2-; }
sshx() {  # sshx <EG 地址> <命令>：用升级 key 连 lsa-upg；EG 那边不管发什么都只进升级入口
  local h="$1"; shift
  ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KH" \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o LogLevel=ERROR "lsa-upg@$h" "$*"
}
kv() { sed -n "s/^$1=//p" <<< "$2" | tail -1; }
# 在子站验签：local_sig <安装文件> → SIGST=ok / unsigned / nokey / bad，SIGMSG=说明
local_sig() {
  local f="$1" out
  SIGST=unsigned SIGMSG="旁边没有 $(basename "$f").sig"
  [ -f "$f.sig" ] || return 0
  if [ "$(awk '!/^[[:space:]]*(#|$)/ { n++ } END { print n + 0 }' "$SIGNERS" 2>/dev/null || echo 0)" = 0 ]; then
    SIGST=nokey SIGMSG="子站没有发布公钥 $SIGNERS（子站先用 0.18.1 起的安装文件 --role sp 升级）"; return 0
  fi
  if out="$(ssh-keygen -Y verify -f "$SIGNERS" -I "$SIG_ID" -n "$SIG_NS" -s "$f.sig" < "$f" 2>&1)"; then
    SIGST=ok SIGMSG="$(grep -o 'SHA256:[A-Za-z0-9+/=]*' <<< "$out" | head -1)"
  else
    SIGST=bad SIGMSG="$(tr '\n' ' ' <<< "$out" | cut -c1-160)"
  fi
}
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
# ---------- --plan --json（网页入口方案 §9.3）----------
jstr() {  # JSON 字符串；控制字符换成空格 / 去掉
  local s="$1"
  s="${s//$'\t'/ }"; s="${s//$'\n'/ }"; s="${s//$'\r'/ }"
  s="$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\037\177')"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}
jstr_or_null() { if [ -z "$1" ] || [ "$1" = - ]; then printf null; else jstr "$1"; fi; }
plan_json() {
  local r u st from act vs why a eg sep='' n_up=0 n_bad=0 ok=false
  printf '{"to":%s,"run":%s,"sha":%s,"size":%s,"sig":%s,"sigNote":%s,"rows":[' \
    "$(jstr "$TO")" "$(jstr "$RUN")" "$(jstr "$SHA")" "${SIZE:-0}" "$(jstr "$SIGST")" "$(jstr "$SIGMSG")"
  for r in "${JROWS[@]}"; do
    IFS=$'\t' read -r u st from act vs why <<< "$r"
    case "$act" in 升级) a=up; n_up=$((n_up + 1)) ;; 跳过) a=skip ;; *) a=bad; n_bad=$((n_bad + 1)) ;; esac
    # egSig：EG 验 ok / 子站验 old-entry / 未签名 unsigned / 都验不了 nokey；跳过的行 null
    case "$vs" in 'EG 验') eg='"ok"' ;; 子站验) eg='"old-entry"' ;; 未签名) eg='"unsigned"' ;; 未验) eg="$(jstr "$SIGST")" ;; *) eg=null ;; esac
    [ "$a" != skip ] || eg=null
    printf '%s{"unit":%s,"state":%s,"from":%s,"action":"%s","reason":%s,"egSig":%s}' \
      "$sep" "$(jstr "$u")" "$(jstr "$st")" "$(jstr_or_null "$from")" "$a" "$(jstr "${why:-}")" "$eg"
    sep=,
  done
  printf '],"noAddr":['; sep=''
  for u in "${NOADDR[@]}"; do printf '%s%s' "$sep" "$(jstr "$u")"; sep=,; done
  # skip 和文字的「合计」一致：含没有地址的那几台
  [ "$BAD" = 0 ] && [ "$SIGST" = ok ] && ok=true
  [ "$lrc" != 3 ] || n_bad=$((n_bad + 1))   # eg-list 还没读全也算一项 !!
  printf '],"summary":{"up":%s,"skip":%s,"bad":%s},"ok":%s%s}\n' "$n_up" "$(( n_skip + ${#NOADDR[@]} ))" "$n_bad" "$ok" \
    "$([ "$lrc" = 3 ] && printf ',"listNotReady":true')"
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
  SIGST="$(sed -n 's/^sig=//p' "$BD/meta")"; SIGMSG="$(sed -n 's/^sig_note=//p' "$BD/meta")"; SIGST="${SIGST:-unsigned}"  # sete-ok（0.18.1 前的批次没有，当未签）
  rm -f "$BD/STOP.resume"
  # 续查：原来的 by / req / source / started_at 不动，记这次续查的人和 pid；ended_at 等这次做完再补
  meta_set pid "$$"; meta_set resumed_at "$(now_ms)"; meta_set resumed_by "$BY"; meta_set resumed_source "$SOURCE"
  if [ -n "$REQ" ]; then meta_set resumed_req "$REQ"; else meta_del resumed_req; fi
  meta_del ended_at; META_ON=1
  # 网页续查（--source web）只认签名验过的批次（方案 Q2）：命令行起的未签名批次只能命令行续
  if [ "$SOURCE" = web ] && [ "$SIGST" != ok ]; then echo "!! 这一批不是签名包（sig=$SIGST），只能命令行续" >&2; exit 1; fi
  [ -f "$RUN" ] || { echo "!! 安装文件 $RUN 不在了：还没开始的不能再升，已经开始的照样续查" >&2; }
  if [ -f "$RUN" ]; then
    stage_copy "$RUN"
    [ "$(sha256sum "$WORKD/pkg.run" | cut -d' ' -f1)" = "$SHA" ] || { echo "!! $RUN 和这一批开始时的不是同一个（sha256 变了）—— 不续" >&2; exit 1; }
    RUN="$WORKD/pkg.run"
  fi
  start_heartbeat
else
  [ -f "$RUN" ] || { echo "没有安装文件：$RUN" >&2; exit 1; }
  [ -n "$SEL" ] || { echo '要给 --all 或 --only AH03,AH05' >&2; exit 2; }
  [ -z "$BATCH_ARG" ] || [ "$PLAN" = 1 ] || [ ! -e "$LOGROOT/$BATCH_ARG" ] || { echo "批次 $BATCH_ARG 已经有了（$LOGROOT/$BATCH_ARG）" >&2; exit 1; }
  [ -f "$KEY" ] || { echo "没有升级 key（$KEY）：先 sudo bash upgrade-egs.sh --keygen，再到各 EG 上授权" >&2; exit 1; }
  RUN="$(readlink -f "$RUN")"; RUN_ORIG="$RUN"
  # 真升级用 root 0700 的工作拷贝（--plan 只看，读原文件；网页的 start 由 --expect-sha 对上这份拷贝）
  if [ "$PLAN" = 0 ]; then stage_copy "$RUN"; RUN="$WORKD/pkg.run"; fi
  TO="$(run_eg_version "$RUN" || true)"
  [ -n "$TO" ] || { echo "$RUN 不是 LSA-9600 的一键安装文件，或者里面没有 EG 发布件" >&2; exit 1; }
  echo "安装文件：$RUN（EG $TO），算 sha256 …"
  SHA="$(sha256sum "$RUN" | cut -d' ' -f1)"; SIZE="$(stat -c %s "$RUN")"
  [ -z "$EXPECT_SHA" ] || [ "$SHA" = "$EXPECT_SHA" ] || { echo "!! 安装文件的 sha256（${SHA:0:12}…）不是确认过的那个（${EXPECT_SHA:0:12}…）：计划之后被换过 —— 整批不开始" >&2; exit 1; }
  [ ! -f "$RUN_ORIG.sha256" ] || [ "$(cut -d' ' -f1 "$RUN_ORIG.sha256")" = "$SHA" ] || { echo "!! $RUN_ORIG 和旁边的 .sha256 对不上：文件坏了？" >&2; exit 1; }
  echo '验签 …'
  local_sig "$RUN"
  if [ "$SIGST" = bad ]; then
    echo "!! 安装文件签名校验不过：不是发布方签的，或者 $(basename "$RUN_ORIG") / .sig 被改过 —— 整批不开始（$SIGMSG）" >&2
    exit 1
  fi
  # 网页入口（执行器 --source web）只认子站验过签名的（方案 Q2）：.sig 在计划之后被删 / 换了也拦得住
  if [ "$SOURCE" = web ] && [ "$PLAN" = 0 ] && [ "$SIGST" != ok ]; then
    echo "!! 网页入口只认签名验过的安装包，这个是 $SIGST（$SIGMSG）—— 整批不开始；未签名的只能命令行升" >&2
    exit 1
  fi
fi
SIGSIZE=0; [ -f "$RUN.sig" ] && SIGSIZE="$(stat -c %s "$RUN.sig")"
case "$SIGST" in
  ok) SIGLINE="已验（发布方 $SIGMSG）" ;;
  nokey) SIGLINE="!! 有 .sig 但子站验不了：$SIGMSG —— EG 上照样验" ;;
  *) SIGLINE='没有签名（0.18.1 过渡期照升，汇总写「未验签」；下一版起没签名不升）' ;;
esac

# ---------- 清单 + 预检 ----------
lrc=0
LIST="$(eg_list)" || lrc=$?
[ "$lrc" = 0 ] || [ "$lrc" = 3 ] || { echo '取不到 EG 清单（子站的 lsa-ext 在跑吗？）' >&2; exit 1; }
declare -A HOST=() CUR=() CFG=() SKIP=() STATE=()
ORDER=()
BADU=()
while IFS=$'\t' read -r cab name host ver tbv cfg up age skip state upok cfgok; do
  [ -n "$cab" ] || continue
  [[ "$cab" =~ $UNIT_RE ]] || { BADU+=("$cab"); continue; }
  HOST[$cab]="$host"; CUR[$cab]="$ver"; CFG[$cab]="$cfg"; SKIP[$cab]="${skip:--}"; STATE[$cab]="${state:-?}"
  ORDER+=("$cab")
done <<< "$LIST"

if [ "$MODE" = resume ]; then
  mapfile -t TARGETS < <(cut -f1 "$BD/plan.tsv")
  for c in "${TARGETS[@]}"; do [[ "$c" =~ $UNIT_RE ]] || { echo "批次的 plan.tsv 里有不合格的单元号：$c" >&2; exit 1; }; done
else
  TARGETS=()
  if [ "$SEL" = all ]; then TARGETS=("${ORDER[@]}")
  else
    IFS=, read -r -a want <<< "$SEL"
    for c in "${want[@]}"; do
      [[ "$c" =~ $UNIT_RE ]] || { echo "单元号不合格：$c" >&2; exit 2; }
      [ -n "${HOST[$c]+x}" ] || { echo "子站上没有 EG-$c" >&2; exit 1; }
      TARGETS+=("$c")
    done
  fi
  [ -z "$CANARY" ] || { [[ "$CANARY" =~ $UNIT_RE ]] && [[ " ${TARGETS[*]} " == *" $CANARY "* ]]; } || { echo "--canary $CANARY 不在要升的清单里" >&2; exit 1; }
fi

printf '\n目标 EG %s（安装文件 %s，sha256 %s…）\n签名：%s\n' "$TO" "$(basename "${RUN_ORIG:-$RUN}")" "${SHA:0:12}" "$SIGLINE"
[ "$lrc" = 3 ] && echo '!! 子站扩展服务刚启动、EG 状态还没读全（eg-list 退出码 3）：等一两分钟再跑'
printf '\n%-8s %-8s %-36s %-6s %-10s %s\n' 单元 在线 '版本（当前 → 目标）' 动作 验签 原因
GO=() BAD=0 NOADDR=() n_skip=0
declare -A ENTRY=()
[ "$lrc" = 3 ] && BAD=1
need_mb=$(( (SIZE * 2) / 1024 / 1024 + 1536 ))
# 验签列：EG 验（入口 ≥ 5 且有发布公钥）/ 子站验（EG 老入口或没公钥，只有子站验过）/ 未签名 / -（不升的）
VS=-
# 每行同时记一份给 --json（单元 \t eg-list 原状态 \t 当前版本 \t 动作 \t 验签列 \t 原因）
JROWS=()
row() {
  printf '%-8s %-8s %-36s %-6s %-10s %s\n' "$1" "$2" "$3 → $TO" "$4" "$VS" "$5"
  JROWS+=("$1"$'\t'"${STATE[$1]:-?}"$'\t'"$3"$'\t'"$4"$'\t'"$VS"$'\t'"${5//$'\t'/ }")
  VS=-
}
# eg-list 给了不合格的单元号（--all 时）：!! 行，不碰文件系统、不连
if [ "$MODE" != resume ] && [ "$SEL" = all ]; then
  for c in "${BADU[@]}"; do
    printf '%-8s %-8s %-36s %-6s %-10s %s\n' "$c" '?' "- → $TO" '!!' - '单元号不合格（只许字母、数字、-，≤ 24 个）：子站清单有问题'
    JROWS+=("${c//$'\t'/ }"$'\t'"?"$'\t'"-"$'\t'"!!"$'\t'"-"$'\t'"单元号不合格（只许字母、数字、-，≤ 24 个）")
    BAD=1
  done
fi
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
  ent="$(kv entry "$out")"; [[ "$ent" =~ ^[0-9]+$ ]] || ent=0; ENTRY[$c]="$ent"
  skeys="$(kv sig_keys "$out")"; sreq="$(kv sig_required "$out")"
  if [ "$SIGST" = unsigned ]; then VS=未签名
  elif [ "$ent" -ge 5 ] && [ "${skeys:-0}" -gt 0 ] 2>/dev/null; then VS='EG 验'
  elif [ "$SIGST" = ok ]; then VS='子站验'
  else VS=未验; fi
  if [ "$MODE" != resume ] && [ "$FORCE" != 1 ]; then
    case "$(vrel "$cur" "$TO")" in
      same) row "$c" "$on" "$cur" 跳过 '已是该版本（要重装加 --force）'; n_skip=$((n_skip + 1)); continue ;;
      gt) row "$c" "$on" "$cur" 跳过 '比目标版本新：不降级'; n_skip=$((n_skip + 1)); continue ;;
    esac
  fi
  if [ "$MODE" != resume ] && [ "$(kv running "$out")" = 1 ]; then row "$c" "$on" "$cur" 跳过 '在维护：EG 上有升级任务正在跑'; n_skip=$((n_skip + 1)); continue; fi
  if [ "$MODE" != resume ] && [ -n "$maint" ]; then row "$c" "$on" "$cur" 跳过 "在维护：$maint"; n_skip=$((n_skip + 1)); continue; fi
  if [ "$MODE" != resume ] && [ "${free:-0}" -lt "$need_mb" ]; then row "$c" "$on" "$cur" '!!' "空间不够：剩 ${free} MB，要约 $need_mb MB"; BAD=1; continue; fi
  if [ "$sreq" = 1 ] && [ "$SIGST" != ok ]; then row "$c" "$on" "$cur" '!!' "这台 EG 要求发布件签名（EG_UPG_SIG_REQUIRED=1），安装文件$([ "$SIGST" = unsigned ] && echo '没有 .sig' || echo '的签名子站没验过')"; BAD=1; continue; fi
  note=''; [ "$(vrel "$cur" "$TO")" = eq ] && note='同版本号、不同构建（重打；构建号分不出新旧，确认是要装的那个）'
  case "$VS" in
    子站验) note="${note:+$note；}EG 是老入口（升到 0.18.1 的这一次），收不了签名：只有子站验过" ;;
    未验) note="${note:+$note；}子站和 EG 都验不了签名（$SIGMSG）" ;;
  esac
  [ "$MODE" = resume ] && note='续查 / 接着做'
  row "$c" "$on" "$cur" 升级 "$note"; GO+=("$c")
done
[ ${#NOADDR[@]} -eq 0 ] || printf '\n没有地址、跳过 %s 台（子站上没有这台 EG 的地址：provision-eg.sh --eg-url，或网关页「子站连它」改）：%s\n' "${#NOADDR[@]}" "${NOADDR[*]}"
printf '\n合计：升级 %s 台，跳过 %s 台%s\n' "${#GO[@]}" "$(( n_skip + ${#NOADDR[@]} ))" "$([ "$BAD" = 1 ] && echo '，有 !! 项')"
if [ "$PLAN" = 1 ]; then
  echo '（--plan：只看，没做任何改动）'
  [ "$JSON" = 0 ] || plan_json >&4
  exit "$BAD"
fi
[ "$BAD" = 0 ] || { echo; echo '预检有问题（上面 !! 那几行），整批不开始。' >&2; exit 1; }
[ ${#GO[@]} -gt 0 ] || { echo; echo '没有要升的。'; exit 0; }

if [ "$MODE" != resume ]; then
  BATCH="${BATCH_ARG:-$(date +%Y%m%d-%H%M%S)}"; BD="$LOGROOT/$BATCH"
  mkdir -p "$LOGROOT"
  mkdir "$BD" || { echo "批次目录 $BD 已经有了（同一秒起了两批？）" >&2; exit 1; }
  [ -n "$CANARY" ] || CANARY="${GO[0]}"
  # 第 5 列：EG 升级入口版本（≥ 5 才传 .sig）
  for c in "${GO[@]}"; do printf '%s\t%s\t%s\t%s\t%s\n' "$c" "${HOST[$c]}" "${CUR[$c]}" "${CFG[$c]}" "${ENTRY[$c]:-0}"; done > "$BD/plan.tsv"
  printf 'run=%s\nsha=%s\nsize=%s\nto=%s\nparallel=%s\ncanary=%s\nsig=%s\nsig_note=%s\n' "${RUN_ORIG:-$RUN}" "$SHA" "$SIZE" "$TO" "$PAR" "$CANARY" "$SIGST" "$SIGMSG" > "$BD/meta.tmp"
  # 0.19.0（网页入口 §9.4）：谁发起、哪个请求、从哪发起、开始时间、pid；ended_at 做完（含出错退出）补。
  # meta 最后写、改名落地：执行器看到 meta 就当批次起来了（plan.tsv 已在）
  printf 'by=%s\nreq=%s\nsource=%s\nstarted_at=%s\npid=%s\n' "$BY" "$REQ" "$SOURCE" "$(now_ms)" "$$" >> "$BD/meta.tmp"
  mv -f "$BD/meta.tmp" "$BD/meta"
  META_ON=1
  start_heartbeat
fi
trap 'exit 143' TERM; trap 'exit 130' INT   # systemctl stop / Ctrl-C 也走 EXIT（补 ended_at）
exec > >(tee -a "$BD/run.log") 2>&1
exec 3>&1   # 每台的结果行写这里（屏幕 + run.log）；每台的过程写它自己的 <单元号>.log
echo "== $(ts) 批次 $BATCH：${#GO[@]} 台，canary $CANARY，并发 $PAR；日志 $BD"

# ---------- 每台 ----------
plan_cfg() { awk -F'\t' -v c="$1" '$1==c { print $4 }' "$BD/plan.tsv"; }
plan_from() { awk -F'\t' -v c="$1" '$1==c { print $3 }' "$BD/plan.tsv"; }
plan_entry() { awk -F'\t' -v c="$1" '$1==c { print ($5 == "" ? 0 : $5) }' "$BD/plan.tsv"; }
result() {  # result <单元号> <结果> <原因>：写一行，失败就让后面的不再开
  local c="$1" r="$2" why="$3" s=$(( $(date +%s) - T0 ))
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$c" "$(plan_from "$c")" "$TO" "$s" "$r" "$why" > "$BD/$c.result"
  echo "$(ts) [$c] $r：$why（${s} s）" >&3
  if [ "$r" = 成功 ]; then phase_set "$c" done; else touch "$BD/STOP"; fi
}
# 每台的阶段（网页进度用，§9.4）：copy / install / selfcheck / spcheck / done（成功才写 done；失败停在出事的那一段，结果看 .result）
phase_set() { [ "$(cat "$BD/$1.phase" 2>/dev/null)" = "$2" ] || echo "$2" > "$BD/$1.phase"; }
up_one() {
  local c="$1" h="${HOST[$1]}" log="$BD/$1.log" out ph job st t_end ok row
  T0=$(date +%s)
  exec >> "$log" 2>&1
  echo "== $(ts) $c（$h）→ $TO"
  if [ -f "$BD/$c.job" ]; then job="$(cat "$BD/$c.job")"; echo "续查 EG 上的任务 $job"
  else
    phase_set "$c" copy
    echo "拷安装文件（$SIZE 字节）…"
    out="$(sshx "$h" "put $SHA $SIZE" < "$RUN" 2>&1)"
    echo "$out"
    grep -q "^OK put $SHA" <<< "$out" || { result "$c" 失败 "拷安装文件没成功：$(tail -1 <<< "$out")"; return; }
    if [ "$SIGSIZE" -gt 0 ] && [ "$(plan_entry "$c")" -ge 5 ]; then
      echo "拷签名（$SIGSIZE 字节）…"
      out="$(sshx "$h" "put-sig $SHA $SIGSIZE" < "$RUN.sig" 2>&1)"
      echo "$out"
      grep -q "^OK put-sig $SHA" <<< "$out" || { result "$c" 失败 "拷签名没成功：$(tail -1 <<< "$out")"; sshx "$h" "drop $SHA" >/dev/null 2>&1; return; }
    fi
    out="$(sshx "$h" "start $SHA" 2>&1)"
    echo "$out"
    grep -q '^OK start ' <<< "$out" || { result "$c" 失败 "EG 没开始升级：$(tail -1 <<< "$out")"; sshx "$h" "drop $SHA" >/dev/null 2>&1; return; }
    job="$(awk '/^OK start / { print $3 }' <<< "$out")"
    phase_set "$c" install
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
      case "$ph" in check) phase_set "$c" selfcheck ;; queued | verify | install | rollback) phase_set "$c" install ;; esac
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
  phase_set "$c" spcheck
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
  # 签名：EG 报的 sig（0.18.1 起的入口：ok / unsigned / nokey；老入口一律 unsigned）+ 子站自己验的结果
  case "$sig:$SIGST" in
    ok:*) signote='；已验签（EG）' ;;
    *:ok) signote='；子站已验签，EG 是老入口没验（升到 0.18.1 以后的下一次起 EG 也验）' ;;
    nokey:*) signote='；安装文件未验签（EG 和子站都没有发布公钥）' ;;
    *) signote='；安装文件未验签（没有 .sig；下一版起要求签名）' ;;
  esac
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
