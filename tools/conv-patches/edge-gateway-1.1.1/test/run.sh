#!/bin/bash
# 同事程序 1.1.1（prep.sh 用 git am 打了本目录的补丁，或 --no-patch 对照）+ sim.py（conv-kit 的串口模拟器）+ 一次性 Mosquitto 2.1.2，连着做三种情况：
#   a. docker pause 总线 60 s 再 unpause；b. docker restart 总线；c. 先停总线、重启程序（程序先于总线启动），30 s 后再起总线
# 一个持久会话（clean_session=False）的记录器订阅 lsa/#，总线暂停 / 重启 / 没起时由总线替它排队，事后 analyze.py 查补传是否完整。
# 全部一次性容器（ct-*、网络 lsa-ct），只用本机镜像（--pull never），不碰 lsa-eg-* 与 VM。约 6 分钟。
#   bash run.sh <工作目录（prep.sh 准备的）>
set -u
export MSYS_NO_PATHCONV=1
W="$(cd "${1:?工作目录}" && (pwd -W 2>/dev/null || pwd))"
REPO="$(cd "$(dirname "$0")/../../../.." && (pwd -W 2>/dev/null || pwd))"
KIT="$REPO/tools/conv-kit"
EV="$W/out/events.log"
ev() { echo "$(date +%s%3N) $*" | tee -a "$EV"; }
cleanup() { docker rm -f ct-conv ct-rec ct-mosq ct-check >/dev/null 2>&1; docker network rm lsa-ct >/dev/null 2>&1; }
cleanup
mkdir -p "$W/out" && rm -f "$W"/out/*
docker network create lsa-ct >/dev/null
docker run -d --pull never --name ct-mosq --network lsa-ct -v "$KIT/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" eclipse-mosquitto:2.1.2 >/dev/null
sleep 2
docker run --rm --pull never --network lsa-ct -v "$W:/ct" -e PYTHONPATH=/ct/deps python:3.12-slim python3 /ct/rec.py ct-mosq /ct/out/rec.jsonl --prime
docker run -d --pull never --name ct-rec --network lsa-ct -v "$W:/ct" -e PYTHONPATH=/ct/deps python:3.12-slim python3 /ct/rec.py ct-mosq /ct/out/rec.jsonl >/dev/null
# conv-kit 的检查工具全程看着（自动认设备；断开期间它自己重连），400 s 到点自己结束、写报告
docker run -d --pull never --name ct-check --network lsa-ct -v "$W:/ct" -v "$KIT:/kit:ro" -e PYTHONUNBUFFERED=1 python:3.12-slim \
  python3 /kit/lsa_check.py --host ct-mosq --port 1883 --duration 400 --quiet --report /ct/out/lsa_check.md >/dev/null
docker run -d --pull never --name ct-conv --network lsa-ct -v "$W:/ct" -v "$W/app:/app" -v "$KIT:/kit:ro" -v "$W/eg:/eg:ro" \
  -e PYTHONPATH=/ct/deps:/app -e TZ=Asia/Shanghai -e EDGE_GATEWAY_CONFIG=/app/config -e LSA_EG_YAML=/eg/eg.yaml -e PYTHONUNBUFFERED=1 \
  python:3.12-slim sh -c 'python3 /kit/sim.py /tmp/ttyV0 > /ct/out/sim.log 2>&1 & sleep 1; cd /app && exec python3 -m src.main' >/dev/null
ev "start"
sleep 60
ev "a-pause"; docker pause ct-mosq >/dev/null; sleep 60; docker unpause ct-mosq >/dev/null; ev "a-unpause"
sleep 60
ev "b-restart"; docker restart ct-mosq >/dev/null; ev "b-restarted"
sleep 60
ev "c-stop-broker"; docker stop ct-mosq >/dev/null; ev "c-broker-stopped"
docker restart ct-conv >/dev/null; ev "c-conv-restarted"
sleep 30
docker start ct-mosq >/dev/null; ev "c-broker-started"
sleep 60
ev "end"
docker logs ct-conv > "$W/out/conv.log" 2>&1
for i in $(seq 1 60); do [ -f "$W/out/lsa_check.md" ] && break; sleep 2; done
docker logs ct-check > "$W/out/lsa_check.log" 2>&1
docker logs ct-mosq > "$W/out/mosq.log" 2>&1
cleanup
ev "cleaned"
