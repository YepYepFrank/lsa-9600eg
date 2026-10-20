#!/bin/bash
# 网页升级 EG 主机侧测试（0.19.0，方案 v0.3 §4.1 / §6 坏请求）：upgrade-egs.sh 的 --plan --json、meta / 阶段、flock，
# 执行器 lsa-eg-upgrade-runner 的白名单与上限、plan → start → stop → resume，setup.sh 的 sp_egup_runner（幂等）。
# EG、eg-list、systemd-run / systemctl / journalctl 都是假的（deploy/test/web-upgrade/bin/），在一次性容器里跑（几十秒）：
#   bash deploy/test/web-upgrade-test.sh [镜像，缺省 python:3.12-slim] [ssh-keygen 来源镜像，缺省本机的 lsa9600sp/app]
# 要 python3 + bash + flock（python:3.12-slim 有）；ssh-keygen 这个镜像里没有，从子站应用镜像（alpine）里拷出来、带上它的 musl 与 libcrypto 跑。
# 不下载任何东西（--pull never）。
set -euo pipefail
export MSYS_NO_PATHCONV=1
IMG="${1:-python:3.12-slim}"
KIMG="${2:-$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -m1 '^lsa9600sp/app:' || true)}"
[ -n "$KIMG" ] || { echo '本机没有 lsa9600sp/app 镜像：第二个参数给一个带 ssh-keygen 的 alpine 镜像' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
K="$(mktemp -d)"; KW="$(cd "$K" && (pwd -W 2>/dev/null || pwd))"; trap 'rm -rf "$K"; docker rm -f lsa-webup-k >/dev/null 2>&1 || true' EXIT
docker create --name lsa-webup-k --pull never "$KIMG" >/dev/null
for f in /usr/bin/ssh-keygen /lib/ld-musl-x86_64.so.1 /usr/lib/libcrypto.so.3; do docker cp -L "lsa-webup-k:$f" "$KW/" >/dev/null; done
echo "镜像 $IMG；ssh-keygen 取自 $KIMG"
docker run --rm --init --pull never --entrypoint bash -u 0 -v "$ROOT/deploy:/deploy:ro" -v "$KW:/musl-src:ro" "$IMG" -c '
set -e
ln -sf /usr/local/bin/python3 /usr/bin/python3
mkdir -p /opt/musl && cp /musl-src/* /opt/musl/ && ln -sf ld-musl-x86_64.so.1 /opt/musl/libc.musl-x86_64.so.1
printf "#!/bin/sh\nexec /opt/musl/ld-musl-x86_64.so.1 --library-path /opt/musl /opt/musl/ssh-keygen \"\$@\"\n" > /usr/local/bin/ssh-keygen && chmod +x /usr/local/bin/ssh-keygen
cp -r /deploy /d && find /d -type f \( -name "*.sh" -o -path "*/bin/*" -o -name "lsa-eg-upgrade-runner*" \) -exec sed -i "s/\r$//" {} + && chmod +x /d/test/web-upgrade/bin/*
bash /d/test/web-upgrade/run.sh'
