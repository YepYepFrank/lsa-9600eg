#!/bin/bash
# 0.8.0 转换程序与 EG 版本配套：带补丁 H（q 标 absent，tag -p8 起）的转换程序只能配 EG 0.8.0 起。
#   install-conv.sh 启用时拒装（从脚本里抽出那一段跑）；pack-eg.mjs --conv 核一下；install.sh --rollback 时 CONV_IMAGE 跟着回。
#   bash deploy/test/conv-pair-test.sh      （本机 bash 跑，几秒；不用 Docker）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail=0; n=0
ok() { n=$((n+1)); echo "  ✓ $*"; }
bad() { n=$((n+1)); echo "  ✗ $*"; fail=1; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
# 抽出 install-conv.sh 里「0.8.0：带补丁 H」那一段（到 pick_serial 那行之前）
awk '/^# 0\.8\.0：带补丁 H/{f=1} f&&/pick_serial/{exit} f' "$ROOT/tools/conv-addon/install-conv.sh" > "$W/pair.sh"
grep -q 'conv_patch_n' "$W/pair.sh" || { echo '没抽到配套检查'; exit 1; }
run() {  # $1 镜像 $2 EG 版本（空 = 没有 VERSION 文件）→ 打印 rc 与输出
  local d="$W/eg-$RANDOM"; mkdir -p "$d"; [ -z "$2" ] || echo "$2" > "$d/VERSION"
  ( cd "$d" && IMG="$1" DIR="$d" bash -c "set -euo pipefail; $(cat "$W/pair.sh"); echo PASS" 2>&1 )
}

echo "== 1. install-conv.sh 启用时的配套检查"
for c in 'lsa-eg-conv:1.1.1-p7|0.7.2-d3e7bbd|PASS|p7（没有补丁 H）配老 EG：照装' \
         'lsa-eg-conv:1.1.1-p8|0.7.2-d3e7bbd|先把 EG 升到 0.8.0|p8 配 EG 0.7.2：拒装' \
         'lsa-eg-conv:1.1.1-p8|0.7.10-abc|先把 EG 升到 0.8.0|p8 配 EG 0.7.10（按版本号比，不按字符串）：拒装' \
         'lsa-eg-conv:1.1.1-p8|0.8.0-1a2b3c4|PASS|p8 配 EG 0.8.0：照装' \
         'lsa-eg-conv:1.1.1-p9|0.10.1-x|PASS|p9 配 EG 0.10.1：照装' \
         'lsa-eg-conv:1.1.1-p8||读不到这台 EG 的版本|p8、读不到 VERSION：拒装' \
         'lsa-eg-conv:1.2.0|0.7.2|PASS|同事正式版（没有 -pN）：不拦'; do
  IFS='|' read -r img ver want why <<< "$c"
  out="$(run "$img" "$ver")"
  grep -q "$want" <<<"$out" && ok "$why" || bad "$why：$out"
done

echo "== 2. pack-eg.mjs --conv 也核"
grep -q 'pn >= 8 && ma === 0 && mi < 8' "$ROOT/scripts/pack-eg.mjs" && ok 'pack-eg：tag -p8 起、发布件 < 0.8.0 就报错不出包' || bad 'pack-eg 没核'

echo "== 3. install.sh --rollback：CONV_IMAGE 跟着回"
sed -n '/^if \[ "\$MODE" = .rollback. \]; then/,/^fi$/p' "$ROOT/deploy/eg/install.sh" > "$W/rb.sh"
grep -q 'for f in \$DEPLOY_FILES; do \[ -e ".previous/\$f" \]' "$W/rb.sh" && grep -q 'CONV_IMAGE.txt' <<<"$(grep '^DEPLOY_FILES=' "$ROOT/deploy/eg/install.sh")" && grep -q '^  conv_setup$' "$W/rb.sh" \
  && ok '回退把上一版的 CONV_IMAGE.txt 拷回来（DEPLOY_FILES 里有它）、再 conv_setup 换回那个镜像' || bad '回退没带 CONV_IMAGE'

echo
[ "$fail" = 0 ] && echo "== 通过（$n 项）" || { echo '== 有失败项'; exit 1; }
