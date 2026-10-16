#!/bin/bash
# 全链路联调的沙箱工具（source 进来用）：两个一次性特权 ubuntu:24.04 当「裸子站主机」「裸 EG」，接在同一个 docker 网络 lsa-it 上，
# 都用一键安装文件装（做法同 fresh-install.sh：Docker 用安装文件里的 deb、systemctl 替身），不下载任何东西。
#   source deploy/test/it-lib.sh
#   it_up <安装文件 .run>            建网络和两个沙箱（itsp / iteg），.run 所在目录只读挂在 /rel
#   sp <命令…> / eg <命令…>          在沙箱里执行
#   it_down                          删沙箱与网络
export MSYS_NO_PATHCONV=1
IT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IT_NET=lsa-it
sp() { docker exec itsp "$@"; }
eg() { docker exec iteg "$@"; }
spi() { docker exec -i itsp "$@"; }
egi() { docker exec -i iteg "$@"; }
ip_of() { docker inspect -f "{{(index .NetworkSettings.Networks \"$IT_NET\").IPAddress}}" "$1"; }

it_shim() {  # $1 = 容器名：policy-rc.d + systemctl 替身（取自 fresh-install.sh）
  docker exec "$1" sh -c 'printf "#!/bin/sh\nexit 101\n" > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d'
  sed -n '/^docker exec -i "\$D" sh -c .cat > \/usr\/local\/bin\/systemctl. <<.EOF.$/,/^EOF$/p' "$IT_ROOT/deploy/test/fresh-install.sh" | sed '1d;$d' | docker exec -i "$1" sh -c 'cat > /usr/local/bin/systemctl'
  docker exec "$1" chmod +x /usr/local/bin/systemctl
}

it_up() {
  local run="${1:?安装文件}" dir
  dir="$(cd "$(dirname "$run")" && { pwd -W 2>/dev/null || pwd; })"
  it_down >/dev/null 2>&1
  docker network create "$IT_NET" >/dev/null
  # 子站网页 443 → 宿主机 127.0.0.1:38443；EG 本地页 80 → 127.0.0.1:38081（浏览器核对用）
  docker run -d --pull never --privileged --name itsp --hostname it-sp --network "$IT_NET" -p 127.0.0.1:38443:443 \
    -v /var/lib/docker -v /var/lib/containerd -v "$dir:/rel:ro" ubuntu:24.04 sleep infinity >/dev/null
  docker run -d --pull never --privileged --name iteg --hostname it-eg --network "$IT_NET" -p 127.0.0.1:38081:80 \
    -v /var/lib/docker -v /var/lib/containerd -v "$dir:/rel:ro" ubuntu:24.04 sleep infinity >/dev/null
  it_shim itsp && it_shim iteg
  echo "沙箱：itsp $(ip_of itsp)，iteg $(ip_of iteg)（网络 $IT_NET）"
}

it_down() {
  docker rm -f -v itsp iteg >/dev/null 2>&1
  docker network rm "$IT_NET" >/dev/null 2>&1
  true
}

# 沙箱用的 ubuntu:24.04 是精简版，没有 openssl（真的 Ubuntu Server 有）—— 子站 gen-certs.sh 要用。
# 只在沙箱里补一个替身：用子站离线包里已导入的 postgres:16 镜像里的 openssl（不下载）。这是测试环境的差别，不是产品问题
it_sp_openssl() {
  docker exec -i itsp sh -c 'cat > /usr/local/bin/openssl && chmod +x /usr/local/bin/openssl' <<'SH'
#!/bin/sh
# 沙箱替身：子站离线包里 postgres:16 镜像的 openssl（it-lib.sh）
exec docker run --rm -i -v /opt:/opt -v /tmp:/tmp -v /root:/root -v /etc:/host-etc:ro -w "$PWD" postgres:16 openssl "$@"
SH
  docker exec itsp openssl version
}

# 同上，精简版 ubuntu 也没有 curl（子站 check.sh 要用）：用子站离线包里 nginx:1.27-alpine 的 curl，--network host 让 127.0.0.1 仍是沙箱自己
it_sp_curl() {
  docker exec -i itsp sh -c 'cat > /usr/local/bin/curl && chmod +x /usr/local/bin/curl' <<'SH'
#!/bin/sh
# 沙箱替身：子站离线包里 nginx:1.27-alpine 镜像的 curl（it-lib.sh）
exec docker run --rm -i --network host -v /opt:/opt -v /tmp:/tmp -w "$PWD" --entrypoint curl nginx:1.27-alpine "$@"
SH
  docker exec itsp curl --version | head -1
}
