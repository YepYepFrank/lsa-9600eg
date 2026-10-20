#!/bin/bash
# 网页升级 EG 主机侧测试（容器里跑，web-upgrade-test.sh 起）：upgrade-egs.sh 的 --plan --json / meta / 阶段 / flock，
# 执行器 lsa-eg-upgrade-runner 的白名单与上限、计划→开始→停止→续查，setup.sh 的 sp_egup_runner。
# EG 是假的（bin/ssh 仿升级入口、bin/eglist 出清单），systemd-run / systemctl / journalctl 也是假的（bin/）；
# ssh-keygen 是真的（验签照 upgrade-egs.sh 一样跑）。被测操作之后不手工重启任何东西：执行器每次都是照 systemd 那样直接起一遍。
set -uo pipefail
T=/d/test/web-upgrade
export PATH="$T/bin:$PATH" EG_LIST_CMD="$T/bin/eglist" LSA_EGUP_START_WAIT=60
E=/var/lib/lsa9600sp/eg-upgrade; R=$E/requests; S=$E/state; SR=$S/requests; P=$E/packages
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
  rm -rf /fake/eg /fake/list; mkdir -p /fake/eg /fake/list
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
say() { echo; echo "== $*"; }
eval "$(sed -n '/^sp_egup_runner() {$/,/^}$/p' "$T/../../bundle/setup.sh")"
declare -F sp_egup_runner >/dev/null || { bad 'setup.sh 里没取到 sp_egup_runner'; exit 1; }
src="$(mktemp -d)"; cp "$T/../../sp/lsa-eg-upgrade-runner" "$T/../../sp/lsa-eg-upgrade-runner.path" "$T/../../sp/lsa-eg-upgrade-runner.service" "$src/"; echo 0.19.0-test > "$src/VERSION"
mkdir -p "$E/requests" && chmod 777 "$E/requests"   # 老子站上手工建过、权限不对
( cd "$src" && sp_egup_runner . ) > /tmp/setup1.log 2>&1 || { bad "sp_egup_runner 第一遍失败"; cat /tmp/setup1.log; }
cp /w/a.run "$P/" && echo keep > "$SR/keep.json"
( cd "$src" && sp_egup_runner . ) > /tmp/setup2.log 2>&1 && ok 'sp_egup_runner 跑两遍都成功' || { bad "第二遍失败"; cat /tmp/setup2.log; }
perm() { stat -c '%a %U:%G' "$1"; }
chk "packages/ root:lsa-upgrade 2775（$(perm "$P")）" [ "$(perm "$P")" = '2775 root:lsa-upgrade' ]
chk "requests/ root 0700（原来 777，改回来了：$(perm "$R")）" [ "$(perm "$R")" = '700 root:root' ]
chk "state/ 0755（$(perm "$S")）" [ "$(perm "$S")" = '755 root:root' ]
chk "/var/log/lsa9600sp/eg-upgrade 0755" [ "$(perm "$LOGROOT")" = '755 root:root' ]
chk '执行器装到 /opt/lsa9600sp（755）' [ "$(stat -c %a "$RUNNER")" = 755 ]
{ [ -f /etc/systemd/system/lsa-eg-upgrade-runner.path ] && [ -f /etc/systemd/system/lsa-eg-upgrade-runner.service ]; } && ok 'systemd 单元装到 /etc/systemd/system' || bad 'systemd 单元没装' 
chk "runner.json（version $(jget "$S/runner.json" 'o["version"]')、pkgDir）" [ "$(jget "$S/runner.json" 'o["version"]+" "+o["pkgDir"]')" = "0.19.0-test $P" ]
{ [ -f "$P/a.run" ] && [ -f "$SR/keep.json" ]; } && ok '升级时已有的包和结果不动' || bad '升级时把已有的包 / 结果弄没了' 
chk 'enable + restart 了 path 单元' grep -q 'restart lsa-eg-upgrade-runner.path' /fake/systemctl.log
rm -f "$P/a.run" "$SR/keep.json"
grep -q '^ExecStart=/usr/bin/python3 -I /opt/lsa9600sp/lsa-eg-upgrade-runner$' /etc/systemd/system/lsa-eg-upgrade-runner.service && grep -q '^Type=oneshot' /etc/systemd/system/lsa-eg-upgrade-runner.service \
  && grep -q '^PathExistsGlob=/var/lib/lsa9600sp/eg-upgrade/requests/\*.json$' /etc/systemd/system/lsa-eg-upgrade-runner.path && ok '单元：oneshot、监 requests/*.json' || bad '单元内容不对'

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
chk "--skip-offline：rc $rc、ok $(J 'o["ok"]')、AH04-A $(J '[r["action"] for r in o["rows"] if r["unit"]=="AH04-A"][0]')" [ "$rc/$(J 'o["ok"]')/$(J '[r["action"] for r in o["rows"] if r["unit"]=="AH04-A"][0]')" = '0/true/skip' ]
out="$(bash "$UP" --run /w/u.run --plan --json --only AH01-A 2>/dev/null)"
chk "未签名包：sig $(J 'o["sig"]')、egSig $(J 'o["rows"][0]["egSig"]')、ok $(J 'o["ok"]')" [ "$(J 'o["sig"]+" "+o["rows"][0]["egSig"]+" "+str(o["ok"])')" = 'unsigned unsigned False' ]
txt="$(bash "$UP" --run /w/a.run --plan --all 2>/dev/null)"
chk '不加 --json：文字照旧在 stdout' grep -q '^合计：升级 2 台，跳过 2 台，有 !! 项' <<< "$txt"
bash "$UP" --run /w/a.run --all --json >/dev/null 2>&1; chk '--json 不配 --plan：拒（rc 2）' [ $? = 2 ]
bash "$UP" --run /w/a.run --all --batch 2026-1 >/dev/null 2>&1; chk '--batch 格式不对：拒' [ $? = 2 ]
bash "$UP" --run /w/a.run --all --source evil >/dev/null 2>&1; chk '--source 只认 web / cli' [ $? = 2 ]
bash "$UP" --run /w/u.run --only AH01-A --source web > /tmp/o 2>&1; rc=$?
chk "--source web 不认未签名包（rc $rc）" grep -q '网页入口只认签名验过' /tmp/o
bash "$UP" --run /w/a.run --only AH01-A --expect-sha "$(printf '0%.0s' {1..64})" > /tmp/o 2>&1
chk '--expect-sha 不符：整批不开始' grep -q '计划之后被换过' /tmp/o
chk '上面几次都没留下批次目录' [ -z "$(ls -A "$LOGROOT" 2>/dev/null)" ]

# ======================================================================
say "3. upgrade-egs.sh 升级：meta 新行、阶段文件"
bash "$UP" --run /w/a.run --only AH01-A --batch 20261020-090000 --by ops1 --req 20261020-085959-abc123 --source web > /tmp/b1.log 2>&1; rc=$?
B=$LOGROOT/20261020-090000
chk "升级成功（rc $rc）" [ "$rc" = 0 ]
m() { sed -n "s/^$1=//p" "$B/meta"; }
chk "meta by/req/source = $(m by) $(m req) $(m source)" [ "$(m by) $(m req) $(m source)" = 'ops1 20261020-085959-abc123 web' ]
{ ms "$(m started_at)" && ms "$(m ended_at)" && [ "$(m pid)" -gt 0 ]; } && ok "meta started_at / ended_at 是毫秒、pid（$(m started_at) → $(m ended_at)，pid $(m pid)）" || bad "meta 时间 / pid 不对：$(cat "$B/meta")"
chk "原有的 run/sha/to/sig 还在" [ "$(m to) $(m sig)" = "$NEW ok" ]
chk "AH01-A.phase = $(cat "$B/AH01-A.phase" 2>/dev/null)" [ "$(cat "$B/AH01-A.phase" 2>/dev/null)" = done ]
{ [ -f "$B/AH01-A.result" ] && [ -s "$B/summary.tsv" ] && [ -s "$B/plan.tsv" ] && [ -s "$B/run.log" ]; } && ok '.result / summary.tsv / plan.tsv / run.log 照旧' || bad '批次文件少了' 
bash "$UP" --run /w/a.run --only AH02-A --batch 20261020-090000 > /tmp/o 2>&1
chk '--batch 已有：拒' grep -q '已经有了' /tmp/o
bash "$UP" --list | grep -q '^20261020-090000  目标' && ok '--list 照旧列出' || bad '--list 不对'

# ======================================================================
say "4. flock：两个批次同时起，只有一个跑；阶段 install → selfcheck → spcheck → done"
# 装 16 s（前 8 s install、后 8 s check）：脚本每 10 s 查一次，第二次查到 check；子站清单晚 3 s 才看到新版本（看得到 spcheck）
reset_egs; SLOW=16 slow eg1 eg2; touch /fake/eglist-lag
bash "$UP" --run /w/a.run --only AH01-A > /tmp/f1.log 2>&1 & p1=$!
sleep 1.5
t0=$(date +%s); bash "$UP" --run /w/a.run --only AH02-A > /tmp/f2.log 2>&1; rc2=$?; t2=$(( $(date +%s) - t0 ))
chk "第二个马上退出（rc $rc2，${t2} s）：已有批次在跑" grep -q '已有批次在跑' /tmp/f2.log
bash "$UP" --resume 20261020-090000 > /tmp/f3.log 2>&1
chk '续查也要锁：已有批次在跑' grep -q '已有批次在跑' /tmp/f3.log
bash "$UP" --run /w/a.run --plan --only AH02-A > /dev/null 2>&1; rc=$?
chk "--plan 不要锁（rc $rc）" [ "$rc" = 0 ]
FB="$LOGROOT/$(ls -1 "$LOGROOT" | grep -v 20261020-090000 | tail -1)"
seen=''; while kill -0 $p1 2>/dev/null; do ph="$(cat "$FB/AH01-A.phase" 2>/dev/null)"; [[ " $seen " == *" $ph "* ]] || seen="$seen $ph"; sleep 0.3; done
wait $p1; rc1=$?; rm -f /fake/eglist-lag
ph="$(cat "$FB/AH01-A.phase")"; [[ " $seen " == *" $ph "* ]] || seen="$seen $ph"
chk "第一个做完（rc $rc1）" [ "$rc1" = 0 ]
chk "看到的阶段：$seen" glob "$seen" '*install*selfcheck*spcheck*done*' 
chk "只多了一个批次目录" [ "$(ls -1 "$LOGROOT" | wc -l)" = 2 ]
chk 'eg2 没被动过' [ "$(cat /fake/eg/eg2/ver)" = "$OLD" ]

# ======================================================================
say "5. 执行器：坏请求"
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
i15="$(nextid)"; ln -s /etc/shadow "$R/$i15.json"
echo '{}' > "$R/hello.json"
cp /etc/shadow /tmp/shadow.before
runner
for x in "$i1 不许带路径" "$i2 不许带路径" "$i3 不认识的请求类型" "$i4 不认识的字段：cmd" "$i5 不认识的字段：x" "$i6 parallel 要是 1–4" "$i7 parallel 要是 1–4" \
         "$i8 单元号格式不对" "$i9 字段重复" "$i10 id 和文件名不一致" "$i11 太大" "$i12 不是合法 JSON" "$i13 batch 要是批次号" "$i14 user 要是" "$i15 符号链接"; do
  read -r id want <<< "$x"
  rejected "$id" "$want" && ok "拒收：$want（$(reason "$id" | cut -c1-60)）" || { bad "没按预期拒（要「$want」）"; show "$id"; }
done
chk '/etc/shadow 没被动过' cmp -s /etc/shadow /tmp/shadow.before
chk '请求文件都移进了 .done/（requests/ 空了）' [ -z "$(ls -A "$R" | grep -v '^\.done$')" ]
{ [ -e "$R/.done/hello.json" ] && [ ! -e "$SR/hello.json" ]; } && ok '文件名不对的（hello.json）移走、不写结果' || bad 'hello.json 处理不对' 
chk '符号链接请求只移走链接本身' [ -L "$R/.done/$i15.json" ]
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

say "9. 执行器：并发 start → 一个起批次、一个拒；停止；续查"
slow eg1 eg2
PLAN=$(req plan '{"run":"a.run","sel":"all","force":false,"skipOffline":true}'); runner
g1=$(st "$PLAN" "$SHA" '"AH02-A"' 1); g2=$(st "$PLAN" "$SHA" null 2)
runner
chk "第一个 start 起了批次（$(status "$g1")：$(jget "$SR/$g1.json" 'o["result"]')）" [ "$(status "$g1")" = done ]
BATCH="$(jget "$SR/$g1.json" 'o["result"]["batch"]')"; BD="$LOGROOT/$BATCH"
rejected "$g2" '已有批次在跑' && ok "并发的第二个 start 拒收：$(reason "$g2")" || { bad '第二个 start 没拒'; show "$g2"; }
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
# 预检不过（计划之后 EG 掉线）：unit 起来又退出、没写 meta → failed 带原因
reset_egs
PLAN=$(req plan '{"run":"a.run","sel":["AH01-A"],"force":false,"skipOffline":false}'); runner
rm -rf /fake/eg/eg1
f1=$(st "$PLAN" "$SHA" null); runner
[ "$(status "$f1")" = failed ] && grep -q '批次没起来' <<< "$(reason "$f1")" && ok "计划之后 EG 掉线：start failed，原因 $(reason "$f1" | cut -c1-70)…" || { bad 'start 预检不过没报 failed'; show "$f1"; }

say "10. 执行器：上限"
reset_egs
for n in $(seq 25); do req scan '{}' > /dev/null; done
ids=($(ls "$R" | sed 's/\.json$//' | sort)); runner
n_bl=0; for id in "${ids[@]:0:5}"; do rejected "$id" '积压过多' && n_bl=$((n_bl + 1)); done
n_dn=0; for id in "${ids[@]:5}"; do [ "$(status "$id")" = done ] && n_dn=$((n_dn + 1)); done
chk "25 个请求：最旧 5 个「积压过多」（$n_bl）、最新 20 个处理（$n_dn）" [ "$n_bl/$n_dn" = 5/20 ]
for n in $(seq 101); do printf x > "$R/junk-$n.json"; done
runner
chk "刷 101 个：全删（剩 $(ls -A "$R" | grep -vc '^\.done$')）" [ "$(ls -A "$R" | grep -vc '^\.done$')" = 0 ]
chk "runner.json flood true、floodAt、floodCount $(jget "$S/runner.json" 'o.get("floodCount")')" [ "$(jget "$S/runner.json" 'str(o["flood"])+" "+str(o["floodCount"])+" "+str(o["floodAt"]>0)')" = 'True 101 True' ]
chk '刷的那些没写结果文件' [ -z "$(ls "$SR" | grep junk)" ]
i=$(req scan '{}'); runner
chk "下一次正常了：flood false、请求照常处理（$(status "$i")）" [ "$(jget "$S/runner.json" 'str(o["flood"])')/$(status "$i")" = False/done ]
printf '{"id":"x"}' > "$R/$(date +%Y%m%d-%H%M%S)-stale1.json.tmp"; touch -d '-20 min' "$R"/*-stale1.json.tmp
printf '{}' > "$R/fresh.json.tmp"
touch -d '-8 days' "$R/.done/hello.json" && echo '{}' > "$SR/20261001-000000-oldold.json" && touch -d '-8 days' "$SR/20261001-000000-oldold.json"
cp "$SR/$i.json" /tmp/dup.json; dup=$(raw "{\"id\":\"$i\",\"type\":\"stop\",\"at\":1,\"user\":\"x\",\"params\":{\"batch\":\"20990101-000000\"}}")
mv "$R/$dup.json" "$R/$i.json"
runner
{ ! ls "$R" | grep -q stale1 && [ -e "$R/fresh.json.tmp" ]; } && ok '放了 20 分钟的 .tmp 删掉、刚写的 .tmp 留着' || bad ".tmp 清理不对：$(ls "$R")"
{ [ ! -e "$R/.done/hello.json" ] && [ ! -e "$SR/20261001-000000-oldold.json" ]; } && ok '.done/ 与 state/requests/ 超过 7 天的清掉' || bad '7 天清理不对' 
chk '请求号重复：不覆盖已有结果' cmp -s "$SR/$i.json" /tmp/dup.json
rm -f "$R/fresh.json.tmp"

echo; echo "== 结果：✓ $n_ok，✗ $fail"
[ "$fail" = 0 ]
