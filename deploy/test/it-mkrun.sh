#!/bin/bash
# 批量升级测试用的「新版本」一键安装文件（只给沙箱用，不是发布件）：从一个真的 .run 拆出负载，
#   - 去掉 sp/ 和 eg/ 下的镜像包（沙箱 EG 上镜像都在，install.sh 按 IMAGES.txt 核对通过就不导入）→ 几十 MB，拷得快；
#   - eg/ 换成本分支的 install.sh、compose.yaml、升级入口等，VERSION 改成给的版本，IMAGES.txt 里应用镜像的 tag 跟着改
#     给了 APPID（环境变量，新版本应用镜像的 ID）就连 ID 一起改 —— agent 报的版本来自镜像里的 /app/package.json，
#     沙箱里先从原镜像派生一个只改了版本号的镜像（docker build --network none），各 EG 上 docker save / load 同一个，ID 一致；
#   - --break：把 IMAGES.txt 里 mosquitto 的镜像 ID 改错 —— install.sh 在第 3 步（已经把旧版挪成 .previous 之后）核对失败退出，测自动回退。
#   - 顶层 setup.sh、join-egs.sh、upgrade-egs.sh、网页升级执行器（lsa-eg-upgrade-runner + 两个 systemd 单元）也换成本分支的（一键加柜测试：--join-key 要新 setup.sh 转给 install.sh）。
#   - 发布公钥 release-signers（0.18.1）：eg/ 和顶层各一份，取本分支的；SIGNERS=<allowed_signers 文件> 换成测试公钥
#     （验签测试：测试包用测试私钥签，不用发布私钥 —— scripts/sign-release.mjs --key <测试私钥> --signers <同一个文件>）。
#     出来的 .run 不带 .sig（旧的 .sig 删掉）：要签自己签。
#   - KEEP_IMAGES=1：sp/ 和 eg/ 的镜像包都留着（给裸沙箱从头装子站、EG）；APPTAR=<docker save 的 .tar.gz>：放成 eg/images-it.tar.gz，
#     install.sh 照样导入（新应用镜像，如带 pending.mjs 的派生镜像；配合 APPID）。
# 重新算 SHA256SUMS，套回原来的 stub。在一次性 ubuntu:24.04 容器里做（不下载）。
#   [KEEP_IMAGES=1] [APPTAR=…] [APPID=…] bash deploy/test/it-mkrun.sh <原 .run> <输出 .run> <新版本> [--break]
set -euo pipefail
export MSYS_NO_PATHCONV=1
SRC="${1:?原 .run}"; OUT="${2:?输出 .run}"; VER="${3:?新版本}"; BREAK="${4:-}"
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
sd="$(cd "$(dirname "$SRC")" && (pwd -W 2>/dev/null || pwd))"; od="$(mkdir -p "$(dirname "$OUT")" && cd "$(dirname "$OUT")" && (pwd -W 2>/dev/null || pwd))"
at=()
if [ -n "${SIGNERS:-}" ]; then at+=(-v "$(cd "$(dirname "$SIGNERS")" && (pwd -W 2>/dev/null || pwd))/$(basename "$SIGNERS"):/signers:ro"); fi
if [ -n "${APPTAR:-}" ]; then at+=(-v "$(cd "$(dirname "$APPTAR")" && (pwd -W 2>/dev/null || pwd))/$(basename "$APPTAR"):/apptar.tar.gz:ro"); fi
docker run --rm --pull never -v "$sd:/src:ro" -v "$od:/out" -v "$ROOT:/repo:ro" "${at[@]}" -e S="$(basename "$SRC")" -e O="$(basename "$OUT")" -e VER="$VER" -e BREAK="$BREAK" -e APPID="${APPID:-}" -e KEEP="${KEEP_IMAGES:-}" ubuntu:24.04 bash -c '
set -euo pipefail
skip=$(awk "/^__LSA_PAYLOAD_BELOW__\$/ { print NR + 1; exit }" "/src/$S")
ex=()
if [ -z "$KEEP" ]; then ex=(--exclude="lsa9600sp-bundle/sp/*" --exclude="lsa9600sp-bundle/eg/images-*.tar.gz"); fi
mkdir /w && tail -n +$skip "/src/$S" | tar -x -C /w "${ex[@]}"
B=/w/lsa9600sp-bundle
mkdir -p $B/sp
old=$(cat $B/eg/VERSION)
for f in install.sh compose.yaml lsa-eg-upgrade lsa-eg-upgrade-job; do sed "s/\r\$//" /repo/deploy/eg/$f > $B/eg/$f; done
sed "s/\r\$//" /repo/tools/conv-addon/install-conv.sh > $B/eg/install-conv.sh
sed "s/\r\$//" /repo/deploy/bundle/setup.sh > $B/setup.sh
sed "s/\r\$//" /repo/deploy/sp/join-egs.sh > $B/join-egs.sh
sed "s/\r\$//" /repo/deploy/sp/upgrade-egs.sh > $B/upgrade-egs.sh
for f in lsa-eg-upgrade-runner lsa-eg-upgrade-runner.path lsa-eg-upgrade-runner.service; do sed "s/\r\$//" /repo/deploy/sp/$f > $B/$f; done
sg=/repo/deploy/eg/release-signers; [ -f /signers ] && sg=/signers
sed "s/\r\$//" $sg > $B/eg/release-signers; cp $B/eg/release-signers $B/release-signers
if [ -f /apptar.tar.gz ]; then cp /apptar.tar.gz $B/eg/images-it.tar.gz; fi
echo "$VER" > $B/eg/VERSION
if [ -n "$APPID" ]; then sed -i -E "s#^lsa-eg-app:$old .*#lsa-eg-app:$VER $APPID $APPID#" $B/eg/IMAGES.txt
else sed -i "s#^lsa-eg-app:$old #lsa-eg-app:$VER #" $B/eg/IMAGES.txt; fi
if [ "$BREAK" = --break ]; then
  sed -i -E "s#^(eclipse-mosquitto:[^ ]+ +[^ ]+ +)sha256:[0-9a-f]{8}#\1sha256:deadbeef#" $B/eg/IMAGES.txt
  grep -q deadbeef $B/eg/IMAGES.txt
fi
cd $B && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
head -n $((skip - 1)) "/src/$S" > "/out/$O"
tar -c --owner=0 --group=0 --numeric-owner -C /w lsa9600sp-bundle >> "/out/$O"
cd /out && rm -f "$O.sig" && sha256sum "$O" > "$O.sha256"
echo "$O：EG $old → $VER${BREAK:+（$BREAK）}，$(stat -c %s "$O") 字节"
grep -E "^(lsa-eg-app|eclipse-mosquitto)" $B/eg/IMAGES.txt
'
