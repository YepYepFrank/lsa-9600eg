#!/bin/bash
# join-egs.sh 0.18.0 编排测试（假子站 + 假 EG，在一次性容器里跑：deploy/test/join-egs-test.sh）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HERE/bin:$PATH"
SPB=/opt/lsa9600sp/lsa9600sp-backend
J="bash ${JOIN_EGS:-$HERE/../../sp/join-egs.sh}"
pass=0 fail=0
check() { if eval "$1"; then pass=$((pass + 1)); echo "  ✓ $2"; else fail=$((fail + 1)); echo "  ✗ $2"; fi; }

hello() {  # hello <host> <entry> <joined> <unit> <cabinet> [tunnel] —— unit 写 - 表示老 EG（不报 unit=）
  local D="/fake/eg/$1"; mkdir -p "$D"; touch "$D/auth"
  { echo "entry=$2"; echo "eg_version=$([ "$2" -ge 4 ] && echo 0.7.0-test || echo 0.6.3-x)"; echo 'free_mb=9000'; echo 'phase=idle'; echo 'running=0'; echo 'maint='
    echo "joined=$3"; [ "$4" != - ] && echo "unit=$4"; echo "cabinet=$5"; echo 'sp=10.9.0.2'; echo 'join_sp=10.9.0.2'; } > "$D/hello"
  [ "${6:-}" = tunnel ] && touch "$D/tunnel"
  return 0
}
reset() {
  rm -rf /fake /var/log/lsa9600sp; mkdir -p /fake/eg /fake/applied; : > /fake/calls
  echo '{"AH01":["AH01-A","AH01-B"],"AH05":["AH05-A","AH05-B"],"AH09":[]}' > /fake/cabs.json
  echo '{}' > /fake/hosts.json
  printf '# 现场覆盖\nlegacyEg: [AH01, AH09]\nunitIndex: { AH01: 1, AH09: 9 }\n' > $SPB/tb/model.site.yaml
}
mkdir -p /opt/lsa9600sp/keys $SPB/scripts $SPB/docker $SPB/tb
for k in eg-upgrade eg-tunnel; do echo k > /opt/lsa9600sp/keys/${k}_ed25519; echo 'ssh-ed25519 AAAA x' > /opt/lsa9600sp/keys/${k}_ed25519.pub; done
echo 'SP_HOST_IP=10.9.0.2' > $SPB/docker/.env
cp "$HERE"/sp/*.sh $SPB/scripts/

echo '1. --unit 照旧一柜一台（老 EG 0.6.x：入口 3、只报 cabinet=）'
reset; hello 10.0.0.9 3 0 - '' tunnel
out="$($J --unit AH09 --eg 10.0.0.9 2>&1)"; rc=$?
check '[ $rc = 0 ]' "接入成功（rc $rc）"
check 'grep -q "provision-eg.sh --cabinet AH09" /fake/calls' 'provision 照旧 --cabinet AH09（老子站也认）'
check 'grep -q "apply-config [0-9a-f]*$" /fake/calls' 'apply-config 不带 force'
check 'grep -q "单元 AH09 接入完成" <<< "$out"' '汇总「单元 AH09 接入完成」'

echo '2. --unit 舱室单元，待接入的 EG 0.7.0'
reset; echo '{"AH05":["AH05-A","AH05-B"]}' > /fake/cabs.json; printf 'legacyEg: []\n' > $SPB/tb/model.site.yaml; hello 10.0.5.1 4 0 '' '' tunnel
out="$($J --unit AH05-A --eg 10.0.5.1 2>&1)"; rc=$?
check '[ $rc = 0 ] && grep -q "provision-eg.sh --unit AH05-A" /fake/calls && grep -q "pack-eg.sh --only AH05-A" /fake/calls' 'provision --unit AH05-A、pack --only AH05-A，成功'
check 'grep -q "^unit=AH05-A" /fake/eg/10.0.5.1/hello' 'EG 上接成 AH05-A'

echo '3. 舱室单元接到老 EG（入口 3）：拒绝'
reset; printf 'legacyEg: []\n' > $SPB/tb/model.site.yaml; hello 10.0.5.1 3 0 - '' tunnel
out="$($J --unit AH05-A --eg 10.0.5.1 --plan 2>&1)"; rc=$?
check '[ $rc != 0 ] && grep -q "接舱室单元要 EG 0.7.0 起" <<< "$out"' "拒绝：接舱室单元要 EG 0.7.0 起（rc $rc）"

echo '4. EG 已接在别的单元：拒绝；--force 改接（apply-config 带 force）'
reset; printf 'legacyEg: []\n' > $SPB/tb/model.site.yaml; hello 10.0.5.1 4 1 AH05-A AH05 tunnel
out="$($J --unit AH05-B --eg 10.0.5.1 2>&1)"; rc=$?
check '[ $rc != 0 ] && grep -q "已接入单元 AH05-A，不能直接接成 AH05-B" <<< "$out"' '不带 --force：拒绝'
check '! grep -q apply-config /fake/calls' '没推配置'
out="$($J --unit AH05-B --eg 10.0.5.1 --force 2>&1)"; rc=$?
check '[ $rc = 0 ] && grep -q "apply-config [0-9a-f]* force" /fake/calls' "--force：apply-config 带 force，成功（rc $rc）"

echo '5. 重跑（已接入本单元、隧道已撤）：建实体跳过'
reset; printf 'legacyEg: []\n' > $SPB/tb/model.site.yaml; hello 10.0.5.1 4 1 AH05-A AH05; touch /fake/eg/10.0.5.1/same /fake/applied/AH05-A
out="$($J --unit AH05-A --eg 10.0.5.1 2>&1)"; rc=$?
check '[ $rc = 0 ] && ! grep -q provision-eg.sh /fake/calls && grep -q "跳过（已接入本单元" <<< "$out" && grep -q "跳过（EG 上已经是这份配置）" <<< "$out"' '建实体跳过、配置 same 跳过，成功'

echo '6. --cabinet 已拆的柜：两个单元依次接（--eg 键只写字母）'
reset; printf 'legacyEg: [AH09]\n' > $SPB/tb/model.site.yaml; hello 10.0.5.1 4 0 '' '' tunnel; hello 10.0.5.2 4 0 '' '' tunnel
out="$($J --cabinet AH05 --eg A=10.0.5.1,B=10.0.5.2 2>&1)"; rc=$?
check '[ $rc = 0 ] && [ -f /fake/applied/AH05-A ] && [ -f /fake/applied/AH05-B ]' "两个单元都接上（rc $rc）"
check 'grep -q "AH05-B *10.0.5.2 *接入完成" <<< "$out"' '汇总表列出两台'

echo '7. --cabinet 一台失败不影响后面的：B 的 EG 没授权'
reset; printf 'legacyEg: []\n' > $SPB/tb/model.site.yaml; hello 10.0.5.1 4 0 '' '' tunnel; hello 10.0.5.2 4 0 '' '' tunnel; rm /fake/eg/10.0.5.2/auth
echo '{"AH05":["AH05-A","AH05-B"]}' > /fake/cabs.json
out="$($J --cabinet AH05 --eg AH05-A=10.0.5.2,AH05-B=10.0.5.1 2>&1)"; rc=$?
check '[ $rc != 0 ] && [ -f /fake/applied/AH05-B ] && grep -q "AH05-A .*失败" <<< "$out"' "A 失败、B 照样接上，汇总带重来命令（rc $rc）"

echo '8. --unit 给了还照旧一柜一台的柜的单元：提示先拆柜'
reset; hello 10.0.1.1 4 0 '' '' tunnel
out="$($J --unit AH01-A --eg 10.0.1.1 --plan 2>&1)"; rc=$?
check '[ $rc != 0 ] && grep -q "先拆柜（--split AH01）" <<< "$out"' '提示 --split AH01'
out="$($J --unit AH05 --eg 10.0.1.1 --plan 2>&1)"
check 'grep -q "已经拆成舱室单元" <<< "$out"' '拆过的柜给柜号：提示按单元接'

echo '9. 拆柜 --plan：原来那台（接在柜 AH01，入口 4、重新授权了隧道）改作 A，新机作 B；什么都不改'
reset; hello 10.0.1.9 4 1 AH01 AH01 tunnel; hello 10.0.1.2 4 0 '' '' tunnel; echo '{"AH01":"10.0.1.9"}' > /fake/hosts.json; touch /fake/applied/AH01
before="$(cat $SPB/tb/model.site.yaml)"
out="$($J --split AH01 --eg A=10.0.1.9,B=10.0.1.2 --plan 2>&1)"; rc=$?
check '[ $rc = 0 ] && grep -q "AH01-A *10.0.1.9 *能接：这面柜原来那台" <<< "$out"' '原来那台：能接（拆柜后改作 AH01-A）'
check '[ "$before" = "$(cat $SPB/tb/model.site.yaml)" ] && ! grep -q up.sh /fake/calls' 'model.site.yaml 没动、没跑 up.sh'

echo '10. 拆柜：有一台不能接 → 什么都不改'
reset; hello 10.0.1.9 4 1 AH01 AH01 tunnel; hello 10.0.1.2 3 0 - '' tunnel
before="$(cat $SPB/tb/model.site.yaml)"
out="$($J --split AH01 --eg A=10.0.1.9,B=10.0.1.2 2>&1)"; rc=$?
check '[ $rc != 0 ] && [ "$before" = "$(cat $SPB/tb/model.site.yaml)" ] && ! grep -q up.sh /fake/calls' "B 是老 EG：拒绝，model.site.yaml 没动、没跑 up.sh（rc $rc）"

echo '11. 拆柜实跑'
reset; hello 10.0.1.9 4 1 AH01 AH01 tunnel; hello 10.0.1.2 4 0 '' '' tunnel; echo '{"AH01":"10.0.1.9"}' > /fake/hosts.json; touch /fake/applied/AH01
out="$($J --split AH01 --eg A=10.0.1.9,B=10.0.1.2 2>&1)"; rc=$?
check '[ $rc = 0 ]' "拆柜成功（rc $rc）"
check 'grep -q "^legacyEg: \[AH09\]" $SPB/tb/model.site.yaml && grep -q "unitIndex: { AH01: 1, AH09: 9 }" $SPB/tb/model.site.yaml' 'model.site.yaml：legacyEg 只剩 AH09，unitIndex 没动'
check 'ls /var/log/lsa9600sp/eg-join/split-AH01-*/model.site.yaml.before >/dev/null' '原文件备份在日志目录'
check 'awk "/up.sh --prod/{u=NR} /provision-eg.sh --unit AH01-A/{p=NR} END{exit !(u && p && u < p)}" /fake/calls' '先 up.sh，再接单元'
check 'grep -q "lsa-upg@10.0.1.9 apply-config [0-9a-f]* force" /fake/calls && grep -q "lsa-upg@10.0.1.2 apply-config [0-9a-f]*$" /fake/calls' '原来那台带 force（改作单元），新机不带'
check '[ -f /fake/applied/AH01-A ] && [ -f /fake/applied/AH01-B ] && grep -q "断数窗口：[0-9]* s" <<< "$out"' '两个单元都接上，报了断数窗口'

echo '12. --from-file --plan'
reset; printf 'legacyEg: [AH09]\n' > $SPB/tb/model.site.yaml; hello 10.0.5.1 4 0 '' '' tunnel; hello 10.0.0.9 3 0 - '' tunnel
printf '# 一批\nAH05-A 10.0.5.1\nAH05-B 10.0.5.9\nAH09 10.0.0.9\n' > /tmp/list
out="$($J --from-file /tmp/list --plan 2>&1)"; rc=$?
check 'grep -q "AH05-A .*能" <<< "$out" && grep -q "AH05-B .*否.*连不上" <<< "$out" && grep -q "AH09 .*能" <<< "$out" && grep -q "合计：3 台，能接 2 台" <<< "$out"' '逐台结论：AH05-A 能、AH05-B 连不上、AH09（老 EG、照旧一柜一台）能'

echo
echo "合计：$pass 过，$fail 不过"
[ "$fail" = 0 ]
