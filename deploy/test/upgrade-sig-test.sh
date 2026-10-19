#!/bin/bash
# 批量升级验签验收（0.18.2）：两台一次性特权 ubuntu:24.04（sigsp = 子站主机、sigeg = EG，网络 lsa-sig；名字和 it-lib.sh 的 itsp / iteg 错开），
# 都用【上一版正式一键安装文件】从头装、一键加柜接好，然后：
#   子站换上本分支的 upgrade-egs.sh + 测试发布公钥（= 子站先升到 0.18.2 的样子），用本分支 EG 脚本做的测试包（it-mkrun.sh，测试私钥签名）：
#   A  --plan sig1（EG 还是老入口 4）：签名「已验」、验签列「子站验」
#   B  升到 sig1：成功，汇总「子站已验签，EG 是老入口没验」
#   C  --plan sig2（EG 已是入口 5）：验签列「EG 验」
#   D  篡改 .run（sig2 末尾多 1 字节，.sig 不变）：--plan / 升级都「整批不开始」；子站验不了时（LSA_RELEASE_SIGNERS 指到没有的文件）EG 拒绝，汇总写原因
#   E  别人的 key 签的 .sig：同 D
#   F  升到 sig2（真签名）：成功，汇总「已验签（EG）」，EG state sig=ok
#   G  没有 .sig：--plan --force 验签列「未签名」，签名行写过渡期照升
#   H  EG 上 EG_UPG_SIG_REQUIRED=1：没签名的 --plan 报 !!；EG 入口直接 start 也拒
# 不下载：ubuntu:24.04 用本机的；openssh / sudo 的 deb 用 DEBS 目录（0.17.2 批准下载过的那批）；Docker 与镜像用安装文件里的。
#   bash deploy/test/upgrade-sig-test.sh <上一版 .run> <工作目录> <放 openssh deb 的目录> [--keep]
set -uo pipefail
export MSYS_NO_PATHCONV=1
OLD="${1:?上一版 .run}"; W="${2:?工作目录}"; DEBS="${3:?openssh deb 目录}"
KEEP=0; for a in "$@"; do [ "$a" = --keep ] && KEEP=1; done
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
source "$HERE/it-lib.sh"
NET=lsa-sig; SPC=sigsp; EGC=sigeg; IT_NET=$NET   # ip_of（it-lib.sh）按 IT_NET 取地址
mkdir -p "$W/runs" && W="$(cd "$W" && pwd)"
wp() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
OLDDIR="$(wp "$(dirname "$OLD")")"; OLDRUN="$(basename "$OLD")"
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

say "== 0. 沙箱 $SPC / $EGC（网络 $NET；上一版 $OLDRUN）"
docker rm -f -v "$SPC" "$EGC" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
docker network create "$NET" >/dev/null || exit 1
for c in "$SPC" "$EGC"; do
  docker run -d --pull never --privileged --name "$c" --hostname "$c" --network "$NET" \
    -v /var/lib/docker -v /var/lib/containerd -v "$OLDDIR:/rel:ro" -v "$(wp "$W"):/w" -v "$(wp "$DEBS"):/debs:ro" ubuntu:24.04 sleep infinity >/dev/null || exit 1
  it_shim "$c"
  docker exec "$c" sh -c 'dpkg -i /debs/*.deb >/var/log/debs.log 2>&1' || { bad "$c 装 openssh / sudo deb 失败"; exit 1; }
done
egx sh -c 'ssh-keygen -A >/dev/null && mkdir -p /run/sshd && /usr/sbin/sshd' || { bad 'EG 起不了 sshd'; exit 1; }
SPIP="$(ip_of "$SPC")"; EGIP="$(ip_of "$EGC")"
[ -n "$SPIP" ] && [ -n "$EGIP" ] || { bad "取不到沙箱地址"; exit 1; }
say "  子站 $SPIP，EG $EGIP；ssh $(spx ssh -V 2>&1)"

say; say "== 1. 子站：$OLDRUN --role sp"
t0=$(date +%s)
spx bash "/rel/$OLDRUN" --role sp --yes --ip "$SPIP" > "$W/sp-install.log" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "子站装好（$(( $(date +%s) - t0 )) s）" || { bad "子站安装 rc $rc（$W/sp-install.log）"; tail -20 "$W/sp-install.log"; exit 1; }

say; say "== 2. EG：--role eg --join-key，子站 join-egs.sh 接入"
JK="$(spx bash /opt/lsa9600sp/join-egs.sh --keygen --sp-addr "$SPIP" 2>&1 | grep -o -- "--join-key '[^']*'" | head -1 | sed "s/^--join-key '//; s/'\$//")"
[ -n "$JK" ] && ok 'join-key 拿到' || { bad '没拿到 join-key'; exit 1; }
t0=$(date +%s)
egx bash "/rel/$OLDRUN" --role eg --yes --join-key "$JK" > "$W/eg-install.log" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "EG 装好（$(( $(date +%s) - t0 )) s，$(egx cat /opt/lsa-eg/VERSION)）" || { bad "EG 安装 rc $rc"; tail -20 "$W/eg-install.log"; exit 1; }
U="$(spx docker exec lsa-ext node bin/eg-list.mjs --json 2>/dev/null | spx docker exec -i lsa-ext node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log((o.egs||[]).map(e=>e.code)[0]||"")})')"
[ -n "$U" ] || { bad '子站 eg-list 里没有 EG'; exit 1; }
t0=$(date +%s)
spx bash /opt/lsa9600sp/join-egs.sh --unit "$U" --eg "$EGIP" > "$W/join.log" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "join-egs.sh --unit $U 接好（$(( $(date +%s) - t0 )) s）" || { bad "join-egs rc $rc"; tail -30 "$W/join.log"; exit 1; }
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
# 篡改件：D 末尾多 1 字节（.sig 用真的）；E 别人的 key 签；G 没签名
mkdir -p "$W/runs/d" "$W/runs/e" "$W/runs/g"
cp "$W/runs/$R2" "$W/runs/d/$R2" && printf 'x' >> "$W/runs/d/$R2" && cp "$W/runs/$R2.sig" "$W/runs/d/"
cp "$W/runs/$R2" "$W/runs/e/$R2" && ssh-keygen -Y sign -q -f "$W/evilkey" -n lsa9600-release "$W/runs/e/$R2" 2>/dev/null
cp "$W/runs/$R2" "$W/runs/g/$R2"
ok '篡改件：d（.run 多 1 字节）、e（别人签的）、g（没签名）'
# 子站换上本分支的 upgrade-egs.sh、测试发布公钥（= 子站先升到 0.18.2）
sed 's/\r$//' "$ROOT/deploy/sp/upgrade-egs.sh" | docker exec -i "$SPC" sh -c 'cat > /opt/lsa9600sp/upgrade-egs.sh && chmod 755 /opt/lsa9600sp/upgrade-egs.sh'
docker exec -i "$SPC" sh -c 'cat > /opt/lsa9600sp/release-signers' < "$W/test-signers"

UP() { spx env ${UPENV:-} bash /opt/lsa9600sp/upgrade-egs.sh --only "$U" "$@"; }
summary_line() { spx sh -c 'd=$(ls -1d /var/log/lsa9600sp/eg-upgrade/*/ | tail -1); cat "$d/summary.tsv"'; }

say; say "== A. --plan $R1（EG 入口 $(egx sh -c "grep -m1 '^ENTRY_VERSION=' /usr/local/sbin/lsa-eg-upgrade | cut -d= -f2")）"
out="$(UP --run "/w/runs/$R1" --plan 2>&1)"; rc=$?; echo "$out" | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && ok '--plan rc 0' || bad "--plan rc $rc"
grep -q '^签名：已验' <<< "$out" && ok '签名行「已验」' || bad '签名行不是「已验」'
grep -E "^$U .*升级 +子站验" <<< "$out" >/dev/null && ok '验签列「子站验」（老入口）' || bad '验签列不是「子站验」'

say; say "== B. 升到 $V1"
out="$(UP --run "/w/runs/$R1" 2>&1)"; rc=$?; echo "$out" | tail -8 | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && ok "升级成功（$(egx cat /opt/lsa-eg/VERSION)）" || bad "升级 rc $rc"
grep -q '子站已验签，EG 是老入口没验' <<< "$(summary_line)" && ok '汇总：子站已验签，EG 是老入口没验' || bad "汇总签名说明不对：$(summary_line)"
[ "$(egx sh -c "grep -m1 '^ENTRY_VERSION=' /usr/local/sbin/lsa-eg-upgrade | cut -d= -f2")" = 5 ] && ok 'EG 入口已是 5' || bad 'EG 入口没换成 5'
egx test -s /opt/lsa-eg/release-signers && ok 'EG 装上了发布公钥 /opt/lsa-eg/release-signers' || bad 'EG 没有 release-signers'
egx bash -c 'cd /opt/lsa-eg && bash install.sh --status 2>&1' | grep -E '升级验签' | sed 's/^/    /' | tee -a "$LOG"

say; say "== C. --plan $R2（EG 入口 5）"
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
out="$(UP --run "/w/runs/$R2" 2>&1)"; rc=$?; echo "$out" | tail -6 | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && [ "$(egx cat /opt/lsa-eg/VERSION)" = "$V2" ] && ok "升级成功（$V2）" || bad "升级 rc $rc，EG $(egx cat /opt/lsa-eg/VERSION)"
grep -q '已验签（EG）' <<< "$(summary_line)" && ok '汇总：已验签（EG）' || bad "汇总签名说明不对：$(summary_line)"
[ "$(egx sed -n 's/^sig=//p' /var/lib/lsa-upg/state | tail -1)" = ok ] && ok "EG state sig=ok（$(egx sed -n 's/^sig_note=//p' /var/lib/lsa-upg/state | tail -1)）" || bad 'EG state sig 不是 ok'

say; say "== G. 没有 .sig（过渡期）"
out="$(UP --run "/w/runs/g/$R2" --plan --force 2>&1)"; rc=$?; echo "$out" | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" = 0 ] && grep -q '^签名：没有签名' <<< "$out" && grep -E "^$U .*升级 +未签名" <<< "$out" >/dev/null && ok '--plan：签名行「没有签名」、验签列「未签名」、rc 0' || bad "未签名的 --plan 不对（rc $rc）"

say; say "== H. EG 提前强制（.env EG_UPG_SIG_REQUIRED=1）"
egx sh -c 'echo EG_UPG_SIG_REQUIRED=1 >> /opt/lsa-eg/.env'
out="$(UP --run "/w/runs/g/$R2" --plan --force 2>&1)"; rc=$?; echo "$out" | grep -E "^$U " | tee -a "$LOG" | sed 's/^/    /'
[ "$rc" != 0 ] && grep -q '要求发布件签名' <<< "$out" && ok "--plan 报 !!（rc $rc）" || bad "--plan 没报（rc $rc）"
sha="$(sha256sum "$W/runs/g/$R2" | cut -d' ' -f1)"; sz="$(stat -c %s "$W/runs/g/$R2")"
egx sh -c "sudo -n /usr/local/sbin/lsa-eg-upgrade 'put $sha $sz' < /w/runs/g/$R2 >/dev/null"
out="$(egx sudo -n /usr/local/sbin/lsa-eg-upgrade "start $sha" 2>&1)"; echo "    $out" | tee -a "$LOG"
grep -q '^ERR 安装文件没有签名' <<< "$out" && ok '入口直接 start 拒绝' || bad "入口没拒：$out"
egx sudo -n /usr/local/sbin/lsa-eg-upgrade "drop $sha" >/dev/null
egx sed -i '/^EG_UPG_SIG_REQUIRED=/d' /opt/lsa-eg/.env

say; say "== 结果：✓ $n_ok，✗ $fail（日志 $LOG）"
[ "$fail" = 0 ]
