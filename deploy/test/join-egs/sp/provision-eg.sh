#!/bin/bash
echo "provision-eg.sh $*" >> /fake/calls; echo "（假）provision $*"
# 0.19.0 r2（换机）：/fake/sys-stale 在时模拟「子站留着旧 EG 的系统管理员口令、这台是新机（本地 TB 还是出厂口令）」——
# 有 tb-sysadmin.json 就按它登录 → 401；没有就用出厂口令登录成功，并像真 provision 第 1b 步那样生成新口令文件
u="${2:-}"; f="/opt/lsa9600sp/lsa9600sp-backend/tb/provision/out/eg/$u/tb-sysadmin.json"
if [ -f /fake/sys-stale ]; then
  if [ -f "$f" ]; then echo "本地 TB 的系统管理员 sysadmin@thingsboard.org 登录不上（TB 401 /api/auth/login: {\"status\":401}）—— 用 --sysadmin-user / --sysadmin-password 指定" >&2; exit 1; fi
  mkdir -p "$(dirname "$f")"; echo '{"password":"NEW"}' > "$f"; echo "  系统管理员 sysadmin@thingsboard.org 的出厂口令已改掉，新口令存 $f"
fi
exit 0
