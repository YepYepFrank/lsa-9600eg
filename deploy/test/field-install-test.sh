#!/bin/bash
# field-install-egs.sh（现场批量装 EG）编排测试：一次性 ubuntu:24.04（本机已有的，--pull never，不下载）里跑 deploy/test/field-install/run.sh。
# 网络与 EG 都是假的（假 ssh / sudo / ip / netplan、机架队列），安装文件是真 stub.sh + 假负载 —— 测的是编排：认机器、改地址、钉主机密钥、
# 自动换回、续传、sha、后台并行、续做、汇总、口令不落盘。真 SSH 口令认证、真 netplan / ARP / systemd-run 测不到（见 docs/EG现场批量安装方案.md §8）。
#   bash deploy/test/field-install-test.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
docker run --rm --pull never -v "$ROOT/deploy:/deploy:ro" ubuntu:24.04 bash -c \
  'cp -r /deploy /d && find /d -type f \( -name "*.sh" -o -path "*/bin/*" -o -path "*/bin-eg/*" \) -exec sed -i "s/\r$//" {} + && chmod +x /d/test/field-install/bin/* /d/test/field-install/bin-eg/* && bash /d/test/field-install/run.sh'
