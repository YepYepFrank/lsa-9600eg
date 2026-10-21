#!/bin/bash
# 批量升级验签验收（0.18.1；0.18.2 起签名强制）：两台一次性特权 ubuntu:24.04（sigsp = 子站主机、sigeg = EG，网络 lsa-sig；名字和 it-lib.sh 的 itsp / iteg 错开），
# 都用【上一版正式一键安装文件】从头装、一键加柜接好，然后：
#   子站换上本分支的 upgrade-egs.sh + 测试发布公钥（= 子站先升到新版的样子），用本分支 EG 脚本做的测试包（it-mkrun.sh，测试私钥签名）：
#   （EG 起点是 0.18.1 起的（入口 5，装着正式发布公钥）：先把 EG 的 release-signers 换成测试公钥，= 测试 key 是发布 key）
#   A  --plan sig1：签名「已验」、验签列「子站验」（EG 老入口 4）/「EG 验」（入口 5）
#   B  升到 sig1：成功，汇总「子站已验签，EG 没验」/「已验签（EG）」；EG 入口变 6
#   C  --plan sig2（EG 已是入口 5）：验签列「EG 验」
#   D  篡改 .run（sig2 末尾多 1 字节，.sig 不变）：--plan / 升级都「整批不开始」；子站验不了时（LSA_RELEASE_SIGNERS 指到没有的文件）EG 拒绝，汇总写原因
#   E  别人的 key 签的 .sig：同 D
#   F  升到 sig2（真签名）：成功，汇总「已验签（EG）」，EG state sig=ok
#   G  没有 .sig（0.18.2 起强制）：--plan --force 签名行 !!、整批 !!（rc ≠ 0）；升级整批不开始；--allow-unsigned 对要求签名的 EG 也 !!
#   H  没 .sig 被拒：EG 入口直接 put + start 拒绝；EG 没有发布公钥时带真 .sig 也拒（验不了签名）
#   I  .env 逃生口 EG_UPG_SIG_REQUIRED=0：hello sig_required=0；子站 --allow-unsigned --force 升级成功、汇总「未验签（应急」；
#      EG 审计 /var/log/lsa-upg.log 有「应急：验签强制已关」、state sig=unsigned、install.sh --status 报 !!；子站 allow-unsigned.log 有记录；删掉后 sig_required=1
# 不下载：ubuntu:24.04 用本机的；openssh / sudo 的 deb 用 DEBS 目录（0.17.2 批准下载过的那批）；Docker 与镜像用安装文件里的。
#   bash deploy/test/upgrade-sig-test.sh <子站用的上一版 .run> <EG 用的上一版 .run> <工作目录> <放 openssh deb 的目录> [--keep]
# 子站和 EG 可以给不同的上一版（0.18.0 r1 的样板模型里 T1 三个单元、北向测点超过一个柜块，子站全新装时 lsa-ext 起不来 ——
#   验签不管子站版本，子站可以用 0.17.4 r1；测试包按 EG 的那个做）。join-egs.sh 老的认 --cabinet、0.18.0 起认 --unit，自动选。
set -uo pipefail
export MSYS_NO_PATHCONV=1
SPOLD="${1:?子站用的上一版 .run}"; OLD="${2:?EG 用的上一版 .run}"; W="${3:?工作目录}"; DEBS="${4:?openssh deb 目录}"
KEEP=0; for a in "$@"; do [ "$a" = --keep ] && KEEP=1; done
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
source "$HERE/it-lib.sh"
NET=lsa-sig; SPC=sigsp; EGC=sigeg; IT_NET=$NET   # ip_of（it-lib.sh）按 IT_NET 取地址
mkdir -p "$W/runs" && W="$(cd "$W" && pwd)"
wp() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
OLDDIR="$(wp "$(dirname "$OLD")")"; OLDRUN="$(basename "$OLD")"
SPDIR="$(wp "$(dirname "$SPOLD")")"; SPRUN="$(basename "$SPOLD")"
LOG="$W/test.log"; : > "$LOG"
fail=0 n_ok=0
ok() { echo "  ✓ $*" | tee -a "$LOG"; n_ok=$((n_ok + 1)); }
bad() { echo "  ✗ $*" | tee -a "$LOG"; fail=$((fail + 1)); }
say() { echo "$*" | tee -a "$LOG"; }
spx() { docker exec "$SPC" "$@"; }
egx() { docker exec "$EGC" "$@"; }
cleanup() {
  if [ "$KEEP" = 1 ]; then say "沙箱留着：docker exec -it $SPC bash / $EGC bash（删：docker rm -f -v $SPC $EGC; docker network rm $NET）"
  else docker rm -f -v "$SPC" "$EGC" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; say '沙箱已删'; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

say "== 0. 沙箱 $SPC / $EGC（网络 $NET；子站 $SPRUN，EG $OLDRUN）"
if [ -z "${REUSE:-}" ]; then
docker rm -f -v "$SPC" "$EGC" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
docker network create "$NET" >/dev/null || exit 1
for c in "$SPC" "$EGC"; do
  docker run -d --pull never --privileged --name "$c" --hostname "$c" --network "$NET" \
    -v /var/lib/docker -v /var/lib/containerd -v "$OLDDIR:/rel:ro" -v "$SPDIR:/rel-sp:ro" -v "$(wp "$W"):/w" -v "$(wp "$DEBS"):/debs:ro" ubuntu:24.04 sleep infinity >/dev/null || exit 1
  it_shim "$c"
  docker exec "$c" sh -c 'dpkg -i /debs/*.deb >/var/log/debs.log 2>&1' || { bad "$c 装 openssh / sudo deb 失败"; exit 1; }
done
egx sh -c 'ssh-keygen -A >/dev/null && mkdir -p /run/sshd && /usr/sbin/sshd' || { bad 'EG 起不了 sshd'; exit 1; }
# 精简 ubuntu 没有 openssl / curl（子站主机 Ubuntu Server 有）：替身用子站离线包里的镜像跑（镜像由安装导入，用到时已经在）
docker exec -i "$SPC" sh -c 'cat > /usr/local/bin/openssl && chmod +x /usr/local/bin/openssl' <<'EOF'
#!/bin/sh
# 沙箱替身：子站离线包里 postgres:16 镜像的 openssl（upgrade-sig-test.sh）
exec docker run --rm -i -v /opt:/opt -v /tmp:/tmp -v /root:/root -v /etc:/host-etc:ro -w "$PWD" postgres:16 openssl "$@"
EOF
docker exec -i "$SPC" sh -c 'cat > /usr/local/bin/curl && chmod +x /usr/local/bin/curl' <<'EOF'
#!/bin/sh
# 沙箱替身：子站离线包里 nginx:1.27-alpine 镜像的 curl（upgrade-sig-test.sh）
exec docker run --rm -i --network host -v /opt:/opt -v /tmp:/tmp -w "$PWD" --entrypoint curl nginx:1.27-alpine "$@"
EOF
fi
SPIP="$(ip_of "$SPC")"; EGIP="$(ip_of "$EGC")"
[ -n "$SPIP" ] && [ -n "$EGIP" ] || { bad "取不到沙箱地址"; exit 1; }
say "  子站 $SPIP，EG $EGIP；ssh $(spx ssh -V 2>&1)"

if [ -z "${REUSE:-}" ]; then   # REUSE=1：沙箱已装好（上次 --keep 留下的），从接入往后做
say; say "== 1. 子站：$SPRUN --role sp"
t0=$(date +%s)
spx bash "/rel-sp/$SPRUN" --role sp --yes --ip "$SPIP" > "$W/sp-install.log" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "子站装好（$(( $(date +%s) - t0 )) s）" || { bad "子站安装 rc $rc（$W/sp-install.log）"; tail -20 "$W/sp-install.log"; exit 1; }

say; say "== 2. EG：--role eg --join-key，子站 join-egs.sh 接入"
JK="$(spx bash /opt/lsa9600sp/join-egs.sh --keygen --sp-addr "$SPIP" 2>&1 | grep -o -- "--join-key '[^']*'" | head -1 | sed "s/^--join-key '//; s/'\$//" || true)"  # sete-ok
[ -n "$JK" ] && ok 'join-key 拿到' || { bad '没拿到 join-key'; exit 1; }
t0=$(date +%s)
egx bash "/rel/$OLDRUN" --role eg --yes --join-key "$JK" > "$W/eg-install.log" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "EG 装好（$(( $(date +%s) - t0 )) s，$(egx cat /opt/lsa-eg/VERSION)）" || { bad "EG 安装 rc $rc"; tail -20 "$W/eg-install.log"; exit 1; }
fi
U="$(spx docker exec lsa-ext node bin/eg-list.mjs --json 2>/dev/null | docker exec -i "$SPC" docker exec -i lsa-ext node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log((o.egs||[]).map(e=>e.code)[0]||"")})')"
[ -n "$U" ] || { bad '子站 eg-list 里没有 EG'; exit 1; }
t0=$(date +%s)
JOPT=--cabinet; spx grep -q -- '--unit AH' /opt/lsa9600sp/join-egs.sh && JOPT=--unit
spx bash /opt/lsa9600sp/join-egs.sh "$JOPT" "$U" --eg "$EGIP" > "$W/join.log" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "join-egs.sh $JOPT $U 接好（$(( $(date +%s) - t0 )) s）" || { bad "join-egs rc $rc"; tail -30 "$W/join.log"; exit 1; }
OLDV="$(egx cat /opt/lsa-eg/VERSION)"

say; say "== 3. 测试包：派生应用镜像（只改版本号）+ it-mkrun.sh + 测试私钥签名"
rm -f "$W"/testkey* "$W"/evilkey* "$W/test-signers"
ssh-keygen -q -t ed25519 -N '' -C sig-test -f "$W/testkey"
ssh-keygen -q -t ed25519 -N '' -C evil -f "$W/evilkey"
echo "lsa9600-release namespaces=\"lsa9600-release\" $(cat "$W/testkey.pub")" > "$W/test-signers"
mkrun() {  # mkrun <版本> <文件名>：EG 上派生 lsa-eg-app:<版本>，做测试包（没签名）
  local v="$1" f="$2" u id
  u="$(egx docker inspect -f '{{.Config.User}}' "lsa-eg-app:$OLDV")"
  printf 'FROM lsa-eg-app:%s\nUSER root\nRUN node -e "const f=\\"/app/package.json\\",p=require(f);p.version=\\"%s\\";require(\\"fs\\").writeFileSync(f,JSON.stringify(p,null,2))"\nUSER %s\n' "$OLDV" "$v" "${u:-root}" \
    | docker exec -i "$EGC" sh -c "DOCKER_BUILDKIT=0 docker build -q --network none -t lsa-eg-app:$v - >/dev/null" || return 1
  id="$(egx docker inspect -f '{{.Id}}' "lsa-eg-app:$v")"
  APPID="$id" SIGNERS="$W/test-signers" bash "$HERE/it-mkrun.sh" "$OLD" "$W/runs/$f" "$v" >> "$W/mkrun.log" 2>&1
}
sign() { node "$(wp "$ROOT")/scripts/sign-release.mjs" "$(wp "$(dirname "$1")")/$(basename "$1")" --key "$(wp "$W")/testkey" --signers "$(wp "$W")/test-signers" >> "$W/mkrun.log" 2>&1; }
V1="${OLDV%%-*}"; V1="${V1%.*}.$(( ${V1##*.} + 1 ))-sig1"; V2="${V1%-sig1}-sig2"
R1=LSA-9600SP-sig1-offline.run; R2=LSA-9600SP-sig2-offline.run
mkrun "$V1" "$R1" && sign "$W/runs/$R1" && ok "$R1（EG $V1）签好" || { bad "做 $R1 失败（$W/mkrun.log）"; exit 1; }
mkrun "$V2" "$R2" && sign "$W/runs/$R2" && ok "$R2（EG $V2）签好" || { bad "做 $R2 失败"; exit 1; }
# 升到 sig1 时 install.sh 会清掉没在用的应用镜像：sig2 的派生镜像先存一份，F 之前再导回（save / load 镜像 ID 不变）
egx docker save -o /w/runs/app-sig2.tar "lsa-eg-app:$V2" || { bad "存不了 lsa-eg-app:$V2"; exit 1; }
# 篡改件：D 末尾多 1 字节（.sig 用真的）；E 别人的 key 签；G 没签名
mkdir -p "$W/runs/d" "$W/runs/e" "$W/runs/g"
cp "$W/runs/$R2" "$W/runs/d/$R2" && printf 'x' >> "$W/runs/d/$R2" && cp "$W/runs/$R2.sig" "$W/runs/d/"
cp "$W/runs/$R2" "$W/runs/e/$R2" && ssh-keygen -Y sign -q -f "$W/evilkey" -n lsa9600-release "$W/runs/e/$R2" 2>/dev/null
cp "$W/runs/$R2" "$W/runs/g/$R2"
ok '篡改件：d（.run 多 1 字节）、e（别人签的）、g（没签名）'
# 子站换上本分支的 upgrade-egs.sh、测试发布公钥（= 子站先升到 0.18.1）
sed 's/\r$//' "$ROOT/deploy/sp/upgrade-egs.sh" | docker exec -i "$SPC" sh -c 'cat > /opt/lsa9600sp/upgrade-egs.sh && chmod 755 /opt/lsa9600sp/upgrade-egs.sh'
docker exec -i "$SPC" sh -c 'cat > /opt/lsa9600sp/release-signers' < "$W/test-signers"

entry_now() { egx sh -c "grep -m1 '^ENTRY_VERSION=' /usr/local/sbin/lsa-eg-upgrade | cut -d= -f2"; }
ENT0="$(entry_now)"
if [ "${ENT0:-0}" -ge 5 ]; then
  docker exec -i "$EGC" sh -c 'cat > /opt/lsa-eg/release-signers' < "$W/test-signers"
  ok "EG 起点入口 $ENT0（自带正式发布公钥）：换成测试公钥"
fi
UP() { spx env ${UPENV:-} bash /opt/lsa9600sp/upgrade-egs.sh --only "$U" "$@"; }
summary_line() { spx sh -c 'd=$(ls -1d /var/log/lsa9600sp/eg-upgrade/*/ | tail -1); cat "$d/summary.tsv"'; }

say; say "== A. --plan $R1（EG 入口 $ENT0）"
out="$(UP --run "/w/runs/$R1" --plan 2>&1)"; rc=$?; echo "$out" | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && ok '--plan rc 0' || bad "--plan rc $rc"
grep -q '^签名：已验' <<< "$out" && ok '签名行「已验」' || bad '签名行不是「已验」'
if [ "${ENT0:-0}" -ge 5 ]; then
  grep -E "^$U .*升级 +EG 验" <<< "$out" >/dev/null && ok "验签列「EG 验」（入口 $ENT0）" || bad '验签列不是「EG 验」'
else
  grep -E "^$U .*升级 +子站验" <<< "$out" >/dev/null && ok '验签列「子站验」（老入口）' || bad '验签列不是「子站验」'
fi

say; say "== B. 升到 $V1"
out="$(UP --run "/w/runs/$R1" 2>&1)"; rc=$?; echo "$out" | tail -8 | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && ok "升级成功（$(egx cat /opt/lsa-eg/VERSION)）" || bad "升级 rc $rc"
if [ "${ENT0:-0}" -ge 5 ]; then want='已验签（EG）'; else want='子站已验签，EG 没验'; fi
grep -q "$want" <<< "$(summary_line)" && ok "汇总：$want" || bad "汇总签名说明不对：$(summary_line)"
[ "$(entry_now)" = 6 ] && ok 'EG 入口已是 6' || bad "EG 入口没换成 6（$(entry_now)）"
egx test -s /opt/lsa-eg/release-signers && ok 'EG 装上了发布公钥 /opt/lsa-eg/release-signers' || bad 'EG 没有 release-signers'
egx bash -c 'cd /opt/lsa-eg && bash install.sh --status 2>&1' | grep -E '升级验签' | sed 's/^/    /' | tee -a "$LOG"

say; say "== C. --plan $R2（EG 入口 6）"
out="$(UP --run "/w/runs/$R2" --plan 2>&1)"; rc=$?; echo "$out" | tee -a "$LOG" | sed 's/^/    /'
grep -E "^$U .*升级 +EG 验" <<< "$out" >/dev/null && ok '验签列「EG 验」' || bad '验签列不是「EG 验」'

for k in d e; do
  case $k in d) what='篡改 .run（多 1 字节）' ;; e) what='别人的 key 签的 .sig' ;; esac
  say; say "== $(tr de DE <<< $k). $what"
  out="$(UP --run "/w/runs/$k/$R2" --plan 2>&1)"; rc=$?; echo "$out" | tail -3 | tee -a "$LOG" | sed 's/^/    /'
  [ "$rc" != 0 ] && grep -q '签名校验不过.*整批不开始' <<< "$out" && ok "--plan：子站验签不过、整批不开始（rc $rc）" || bad "--plan 没拦住（rc $rc）"
  out="$(UP --run "/w/runs/$k/$R2" 2>&1)"; rc=$?
  [ "$rc" != 0 ] && grep -q '整批不开始' <<< "$out" && ok "升级：整批不开始（rc $rc）" || bad "升级没拦住（rc $rc）"
  [ "$(egx cat /opt/lsa-eg/VERSION)" = "$V1" ] && ok "EG 还是 $V1" || bad "EG 版本变了：$(egx cat /opt/lsa-eg/VERSION)"
  # 子站验不了（没有发布公钥）时交给 EG：EG 要拒
  out="$(UPENV=LSA_RELEASE_SIGNERS=/nonexistent UP --run "/w/runs/$k/$R2" 2>&1)"; rc=$?; echo "$out" | tail -4 | tee -a "$LOG" | sed 's/^/    /'
  s="$(summary_line)"
  [ "$rc" != 0 ] && grep -q '签名校验不过' <<< "$s" && ok "子站不验时 EG 拒绝，汇总：$(cut -f6 <<< "$s" | cut -c1-90)…" || bad "EG 没拒（rc $rc）：$s"
  [ "$(egx cat /opt/lsa-eg/VERSION)" = "$V1" ] && ok "EG 还是 $V1" || bad "EG 版本变了：$(egx cat /opt/lsa-eg/VERSION)"
  egx sh -c 'ls /var/lib/lsa-upg/incoming/ | grep -c . || true' | grep -qx 0 && ok 'EG 上收到的文件已删' || bad "EG incoming 里还有：$(egx ls /var/lib/lsa-upg/incoming/)"
done
egx tail -n 4 /var/log/lsa-upg.log | sed 's/^/    EG 审计：/' | tee -a "$LOG"

say; say "== F. 升到 $V2（真签名）"
egx docker image inspect "lsa-eg-app:$V2" >/dev/null 2>&1 || egx docker load -q -i /w/runs/app-sig2.tar >/dev/null
out="$(UP --run "/w/runs/$R2" 2>&1)"; rc=$?; echo "$out" | tail -6 | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && [ "$(egx cat /opt/lsa-eg/VERSION)" = "$V2" ] && ok "升级成功（$V2）" || bad "升级 rc $rc，EG $(egx cat /opt/lsa-eg/VERSION)"
grep -q '已验签（EG）' <<< "$(summary_line)" && ok '汇总：已验签（EG）' || bad "汇总签名说明不对：$(summary_line)"
[ "$(egx sed -n 's/^sig=//p' /var/lib/lsa-upg/state | tail -1)" = ok ] && ok "EG state sig=ok（$(egx sed -n 's/^sig_note=//p' /var/lib/lsa-upg/state | tail -1)）" || bad 'EG state sig 不是 ok'  # sete-ok

say; say "== G. 没有 .sig（0.18.2 起强制）"
out="$(UP --run "/w/runs/g/$R2" --plan --force 2>&1)"; rc=$?; echo "$out" | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" != 0 ] && grep -q '^签名：!! 没有签名' <<< "$out" && grep -E "^$U .*!! +未签名" <<< "$out" >/dev/null && ok "--plan：签名行 !!、这台 !!、rc $rc" || bad "未签名的 --plan 没拦（rc $rc）"
out="$(UP --run "/w/runs/g/$R2" --force 2>&1)"; rc=$?
[ "$rc" != 0 ] && grep -q '整批不开始' <<< "$out" && ok "升级：整批不开始（rc $rc）" || bad "没签名的升级没拦住（rc $rc）"
[ "$(egx cat /opt/lsa-eg/VERSION)" = "$V2" ] && ok "EG 还是 $V2" || bad "EG 版本变了：$(egx cat /opt/lsa-eg/VERSION)"
out="$(UP --run "/w/runs/g/$R2" --plan --force --allow-unsigned 2>&1)"; rc=$?; echo "$out" | grep -E "^$U " | tee -a "$LOG" | sed 's/^/    /'  # sete-ok
[ "$rc" != 0 ] && grep -q 'allow-unsigned 也不行' <<< "$out" && ok "--allow-unsigned：要求签名的 EG 照样 !!（rc $rc）" || bad "--allow-unsigned 放过了要求签名的 EG（rc $rc）"

say; say "== H. 没 .sig 被拒（EG 入口直接调，缺省强制）"
egx sudo -n /usr/local/sbin/lsa-eg-upgrade hello > "$W/hello.txt" 2>&1; grep -qx 'sig_required=1' "$W/hello.txt" && ok 'hello sig_required=1（缺省）' || bad 'hello 不是 sig_required=1'
sha="$(sha256sum "$W/runs/g/$R2" | cut -d' ' -f1)"; sz="$(stat -c %s "$W/runs/g/$R2")"
egx sh -c "sudo -n /usr/local/sbin/lsa-eg-upgrade 'put $sha $sz' < /w/runs/g/$R2 >/dev/null"
out="$(egx sudo -n /usr/local/sbin/lsa-eg-upgrade "start $sha" 2>&1)"; echo "    $out" | tee -a "$LOG"
grep -q '^ERR 安装文件没有签名' <<< "$out" && ok '没 .sig：入口 start 拒绝' || bad "入口没拒：$out"
egx sudo -n /usr/local/sbin/lsa-eg-upgrade "drop $sha" >/dev/null
# 本机没有发布公钥：带真 .sig 也拒
egx mv /opt/lsa-eg/release-signers /opt/lsa-eg/release-signers.off
sha="$(sha256sum "$W/runs/$R2" | cut -d' ' -f1)"; sz="$(stat -c %s "$W/runs/$R2")"; ssz="$(stat -c %s "$W/runs/$R2.sig")"
egx sh -c "sudo -n /usr/local/sbin/lsa-eg-upgrade 'put $sha $sz' < /w/runs/$R2 >/dev/null && sudo -n /usr/local/sbin/lsa-eg-upgrade 'put-sig $sha $ssz' < /w/runs/$R2.sig >/dev/null"
out="$(egx sudo -n /usr/local/sbin/lsa-eg-upgrade "start $sha" 2>&1)"; echo "    $out" | tee -a "$LOG"
grep -q '^ERR 验不了签名' <<< "$out" && ok 'EG 没有发布公钥：带 .sig 也拒' || bad "没公钥没拒：$out"
egx sudo -n /usr/local/sbin/lsa-eg-upgrade "drop $sha" >/dev/null
egx mv /opt/lsa-eg/release-signers.off /opt/lsa-eg/release-signers

say; say "== I. 应急逃生口（.env EG_UPG_SIG_REQUIRED=0 + 子站 --allow-unsigned）"
egx sh -c 'echo EG_UPG_SIG_REQUIRED=0 >> /opt/lsa-eg/.env'
egx sudo -n /usr/local/sbin/lsa-eg-upgrade hello > "$W/hello.txt" 2>&1; grep -qx 'sig_required=0' "$W/hello.txt" && ok 'hello sig_required=0' || bad 'hello 不是 sig_required=0'
out="$(UP --run "/w/runs/g/$R2" --plan --force --allow-unsigned 2>&1)"; rc=$?; echo "$out" | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && grep -E "^$U .*升级 +未签名 .*应急" <<< "$out" >/dev/null && ok '--plan --allow-unsigned：这台「升级 / 未签名 / 应急」、rc 0' || bad "逃生口 --plan 不对（rc $rc）"
egx docker image inspect "lsa-eg-app:$V2" >/dev/null 2>&1 || egx docker load -q -i /w/runs/app-sig2.tar >/dev/null
n0="$(egx sh -c 'grep -c "应急：验签强制已关" /var/log/lsa-upg.log || true')"
out="$(UP --run "/w/runs/g/$R2" --force --allow-unsigned 2>&1)"; rc=$?; echo "$out" | tail -6 | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && [ "$(egx cat /opt/lsa-eg/VERSION)" = "$V2" ] && ok "应急照升成功（$V2）" || bad "应急升级 rc $rc"
grep -q '未验签（应急' <<< "$(summary_line)" && ok '汇总：未验签（应急…）' || bad "汇总不对：$(summary_line)"
n1="$(egx sh -c 'grep -c "应急：验签强制已关" /var/log/lsa-upg.log || true')"
[ "${n1:-0}" -gt "${n0:-0}" ] && ok "EG 审计记了应急：$(egx sh -c 'grep "应急：验签强制已关" /var/log/lsa-upg.log | tail -1' | cut -c1-120)" || bad 'EG 审计没记应急'
[ "$(egx sed -n 's/^sig=//p' /var/lib/lsa-upg/state | tail -1)" = unsigned ] && ok 'EG state sig=unsigned' || bad 'EG state sig 不是 unsigned'  # sete-ok
spx test -s /var/log/lsa9600sp/eg-upgrade-allow-unsigned.log && ok "子站审计：$(spx tail -1 /var/log/lsa9600sp/eg-upgrade-allow-unsigned.log | cut -c1-120)" || bad '子站没有 allow-unsigned.log'
egx bash -c 'cd /opt/lsa-eg && bash install.sh --status 2>&1' > "$W/status.txt"; grep -q '验签强制已应急关闭' "$W/status.txt" && ok 'install.sh --status 报应急关闭' || bad 'install.sh --status 没提示'
egx sed -i '/^EG_UPG_SIG_REQUIRED=/d' /opt/lsa-eg/.env
egx sudo -n /usr/local/sbin/lsa-eg-upgrade hello > "$W/hello.txt" 2>&1; grep -qx 'sig_required=1' "$W/hello.txt" && ok '删掉后 sig_required=1' || bad '删掉后不是 sig_required=1'

say; say "== 结果：✓ $n_ok，✗ $fail（日志 $LOG）"
[ "$fail" = 0 ]
