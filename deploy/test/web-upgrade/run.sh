#!/bin/bash
# 网页升级 EG 主机侧测试（容器里跑，web-upgrade-test.sh 起）：upgrade-egs.sh 的 --plan --json / meta / 阶段 / flock / 工作拷贝 / .alive，
# 执行器 lsa-eg-upgrade-runner 的白名单与上限、计划→开始→停止→续查、容器不可信（requests/ 里的链接 / 目录），setup.sh 的 sp_egup_runner。
# EG 是假的（bin/ssh 仿升级入口、bin/eglist 出清单），systemd-run / systemctl / journalctl 也是假的（bin/）；
# ssh-keygen 是真的（验签照 upgrade-egs.sh 一样跑）。被测操作之后不手工重启任何东西：执行器每次都是照 systemd 那样直接起一遍。
set -uo pipefail
T=/d/test/web-upgrade
export PATH="$T/bin:$PATH" EG_LIST_CMD="$T/bin/eglist" LSA_EGUP_START_WAIT=60
E=/var/lib/lsa9600sp/eg-upgrade; R=$E/requests; DN=$E/done; S=$E/state; SR=$S/requests; P=$E/packages
LOGROOT=/var/log/lsa9600sp/eg-upgrade
UP=/opt/lsa9600sp/upgrade-egs.sh; RUNNER=/opt/lsa9600sp/lsa-eg-upgrade-runner
fail=0 n_ok=0
ok() { echo "  ✓ $*"; n_ok=$((n_ok + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
chk() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }
say() { echo; echo "== $*"; }
# jget <文件> <python 表达式，o 是 JSON>：打印结果（字符串原样，其余 JSON）
jget() { python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); v=eval(sys.argv[2]); print(v if isinstance(v,str) else json.dumps(v,ensure_ascii=False))' "$1" "$2" 2>/dev/null; }
jstdin() { python3 -c 'import json,sys; o=json.load(sys.stdin); v=eval(sys.argv[1]); print(v if isinstance(v,str) else json.dumps(v,ensure_ascii=False))' "$1" 2>/dev/null; }
glob() { [[ $1 == $2 ]]; }
ms() { [[ $1 =~ ^[0-9]{13}$ ]]; }
# 请求号：YYYYMMDD-HHMMSS-q<5 位序号>（序号记在文件里：req 常在 $(…) 子 shell 里调）
nextid() { local n; n=$(( $(cat /tmp/reqn 2>/dev/null || echo 0) + 1 )); echo "$n" > /tmp/reqn; printf '%s-q%05d' "$(date +%Y%m%d-%H%M%S)" "$n"; }
# req <type> <params JSON> [user] [多余的顶层字段 JSON 片段]：按约定先写 .tmp 再改名；打印请求号
req() {
  local id; id="$(nextid)"
  printf '{"id":"%s","type":"%s","at":%s,"user":"%s","params":%s%s}' "$id" "$1" "$(date +%s%3N)" "${3:-admin}" "$2" "${4:-}" > "$R/$id.json.tmp"
  mv "$R/$id.json.tmp" "$R/$id.json"
  echo "$id"
}
raw() { local id; id="$(nextid)"; printf '%s' "$1" | sed "s/@ID@/$id/g" > "$R/$id.json"; echo "$id"; }
runner() { python3 -I "$RUNNER" >> /tmp/runner.log 2>&1; }
status() { jget "$SR/$1.json" 'o["status"]'; }
reason() { jget "$SR/$1.json" 'o["reason"]'; }
rejected() { [ "$(status "$1")" = rejected ] && grep -q -- "$2" <<< "$(reason "$1")"; }
show() { echo "    $1 → $(status "$1")：$(reason "$1")"; }
wait_status() { local i; for i in $(seq "${3:-40}"); do [ "$(status "$1")" = "$2" ] && return 0; sleep 1; done; return 1; }
mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }

say "0. 沙箱：假 EG、测试发布公钥、测试安装包"
ssh-keygen -q -t ed25519 -N '' -C web-test -f /tmp/testkey && ssh-keygen -q -t ed25519 -N '' -C evil -f /tmp/evilkey || { bad 'ssh-keygen 不能用'; exit 1; }
mkdir -p /opt/lsa9600sp/keys && : > /opt/lsa9600sp/keys/eg-upgrade_ed25519
echo "lsa9600-release namespaces=\"lsa9600-release\" $(cat /tmp/testkey.pub)" > /opt/lsa9600sp/release-signers
install -m 755 "$T/../../sp/upgrade-egs.sh" "$UP"
OLD=0.7.1-aaaaaaa NEW=0.8.0-bbbbbbb
# mkrun <文件> <EG 版本> [填充字节]：最小的一键安装文件（头 + 标记行 + tar 负载里的 eg/VERSION）
mkrun() {
  local w; w="$(mktemp -d)"; mkdir -p "$w/lsa9600sp-bundle/eg"; echo "$2" > "$w/lsa9600sp-bundle/eg/VERSION"
  head -c "${3:-4096}" /dev/urandom > "$w/lsa9600sp-bundle/eg/images-x.bin"
  { printf '#!/bin/sh\necho stub; exit 0\n__LSA_PAYLOAD_BELOW__\n'; tar -c -C "$w" lsa9600sp-bundle; } > "$1"; rm -rf "$w"
}
sign() { rm -f "$1.sig"; ssh-keygen -Y sign -q -f "${2:-/tmp/testkey}" -n lsa9600-release "$1" 2>/dev/null; }
# 单元：AH01-A / AH02-A 在线旧版，AH03-A 已是新版，AH04-A 离线（假 ssh 连不上），AH05-A 没有地址
reset_egs() {
  rm -rf /fake/eg /fake/list /fake/extra.tsv; mkdir -p /fake/eg /fake/list
  for x in AH01-A:eg1:online:$OLD AH02-A:eg2:online:$OLD AH03-A:eg3:online:$NEW AH04-A:eg4:offline:$OLD AH05-A:-:online:$OLD; do
    IFS=: read -r u h st v <<< "$x"
    mkdir -p "/fake/list/$u"; echo "$h" > "/fake/list/$u/host"; echo "$st" > "/fake/list/$u/state"; echo "$v" > "/fake/list/$u/ver"
    [ "$st" = online ] && [ "$h" != - ] && { mkdir -p "/fake/eg/$h"; echo "$v" > "/fake/eg/$h/ver"; }
  done
  echo "$NEW" > /fake/to
}
slow() { for h in "$@"; do echo "${SLOW:-8}" > "/fake/eg/$h/slow"; done; }
reset_egs
mkdir -p /w && mkrun /w/a.run "$NEW" && sign /w/a.run && mkrun /w/u.run "$NEW"
ok "测试包：a.run（签名）、u.run（没签名），EG $NEW"

# ======================================================================
say "1. setup.sh --role sp 的 sp_egup_runner（装两遍：幂等；老目录权限不对的改回来）"
SP_DEST=/opt/lsa9600sp
unset EGUP_ENABLE   # 0.19.0 起缺省打开：这一节不带开关，验缺省就是打开的；关掉 / 记住 / 再打开见 1b
eval "$(sed -n '/^sp_egup_runner() {$/,/^}$/p' "$T/../../bundle/setup.sh")"
declare -F sp_egup_runner >/dev/null || { bad 'setup.sh 里没取到 sp_egup_runner'; exit 1; }
src="$(mktemp -d)"; cp "$T/../../sp/lsa-eg-upgrade-runner" "$T/../../sp/lsa-eg-upgrade-runner.path" "$T/../../sp/lsa-eg-upgrade-runner.service" "$T/../../sp/lsa-eg-upgrade-runner.timer" "$src/"; echo 0.19.0-test > "$src/VERSION"
mkdir -p "$R" && chmod 777 "$R"   # 老子站上手工建过、权限不对
( cd "$src" && sp_egup_runner . ) > /tmp/setup1.log 2>&1 || { bad "sp_egup_runner 第一遍失败"; cat /tmp/setup1.log; }
cp /w/a.run "$P/" && echo keep > "$SR/keep.json"
mkdir -p /tmp/victim && chmod 750 /tmp/victim && rm -rf "$E/work" && ln -s /tmp/victim "$E/work"   # 万一 work/ 成了链接
( cd "$src" && sp_egup_runner . ) > /tmp/setup2.log 2>&1 && ok 'sp_egup_runner 跑两遍都成功' || { bad "第二遍失败"; cat /tmp/setup2.log; }
perm() { stat -c '%a %U:%G' "$1"; }
chk "packages/ root:lsa-upgrade 2775（$(perm "$P")）" [ "$(perm "$P")" = '2775 root:lsa-upgrade' ]
chk "requests/ root 0700（原来 777，改回来了：$(perm "$R")）" [ "$(perm "$R")" = '700 root:root' ]
chk "done/ work/ root 0700（不挂进容器）" [ "$(perm "$DN") $(perm "$E/work")" = '700 root:root 700 root:root' ]
{ [ ! -L "$E/work" ] && [ "$(stat -c %a /tmp/victim)" = 750 ]; } && ok "work/ 是链接时删掉链接重建，不碰链接指向的（/tmp/victim 还是 750）" || bad "work/ 链接处理不对（/tmp/victim $(stat -c %a /tmp/victim)）"
chk "state/ 0755（$(perm "$S")）" [ "$(perm "$S")" = '755 root:root' ]
chk "/var/log/lsa9600sp/eg-upgrade 0755" [ "$(perm "$LOGROOT")" = '755 root:root' ]
chk '执行器装到 /opt/lsa9600sp（755）' [ "$(stat -c %a "$RUNNER")" = 755 ]
{ [ -f /etc/systemd/system/lsa-eg-upgrade-runner.path ] && [ -f /etc/systemd/system/lsa-eg-upgrade-runner.service ]; } && ok 'systemd 单元装到 /etc/systemd/system' || bad 'systemd 单元没装'
chk "tmpfiles 建 /run/lsa9600sp" grep -q '^d /run/lsa9600sp 0755 root root' /etc/tmpfiles.d/lsa9600sp.conf
chk "runner.json（version $(jget "$S/runner.json" 'o["version"]')、pkgDir）" [ "$(jget "$S/runner.json" 'o["version"]+" "+o["pkgDir"]')" = "0.19.0-test $P" ]
{ [ -f "$P/a.run" ] && [ -f "$SR/keep.json" ]; } && ok '升级时已有的包和结果不动' || bad '升级时把已有的包 / 结果弄没了'
chk 'enable + restart 了 path 单元' grep -q 'restart lsa-eg-upgrade-runner.path' /fake/systemctl.log
chk 'timer 装了、enable + restart（每 5 min 兜底：清 flood、7 天清理）' grep -q 'restart lsa-eg-upgrade-runner.timer' /fake/systemctl.log
chk 'timer 每 5 min 触发执行器' grep -q '^OnUnitActiveSec=5min$' /etc/systemd/system/lsa-eg-upgrade-runner.timer
rm -f "$P/a.run" "$SR/keep.json"

say "1b. --disable-web-upgrade（0.19.0）：照装文件，但 .path / .timer disable --now、不 restart，删 runner.json，并记住"
: > /fake/systemctl.log
OFF="$E/web-upgrade-off"
( cd "$src" && EGUP_ENABLE=0 sp_egup_runner . ) > /tmp/setup3.log 2>&1 && ok 'sp_egup_runner（关）成功' || { bad "关时失败"; cat /tmp/setup3.log; }
chk 'disable --now 了 path 与 timer（预览叠装过的机器升级时也关掉）' grep -q 'disable --now lsa-eg-upgrade-runner.path lsa-eg-upgrade-runner.timer' /fake/systemctl.log
! grep -qE 'restart|^systemctl enable' /fake/systemctl.log && ok '没有 enable、没有 restart' || bad "不启用时还 enable / restart 了：$(cat /fake/systemctl.log | tr '
' ' ')"
chk '执行器与 unit 文件照装' [ -x "$RUNNER" -a -f /etc/systemd/system/lsa-eg-upgrade-runner.path -a -f /etc/systemd/system/lsa-eg-upgrade-runner.timer ]
chk 'runner.json 删了（扩展服务看它判断装没装）' [ ! -e "$S/runner.json" ]
chk '输出写明已关、怎么重新打开' grep -q '已关（--disable-web-upgrade.*重新打开：--enable-web-upgrade' /tmp/setup3.log
chk "记住了：$OFF" [ -f "$OFF" ]
: > /fake/systemctl.log
( cd "$src" && sp_egup_runner . ) > /tmp/setup3b.log 2>&1 && ! grep -qE 'restart|^systemctl enable' /fake/systemctl.log && [ ! -e "$S/runner.json" ] \
  && ok '以后不带开关重跑（升级）：照样关着，不 enable、不 restart、没有 runner.json' || bad "记住的「关」没生效：$(tr '\n' ' ' < /fake/systemctl.log)"
( cd "$src" && EGUP_ENABLE=1 sp_egup_runner . ) > /tmp/setup4.log 2>&1 && grep -q 'restart lsa-eg-upgrade-runner.path' /fake/systemctl.log && [ -f "$S/runner.json" ] && [ ! -e "$OFF" ] \
  && ok '--enable-web-upgrade：enable + restart、runner.json 回来、记号删掉（后面各节照旧）' || bad '--enable-web-upgrade 重新打开不对'
: > /fake/systemctl.log
( cd "$src" && sp_egup_runner . ) > /tmp/setup5.log 2>&1 && grep -q 'restart lsa-eg-upgrade-runner.path' /fake/systemctl.log && grep -q '已启用（关掉用 --disable-web-upgrade）' /tmp/setup5.log \
  && ok '再不带开关重跑：照缺省打开' || bad "重新打开后再重跑不对：$(cat /tmp/setup5.log | tail -2)"
U1=/etc/systemd/system/lsa-eg-upgrade-runner.service
{ grep -qx 'StartLimitIntervalSec=0' $U1 && grep -qx 'ExecStopPost=-/usr/bin/systemctl reset-failed lsa-eg-upgrade-runner.path' $U1 && grep -qx 'ExecStopPost=-/usr/bin/systemctl --no-block start lsa-eg-upgrade-runner.path' $U1; } \
  && ok '0.19.0 r2（F7）：执行器不限速（StartLimitIntervalSec=0），每次跑完 reset-failed + --no-block 拉起 path（请求密了 path 不再卡在 failed）' || bad "执行器 unit 没有 F7 的改动：$(grep -E 'StartLimit|ExecStopPost' $U1 | tr '\n' ' ')"
{ grep -qx 'TriggerLimitIntervalSec=10s' /etc/systemd/system/lsa-eg-upgrade-runner.path && grep -qx 'TriggerLimitBurst=200' /etc/systemd/system/lsa-eg-upgrade-runner.path; } \
  && ok '0.19.0 r2（F7）：path 单元触发限速放宽（10 s / 200，同 lsa-eg-camntp.path）' || bad "path 单元：$(grep -E 'TriggerLimit' /etc/systemd/system/lsa-eg-upgrade-runner.path | tr '\n' ' ')"
grep -q '^ExecStart=/usr/bin/python3 -I /opt/lsa9600sp/lsa-eg-upgrade-runner$' $U1 && grep -q '^Type=oneshot' $U1 \
  && grep -q '^PathExistsGlob=/var/lib/lsa9600sp/eg-upgrade/requests/\*.json$' /etc/systemd/system/lsa-eg-upgrade-runner.path && ok '单元：oneshot、监 requests/*.json' || bad '单元内容不对'
{ grep -q '^ProtectSystem=strict$' $U1 && grep -q '^ReadWritePaths=/var/lib/lsa9600sp/eg-upgrade /var/log/lsa9600sp/eg-upgrade -/run/lsa9600sp$' $U1 \
  && grep -q '^NoNewPrivileges=yes$' $U1 && grep -q '^PrivateTmp=yes$' $U1; } && ok 'service：ProtectSystem=strict、只放开 eg-upgrade / 批次日志 / /run/lsa9600sp、NoNewPrivileges' || bad 'service 加固不对'

# ======================================================================
say "2. upgrade-egs.sh --plan --json"
out="$(bash "$UP" --run /w/a.run --plan --json --all 2>/tmp/plan.err)"; rc=$?
chk "有 !! 时退出码 1（$rc）" [ "$rc" = 1 ]
jstdin 'o["to"]' <<< "$out" >/dev/null && ok 'stdout 是一个 JSON' || { bad "stdout 不是 JSON：$out"; head -5 /tmp/plan.err; }
J() { jstdin "$1" <<< "$out"; }
chk "to / sig / sha（$(J 'o["to"]') $(J 'o["sig"]')）" [ "$(J 'o["to"]+" "+o["sig"]+" "+o["sha"]')" = "$NEW ok $(sha256sum /w/a.run | cut -d' ' -f1)" ]
chk "size $(J 'o["size"]')" [ "$(J 'o["size"]')" = "$(stat -c %s /w/a.run)" ]
chk "行：$(J '" ".join(r["unit"]+"="+r["action"] for r in o["rows"])')" [ "$(J '" ".join(r["unit"]+"="+r["action"] for r in o["rows"])')" = 'AH01-A=up AH02-A=up AH03-A=skip AH04-A=bad' ]
chk "state 用 eg-list 原值（AH04-A $(J '[r["state"] for r in o["rows"] if r["unit"]=="AH04-A"][0]')）" [ "$(J '[r["state"] for r in o["rows"] if r["unit"]=="AH04-A"][0]')" = offline ]
chk "from / egSig（AH01-A $(J 'o["rows"][0]["from"]+" "+o["rows"][0]["egSig"]')；跳过的 egSig null）" [ "$(J 'o["rows"][0]["from"]+" "+o["rows"][0]["egSig"]+" "+str(o["rows"][2]["egSig"])')" = "$OLD ok None" ]
chk "noAddr $(J 'o["noAddr"]')" [ "$(J 'o["noAddr"]')" = '["AH05-A"]' ]
chk "summary $(J 'o["summary"]')、ok false" [ "$(J 'o["summary"]')/$(J 'o["ok"]')" = '{"up": 2, "skip": 2, "bad": 1}/false' ]
chk '文字表进了 stderr' grep -q '^合计：升级 2 台，跳过 2 台，有 !! 项' /tmp/plan.err
out="$(bash "$UP" --run /w/a.run --plan --json --all --skip-offline 2>/dev/null)"; rc=$?
chk "--skip-offline：rc $rc、ok $(J 'o["ok"]')、AH04-A $(J '[r["action"] for r in o["rows"] if r["unit"]=="AH04-A"][0]')（egSig $(J '[str(r["egSig"]) for r in o["rows"] if r["unit"]=="AH04-A"][0]')）" \
  [ "$rc/$(J 'o["ok"]')/$(J '[r["action"]+" "+str(r["egSig"]) for r in o["rows"] if r["unit"]=="AH04-A"][0]')" = '0/true/skip None' ]
out="$(bash "$UP" --run /w/u.run --plan --json --only AH01-A 2>/dev/null)"
chk "未签名包：sig $(J 'o["sig"]')、egSig $(J 'o["rows"][0]["egSig"]')、ok $(J 'o["ok"]')" [ "$(J 'o["sig"]+" "+o["rows"][0]["egSig"]+" "+str(o["ok"])')" = 'unsigned unsigned False' ]
touch /fake/eg/eg1/nokeys
out="$(LSA_RELEASE_SIGNERS=/nonexistent bash "$UP" --run /w/a.run --plan --json --only AH01-A 2>/dev/null)"
chk "子站和 EG 都验不了：sig $(J 'o["sig"]')、egSig $(J 'o["rows"][0]["egSig"]')（不当成 unsigned）" [ "$(J 'o["sig"]+" "+o["rows"][0]["egSig"]')" = 'nokey nokey' ]
# 0.18.2 签名强制：EG 是 0.18.2 的入口（要求签名）、没有发布公钥：子站验过也 bad，egSig nokey
touch /fake/eg/eg1/entry6
out="$(bash "$UP" --run /w/a.run --plan --json --only AH01-A 2>/dev/null)"
chk "入口 6 没公钥：action $(J 'o["rows"][0]["action"]')、egSig $(J 'o["rows"][0]["egSig"]')、bad $(J 'o["summary"]["bad"]')、ok $(J 'o["ok"]')" \
  [ "$(J 'o["rows"][0]["action"]+" "+o["rows"][0]["egSig"]+" "+str(o["summary"]["bad"])+" "+str(o["ok"])')" = 'bad nokey 1 False' ]
rm -f /fake/eg/eg1/nokeys
out="$(bash "$UP" --run /w/u.run --plan --json --only AH01-A --allow-unsigned 2>/dev/null)"
chk "入口 6 + 未签名包：--allow-unsigned 也 bad（$(J 'o["rows"][0]["action"]+" "+o["rows"][0]["egSig"]')）" [ "$(J 'o["rows"][0]["action"]+" "+o["rows"][0]["egSig"]+" "+str(o["ok"])')" = 'bad unsigned False' ]
rm -f /fake/eg/eg1/entry6
# 未签名包、这台全跳过（已是该版本）：没有 bad 行，summary.bad 也算一项
out="$(bash "$UP" --run /w/u.run --plan --json --only AH03-A 2>/dev/null)"; rc=$?
chk "未签名包、全跳过：rc $rc、bad $(J 'o["summary"]["bad"]')、ok $(J 'o["ok"]')" [ "$rc/$(J 'str(o["summary"]["bad"])+" "+str(o["ok"])')" = '1/1 False' ]
# 应急开关只给命令行：--source web 带 --allow-unsigned 脚本自己就拒
bash "$UP" --run /w/u.run --plan --json --only AH01-A --source web --allow-unsigned > /tmp/o 2>&1; rc=$?
chk "--source web --allow-unsigned：rc $rc、拒" [ "$rc" = 2 ] && grep -q '只能在命令行用' /tmp/o
out="$(EG_LIST_CMD="$T/bin/eglist; exit 3" bash "$UP" --run /w/a.run --plan --json --all --skip-offline 2>/dev/null)"
chk "eg-list 退出码 3：listNotReady、summary.bad 计上（$(J 'o["summary"]["bad"]')）、ok false" [ "$(J 'str(o.get("listNotReady"))+" "+str(o["summary"]["bad"])+" "+str(o["ok"])')" = 'True 1 False' ]
txt="$(bash "$UP" --run /w/a.run --plan --all 2>/dev/null)"
chk '不加 --json：文字照旧在 stdout' grep -q '^合计：升级 2 台，跳过 2 台，有 !! 项' <<< "$txt"
bash "$UP" --run /w/a.run --all --json >/dev/null 2>&1; chk '--json 不配 --plan：拒（rc 2）' [ $? = 2 ]
bash "$UP" --run /w/a.run --all --batch 2026-1 >/dev/null 2>&1; chk '--batch 格式不对：拒' [ $? = 2 ]
bash "$UP" --run /w/a.run --all --source evil >/dev/null 2>&1; chk '--source 只认 web / cli' [ $? = 2 ]
bash "$UP" --run /w/a.run --all --by 'a$(id)' >/dev/null 2>&1; chk '--by 带 $：拒（rc 2）' [ $? = 2 ]
bash "$UP" --run /w/u.run --only AH01-A --source web > /tmp/o 2>&1; rc=$?
chk "--source web 不认未签名包（rc $rc）" grep -q '网页入口只认签名验过' /tmp/o
bash "$UP" --run /w/a.run --only AH01-A --expect-sha "$(printf '0%.0s' {1..64})" > /tmp/o 2>&1
chk '--expect-sha 不符：整批不开始' grep -q '计划之后被换过' /tmp/o
chk '上面几次都没留下批次目录' [ -z "$(ls -A "$LOGROOT" 2>/dev/null)" ]
chk '也没留下工作拷贝' [ -z "$(ls -A "$E/work" 2>/dev/null)" ]

say "2b. 单元号来自 eg-list（容器）：带 ../、- 开头、.. 的不碰文件系统"
for u in '../../tmp/pwn' '-xpwn' '..'; do printf '%s\tEG-x\teg1\t%s\t4.2.2.6\tcfg1\tok\t5\t-\tonline\ttrue\ttrue\n' "$u" "$OLD"; done > /fake/extra.tsv
out="$(bash "$UP" --run /w/a.run --plan --json --all --skip-offline 2>/dev/null)"; rc=$?
chk "--plan --json：这三行都是 bad（$(J '[r["unit"]+"="+r["action"] for r in o["rows"] if "pwn" in r["unit"] or r["unit"]==".."]')）、rc $rc、ok false" \
  [ "$(J '" ".join(r["action"] for r in o["rows"] if "pwn" in r["unit"] or r["unit"]=="..")+" "+str(o["ok"])')/$rc" = 'bad bad bad False/1' ]
bash "$UP" --run /w/a.run --all --skip-offline > /tmp/o 2>&1; rc=$?
chk "真升级：预检 !!、整批不开始（rc $rc）" grep -q '整批不开始' /tmp/o
bash "$UP" --run /w/a.run --only '../../tmp/pwn' > /tmp/o 2>&1; rc=$?
chk "--only ../../tmp/pwn：拒（rc $rc）" [ "$rc" = 2 ]
bash "$UP" --run /w/a.run --only '-xpwn' > /tmp/o 2>&1; rc=$?
chk "--only -xpwn：拒（rc $rc）" [ "$rc" = 2 ]
bash "$UP" --run /w/a.run --only AH01-A --canary '-xpwn' > /tmp/o 2>&1; rc=$?
chk "--canary -xpwn：拒（rc $rc）" [ "$rc" != 0 ]
{ [ -z "$(ls /tmp | grep pwn)" ] && [ -z "$(ls -A "$LOGROOT")" ]; } && ok '没有在批次目录外写任何东西（/tmp/pwn.*）、没留批次' || bad "写到外面去了：$(ls /tmp | grep pwn) / $(ls "$LOGROOT")"
rm -f /fake/extra.tsv

# ======================================================================
say "3. upgrade-egs.sh 升级：meta 新行、阶段文件、工作拷贝"
bash "$UP" --run /w/a.run --only AH01-A --batch 20261020-090000 --by ops1 --req 20261020-085959-abc123 --source web > /tmp/b1.log 2>&1; rc=$?
B=$LOGROOT/20261020-090000
chk "升级成功（rc $rc）" [ "$rc" = 0 ]
m() { sed -n "s/^$1=//p" "$B/meta"; }
chk "meta by/req/source = $(m by) $(m req) $(m source)" [ "$(m by) $(m req) $(m source)" = 'ops1 20261020-085959-abc123 web' ]
{ ms "$(m started_at)" && ms "$(m ended_at)" && [ "$(m pid)" -gt 0 ]; } && ok "meta started_at / ended_at 是毫秒、pid（$(m started_at) → $(m ended_at)，pid $(m pid)）" || bad "meta 时间 / pid 不对：$(cat "$B/meta")"
chk "原有的 run/sha/to/sig 还在，run 记原路径（$(m run)）" [ "$(m run) $(m to) $(m sig)" = "/w/a.run $NEW ok" ]
chk "AH01-A.phase = $(cat "$B/AH01-A.phase" 2>/dev/null)" [ "$(cat "$B/AH01-A.phase" 2>/dev/null)" = done ]
{ [ -f "$B/AH01-A.result" ] && [ -s "$B/summary.tsv" ] && [ -s "$B/plan.tsv" ] && [ -s "$B/run.log" ] && [ -f "$B/.alive" ]; } && ok '.result / summary.tsv / plan.tsv / run.log 照旧，有 .alive' || bad '批次文件少了'
chk "EG 收到的 sha256 = meta 的（$(cut -c1-12 /fake/eg/eg1/put_sha)…）" [ "$(cat /fake/eg/eg1/put_sha)" = "$(m sha)" ]
chk '做完删了工作拷贝' [ -z "$(ls -A "$E/work")" ]
bash "$UP" --run /w/a.run --only AH02-A --batch 20261020-090000 > /tmp/o 2>&1
chk '--batch 已有：拒' grep -q '已经有了' /tmp/o
bash "$UP" --list | grep -q '^20261020-090000  目标' && ok '--list 照旧列出' || bad '--list 不对'

say "3b. 组成员在 sha 和验签之间换包：sha、验签、推给 EG 都用 root 的工作拷贝"
reset_egs
mkrun /w/s.run "$NEW" 6000 && sign /w/s.run && SSHA="$(sha256sum /w/s.run | cut -d' ' -f1)"
mkrun /tmp/evil.run "$NEW" 7000
mkdir -p /tmp/swapbin && cat > /tmp/swapbin/sha256sum <<'EOF'
#!/bin/bash
# 第一次算完 sha256 就把 /fake/swap 里写的那个原文件换成别的（仿组成员在两次读之间换包）
/usr/bin/sha256sum "$@"; rc=$?
if [ -f /fake/swap ]; then f="$(cat /fake/swap)"; rm -f /fake/swap; cp /tmp/evil.run "$f"; fi
exit $rc
EOF
chmod +x /tmp/swapbin/sha256sum; echo /w/s.run > /fake/swap
PATH="/tmp/swapbin:$PATH" bash "$UP" --run /w/s.run --only AH01-A --source web --expect-sha "$SSHA" > /tmp/sw.log 2>&1; rc=$?
SB="$LOGROOT/$(ls -1 "$LOGROOT" | grep -v 20261020-090000 | tail -1)"
chk "原文件确实被换了（$(sha256sum /w/s.run | cut -c1-12)…）" [ "$(sha256sum /w/s.run | cut -d' ' -f1)" != "$SSHA" ]
{ [ "$rc" = 0 ] && [ "$(cat /fake/eg/eg1/put_sha)" = "$SSHA" ] && [ "$(sed -n 's/^sha=//p' "$SB/meta")" = "$SSHA" ]; } \
  && ok "升级照样成功、用的是换之前那一份（EG 收到 $(cut -c1-12 /fake/eg/eg1/put_sha)…）" || { bad "换包以后不对（rc $rc）"; tail -5 /tmp/sw.log; }
chk "签名照样是 ok（验的是拷贝）" [ "$(sed -n 's/^sig=//p' "$SB/meta")" = ok ]
chk '工作拷贝删了' [ -z "$(ls -A "$E/work")" ]
rm -rf "$SB"

# ======================================================================
say "4. flock：两个批次同时起，只有一个跑；阶段 install → selfcheck → spcheck → done；.alive 心跳"
# 装 16 s（前 8 s install、后 8 s check）：脚本每 10 s 查一次，第二次查到 check；子站清单晚 3 s 才看到新版本（看得到 spcheck）
reset_egs; SLOW=16 slow eg1 eg2; touch /fake/eglist-lag
LSA_EGUP_ALIVE_S=1 bash "$UP" --run /w/a.run --only AH01-A > /tmp/f1.log 2>&1 & p1=$!
sleep 1.5
t0=$(date +%s); bash "$UP" --run /w/a.run --only AH02-A > /tmp/f2.log 2>&1; rc2=$?; t2=$(( $(date +%s) - t0 ))
chk "第二个马上退出（rc $rc2，${t2} s）：已有批次在跑" grep -q '已有批次在跑' /tmp/f2.log
bash "$UP" --resume 20261020-090000 > /tmp/f3.log 2>&1
chk '续查也要锁：已有批次在跑' grep -q '已有批次在跑' /tmp/f3.log
bash "$UP" --run /w/a.run --plan --only AH02-A > /dev/null 2>&1; rc=$?
chk "--plan 不要锁（rc $rc）" [ "$rc" = 0 ]
FB="$LOGROOT/$(ls -1 "$LOGROOT" | grep -v 20261020-090000 | tail -1)"
a1=$(mtime "$FB/.alive"); sleep 2.5; a2=$(mtime "$FB/.alive")
chk "跑着的时候 .alive 在动（$a1 → $a2）" [ "$a2" -gt "$a1" ]
seen=''; while kill -0 $p1 2>/dev/null; do ph="$(cat "$FB/AH01-A.phase" 2>/dev/null)"; [[ " $seen " == *" $ph "* ]] || seen="$seen $ph"; sleep 0.3; done
wait $p1; rc1=$?; rm -f /fake/eglist-lag
ph="$(cat "$FB/AH01-A.phase")"; [[ " $seen " == *" $ph "* ]] || seen="$seen $ph"
chk "第一个做完（rc $rc1）" [ "$rc1" = 0 ]
chk "看到的阶段：$seen" glob "$seen" '*install*selfcheck*spcheck*done*'
a1=$(mtime "$FB/.alive"); sleep 2.5; a2=$(mtime "$FB/.alive")
{ [ "$a1" = "$a2" ] && [ -n "$(sed -n 's/^ended_at=//p' "$FB/meta")" ]; } && ok "做完以后心跳停了（$a1 = $a2）、补了 ended_at" || bad "心跳没停 / 没 ended_at（$a1 → $a2）"
chk "只多了一个批次目录" [ "$(ls -1 "$LOGROOT" | wc -l)" = 2 ]
chk 'eg2 没被动过' [ "$(cat /fake/eg/eg2/ver)" = "$OLD" ]

# ======================================================================
say "5. 执行器：坏请求、容器在 requests/ 里放链接 / 目录"
rm -rf /fake/units; reset_egs
cp /w/a.run /w/a.run.sig "$P/"; cp /w/u.run "$P/"
ln -s /etc/shadow "$P/evil.run"; cp /w/u.run "$P/bad name.run"
i1=$(req plan '{"run":"../../../etc/passwd.run","sel":"all","force":false,"skipOffline":false}')
i2=$(req plan '{"run":"x/../a.run","sel":"all","force":false,"skipOffline":false}')
i3=$(req exec '{}')
i4=$(req scan '{}' admin ',"cmd":"rm -rf /"')
i5=$(req scan '{"x":1}')
i6=$(req start '{"plan":"20261020-000000-aaaaaa","sha":"'"$(printf 'a%.0s' {1..64})"'","canary":null,"parallel":5}')
i7=$(req start '{"plan":"20261020-000000-aaaaaa","sha":"'"$(printf 'a%.0s' {1..64})"'","canary":null,"parallel":true}')
i8=$(req plan '{"run":"a.run","sel":["AH01-A","AH01-A;reboot"],"force":false,"skipOffline":false}')
i9=$(raw '{"id":"@ID@","type":"scan","type":"stop","at":1,"user":"admin","params":{}}')
i10=$(raw '{"id":"20200101-000000-zzzzzz","type":"scan","at":1,"user":"admin","params":{}}')
i11=$(raw "{\"id\":\"@ID@\",\"type\":\"scan\",\"at\":1,\"user\":\"admin\",\"params\":{},\"pad\":\"$(head -c 17000 /dev/zero | tr '\0' x)\"}")
i12=$(raw 'not json')
i13=$(req stop '{"batch":"../../etc"}')
i14=$(req scan '{}' "$(printf 'a\\nb')")
i16=$(req scan '{}' 'adm$(id)')
i17=$(req scan '{}' 'a b')
i18=$(req plan '{"run":"a.run","sel":["-xpwn"],"force":false,"skipOffline":false}')
i19=$(req start '{"plan":"20261020-000000-aaaaaa","sha":"'"$(printf 'a%.0s' {1..64})"'","canary":"-x","parallel":1}')
# 0.18.2：应急 --allow-unsigned 只给命令行，请求里带了（字段或值）直接拒
i20=$(req plan '{"run":"a.run","sel":"all","force":false,"skipOffline":false,"allowUnsigned":true}')
i21=$(req plan '{"run":"a.run","sel":["--allow-unsigned"],"force":false,"skipOffline":false}')
# 容器能做的：requests/ 里放指向主机文件的链接、目录、管道，把（以前的）.done 换成指向主机目录的链接
mkdir -p /tmp/victim2 && echo keep > /tmp/victim2/old && touch -d '-30 days' /tmp/victim2/old
i15="$(nextid)"; ln -s /etc/shadow "$R/$i15.json"
ln -s /tmp/victim2 "$R/.done"; ln -s /tmp/victim2 "$R/done"; ln -s /tmp/victim2/old "$R/$(nextid).json"
dj="$(nextid).json"; mkdir "$R/$dj"                                       # 空目录：rmdir
dk="$(nextid).json"; mkdir -p "$R/$dk/sub" && echo x > "$R/$dk/sub/f" && ln -s /tmp/victim2 "$R/$dk/sub/lnk"   # 不空的目录：整个挪进 done/
mkfifo "$R/$(nextid).json"
h1="$(nextid)"; h2="$(nextid)"; printf '{"id":"%s","type":"scan","at":1,"user":"admin","params":{}}' "$h1" > "$R/$h1.json"; ln "$R/$h1.json" "$R/$h2.json"   # 硬链接
echo '{}' > "$R/hello.json"
cp /etc/shadow /tmp/shadow.before
runner
for x in "$i1 不许带路径" "$i2 不许带路径" "$i3 不认识的请求类型" "$i4 不认识的字段：cmd" "$i5 不认识的字段：x" "$i6 parallel 要是 1–4" "$i7 parallel 要是 1–4" \
         "$i8 单元号格式不对" "$i9 字段重复" "$i10 id 和文件名不一致" "$i11 太大" "$i12 不是合法 JSON" "$i13 batch 要是批次号" "$i14 user 只许" "$i16 user 只许" "$i17 user 只许"          "$i18 单元号格式不对" "$i19 canary 要是单元号" "$i20 网页入口不许带" "$i21 网页入口不许带"; do
  read -r id want <<< "$x"
  rejected "$id" "$want" && ok "拒收：$want（$(reason "$id" | cut -c1-60)）" || { bad "没按预期拒（要「$want」）"; show "$id"; }
done
chk '/etc/shadow 没被动过' cmp -s /etc/shadow /tmp/shadow.before
chk "requests/ 里的链接 / 目录 / FIFO / 硬链接都清走了，requests/ 空了（剩：$(ls -A "$R" | tr '\n' ' ')）" [ -z "$(ls -A "$R")" ]
{ [ -f "$DN/$dk/sub/f" ] && [ -L "$DN/$dk/sub/lnk" ]; } && ok '不空的目录整个挪进 done/（不递归删、不跟随里面的链接）' || bad '不空的目录没挪进 done/'
{ [ ! -e "$SR/$h1.json" ] && [ ! -e "$SR/$h2.json" ]; } && ok '硬链接的请求（两个名字）不处理、不写结果' || bad '硬链接的请求被处理了'

chk '链接指向的主机目录没被动（/tmp/victim2/old 还在、没多东西）' [ "$(ls -A /tmp/victim2)" = old ]
chk '指向 /etc/shadow 的链接请求：删掉、不写结果' [ ! -e "$SR/$i15.json" ]
{ [ -f "$DN/$i1.json" ] && [ -f "$DN/hello.json" ]; } && ok "处理完的请求在 $DN（不在挂载目录里）" || bad "done/ 里没有处理完的请求"
chk '文件名不对的（hello.json）移走、不写结果' [ ! -e "$SR/hello.json" ]
grep -q 'exec' /fake/calls 2>/dev/null && bad '假 EG 收到了不该有的命令' || ok '假 EG 没收到任何命令'

say "6. 执行器：scan"
i=$(req scan '{}'); runner
chk "scan 完成（$(status "$i")）" [ "$(status "$i")" = done ]
PJ=$S/packages.json
chk "列出 a.run / u.run（$(jget "$PJ" '[p["file"] for p in o["packages"]]')）" [ "$(jget "$PJ" '",".join(sorted(p["file"] for p in o["packages"]))')" = 'a.run,u.run' ]
chk "a.run：sig ok、egVersion $NEW、sha256 对" [ "$(jget "$PJ" '[p["sig"]+" "+p["egVersion"]+" "+p["sha256"] for p in o["packages"] if p["file"]=="a.run"][0]')" = "ok $NEW $(sha256sum /w/a.run | cut -d' ' -f1)" ]
chk "u.run：sig unsigned" [ "$(jget "$PJ" '[p["sig"] for p in o["packages"] if p["file"]=="u.run"][0]')" = unsigned ]
chk "符号链接 evil.run、文件名带空格的不列，warn 里说（$(jget "$PJ" 'len(o["warn"])') 条）" [ "$(jget "$PJ" 'sum(1 for w in o["warn"] if "evil.run" in w or "bad name.run" in w)')" = 2 ]
chk "disk freeBytes / totalBytes" [ "$(jget "$PJ" 'o["disk"]["freeBytes"] > 0 and o["disk"]["totalBytes"] > 0')" = true ]
chk 'result 和 packages.json 一样' [ "$(jget "$SR/$i.json" 'o["result"]["packages"]')" = "$(jget "$PJ" 'o["packages"]')" ]
chk "runner.json 刷新了 at、flood false" [ "$(jget "$S/runner.json" 'str(o["flood"])+" "+o["version"]')" = 'False 0.19.0-test' ]
rm -f "$P/evil.run" "$P/bad name.run"

say "7. 执行器：plan"
i=$(req plan '{"run":"u.run","sel":"all","force":false,"skipOffline":true}'); runner
rejected "$i" '网页入口只认签名验过' && ok "未签名包的 plan 拒收：$(reason "$i" | cut -c1-50)…" || { bad '未签名包的 plan 没拒'; show "$i"; }
i=$(req plan '{"run":"nope.run","sel":"all","force":false,"skipOffline":true}'); runner
rejected "$i" '包目录里没有' && ok '包目录里没有的拒收' || { bad '不存在的包没拒'; show "$i"; }
PBAD=$(req plan '{"run":"a.run","sel":"all","force":false,"skipOffline":false}')
PLAN=$(req plan '{"run":"a.run","sel":"all","force":false,"skipOffline":true}')
runner
chk "plan 完成（$(status "$PLAN")）" [ "$(status "$PLAN")" = done ]
chk "result 带 req / run / params（$(jget "$SR/$PLAN.json" 'o["result"]["req"]+" "+o["result"]["run"]')）" [ "$(jget "$SR/$PLAN.json" 'o["result"]["req"]+" "+o["result"]["run"]+" "+str(o["result"]["params"]["skipOffline"])')" = "$PLAN a.run True" ]
chk "ok true、summary $(jget "$SR/$PLAN.json" 'o["result"]["summary"]')" [ "$(jget "$SR/$PLAN.json" 'o["result"]["ok"]')" = true ]
chk "有 !! 的计划 ok false" [ "$(jget "$SR/$PBAD.json" 'o["result"]["ok"]')" = false ]
SHA="$(sha256sum /w/a.run | cut -d' ' -f1)"

say "8. 执行器：start 的拒收"
st() { req start "{\"plan\":\"$1\",\"sha\":\"$2\",\"canary\":$3,\"parallel\":${4:-1}}"; }
s1=$(st "$PBAD" "$SHA" null)
s2=$(st "$PLAN" "$(printf 'b%.0s' {1..64})" null)
s3=$(st "$PLAN" "$SHA" '"AH03-A"')
s4=$(st "$PLAN" "$SHA" '"AH09-A"')
s5=$(req start "{\"plan\":\"$PLAN\",\"sha\":\"$SHA\",\"canary\":null,\"parallel\":1,\"sel\":[\"AH02-A\"]}")
s6=$(req start "{\"plan\":\"$PLAN\",\"sha\":\"$SHA\",\"canary\":null,\"parallel\":1,\"run\":\"u.run\"}")
s7=$(st 20261020-000000-nopla1 "$SHA" null)
s8=$(st "$i" "$SHA" null)
runner
for x in "$s1 计划不能开始" "$s2 sha256 和计划里的不一致" "$s3 不是计划里要升级的单元" "$s4 不是计划里要升级的单元" "$s5 不认识的字段：sel" "$s6 不认识的字段：run" "$s7 没有这个计划" "$s8 没有生成成功"; do
  read -r id want <<< "$x"
  rejected "$id" "$want" && ok "拒收：$want" || { bad "没按预期拒（要「$want」）"; show "$id"; }
done
# 计划超过 10 分钟
cp "$SR/$PLAN.json" /tmp/plan.bak
python3 -c 'import json,sys,time; p=sys.argv[1]; o=json.load(open(p)); o["endedAt"]-=11*60*1000; json.dump(o,open(p,"w"))' "$SR/$PLAN.json"
s9=$(st "$PLAN" "$SHA" null); runner
rejected "$s9" '超过 10 分钟' && ok '计划超过 10 分钟：拒收' || { bad '过期计划没拒'; show "$s9"; }
cp /tmp/plan.bak "$SR/$PLAN.json"
# 计划之后包被换了（另一个签过名的版本）
cp "$P/a.run" /tmp/a.keep; cp "$P/a.run.sig" /tmp/a.sig.keep
mkrun "$P/a.run" "$NEW" 5000 && sign "$P/a.run"
s10=$(st "$PLAN" "$SHA" null); runner
rejected "$s10" '被换过' && ok "包被替换后 start：拒收（$(reason "$s10" | cut -c1-40)…）" || { bad '换了包没拒'; show "$s10"; }
# 计划之后 .sig 被删 / 换成别人签的
cp /tmp/a.keep "$P/a.run"; rm -f "$P/a.run.sig"
s11=$(st "$PLAN" "$SHA" null); runner
rejected "$s11" '网页入口只认签名验过' && ok '计划之后 .sig 被删：start 拒收' || { bad '.sig 删了没拒'; show "$s11"; }
cp "$P/a.run" /tmp/e.run && sign /tmp/e.run /tmp/evilkey && cp /tmp/e.run.sig "$P/a.run.sig"
s12=$(st "$PLAN" "$SHA" null); runner
rejected "$s12" 'bad' && ok '计划之后 .sig 换成别人签的：start 拒收' || { bad '.sig 换了没拒'; show "$s12"; }
cp /tmp/a.sig.keep "$P/a.run.sig"
chk '以上都没起批次（没有 systemd-run）' [ ! -d /fake/units ]
chk '被拒的 start 不算用过计划' [ "$(jget "$SR/$PLAN.json" 'str(o.get("consumedBy"))')" = None ]

say "9. 执行器：并发 start → 一个起批次、一个拒；计划只用一次；停止；续查"
slow eg1 eg2
P1=$(req plan '{"run":"a.run","sel":"all","force":false,"skipOffline":true}'); P2=$(req plan '{"run":"a.run","sel":["AH01-A"],"force":false,"skipOffline":false}'); runner
g1=$(st "$P1" "$SHA" '"AH02-A"' 1); g2=$(st "$P2" "$SHA" null 2)
runner
chk "第一个 start 起了批次（$(status "$g1")：$(jget "$SR/$g1.json" 'o["result"]')）" [ "$(status "$g1")" = done ]
BATCH="$(jget "$SR/$g1.json" 'o["result"]["batch"]')"; BD="$LOGROOT/$BATCH"
rejected "$g2" '已有批次在跑' && ok "并发的第二个 start 拒收：$(reason "$g2")" || { bad '第二个 start 没拒'; show "$g2"; }
chk "计划标了 consumedBy = $g1" [ "$(jget "$SR/$P1.json" 'o["consumedBy"]')" = "$g1" ]
g3=$(st "$P1" "$SHA" null 1); runner
rejected "$g3" '已经用过' && ok '同一个计划再 start：拒收（已经用过）' || { bad '计划用了两次'; show "$g3"; }
chk "unit 名 lsa-eg-upgrade-$BATCH" [ -f "/fake/units/lsa-eg-upgrade-$BATCH.cmd" ]
cmdl="$(cat "/fake/units/lsa-eg-upgrade-$BATCH.cmd")"; echo "    $cmdl"
chk '照计划原样：--all --skip-offline，canary AH02-A，并发 1，--expect-sha' glob "$cmdl" "*--run $P/a.run --all --skip-offline --parallel 1 --canary AH02-A --batch $BATCH --by admin --req $g1 --source web --expect-sha $SHA"
mB() { sed -n "s/^$1=//p" "$BD/meta"; }
chk "meta：source $(mB source)、by $(mB by)、req = start 请求号" [ "$(mB source) $(mB by) $(mB req)" = "web admin $g1" ]
bash "$UP" --run /w/a.run --only AH01-A > /tmp/o 2>&1
chk '网页的批次在跑时命令行起不了：已有批次在跑' grep -q '已有批次在跑' /tmp/o
x=$(req stop "{\"batch\":\"$BATCH\"}"); runner
{ [ "$(status "$x")" = done ] && [ -f "$BD/STOP" ]; } && ok 'stop 完成、放了 STOP' || { bad 'stop 不对'; show "$x"; }
for _ in $(seq 60); do [ -n "$(mB ended_at)" ] && break; sleep 1; done
chk "批次做完、写了 ended_at（$(mB ended_at)）" [ -n "$(mB ended_at)" ]
chk "canary AH02-A 成功、AH01-A 因为停了没开（$(cut -f1,5 "$BD/summary.tsv" | tr '\t\n' ': ')）" [ "$(cut -f1,5 "$BD/summary.tsv" | tr '\t\n' ':,')" = 'AH01-A:没做,AH02-A:成功,' ]
chk 'eg1 没被升' [ "$(cat /fake/eg/eg1/ver)" = "$OLD" ]
chk "unit 退出时的 --finish 不改已经 done 的结果" [ "$(status "$g1")" = done ]
x=$(req stop "{\"batch\":\"$BATCH\"}"); y=$(req stop '{"batch":"20990101-000000"}'); runner
rejected "$x" '已经结束' && ok '已结束的批次 stop：拒收' || { bad '已结束的批次 stop 没拒'; show "$x"; }
rejected "$y" '没有批次' && ok '没有的批次 stop：拒收' || { bad '没有的批次 stop 没拒'; show "$y"; }
r1=$(req resume "{\"batch\":\"$BATCH\"}"); runner
chk "resume 完成（$(status "$r1")：$(reason "$r1")）" [ "$(status "$r1")" = done ]
U="lsa-eg-upgrade-$BATCH-resume-${r1: -6}"
grep -q -- "--resume $BATCH --by admin --req $r1 --source web" "/fake/units/$U.cmd" 2>/dev/null && ok "另起 unit $U" || bad "没另起 unit $U"
for _ in $(seq 30); do kill -0 "$(cat "/fake/units/$U.pid")" 2>/dev/null || break; sleep 1; done
chk "meta resumed_req / resumed_by，原来的 req 不变" [ "$(mB resumed_req) $(mB resumed_by) $(mB req)" = "$r1 admin $g1" ]
{ [ "$(cat /fake/eg/eg1/ver)" = "$OLD" ] && grep -q '只续查已经开始的' "/fake/units/$U.log"; } && ok "停过的批次续查不开新的（eg1 还是 $OLD）" || { bad '续查开了新的？'; tail -5 "/fake/units/$U.log"; }
chk "续查做完补了 ended_at" [ -n "$(mB ended_at)" ]
# v0.4：网页续查还要安装包现在的 sha / 签名对
cp "$P/a.run" /tmp/a.keep2; cp "$P/a.run.sig" /tmp/a.sig.keep2
mkrun "$P/a.run" "$NEW" 5000 && sign "$P/a.run"
r3=$(req resume "{\"batch\":\"$BATCH\"}"); runner
rejected "$r3" 'sha256 变了' && ok '包在批次之后被换（换成另一个签过名的）：网页续查拒收' || { bad '换了包还能续'; show "$r3"; }
cp /tmp/a.keep2 "$P/a.run"; rm -f "$P/a.run.sig"
r4=$(req resume "{\"batch\":\"$BATCH\"}"); runner
rejected "$r4" '现在验签不过' && ok '.sig 没了：网页续查拒收' || { bad '.sig 没了还能续'; show "$r4"; }
bash "$UP" --resume "$BATCH" --source web --req 20261020-000000-zzzzzz > /tmp/o 2>&1
chk '脚本自己也拒（--resume --source web，包验签不过）' grep -q '现在验签不过' /tmp/o
chk "检查没过就不改 meta（resumed_req 还是 $(mB resumed_req)）" [ "$(mB resumed_req)" = "$r1" ]
mv "$P/a.run" /tmp/a.away
r5=$(req resume "{\"batch\":\"$BATCH\"}"); runner
rejected "$r5" '已不在安装包目录' && ok '包不在了：网页续查拒收' || { bad '包不在还能续'; show "$r5"; }
mv /tmp/a.away "$P/a.run"; cp /tmp/a.sig.keep2 "$P/a.run.sig"

say "9b. 网页续查未签名的批次：拒"
reset_egs
bash "$UP" --run /w/u.run --only AH01-A > /tmp/ub.log 2>&1; rc=$?
chk "0.18.2 起命令行不带 --allow-unsigned 不升未签名包（rc $rc）" [ "$rc" = 1 ]
bash "$UP" --run /w/u.run --only AH01-A --allow-unsigned > /tmp/ub.log 2>&1
UB="$(ls -1t "$LOGROOT" | head -1)"
chk "命令行起的未签名批次 $UB（sig=$(sed -n 's/^sig=//p' "$LOGROOT/$UB/meta")）" [ "$(sed -n 's/^sig=//p' "$LOGROOT/$UB/meta")" = unsigned ]
r2=$(req resume "{\"batch\":\"$UB\"}"); runner
rejected "$r2" '不是签名包，只能命令行续' && ok "执行器拒收：$(reason "$r2" | cut -c1-40)…" || { bad '网页续查了未签名批次'; show "$r2"; }
bash "$UP" --resume "$UB" --source web > /tmp/o 2>&1; rc=$?
chk "脚本自己也拒（--resume --source web，rc $rc）" grep -q '只能命令行续' /tmp/o
chk "没起 unit" [ ! -f "/fake/units/lsa-eg-upgrade-$UB-resume-${r2: -6}.cmd" ]

say "9c. start 之后：预检不过 / 没有要升的 → failed；等不到 meta → running，unit 退出后 --finish 补上"
reset_egs
PA=$(req plan '{"run":"a.run","sel":["AH01-A"],"force":false,"skipOffline":false}'); PB=$(req plan '{"run":"a.run","sel":["AH01-A"],"force":false,"skipOffline":false}')
PC=$(req plan '{"run":"a.run","sel":["AH01-A"],"force":false,"skipOffline":false}'); runner
rm -rf /fake/eg/eg1
f1=$(st "$PA" "$SHA" null); runner
[ "$(status "$f1")" = failed ] && grep -q '批次没起来' <<< "$(reason "$f1")" && ok "计划之后 EG 掉线：start failed，原因 $(reason "$f1" | cut -c1-60)…" || { bad 'start 预检不过没报 failed'; show "$f1"; }
chk "failed 的结果里也带批次号（$(jget "$SR/$f1.json" 'o["result"]')）" [ -n "$(jget "$SR/$f1.json" 'o["result"]["batch"]')" ]
reset_egs; echo "$NEW" > /fake/eg/eg1/ver
f2=$(st "$PB" "$SHA" null); runner
[ "$(status "$f2")" = failed ] && grep -q '没有要升的' <<< "$(reason "$f2")" && ok "计划之后已经是新版：failed「$(reason "$f2" | cut -c1-30)…」" || { bad '没有要升的没写进结果'; show "$f2"; }
reset_egs; echo 4 > /fake/eg/eg1/hello_slow
f3=$(st "$PC" "$SHA" null); LSA_EGUP_START_WAIT=1 runner
{ [ "$(status "$f3")" = running ] && [ -n "$(jget "$SR/$f3.json" 'o["result"]["batch"]')" ]; } && ok "等不到 meta：status running、带批次号（$(jget "$SR/$f3.json" 'o["result"]')）" || { bad '等不到 meta 时不是 running'; show "$f3"; }
wait_status "$f3" done 40 && ok "unit 退出后 --finish 补成 done（$(status "$f3")）" || { bad "--finish 没补上"; show "$f3"; }
rm -f /fake/eg/eg1/hello_slow

say "9d. 联调 F2：systemd-run 起了批次以后执行器出异常 —— 不记 failed，记 running + 批次号，--finish 按批次补"
# 用一个外壳加载执行器、把某个函数换成抛异常的（只在这一次运行里），其余照常；unit 退出时的 --finish 是原样的执行器
fault() {  # fault <函数名> <python 条件表达式，a 是参数元组>
  python3 - "$RUNNER" "$1" "$2" >> /tmp/runner.log 2>&1 <<'EOF'
import importlib.machinery, sys
path, fn, cond = sys.argv[1:4]
m = importlib.machinery.SourceFileLoader('runner', path).load_module()
orig = getattr(m, fn)
def bad(*a, **k):
    if eval(cond):
        raise RuntimeError('测试注入的异常')
    return orig(*a, **k)
setattr(m, fn, bad)
sys.argv = [path]
m.main()
EOF
}
reset_egs; echo 3 > /fake/eg/eg1/slow
PD=$(req plan '{"run":"a.run","sel":["AH01-A"],"force":false,"skipOffline":false}'); PE=$(req plan '{"run":"a.run","sel":["AH01-A"],"force":false,"skipOffline":false}'); runner
# a) 等批次 meta 的时候出异常（read_meta 抛）
e1=$(st "$PD" "$SHA" null); fault read_meta True
{ [ "$(status "$e1")" = running ] && [ -n "$(jget "$SR/$e1.json" 'o["result"]["batch"]')" ] && grep -q '批次已经起来了' <<< "$(reason "$e1")"; } \
  && ok "等 meta 时出异常：running + 批次号（$(reason "$e1" | cut -c1-40)…）" || { bad '等 meta 时出异常记错了'; show "$e1"; }
wait_status "$e1" done 60 && ok "批次做完，unit 的 --finish 补成 done" || { bad '--finish 没补成 done'; show "$e1"; }
EB="$(jget "$SR/$e1.json" 'o["result"]["batch"]')"
chk "批次 $EB 真的升了（eg1 $(cat /fake/eg/eg1/ver)）" [ "$(cat /fake/eg/eg1/ver)" = "$NEW" ]
# b) launch 返回之后、写结果的时候出异常（put_state 写 done 时抛）
reset_egs; echo 3 > /fake/eg/eg1/slow
e2=$(st "$PE" "$SHA" null); fault put_state 'a[2] == "done" and a[1] == "start"'
{ [ "$(status "$e2")" = running ] && [ -n "$(jget "$SR/$e2.json" 'o["result"]["batch"]')" ]; } \
  && ok "写结果时出异常：running + 批次号，不是 failed（$(status "$e2")）" || { bad '写结果时出异常记成了别的'; show "$e2"; }
wait_status "$e2" done 60 && ok "unit 退出后 --finish 补成 done" || { bad '--finish 没补成 done'; show "$e2"; }
# c) 老的 failed（result 空）：--finish <请求号> <批次号> 按批次 meta 补；meta 的 req 不是它就不动
EB2="$(jget "$SR/$e2.json" 'o["result"]["batch"]')"
python3 -c 'import json,sys; p=sys.argv[1]; o=json.load(open(p)); o.update(status="failed",result=None,reason="执行器出错：x"); json.dump(o,open(p,"w"))' "$SR/$e2.json"
python3 -I "$RUNNER" --finish "$e2" "$EB2" >> /tmp/runner.log 2>&1
chk "failed + result 空、批次 meta 的 req 是它：--finish 补成 done、result 带批次（$(jget "$SR/$e2.json" 'o["status"]+" "+str(o["result"])')）" [ "$(jget "$SR/$e2.json" 'o["status"]+" "+o["result"]["batch"]')" = "done $EB2" ]
python3 -c 'import json,sys; p=sys.argv[1]; o=json.load(open(p)); o.update(status="failed",result=None,reason="执行器出错：x"); json.dump(o,open(p,"w"))' "$SR/$e1.json"
python3 -I "$RUNNER" --finish "$e1" "$EB2" >> /tmp/runner.log 2>&1
chk "批次 meta 的 req 不是这个请求：failed 不动" [ "$(status "$e1")" = failed ]
chk "ExecStopPost 带上批次号（--finish <请求号> <批次号>）" grep -q -- "--finish $e2 $EB2 -- " /tmp/runner.log

say "9e. 联调 F5：批次被 TERM（子站关机 / systemctl stop）打断 —— 不写 ended_at，写 interrupted；续查清掉、做完补 ended_at"
reset_egs; echo 12 > /fake/eg/eg1/slow
# 自己一个进程组跑，TERM 发给整组（同 systemd 停 unit 时发给整个 cgroup）
before="$(ls -1 "$LOGROOT")"
setsid bash "$UP" --run /w/a.run --only AH01-A > /tmp/i1.log 2>&1 &
IB=''; for _ in $(seq 40); do
  for d in $(ls -1 "$LOGROOT"); do grep -qx "$d" <<< "$before" || IB="$LOGROOT/$d"; done
  [ -n "$IB" ] && [ -f "$IB/AH01-A.job" ] && break; sleep 0.5
done
mI() { sed -n "s/^$1=//p" "$IB/meta"; }
ip="$(mI pid)"; pg="$(awk '{ print $5 }' "/proc/$ip/stat" 2>/dev/null)"
echo "    批次 $(basename "$IB")，pid $ip，进程组 $pg"
kill -TERM -- "-$pg"; for _ in $(seq 20); do kill -0 "$ip" 2>/dev/null || break; sleep 0.5; done
gone() { ! kill -0 "$1" 2>/dev/null; }
chk "TERM 以后进程退了" gone "$ip"
{ [ -z "$(mI ended_at)" ] && [ "$(mI interrupted)" = 1 ] && ms "$(mI interrupted_at)"; } && ok "meta 没有 ended_at、有 interrupted=1 / interrupted_at（$(mI interrupted_at)）" || bad "TERM 以后 meta 不对：$(grep -E 'ended_at|interrupted' "$IB/meta" | tr '\n' ' ')"
a1=$(mtime "$IB/.alive"); sleep 2.5; a2=$(mtime "$IB/.alive")
chk "心跳停了（$a1 = $a2）" [ "$a1" = "$a2" ]
chk '工作拷贝删了' [ -z "$(ls -A "$E/work")" ]
bash "$UP" --resume "$(basename "$IB")" > /tmp/i2.log 2>&1; rc=$?
{ [ "$rc" = 0 ] && [ -z "$(mI interrupted)" ] && [ -z "$(mI interrupted_at)" ] && ms "$(mI ended_at)"; } && ok "续查做完：interrupted 清掉、补了 ended_at（rc $rc）" || { bad "续查以后 meta 不对（rc $rc）：$(grep -E 'ended_at|interrupted' "$IB/meta" | tr '\n' ' ')"; tail -5 /tmp/i2.log; }
chk "eg1 升好了（$(cat /fake/eg/eg1/ver)）" [ "$(cat /fake/eg/eg1/ver)" = "$NEW" ]
# 正常做完（含 STOP 后做完）照旧写 ended_at、没有 interrupted
{ [ -n "$(mB ended_at)" ] && [ -z "$(mB interrupted)" ]; } && ok "STOP 后做完的批次（9 节的 $BATCH）：有 ended_at、没有 interrupted" || bad 'STOP 后做完的批次 meta 不对' 

say "9b. 拷包进度（0.8.2）：EG 慢慢收（约 7 s），屏幕每 2 s 一行「拷包 x%」，<单元>.copy 拷完已传 = 总"
reset_egs
sz=$(stat -c %s /w/a.run); echo $(( sz / 25 + 1 )) > /fake/eg/eg1/put_slow
LSA_EGUP_PROGRESS_S=2 bash "$UP" --run /w/a.run --only AH01-A > /tmp/cp.out 2>&1; rc=$?
rm -f /fake/eg/eg1/put_slow
BDC="$(sed -n 's/^日志：//p' /tmp/cp.out | tail -1)"
n_pct=$(grep -c '\[AH01-A\] 拷包 [0-9]*%（' /tmp/cp.out)
grep '\[AH01-A\] 拷包' /tmp/cp.out | sed 's/^/    /' | head -6
chk "升级 rc 0（$rc）" [ "$rc" = 0 ]
chk "屏幕拷包进度 $n_pct 行（≥ 2）" [ "$n_pct" -ge 2 ]
chk '拷完一行「拷包完成」' grep -q '\[AH01-A\] 拷包完成（' /tmp/cp.out
read -r c_pos c_size c_rate c_at < "$BDC/AH01-A.copy" 2>/dev/null
chk "AH01-A.copy：已传 = 总 = $sz（$c_pos / $c_size，速率 $c_rate B/s）" [ "$c_pos/$c_size" = "$sz/$sz" ]
chk '临时输出 AH01-A.put.out 删了' [ ! -e "$BDC/AH01-A.put.out" ]

say "10. 执行器：上限"
reset_egs
for n in $(seq 25); do req scan '{}' > /dev/null; done
ids=($(ls "$R" | sed 's/\.json$//' | sort)); runner
n_bl=0; for id in "${ids[@]:0:5}"; do rejected "$id" '积压过多' && n_bl=$((n_bl + 1)); done
n_dn=0; for id in "${ids[@]:5}"; do [ "$(status "$id")" = done ] && n_dn=$((n_dn + 1)); done
chk "25 个请求：最旧 5 个「积压过多」（$n_bl）、最新 20 个处理（$n_dn）" [ "$n_bl/$n_dn" = 5/20 ]
for n in $(seq 101); do printf x > "$R/junk-$n.json"; done
runner
chk "刷 101 个：全删（剩 $(ls -A "$R" | wc -l)）" [ "$(ls -A "$R" | wc -l)" = 0 ]
chk "runner.json flood true、floodAt、floodCount $(jget "$S/runner.json" 'o.get("floodCount")')" [ "$(jget "$S/runner.json" 'str(o["flood"])+" "+str(o["floodCount"])+" "+str(o["floodAt"]>0)')" = 'True 101 True' ]
chk '刷的那些没写结果文件' [ -z "$(ls "$SR" | grep junk)" ]
i=$(req scan '{}'); runner
runner   # 定时器那样空跑一次（没有新请求）
chk "刷过去以后不来新请求、定时器空跑一次：flood 清掉（$(jget "$S/runner.json" 'str(o["flood"])')）" [ "$(jget "$S/runner.json" 'str(o["flood"])')" = False ]
chk "下一次正常了：flood false、请求照常处理（$(status "$i")）" [ "$(jget "$S/runner.json" 'str(o["flood"])')/$(status "$i")" = False/done ]
printf '{"id":"x"}' > "$R/$(date +%Y%m%d-%H%M%S)-stale1.json.tmp"; touch -d '-20 min' "$R"/*-stale1.json.tmp
printf '{}' > "$R/fresh.json.tmp"
touch -d '-8 days' "$DN/hello.json" && echo '{}' > "$SR/20261001-000000-oldold.json" && touch -d '-8 days' "$SR/20261001-000000-oldold.json" && touch -d '-8 days' "$DN/$dk"
cp "$SR/$i.json" /tmp/dup.json; dup=$(raw "{\"id\":\"$i\",\"type\":\"stop\",\"at\":1,\"user\":\"x\",\"params\":{\"batch\":\"20990101-000000\"}}")
mv "$R/$dup.json" "$R/$i.json"
runner
{ ! ls "$R" | grep -q stale1 && [ -e "$R/fresh.json.tmp" ]; } && ok '放了 20 分钟的 .tmp 删掉、刚写的 .tmp 留着' || bad ".tmp 清理不对：$(ls "$R")"
{ [ ! -e "$DN/hello.json" ] && [ ! -e "$SR/20261001-000000-oldold.json" ]; } && ok 'done/ 与 state/requests/ 超过 7 天的清掉' || bad '7 天清理不对'
{ [ ! -e "$DN/$dk" ] && [ "$(ls -A /tmp/victim2)" = old ]; } && ok '挪进 done/ 的目录 7 天后整个删掉，里面指向主机目录的链接不跟随（/tmp/victim2 没动）' || bad "done/ 里的目录没清 / 跟了链接（$(ls -A /tmp/victim2)）"
chk '请求号重复：不覆盖已有结果' cmp -s "$SR/$i.json" /tmp/dup.json
rm -f "$R/fresh.json.tmp"

echo; echo "== 结果：✓ $n_ok，✗ $fail"
[ "$fail" = 0 ]
