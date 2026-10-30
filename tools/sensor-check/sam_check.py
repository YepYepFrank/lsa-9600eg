#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LSA-9600EG 传感器单元验收脚本（到货检验 / 装柜前自检用）。

在一台 EG（X26A，Ubuntu）上直接跑，只用 Python 3.8+ 标准库，不装任何东西、不联网：
  1. COM2（RS-485，/dev/ttyS1，9600 8N1）逐台问传感器 —— 不经转换程序，直接 Modbus RTU：
       局放（超声）从站 2、气体（烟雾）3、温湿度 4、ALS10 弧光 5（FC04）；--ir 再加红外 1（S19 没有）
     每台问几轮：应答率、时延、读数是否在合理范围、状态位 / 故障位；没应答时自动扫一遍地址，看是不是地址设错了。
  2. 功能试验（人在旁边配合，每项可跳过）：强光照弧光、哈气 / 手握温湿度、搓手 / 超声发生器对局放、烟靠近气体。
  3. 双目摄像机（LAN1）：restv1 登录、设备信息、两路流地址、全画面温度、两路抓拍（存成 JPEG 看图）；
     RTSP 可见光 / 热像各主、子码流逐路拉几秒：鉴权、SDP、收 RTP、关键帧、分辨率、帧率、码率。

EG 上的转换程序（容器 lsa-eg-conv）占着串口：脚本会先停掉它、跑完再起来（Ctrl+C 也会起）。
已经接入子站的 EG 上跑，停转换程序期间子站会看到这台 SAM 通信中断 —— 到货检验建议用没接入的 EG。

用法（在 EG 上）：
  sudo python3 sam_check.py                         # 全部：传感器 + 功能试验（逐项问）+ 摄像机
  sudo python3 sam_check.py --sn SAM-0001           # 报告里记上传感器单元编号
  sudo python3 sam_check.py --loop                  # 连续换测：一台 EG 上热插拔换一套测一套，每套出「通过 / 哪一路有问题」，汇总 summary.csv
  sudo python3 sam_check.py --no-func               # 不做功能试验（无人值守）
  sudo python3 sam_check.py --no-cam                # 不查摄像机
  sudo python3 sam_check.py --cam-only              # 只查摄像机
  sudo python3 sam_check.py --scan                  # 扫 1–32 号地址，看总线上到底有谁
  sudo python3 sam_check.py --port /dev/ttyUSB0     # 用 USB 转 485
  sudo python3 sam_check.py --cam 192.168.1.19    # 摄像机地址（缺省取 /opt/lsa-eg/config/local.yaml）
摄像机口令：缺省取 local.yaml；没有就问（不回显）。也可设环境变量 LSA_CAM_PASS（RTSP，admin）/ LSA_CAM_REST_PASS（restv1 接口）。
报告和抓拍存在 ./sam-check-<编号>-<时间>/。退出码：全部通过 0，有不通过 1，参数 / 环境错 2。
"""
import argparse
import base64
import getpass
import hashlib
import json
import os
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = '1.0'

# ───────────────────────────── 输出 ─────────────────────────────

COLOR = sys.stdout.isatty() and os.environ.get('NO_COLOR') is None
C = {'PASS': '32', 'WARN': '33', 'FAIL': '31', 'SKIP': '90', 'INFO': '36'}
LABEL = {'PASS': '通过', 'WARN': '注意', 'FAIL': '不通过', 'SKIP': '跳过', 'INFO': '信息'}
LOG = []          # 报告全文（不带颜色）
RESULTS = []      # (分项, 级别, 说明)


def out(s=''):
    print(s, flush=True)
    LOG.append(re.sub(r'\x1b\[[0-9;]*m', '', s))


def tag(level):
    t = '[%s]' % LABEL[level]
    return '\x1b[%sm%s\x1b[0m' % (C[level], t) if COLOR else t


def item(level, name, msg=''):
    out('  %s %s%s' % (tag(level), name, ('：' + msg) if msg else ''))


def result(name, level, msg=''):
    RESULTS.append((name, level, msg))
    item(level, name, msg)


def head(s):
    out('')
    out(('\x1b[1m== %s\x1b[0m' if COLOR else '== %s') % s)


def dwidth(s):
    """终端显示宽度（中文算 2）"""
    return sum(2 if ord(ch) > 0x2E80 else 1 for ch in s)


def worst(levels):
    for lv in ('FAIL', 'WARN', 'PASS'):
        if lv in levels:
            return lv
    return 'SKIP'


# ───────────────────────────── 串口 / Modbus RTU ─────────────────────────────

def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


class SerialPort:
    """本机串口（termios，原始模式 8N1）；tcp://主机:端口 走网口（485 转以太网模块 / 本地自测）"""

    def __init__(self, path, baud):
        self.path, self.baud = path, baud
        self.sock = None
        self.fd = None
        if path.startswith('tcp://'):
            host, _, port = path[6:].rpartition(':')
            self.sock = socket.create_connection((host, int(port)), timeout=3)
            self.sock.setblocking(False)
            return
        import termios
        import tty
        speed = getattr(termios, 'B%d' % baud, None)
        if speed is None:
            raise ValueError('不支持的波特率 %d' % baud)
        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        tty.setraw(self.fd)
        a = termios.tcgetattr(self.fd)
        a[2] = (a[2] & ~(termios.PARENB | termios.CSTOPB | termios.CSIZE | getattr(termios, 'CRTSCTS', 0))) \
            | termios.CS8 | termios.CLOCAL | termios.CREAD
        a[0] &= ~(termios.IXON | termios.IXOFF | termios.IXANY)
        a[4] = a[5] = speed
        termios.tcsetattr(self.fd, termios.TCSANOW, a)
        termios.tcflush(self.fd, termios.TCIOFLUSH)

    def handle(self):
        return self.sock if self.sock else self.fd

    def flush_in(self):
        if self.fd is not None:
            import termios
            termios.tcflush(self.fd, termios.TCIFLUSH)
        while self.read(0) != b'':
            pass

    def write(self, data):
        if self.sock:
            self.sock.sendall(data)
        else:
            os.write(self.fd, data)
            import termios
            termios.tcdrain(self.fd)

    def read(self, timeout):
        r, _, _ = select.select([self.handle()], [], [], timeout)
        if not r:
            return b''
        try:
            return self.sock.recv(256) if self.sock else os.read(self.fd, 256)
        except (BlockingIOError, InterruptedError):
            return b''

    def close(self):
        if self.sock:
            self.sock.close()
        elif self.fd is not None:
            os.close(self.fd)


class Modbus:
    def __init__(self, port, timeout, raw=False):
        self.port, self.timeout, self.raw = port, timeout, raw
        self.skipped = 0        # 应答前面夹着杂字节、被跳过的次数（转换头收发切换的毛刺 / 不完整回显）

    @staticmethod
    def _find(buf, slave, fc):
        """在收到的字节里找一帧 CRC 对的应答（从站号 + 功能码 / 异常码开头）；返回 (帧, 前面跳过的字节数) 或 (None, 0)"""
        for i in range(len(buf) - 4):
            if buf[i] != slave or buf[i + 1] not in (fc, fc | 0x80):
                continue
            need = 5 if buf[i + 1] & 0x80 else 5 + buf[i + 2]
            f = buf[i:i + need]
            if len(f) == need and crc16(f[:-2]) == struct.unpack('<H', f[-2:])[0]:
                return f, i
        return None, 0

    def read(self, slave, fc, addr, count, timeout=None):
        """读保持（03）/ 输入（04）寄存器。返回 (寄存器列表 或 None, 错误说明, 毫秒)"""
        req = struct.pack('>BBHH', slave, fc, addr, count)
        req += struct.pack('<H', crc16(req))
        self.port.flush_in()
        time.sleep(0.005)                    # 帧间隔（9600 bps 3.5 字符约 4 ms）
        t0 = time.monotonic()
        self.port.write(req)
        deadline = t0 + (timeout or self.timeout)
        buf = b''
        frame, skip = None, 0
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            chunk = self.port.read(min(left, 0.05))
            if chunk:
                buf += chunk
                if buf.startswith(req):      # 有的 485 模块 / 转换头会把自己发的回显回来
                    buf = buf[len(req):]
                frame, skip = self._find(buf, slave, fc)
                if frame:
                    break
        ms = (time.monotonic() - t0) * 1000
        if self.raw:
            print('     发 %s ／ 收 %s' % (req.hex(' '), buf.hex(' ') or '（无）'))
        time.sleep(0.02)
        if frame:
            if skip:
                self.skipped += 1
            buf = frame
        elif not buf:
            return None, '没有应答', ms
        elif len(buf) < 5:
            return None, '应答不完整（%s）' % buf.hex(' '), ms
        else:
            return None, 'CRC 错（收到 %s）—— 波特率 / 接线干扰 / 两台同地址 / 转换头收发切换？' % buf[:40].hex(' '), ms
        if buf[1] & 0x80:
            return None, '异常应答 %d（%s）' % (buf[2], {1: '不支持此功能码', 2: '寄存器地址不对', 3: '数据不对', 4: '从站故障'}.get(buf[2], '?')), ms
        if buf[1] != fc:
            return None, '功能码不对（%d）' % buf[1], ms
        n = buf[2] // 2
        if n < count:
            return None, '寄存器个数不对（要 %d 回 %d）' % (count, n), ms
        return list(struct.unpack('>%dH' % n, buf[3:3 + 2 * n])), '', ms

    def present(self, slave, timeout=0.15):
        """地址扫描：03 读寄存器 0，或 04 读 0；任何合法应答（含异常应答）都算在"""
        for fc in (3, 4):
            regs, err, _ = self.read(slave, fc, 0, 1, timeout)
            if regs is not None or err.startswith('异常应答') or err.startswith('寄存器个数'):
                return True
        return False


def s16(v):
    return v - 0x10000 if v > 0x7FFF else v


# ───────────────────────────── 传感器定义 ─────────────────────────────
# 寄存器表与转换程序（edge-gateway 1.1.1 drivers/、config/sensors/）一致；见 tools/conv-kit/sim.py

PD_TYPE = {0: '无放电', 1: '针尖', 2: '悬浮', 4: '颗粒', 7: '其他'}
PD_LEVEL = {0: '正常', 1: '异常', 2: '危险'}
ARC_DEV_BITS = {0: 'READY', 1: 'MEASURING', 2: 'ALARM_ACTIVE', 3: 'ALARM_LATCHED', 4: 'FAULT_ACTIVE',
                5: 'CALIBRATING', 7: 'STARTUP_INHIBIT', 9: 'SERVICE_MODE'}
ARC_FAULT_BITS = {1: '传感器饱和', 2: 'ADC 故障', 3: 'NVM 故障', 5: '温度故障', 6: '标定无效', 7: '看门狗复位'}
ARC_EVENT = {1: '弧光告警', 2: '故障', 3: '上电 / 复位'}


def bits(v, names):
    return [n for b, n in names.items() if v & (1 << b)] + (['bit%d' % b for b in range(16) if v & (1 << b) and b not in names])


def dec_th(r):
    rh, t = r[0] * 0.1, s16(r[1]) * 0.1
    v = {'湿度': '%.1f %%RH' % rh, '温度': '%.1f ℃' % t}
    iss = []
    if not 0 < rh <= 100:
        iss.append(('FAIL', '湿度 %.1f %%RH 超出 0–100' % rh))
    if not -40 <= t <= 85:
        iss.append(('FAIL', '温度 %.1f ℃ 超出 -40–85' % t))
    elif not 0 <= t <= 50:
        iss.append(('WARN', '温度 %.1f ℃，室内验收不太可能 —— 核对' % t))
    if r[0] == 0 and r[1] == 0:
        iss.append(('WARN', '湿度、温度都是 0：探头没接好？'))
    return v, iss, {'rh': rh, 't': t}


def dec_gas(r):
    ppm, rng = r[0], r[1]
    v = {'烟雾': '%d ppm' % ppm, '量程': str(rng)}
    iss = []
    if rng != 1000:
        iss.append(('WARN', '量程寄存器 %d（以前实测是 1000）—— 型号不同？' % rng))
    if ppm >= 100:
        iss.append(('WARN', '洁净空气里 %d ppm ≥ 100（重要告警线）：刚上电没稳定 / 周围有烟 / 传感器问题' % ppm))
    return v, iss, {'ppm': ppm}


def dec_pd(r):
    amp, cnt, typ, lvl = r[0] * 0.1, r[1], r[2], r[3]
    tev, uhf = r[6], r[10]
    v = {'超声放电量': '%.1f dBμV' % amp, '次数': str(cnt), '类型': PD_TYPE.get(typ, '未知 %d' % typ),
         '等级': PD_LEVEL.get(lvl, '未知 %d' % lvl),
         '地电波': '没装（187）' if tev == 187 else '%.1f dBmV' % (tev * 0.1),
         '特高频': '没装（269）' if uhf == 269 else '%.1f dBmV' % (uhf * 0.1)}
    iss = []
    if typ not in PD_TYPE:
        iss.append(('WARN', '放电类型 %d 不在 0/1/2/4/7 里' % typ))
    if lvl not in PD_LEVEL:
        iss.append(('WARN', '告警等级 %d 不在 0/1/2 里' % lvl))
    elif lvl:
        iss.append(('WARN', '台架上报告警等级「%s」—— 周围有干扰源？' % PD_LEVEL[lvl]))
    if amp > 40:
        iss.append(('WARN', '超声放电量 %.1f dBμV > 40（告警线），台架上不应该这么高' % amp))
    if tev != 187:
        iss.append(('INFO', 'S19 只配超声，地电波却有读数 %d —— 型号不同？' % tev))
    return v, iss, {'amp': amp, 'cnt': cnt}


def dec_arc(r):
    st, al, ft, lv, pk = r[0], r[1], r[2], r[3] * 0.01, r[6] * 0.01
    v = {'状态': ' '.join(bits(st, ARC_DEV_BITS)) or '0', '弧光强度': '%.2f %%' % lv, '峰值': '%.2f %%' % pk}
    iss = []
    if ft:
        iss.append(('FAIL', '故障位 0x%04X：%s' % (ft, '、'.join(bits(ft, ARC_FAULT_BITS)))))
    if st & 0x80:
        iss.append(('WARN', '启动抑制中（STARTUP_INHIBIT），上电后等一会儿再测'))
    elif not (st & 1 and st & 2):
        iss.append(('WARN', '没有 READY + MEASURING（状态 0x%04X）' % st))
    if st & 0x20:
        iss.append(('WARN', '标定中（CALIBRATING）'))
    if st & 0x200:
        iss.append(('WARN', '维护模式（SERVICE_MODE）'))
    if al & 0x3:
        iss.append(('WARN', '弧光告警%s（告警位 0x%04X）—— 出厂是锁存模式，复位后再测' % ('已锁存' if al & 2 else '中', al)))
    if lv >= 50:
        iss.append(('WARN', '无光照时弧光强度 %.2f %% ≥ 50：探头对着强光源？' % lv))
    return v, iss, {'lv': lv, 'pk': pk}


def dec_ir(r):
    mx, mn, av = s16(r[0]) * 0.1, s16(r[1]) * 0.1, s16(r[2]) * 0.1
    iss = [] if mn <= av <= mx else [('WARN', '最低 ≤ 平均 ≤ 最高 不成立')]
    return {'最高': '%.1f ℃' % mx, '最低': '%.1f ℃' % mn, '平均': '%.1f ℃' % av}, iss, {'max': mx}


SENSORS = [
    # 键, 名称, 缺省从站, 功能码, 起始地址, 个数, 解码
    ('pd', '局放（超声）', 2, 3, 0x0000, 14, dec_pd),
    ('gas', '气体（烟雾）', 3, 3, 0x0016, 2, dec_gas),
    ('th', '温湿度', 4, 3, 0x0000, 2, dec_th),
    ('arc', '弧光 ALS10', 5, 4, 0x0000, 7, dec_arc),
    ('ir', '红外（SAM 自带）', 1, 3, 0x004F, 3, dec_ir),
]


def check_sensors(mb, args, slaves):
    head('传感器（%s，%d 8N1，每台 %d 轮）' % (args.port, args.baud, args.rounds))
    found = {}
    silent = []
    for key, name, _, fc, addr, cnt, dec in SENSORS:
        if key not in slaves:
            continue
        sid = slaves[key]
        ok, ms, errs, last = 0, [], [], None
        issues = {}
        for i in range(args.rounds):
            regs, err, t = mb.read(sid, fc, addr, cnt)
            if regs is None:
                errs.append(err)
            else:
                ok += 1
                ms.append(t)
                last = regs
                for lv, msg in dec(regs)[1]:
                    issues.setdefault(msg, lv)
            if i < args.rounds - 1:
                time.sleep(args.interval)
        title = '%s（从站 %d）' % (name, sid)
        if not ok:
            result(title, 'FAIL', '%d 轮全没读到：%s' % (args.rounds, errs[-1]))
            silent.append(key)
            continue
        found[key] = sid
        vals, _, _ = dec(last)
        comm = '应答 %d/%d，平均 %.0f ms' % (ok, args.rounds, sum(ms) / len(ms))
        lv = 'PASS' if ok == args.rounds else 'WARN'
        if ok < args.rounds:
            comm += '（失败：%s）' % '；'.join(sorted(set(errs)))
        levels = [lv] + [v for v in issues.values() if v != 'INFO']
        result(title, worst(levels), comm)
        out('       读数：' + '，'.join('%s %s' % kv for kv in vals.items()))
        for msg, l in issues.items():
            item(l, '    ' + msg)
        if key == 'arc':
            ev, err, _ = mb.read(sid, 4, 0x0100, 8)
            if ev:
                out('       最近一次事件：序号 %d，%s，峰值 %.2f %%，持续 %d ms' % (
                    ev[0], ARC_EVENT.get(ev[1], '类型 %d' % ev[1]), ev[4] * 0.01, (ev[5] << 16) | ev[6]))
    if mb.skipped:
        item('INFO', '有 %d 次应答前面夹着杂字节（转换头收发切换的毛刺 / 回显不完整），已自动跳过、照常读出' % mb.skipped)
        mb.skipped = 0
    if silent or args.scan:
        scan(mb, args, slaves, found)
    return found


def scan(mb, args, slaves, found):
    lo, hi = args.scan_range
    out('')
    out('  扫地址 %d–%d（每个约 0.3 s）……' % (lo, hi))
    hit = []
    for sid in range(lo, hi + 1):
        if mb.present(sid):
            hit.append(sid)
    known = {v: k for k, v in slaves.items()}
    names = {s[0]: s[1] for s in SENSORS}
    if not hit:
        result('地址扫描', 'FAIL', '%d–%d 一个应答都没有：A+/B- 接反？没供电？波特率不是 %d？BIOS 里 COM2 没设成 RS-485？' % (lo, hi, args.baud))
        return
    desc = ['%d%s' % (s, '（%s）' % names[known[s]] if s in known else '（不认识）') for s in hit]
    extra = [s for s in hit if s not in known]
    lv = 'WARN' if extra else 'INFO'
    item(lv, '总线上应答的地址', '、'.join(desc))
    if extra:
        out('       有不在预期里的地址：可能是传感器地址没按出厂约定设（局放 2、气体 3、温湿度 4、弧光 5）。'
            '确认是哪一台后用 --slave 指定再跑，或让厂家改地址。')


# ───────────────────────────── 功能试验 ─────────────────────────────

def ask(prompt):
    try:
        a = input('  → %s [回车开始 / s 跳过] ' % prompt).strip().lower()
    except EOFError:
        return False
    return a not in ('s', 'n', 'no', 'skip')


def watch(mb, sid, fc, addr, cnt, dec, field, secs, period, hit):
    """先取基线，再在 secs 秒内反复读，hit(基线, 当前, 原始寄存器) 为真即通过。返回 (通过?, 基线, 最大值, 说明)"""
    base = None
    for _ in range(3):
        regs, _, _ = mb.read(sid, fc, addr, cnt)
        if regs:
            base = dec(regs)[2][field]
            break
    if base is None:
        return False, None, None, '读不到基线'
    best = base
    t_end = time.monotonic() + secs
    last_print = 0
    while time.monotonic() < t_end:
        regs, _, _ = mb.read(sid, fc, addr, cnt)
        if regs:
            cur = dec(regs)[2][field]
            best = max(best, cur)
            if time.monotonic() - last_print > 1:
                left = int(t_end - time.monotonic())
                sys.stdout.write('\r     当前 %-8s 基线 %-8s 最大 %-8s 还剩 %2d s ' % (round(cur, 2), round(base, 2), round(best, 2), left))
                sys.stdout.flush()
                last_print = time.monotonic()
            if hit(base, cur, regs):
                sys.stdout.write('\n')
                return True, base, best, ''
        time.sleep(period)
    sys.stdout.write('\n')
    return False, base, best, ''


def functional(mb, args, found):
    head('功能试验（人配合；每项回车开始，输入 s 跳过）')
    if not sys.stdin.isatty():
        out('  标准输入不是终端，跳过功能试验（用 --no-func 可省掉这一段）')
        return
    sp = {s[0]: s for s in SENSORS}

    def run(key, prompt, field, secs, period, hit, desc, miss_hint):
        if key not in found:
            return
        _, name, _, fc, addr, cnt, dec = sp[key]
        if not ask('%s：%s（%d s 内）' % (name, prompt, secs)):
            result('功能 · ' + name, 'SKIP', '人工跳过')
            return
        ok, base, best, err = watch(mb, found[key], fc, addr, cnt, dec, field, secs, period, hit)
        if err:
            result('功能 · ' + name, 'FAIL', err)
        elif ok:
            result('功能 · ' + name, 'PASS', desc % (base, best))
        else:
            result('功能 · ' + name, 'WARN', '没看到响应（基线 %s，最大 %s）—— %s' % (round(base, 2), round(best, 2), miss_hint))

    # 弧光：强度涨 ≥ arc_rise 个百分点，或事件序号变（真弧光事件）
    arc_seq = [None]
    if 'arc' in found:
        ev, _, _ = mb.read(found['arc'], 4, 0x0100, 1)
        arc_seq[0] = ev[0] if ev else None
    rise = args.arc_rise
    run('arc', '手机闪光灯 / 强光手电正对探头照 2–3 秒', 'lv', 30, 0.2,
        lambda b, c, r: c - b >= rise or r[6] * 0.01 - b >= rise,
        '弧光强度 %.2f %% → %.2f %%', '光不够强 / 没对准探头；可用 --arc-rise 调低判据')
    if 'arc' in found and arc_seq[0] is not None:
        ev, _, _ = mb.read(found['arc'], 4, 0x0100, 8)
        if ev and ev[0] != arc_seq[0]:
            item('INFO', '    弧光事件序号 %d → %d：%s，峰值 %.2f %%，持续 %d ms' % (
                arc_seq[0], ev[0], ARC_EVENT.get(ev[1], '类型 %d' % ev[1]), ev[4] * 0.01, (ev[5] << 16) | ev[6]))
            if ev[1] == 1:
                out('       强光触发了弧光告警，出厂是锁存模式：按厂家方法复位（或断电重启传感器单元）后再装柜。')
    run('th', '对着温湿度探头哈气，或用手握住探头', 'rh', 60, 1.0,
        lambda b, c, r: c - b >= 3 or s16(r[1]) * 0.1 - TH0[0] >= 0.5,
        '湿度 %.1f → %.1f %%RH', '哈气要正对探头进气孔')
    run('pd', '探头前搓手 / 揉塑料袋 / 超声发生器对准（局放 3 s 才刷新一次）', 'amp', 45, 1.0,
        lambda b, c, r: c - b >= 3 or r[1] > 0,
        '超声放电量 %.1f → %.1f dBμV（或放电次数 > 0）', '超声探头方向性强，要正对；有超声发生器最可靠')
    run('gas', '点一支香 / 火柴吹灭后的烟靠近进气口', 'ppm', 90, 2.0,
        lambda b, c, r: c - b >= 20,
        '烟雾 %d → %d ppm', '烟量不够 / 没进进气口；这一项可以留到现场')


TH0 = [999.0]   # 温湿度功能试验时的温度基线（湿度、温度任一涨就算）


# ───────────────────────────── 摄像机：restv1 ─────────────────────────────

def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def http_json(url, body=None, token=None, timeout=6):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method='POST' if body is not None else 'GET')
    if body is not None:
        req.add_header('content-type', 'application/json')
    if token:
        req.add_header('accessToken', token)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def jpeg_size(b):
    i = 2
    while i + 9 < len(b):
        if b[i] != 0xFF:
            i += 1
            continue
        m = b[i + 1]
        if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack('>HH', b[i + 5:i + 9])
            return w, h
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        i += 2 + struct.unpack('>H', b[i + 2:i + 4])[0]
    return None


def tcp_ok(host, port, timeout=2):
    try:
        socket.create_connection((host, port), timeout=timeout).close()
        return True
    except OSError as e:
        return e


def check_restv1(cam, outdir):
    base = cam['rest']
    url = base if re.match(r'^https?://', base) else 'http://' + base
    url = url.rstrip('/')
    try:
        j = http_json(url + '/restv1/token', {'user': md5(cam['rest_user']), 'key': md5(cam['rest_pass'])})
    except (urllib.error.URLError, OSError, ValueError) as e:
        result('restv1 登录', 'FAIL', '%s：%s' % (url, e))
        return {}
    tok = (j.get('data') or {}).get('accessToken')
    if j.get('code') != 200 or not tok:
        hint = {10009: '账号或口令不对', 10001: '账号或口令不对', 19999: '会话满了（摄像机最多 2 个：eg-video 占一个，网页 / 调试工具再占一个就满）'}
        result('restv1 登录', 'FAIL', '%s %s（账号 %s）%s' % (j.get('code'), j.get('msg', ''), cam['rest_user'], hint.get(j.get('code'), '')))
        return {}
    result('restv1 登录', 'PASS', '账号 %s' % cam['rest_user'])
    got = {}

    def get(p):
        try:
            r = http_json(url + p, token=tok, timeout=12 if 'snap' in p else 6)
        except (urllib.error.URLError, OSError, ValueError) as e:
            return None, str(e)
        if r.get('code') != 200:
            return None, '%s %s' % (r.get('code'), r.get('msg', ''))
        return r.get('data'), ''

    d, e = get('/restv1/device/info')
    if d is not None:
        ver = d.get('version') or {}
        out('       设备：%s，序列号 %s，固件 %s（%s）' % (d.get('name', '?'), d.get('serial', '?'), ver.get('firmwareVersion', '?'), ver.get('firmwareBuildTime', '?')))
        got['info'] = d
    else:
        item('WARN', '    /restv1/device/info', e)
    for ch, nm in ((0, '可见光'), (1, '热像')):
        d, e = get('/restv1/channel/rtsp/%d' % ch)
        if d:
            got['rtsp%d' % ch] = (d.get('rtspUrlMain'), d.get('rtspUrlSub'))
            out('       %s流地址：主 %s ／ 子 %s' % (nm, strip_cred(d.get('rtspUrlMain')), strip_cred(d.get('rtspUrlSub'))))
        else:
            item('WARN', '    %s流地址（/restv1/channel/rtsp/%d）' % (nm, ch), e)
    d, e = get('/restv1/measurement/globTemp')
    if d:
        def t(k):
            v = (d.get(k) or {}).get('value')
            return None if v is None else round(float(v), 1)
        mx, mn, av = t('max'), t('min'), t('avg')
        if mx is None or mn is None:
            result('热像测温（全画面）', 'FAIL', '没有最高 / 最低温：%s' % json.dumps(d, ensure_ascii=False)[:120])
        else:
            lv = 'PASS' if -20 <= mn <= mx <= 150 and mx - mn > 0.3 else 'WARN'
            msg = '最高 %s ℃，最低 %s ℃，平均 %s ℃' % (mx, mn, av)
            if lv == 'WARN':
                msg += '（读数可疑：最高最低一样 = 画面没内容 / 镜头盖没摘；或超出 -20–150）'
            result('热像测温（全画面）', lv, msg)
    else:
        result('热像测温（全画面）', 'FAIL', e)
    for ch, nm, want in ((0, '可见光', None), (1, '热像', (640, 480))):
        d, e = get('/restv1/channel/snap/%d' % ch)
        if not d or not d.get('snapData'):
            result('抓拍 · ' + nm, 'FAIL', e or '没有 snapData')
            continue
        b = base64.b64decode(re.sub(r'^data:image/\w+;base64,', '', d['snapData']))
        if b[:2] != b'\xff\xd8':
            result('抓拍 · ' + nm, 'FAIL', '回的不是 JPEG（%d 字节）' % len(b))
            continue
        wh = jpeg_size(b)
        fn = os.path.join(outdir, 'snap-%d-%s.jpg' % (ch, 'visible' if ch == 0 else 'thermal'))
        with open(fn, 'wb') as f:
            f.write(b)
        msg = '%s，%d KB → %s（拷出来看一眼画面对不对）' % ('%d×%d' % wh if wh else '尺寸?', len(b) // 1024, fn)
        result('抓拍 · ' + nm, 'PASS' if len(b) > 2000 else 'WARN', msg)
    return got


def strip_cred(u):
    return re.sub(r'//[^/@]*@', '//', u) if u else '—'


# ───────────────────────────── 摄像机：RTSP ─────────────────────────────

class RtspError(Exception):
    pass


class Rtsp:
    def __init__(self, url, user, pw, timeout=5):
        m = re.match(r'^rtsp://(?:([^:@/]*)(?::([^@/]*))?@)?([^/:]+)(?::(\d+))?(/.*)?$', url)
        if not m:
            raise RtspError('地址不对：%s' % url)
        u, p, self.host, port, path = m.groups()
        self.user = user or urllib.parse.unquote(u or '')
        self.pw = pw if pw else urllib.parse.unquote(p or '')
        self.port = int(port or 554)
        self.url = 'rtsp://%s:%d%s' % (self.host, self.port, path or '/')
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.buf = b''
        self.cseq = 0
        self.auth = None
        self.session = None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def _recv(self):
        d = self.sock.recv(65536)
        if not d:
            raise RtspError('摄像机断开了连接')
        self.buf += d

    def _authz(self, method, uri):
        a = self.auth
        if not a:
            return None
        if a['scheme'] == 'basic':
            return 'Basic ' + base64.b64encode(('%s:%s' % (self.user, self.pw)).encode()).decode()
        ha1 = md5('%s:%s:%s' % (self.user, a['realm'], self.pw))
        ha2 = md5('%s:%s' % (method, uri))
        if 'auth' in a.get('qop', '').split(','):
            a['nc'] = a.get('nc', 0) + 1
            nc, cn = '%08x' % a['nc'], md5(str(time.time()))[:16]
            resp = md5('%s:%s:%s:%s:auth:%s' % (ha1, a['nonce'], nc, cn, ha2))
            extra = ', qop=auth, nc=%s, cnonce="%s"' % (nc, cn)
        else:
            resp = md5('%s:%s:%s' % (ha1, a['nonce'], ha2))
            extra = ''
        s = 'Digest username="%s", realm="%s", nonce="%s", uri="%s", response="%s"%s' % (
            self.user, a['realm'], a['nonce'], uri, resp, extra)
        if a.get('opaque'):
            s += ', opaque="%s"' % a['opaque']
        return s

    def _read_msg(self):
        """读一条 RTSP 回应；中途夹着的 $ 交错包丢掉"""
        while True:
            while self.buf[:1] == b'$':
                if len(self.buf) < 4:
                    self._recv()
                    continue
                n = struct.unpack('>H', self.buf[2:4])[0]
                while len(self.buf) < 4 + n:
                    self._recv()
                self.buf = self.buf[4 + n:]
            i = self.buf.find(b'\r\n\r\n')
            if i < 0 or self.buf[:1] == b'$':
                self._recv()
                continue
            head_, self.buf = self.buf[:i].decode('utf-8', 'replace'), self.buf[i + 4:]
            lines = head_.split('\r\n')
            hdr = {}
            for ln in lines[1:]:
                k, _, v = ln.partition(':')
                hdr.setdefault(k.strip().lower(), []).append(v.strip())
            n = int(hdr.get('content-length', ['0'])[0])
            while len(self.buf) < n:
                self._recv()
            body, self.buf = self.buf[:n], self.buf[n:]
            if lines[0].startswith('RTSP/'):
                parts = lines[0].split(' ', 2)
                return int(parts[1]), (parts[2] if len(parts) > 2 else ''), hdr, body.decode('utf-8', 'replace')
            # 摄像机发来的请求（如 GET_PARAMETER）：不管

    def req(self, method, uri=None, headers=None, retry=True):
        uri = uri or self.url
        self.cseq += 1
        h = ['%s %s RTSP/1.0' % (method, uri), 'CSeq: %d' % self.cseq, 'User-Agent: lsa-sam-check/%s' % VERSION]
        if self.session:
            h.append('Session: ' + self.session)
        az = self._authz(method, uri)
        if az:
            h.append('Authorization: ' + az)
        for k, v in (headers or {}).items():
            h.append('%s: %s' % (k, v))
        self.sock.sendall(('\r\n'.join(h) + '\r\n\r\n').encode())
        code, reason, hdr, body = self._read_msg()
        if code == 401 and retry:
            chal = hdr.get('www-authenticate', [])
            dig = [c for c in chal if c.lower().startswith('digest')]
            if dig:
                kv = dict((k.lower(), v1 or v2) for k, v1, v2 in re.findall(r'(\w+)=(?:"([^"]*)"|([^,\s]*))', dig[0][6:]))
                self.auth = {'scheme': 'digest', 'realm': kv.get('realm', ''), 'nonce': kv.get('nonce', ''),
                             'qop': kv.get('qop', ''), 'opaque': kv.get('opaque', '')}
            elif chal:
                self.auth = {'scheme': 'basic'}
            else:
                raise RtspError('401 但没给鉴权方式')
            return self.req(method, uri, headers, retry=False)
        return code, reason, hdr, body


def parse_sdp(sdp, base):
    """取第一个视频轨：编码、控制地址、sprop 里的 SPS"""
    media = None
    tracks = []
    for ln in sdp.splitlines():
        ln = ln.strip()
        if ln.startswith('m='):
            media = {'kind': ln[2:].split()[0], 'pt': ln.split()[-1], 'control': None, 'codec': '?', 'sps': None}
            tracks.append(media)
        elif media and ln.startswith('a=rtpmap:'):
            media['codec'] = ln.split(None, 1)[1].split('/')[0].upper()
        elif media and ln.startswith('a=control:'):
            media['control'] = ln[10:]
        elif media and ln.startswith('a=fmtp:'):
            m = re.search(r'sprop-parameter-sets=([^;,\s]+)', ln)
            if m:
                media['sps'] = base64.b64decode(m.group(1) + '==')
            m = re.search(r'sprop-sps=([^;\s]+)', ln)
            if m:
                media['sps'] = base64.b64decode(m.group(1) + '==')
    v = [t for t in tracks if t['kind'] == 'video']
    if not v:
        return None
    t = v[0]
    c = t['control'] or ''
    if not c or c == '*':
        t['url'] = base
    elif c.startswith('rtsp://'):
        t['url'] = c
    else:
        t['url'] = base.rstrip('/') + '/' + c
    return t


class Bits:
    def __init__(self, b):
        # 去掉防竞争字节 00 00 03
        self.b = re.sub(b'\x00\x00\x03', b'\x00\x00', b)
        self.i = 0

    def u(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.b[self.i >> 3] >> (7 - (self.i & 7))) & 1)
            self.i += 1
        return v

    def ue(self):
        z = 0
        while self.u(1) == 0:
            z += 1
        return (1 << z) - 1 + self.u(z)

    def se(self):
        v = self.ue()
        return (v + 1) // 2 if v & 1 else -(v // 2)


def h264_size(sps):
    """H.264 SPS → (宽, 高)；解析不了返回 None"""
    try:
        b = Bits(sps[1:])
        prof = b.u(8)
        b.u(16)
        b.ue()
        cf = 1
        if prof in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
            cf = b.ue()
            if cf == 3:
                b.u(1)
            b.ue()
            b.ue()
            b.u(1)
            if b.u(1):
                for i in range(8 if cf != 3 else 12):
                    if b.u(1):
                        last, nxt = 8, 8
                        for _ in range(16 if i < 6 else 64):
                            if nxt:
                                nxt = (last + b.se()) % 256
                            last = nxt or last
        b.ue()
        poc = b.ue()
        if poc == 0:
            b.ue()
        elif poc == 1:
            b.u(1)
            b.se()
            b.se()
            for _ in range(b.ue()):
                b.se()
        b.ue()
        b.u(1)
        w = (b.ue() + 1) * 16
        mbh = b.ue() + 1
        fmo = b.u(1)
        h = mbh * 16 * (2 - fmo)
        if not fmo:
            b.u(1)
        b.u(1)
        if b.u(1):
            l, r, t, bt = b.ue(), b.ue(), b.ue(), b.ue()
            cx = 1 if cf == 0 else 2 if cf in (1, 2) else 1
            cy = (2 - fmo) * (2 if cf == 1 else 1)
            w -= (l + r) * cx
            h -= (t + bt) * cy
        return w, h
    except (IndexError, ValueError):
        return None


def rtsp_probe(url, user, pw, secs):
    """拉一路流 secs 秒。返回 dict：ok、codec、size、fps、kbps、idr、pkts、err"""
    r = {'ok': False, 'err': ''}
    try:
        c = Rtsp(url, user, pw)
    except (OSError, RtspError) as e:
        r['err'] = '连不上：%s' % e
        return r
    try:
        c.req('OPTIONS')
        code, reason, hdr, body = c.req('DESCRIBE', headers={'Accept': 'application/sdp'})
        if code == 401:
            r['err'] = '401 鉴权失败（RTSP 只认 admin；账号 %s）' % c.user
            return r
        if code != 200:
            r['err'] = 'DESCRIBE %d %s' % (code, reason)
            return r
        base = (hdr.get('content-base') or hdr.get('content-location') or [c.url])[0]
        t = parse_sdp(body, base)
        if not t:
            r['err'] = 'SDP 里没有视频轨'
            return r
        r['codec'] = t['codec']
        sps = t['sps']
        code, reason, hdr, _ = c.req('SETUP', t['url'], {'Transport': 'RTP/AVP/TCP;unicast;interleaved=0-1'})
        if code != 200:
            r['err'] = 'SETUP %d %s%s' % (code, reason, '（会话满了？EG 的 mediamtx 也在拉）' if code in (453, 454, 503) else '')
            return r
        c.session = (hdr.get('session') or [''])[0].split(';')[0]
        code, reason, _, _ = c.req('PLAY', headers={'Range': 'npt=0.000-'})
        if code != 200:
            r['err'] = 'PLAY %d %s' % (code, reason)
            return r
        h265 = t['codec'] in ('H265', 'HEVC')
        pkts = byts = frames = 0
        idr = False
        first = last_ts = None
        ts0 = None
        t0 = time.monotonic()
        c.sock.settimeout(1.0)
        while time.monotonic() - t0 < secs:
            if len(c.buf) < 4:
                try:
                    c._recv()
                except socket.timeout:
                    continue
                continue
            if c.buf[:1] != b'$':
                i = c.buf.find(b'$')        # 夹着的 RTSP 消息：跳过
                if i < 0:
                    c.buf = b''
                    continue
                c.buf = c.buf[i:]
                continue
            ch = c.buf[1]
            n = struct.unpack('>H', c.buf[2:4])[0]
            while len(c.buf) < 4 + n:
                try:
                    c._recv()
                except socket.timeout:
                    pass
                if time.monotonic() - t0 > secs + 3:
                    break
            p, c.buf = c.buf[4:4 + n], c.buf[4 + n:]
            if ch != 0 or len(p) < 13:
                continue
            pkts += 1
            byts += len(p)
            cc = p[0] & 0x0F
            ext = p[0] & 0x10
            off = 12 + 4 * cc
            if ext and len(p) >= off + 4:
                off += 4 + 4 * struct.unpack('>H', p[off + 2:off + 4])[0]
            pl = p[off:]
            ts = struct.unpack('>I', p[4:8])[0]
            if p[1] & 0x80:
                frames += 1
                if ts0 is None:
                    ts0 = ts
                last_ts = ts
            if first is None:
                first = time.monotonic()
            if not pl:
                continue
            if h265:
                nt = (pl[0] >> 1) & 0x3F
                if nt == 49 and len(pl) > 2:
                    nt = pl[2] & 0x3F
                if 16 <= nt <= 21:
                    idr = True
            else:
                nt = pl[0] & 0x1F
                nals = []
                if nt == 28 and len(pl) > 1:
                    if pl[1] & 0x80:
                        nals.append(bytes([(pl[0] & 0xE0) | (pl[1] & 0x1F)]) + pl[2:])
                elif nt == 24:
                    i = 1
                    while i + 2 < len(pl):
                        ln = struct.unpack('>H', pl[i:i + 2])[0]
                        nals.append(pl[i + 2:i + 2 + ln])
                        i += 2 + ln
                else:
                    nals.append(pl)
                for nal in nals:
                    if not nal:
                        continue
                    k = nal[0] & 0x1F
                    if k == 5:
                        idr = True
                    elif k == 7 and sps is None:
                        sps = nal
        dt = time.monotonic() - (first or t0)
        r.update(pkts=pkts, kbps=byts * 8 / 1000 / max(dt, 0.1), idr=idr)
        if ts0 is not None and last_ts is not None and frames > 1 and last_ts != ts0:
            r['fps'] = (frames - 1) / (((last_ts - ts0) & 0xFFFFFFFF) / 90000.0)
        else:
            r['fps'] = frames / max(dt, 0.1)
        if sps and not h265 and (sps[0] & 0x1F) == 7:
            r['size'] = h264_size(sps)
        try:
            c.sock.settimeout(2)
            c.req('TEARDOWN')
        except (OSError, RtspError):
            pass
        if not pkts:
            r['err'] = '%d 秒没收到一个视频包' % secs
        elif not idr:
            r['err'] = '收到 %d 包但没等到关键帧（I 帧间隔比 %d s 长？用 --rtsp-secs 加长）' % (pkts, secs)
            r['ok'] = None
        else:
            r['ok'] = True
        return r
    except (OSError, RtspError) as e:
        r['err'] = str(e) or e.__class__.__name__
        return r
    finally:
        c.close()


def check_rtsp(cam, urls, args):
    for ch, nm, want_fps in ((0, '可见光', 25), (1, '热像', 9)):
        for kind in ('main', 'sub'):
            url = urls.get((ch, kind))
            title = 'RTSP · %s%s' % (nm, '主码流' if kind == 'main' else '子码流')
            if not url:
                result(title, 'SKIP', '没有地址')
                continue
            r = rtsp_probe(url, cam['rtsp_user'], cam['rtsp_pass'], args.rtsp_secs)
            if r['ok'] is False and '401' not in r['err']:
                time.sleep(5)
                r = rtsp_probe(url, cam['rtsp_user'], cam['rtsp_pass'], args.rtsp_secs)
            if r['ok'] is False:
                result(title, 'FAIL', '%s（%s）' % (r['err'], strip_cred(url)))
                continue
            sz = r.get('size')
            msg = '%s %s，%.1f 帧/秒，%.0f kbit/s，%d 包%s' % (
                r.get('codec', '?'), '%d×%d' % sz if sz else '', r.get('fps', 0), r.get('kbps', 0), r['pkts'],
                '' if r['idr'] else '，没等到关键帧')
            lv = 'PASS' if r['ok'] else 'WARN'
            if r.get('fps', 0) < want_fps * 0.5:
                lv = 'WARN'
                msg += '（帧率偏低，标称约 %d）' % want_fps
            if ch == 1 and sz and sz[0] > 1000:
                lv = 'WARN'
                msg += '（热像通道却是高清画面：两路接反了？）'
            result(title, lv, msg + '  ' + strip_cred(url))


# ───────────────────────────── 摄像机配置 ─────────────────────────────

def yaml_val(v):
    v = v.strip()
    if v.startswith("'"):
        return v[1:v.rfind("'")].replace("''", "'") if v.rfind("'") > 0 else v[1:]
    if v.startswith('"'):
        try:
            return json.loads(v[:v.rfind('"') + 1])
        except ValueError:
            return v.strip('"')
    return re.sub(r'\s+#.*$', '', v)


def read_local_camera(path):
    """只读 local.yaml 的 camera 段（block 写法，EG 用 yaml 库生成）；读不到返回 {}"""
    cam, rtsp = {}, {}
    try:
        lines = open(path, encoding='utf-8').read().splitlines()
    except OSError:
        return {}
    sect = sub = None
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith('#'):
            continue
        ind = len(raw) - len(raw.lstrip(' '))
        k, _, v = raw.strip().partition(':')
        if ind == 0:
            sect = k
            sub = None
            continue
        if sect != 'camera':
            continue
        if ind == 2:
            sub = k if v.strip() == '' else None
            if v.strip().startswith('{'):
                for kk, vv in re.findall(r"(\w+)\s*:\s*('[^']*'|\"[^\"]*\"|[^,}]*)", v):
                    rtsp[kk] = yaml_val(vv)
            elif sub is None:
                cam[k] = yaml_val(v)
        elif sub == 'rtsp':
            rtsp[k] = yaml_val(v)
    cam['rtsp'] = rtsp
    return cam


def camera_conf(args):
    lc = read_local_camera(args.local_yaml) if args.local_yaml else {}
    if lc:
        out('  摄像机配置取自 %s（驱动 %s）' % (args.local_yaml, lc.get('driver', '?')))
    host = args.cam
    rest = lc.get('restv1', '')
    if not host:
        for u in (rest, lc.get('onvif', ''), lc.get('rtsp', {}).get('visible', '')):
            m = re.match(r'^\w+://(?:[^@/]*@)?([^/:]+)', u or '')
            if m:
                host = m.group(1)
                break
    if not host:
        host = '192.168.1.19'
        out('  没指定摄像机地址、local.yaml 里也没有：用出厂地址 %s（--cam 改）' % host)
    if args.cam or not rest:
        rest = 'http://%s%s' % (host, '' if args.cam_http_port == 80 else ':%d' % args.cam_http_port)
    tty_in = sys.stdin.isatty()

    def secret(prompt):
        return getpass.getpass(prompt) if tty_in else ''

    # RTSP（取流）账号：真机只认 admin
    rtsp_user = args.rtsp_user or lc.get('user') or 'admin'
    rtsp_pass = os.environ.get('LSA_CAM_PASS') or (lc.get('password') if rtsp_user == lc.get('user') else '')
    if not rtsp_pass:
        rtsp_pass = secret('  RTSP 口令（账号 %s，不回显）：' % rtsp_user)
    # restv1 接口账号：真机和 RTSP 是两套；local.yaml 的 restUser 留空 = 同取流账号
    rest_user = args.rest_user or lc.get('restUser') or ''
    if not rest_user:
        if not lc and tty_in:
            rest_user = input('  restv1 接口账号（真机接口和 RTSP 是两套账号；回车 = 同 %s）：' % rtsp_user).strip()
        rest_user = rest_user or rtsp_user
    rest_pass = os.environ.get('LSA_CAM_REST_PASS') or ''
    if not rest_pass and lc.get('restUser') and rest_user == lc.get('restUser'):
        rest_pass = lc.get('restPassword', '')
    if not rest_pass and rest_user == rtsp_user:
        rest_pass = rtsp_pass
    if not rest_pass:
        rest_pass = secret('  restv1 口令（账号 %s，不回显）：' % rest_user)
    return {'host': host, 'rest': rest, 'rest_user': rest_user, 'rest_pass': rest_pass,
            'rtsp_user': rtsp_user, 'rtsp_pass': rtsp_pass, 'rtsp': lc.get('rtsp', {})}


def cam_mac(host):
    """EG 上 ARP 表里摄像机地址对应的 MAC（换了摄像机，MAC 应该变）"""
    try:
        r = subprocess.run(['ip', 'neigh', 'show', host], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ''
    m = re.search(r'lladdr ([0-9a-f:]{17})', r.stdout)
    return m.group(1) if m else ''


def check_camera(args, outdir, cam, prev=None):
    """返回摄像机身份 {serial, mac}；prev 是上一套的（换测时核对是不是真换了）"""
    head('双目摄像机（LAN1）')
    host = cam['host']
    ident = {'serial': '', 'mac': ''}
    hp, rp = args.cam_http_port, args.cam_rtsp_port
    p80, p554 = tcp_ok(host, hp), tcp_ok(host, rp)
    if p80 is not True and p554 is not True:
        result('摄像机网络', 'FAIL', '%s 的 %d / %d 都连不上（%s）：网线 / PoE 供电 / LAN1 地址（EG 应是 192.168.1.1/24）' % (host, hp, rp, p80))
        return ident
    result('摄像机网络', 'PASS' if p80 is True and p554 is True else 'WARN',
           '%s  HTTP %d %s，RTSP %d %s' % (host, hp, '通' if p80 is True else '不通', rp, '通' if p554 is True else '不通'))
    got = check_restv1(cam, outdir) if p80 is True else {}
    ident['serial'] = str((got.get('info') or {}).get('serial') or '')
    ident['mac'] = cam_mac(host)
    if ident['mac']:
        out('       MAC：%s' % ident['mac'])
    if prev and ((ident['serial'] and ident['serial'] == prev.get('serial')) or (ident['mac'] and ident['mac'] == prev.get('mac'))):
        result('摄像机已更换', 'WARN', '序列号 / MAC 和上一套一样（%s %s）：摄像机没换？' % (ident['serial'] or '—', ident['mac'] or '—'))
    urls = {}
    for ch in (0, 1):
        if 'rtsp%d' % ch in got:
            m, s = got['rtsp%d' % ch]
            urls[(ch, 'main')], urls[(ch, 'sub')] = m, s
    lr = cam['rtsp']
    for (ch, kind), k in (((0, 'main'), 'visible'), ((0, 'sub'), 'visibleSub'), ((1, 'main'), 'thermal'), ((1, 'sub'), 'thermalSub')):
        if not urls.get((ch, kind)):
            urls[(ch, kind)] = lr.get(k) if lr.get(k) and not args.cam else 'rtsp://%s:%d/%d/%s' % (host, rp, ch, kind)
    if p554 is not True:
        result('RTSP', 'FAIL', '%d 端口不通' % rp)
        return ident
    check_rtsp(cam, urls, args)
    return ident


# ───────────────────────────── 转换程序（占串口）─────────────────────────────

CONV = 'lsa-eg-conv'


def conv_running():
    if not shutil.which('docker'):
        return False
    try:
        r = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', CONV], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0 and r.stdout.strip() == 'true'


def stop_hint(pid):
    """这个进程归谁管、怎么停：容器 → docker stop，systemd 服务 → systemctl stop，都不是 → kill（手工起的）"""
    try:
        cg = open('/proc/%s/cgroup' % pid).read()
    except OSError:
        cg = ''
    m = re.search(r'docker[-/]([0-9a-f]{12,64})', cg)
    if m:
        name = m.group(1)[:12]
        try:
            r = subprocess.run(['docker', 'inspect', '-f', '{{.Name}}', m.group(1)], capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                name = r.stdout.strip().lstrip('/')
        except (OSError, subprocess.SubprocessError):
            pass
        return '容器 %s → sudo docker stop %s（测完 sudo docker start %s）' % (name, name, name)
    m = re.search(r'/([\w@.-]+\.service)\s*$', cg, re.M)
    if m and m.group(1) not in ('user@0.service',) and not m.group(1).startswith('user@') and not m.group(1).startswith('session-'):
        u = m.group(1)
        return '服务 %s → sudo systemctl stop %s（测完 sudo systemctl start %s）' % (u, u, u)
    return '手工起的（某个终端 / nohup / run.sh）→ 在那个终端 Ctrl+C，或 sudo kill %s' % pid


def holders(path):
    """哪些进程开着这个串口（/proc 扫 fd），带上怎么停"""
    try:
        real = os.path.realpath(path)
    except OSError:
        return []
    res = []
    for pid in os.listdir('/proc') if os.path.isdir('/proc') else []:
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            for fd in os.listdir('/proc/%s/fd' % pid):
                if os.path.realpath('/proc/%s/fd/%s' % (pid, fd)) == real:
                    cmd = open('/proc/%s/cmdline' % pid, 'rb').read().replace(b'\0', b' ').decode('utf-8', 'replace').strip()
                    res.append('%s %s\n    归属：%s' % (pid, cmd[:80], stop_hint(pid)))
                    break
        except OSError:
            continue
    return res


# ───────────────────────────── 主流程 ─────────────────────────────

def parse_args():
    ap = argparse.ArgumentParser(description='LSA-9600EG 传感器单元验收（串口传感器 + 双目摄像机）',
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split('用法（在 EG 上）：')[1])
    ap.add_argument('--sn', default='', help='传感器单元编号（写进报告和目录名）')
    ap.add_argument('--port', default='/dev/ttyS1', help='串口（缺省 X26A COM2 /dev/ttyS1；也可 /dev/ttyUSB0、tcp://主机:端口）')
    ap.add_argument('--baud', type=int, default=9600)
    ap.add_argument('--timeout', type=float, default=0.6, help='每次问的应答超时秒（缺省 0.6）')
    ap.add_argument('--raw', action='store_true', help='逐条打印串口收发的原始字节（查 CRC 错、转换头问题用）')
    ap.add_argument('--rounds', type=int, default=5, help='每台问几轮（缺省 5）')
    ap.add_argument('--interval', type=float, default=0.5, help='两轮间隔秒')
    ap.add_argument('--slave', default='', help='改从站地址，如 pd=7,th=8（键：pd gas th arc ir）')
    ap.add_argument('--only', default='', help='只查这几路，如 th,arc')
    ap.add_argument('--ir', action='store_true', help='也查 SAM 自带红外（从站 1；S19 没有）')
    ap.add_argument('--scan', nargs='?', const='1-32', default=None, help='扫地址（缺省 1-32；有传感器不应答时自动扫）')
    ap.add_argument('--no-func', action='store_true', help='不做功能试验')
    ap.add_argument('--arc-rise', type=float, default=1.0, help='弧光功能试验判据：强度至少涨几个百分点（缺省 1.0）')
    ap.add_argument('--no-cam', action='store_true', help='不查摄像机')
    ap.add_argument('--cam-only', action='store_true', help='只查摄像机')
    ap.add_argument('--cam', default='', help='摄像机地址（缺省取 local.yaml，再没有用 192.168.1.19）')
    ap.add_argument('--cam-http-port', type=int, default=80, help=argparse.SUPPRESS)
    ap.add_argument('--cam-rtsp-port', type=int, default=554, help=argparse.SUPPRESS)
    ap.add_argument('--rtsp-user', default='', help='RTSP 账号（缺省 local.yaml 的 user，一般 admin）')
    ap.add_argument('--rest-user', default='', help='restv1 接口账号（缺省 local.yaml 的 restUser）')
    ap.add_argument('--rtsp-secs', type=int, default=4, help='每路拉流秒数（缺省 4）')
    ap.add_argument('--local-yaml', default='/opt/lsa-eg/config/local.yaml', help='EG 的 local.yaml（读摄像机配置；给空串不读）')
    ap.add_argument('--loop', action='store_true', help='连续换测：每换一套回车（或扫码输入编号）测一套，q 退出；汇总 summary.csv')
    ap.add_argument('--wait', type=int, default=None, help='开测前最多等设备上线几秒（--loop 缺省 120，单次缺省 0）')
    ap.add_argument('--keep-conv', action='store_true', help='不停转换程序（串口另有他用时自己负责）')
    ap.add_argument('--out', default='', help='报告目录（缺省 ./sam-check-<编号>-<时间>；--loop 时 ./sam-check-batch-<时间>，每套一个子目录）')
    ap.add_argument('--version', action='version', version=VERSION)
    a = ap.parse_args()
    try:
        lo, hi = (a.scan or '1-32').split('-')
        a.scan_range = (max(1, int(lo)), min(247, int(hi)))
    except ValueError:
        ap.error('--scan 写成 1-32')
    if a.wait is None:
        a.wait = 120 if a.loop else 0
    if a.loop and not sys.stdin.isatty():
        ap.error('--loop 要在终端里跑（每套要回车 / 输入编号）')
    return a


def wait_online(args, mb, slaves, cam):
    """换上一套后：清掉摄像机的 ARP（新摄像机同一个 IP、MAC 不同），最多等 args.wait 秒，
    直到预期的传感器都应答、弧光过了启动抑制、摄像机 HTTP / RTSP 端口都开了"""
    if cam:
        try:
            subprocess.run(['ip', 'neigh', 'flush', 'to', cam['host']], capture_output=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            pass
    t0 = time.monotonic()
    pend = {}
    while True:
        pend = {}
        for key, sid in (slaves.items() if mb else []):
            s = next(x for x in SENSORS if x[0] == key)
            regs, err, _ = mb.read(sid, s[3], s[4], s[5], 0.3)
            if regs is None:
                pend[s[1]] = '没应答'
            elif key == 'arc' and regs[0] & 0x80:
                pend[s[1]] = '启动抑制中'
        if cam:
            if tcp_ok(cam['host'], args.cam_http_port, 1) is not True or tcp_ok(cam['host'], args.cam_rtsp_port, 1) is not True:
                pend['摄像机'] = '端口没开'
        left = args.wait - (time.monotonic() - t0)
        if not pend or left <= 0:
            break
        sys.stdout.write('\r  等设备上线（还剩 %3d s）：%s        ' % (left, '，'.join('%s %s' % kv for kv in pend.items())))
        sys.stdout.flush()
        time.sleep(2)
    if args.wait:
        sys.stdout.write('\r' + ' ' * 100 + '\r')
        out('  设备上线：%s（等了 %d s）' % ('都到了' if not pend else '没到齐，照常测：' + '，'.join(pend), time.monotonic() - t0))


def run_unit(args, sn, outdir, mb, slaves, cam, prev_cam):
    """测一套：返回 (结论, 不通过项, 注意项, 摄像机身份)"""
    RESULTS.clear()
    LOG.clear()
    os.makedirs(outdir, exist_ok=True)
    out('LSA-9600EG 传感器单元验收 v%s   %s   单元编号：%s   主机：%s' % (
        VERSION, time.strftime('%Y-%m-%d %H:%M:%S'), sn or '（没填，--sn）', socket.gethostname()))
    ident = {}
    try:
        if args.wait:
            wait_online(args, mb, slaves, cam)
        if mb and slaves:
            found = check_sensors(mb, args, slaves)
            if not args.no_func and found:
                if 'th' in found:
                    regs, _, _ = mb.read(found['th'], 3, 0, 2)
                    if regs:
                        TH0[0] = s16(regs[1]) * 0.1
                functional(mb, args, found)
        if cam:
            ident = check_camera(args, outdir, cam, prev_cam) or {}
    except KeyboardInterrupt:
        out('\n（Ctrl+C，这一套中止）')
        result('中止', 'FAIL', '人工 Ctrl+C')

    head('汇总')
    width = max([dwidth(n) for n, _, _ in RESULTS] + [4])
    for n, lv, msg in RESULTS:
        out('  %s %s  %s' % (tag(lv), n + ' ' * (width - dwidth(n)), msg[:110]))
    fails = [(n, m) for n, lv, m in RESULTS if lv == 'FAIL']
    warns = [(n, m) for n, lv, m in RESULTS if lv == 'WARN']
    verdict = '不通过' if fails else '通过'
    out('')
    bar = '=' * 64
    lv = 'FAIL' if fails else ('WARN' if warns else 'PASS')
    big = '%s   %s   %s' % (sn or '本套', verdict, '（%d 项注意）' % len(warns) if warns and not fails else '')
    out(('\x1b[1;%sm%s\x1b[0m' % (C[lv], bar)) if COLOR else bar)
    out(('\x1b[1;%sm  %s\x1b[0m' % (C[lv], big)) if COLOR else '  ' + big)
    for n, m in fails:
        out('  %s %s：%s' % (tag('FAIL'), n, m[:90]))
    for n, m in warns:
        out('  %s %s：%s' % (tag('WARN'), n, m[:90]))
    out(('\x1b[1;%sm%s\x1b[0m' % (C[lv], bar)) if COLOR else bar)
    rp = os.path.join(outdir, 'report.txt')
    with open(rp, 'w', encoding='utf-8') as f:
        f.write('\n'.join(LOG) + '\n')
    print('报告：%s' % os.path.abspath(rp))
    return verdict, fails, warns, ident


def csv_row(path, row):
    import csv
    new = not os.path.exists(path)
    with open(path, 'a', encoding='utf-8-sig' if new else 'utf-8', newline='') as f:
        w = csv.writer(f)
        if new:
            w.writerow(['时间', '编号', '结论', '不通过项', '注意项', '摄像机序列号', '摄像机 MAC', '报告'])
        w.writerow(row)


def main():
    args = parse_args()
    slaves = {s[0]: s[2] for s in SENSORS if s[0] != 'ir' or args.ir}
    for kv in filter(None, args.slave.split(',')):
        k, _, v = kv.partition('=')
        if k.strip() not in {s[0] for s in SENSORS} or not v.strip().isdigit():
            print('--slave 写法：pd=2,gas=3,th=4,arc=5,ir=1')
            return 2
        slaves[k.strip()] = int(v)
    if args.only:
        keep = set(args.only.split(','))
        slaves = {k: v for k, v in slaves.items() if k in keep}
    if args.cam_only:
        slaves = {}

    stamp = time.strftime('%Y%m%d-%H%M%S')
    stopped = False
    port = None

    def restore(*_):
        nonlocal stopped
        if stopped:
            print('\n== 重新起转换程序 %s' % CONV)
            r = subprocess.run(['docker', 'start', CONV], capture_output=True, text=True)
            print('  ' + ('已起来' if r.returncode == 0 else '起不来：%s —— 手工 docker start %s' % (r.stderr.strip(), CONV)))
            stopped = False

    def on_sig(signum, _f):
        restore()
        sys.exit(130)

    signal.signal(signal.SIGTERM, on_sig)
    try:
        mb = None
        if slaves:
            if not args.port.startswith('tcp://'):
                if not os.path.exists(args.port):
                    print('串口 %s 不存在。可用的：%s' % (args.port, ' '.join(sorted(
                        p for d in ('/dev',) for p in (os.path.join(d, f) for f in os.listdir(d)) if re.search(r'tty(S\d|USB|ACM)', p))[:12])))
                    return 2
                if not args.keep_conv and conv_running():
                    print('== 转换程序 %s 占着串口：先停掉，%s自动起来' % (CONV, '退出时' if args.loop else '跑完'))
                    r = subprocess.run(['docker', 'stop', '-t', '10', CONV], capture_output=True, text=True)
                    if r.returncode != 0:
                        print('  停不掉：%s（要 sudo）' % r.stderr.strip())
                        return 2
                    stopped = True
                    time.sleep(1)
                h = holders(args.port)
                if h and not args.keep_conv:
                    print('串口 %s 还被别的进程开着，读数会乱：\n  %s\n按上面「归属」停掉再跑；或者换个串口（如 --port /dev/ttyS0）；实在要同时跑加 --keep-conv（读数会乱）' % (args.port, '\n  '.join(h)))
                    return 2
            try:
                port = SerialPort(args.port, args.baud)
            except (OSError, ValueError) as e:
                print('打不开串口 %s：%s%s' % (args.port, e, '（要 sudo，或把用户加进 dialout 组）' if isinstance(e, PermissionError) else ''))
                return 2
            mb = Modbus(port, args.timeout, args.raw)
        cam = None if args.no_cam else camera_conf(args)

        if not args.loop:
            outdir = args.out or 'sam-check-%s%s' % ((re.sub(r'[^\w.-]', '_', args.sn) + '-') if args.sn else '', stamp)
            verdict, fails, _, _ = run_unit(args, args.sn, outdir, mb, slaves, cam, None)
            return 1 if fails else 0

        # 连续换测
        batch = args.out or 'sam-check-batch-%s' % stamp
        os.makedirs(batch, exist_ok=True)
        summary = os.path.join(batch, 'summary.csv')
        n, npass, prev = 0, 0, None
        sn = args.sn
        print('\n连续换测：汇总在 %s' % os.path.abspath(summary))
        while True:
            if n or not sn:
                try:
                    a = input('\n→ 换上%s一套，插好后输入编号（可扫码）回车开始；直接回车自动编号；q 退出：' % ('下' if n else '第')).strip()
                except EOFError:
                    break
                if a.lower() in ('q', 'quit', 'exit'):
                    break
                sn = a or 'unit-%03d' % (n + 1)
            n += 1
            outdir = os.path.join(batch, '%03d-%s' % (n, re.sub(r'[^\w.-]', '_', sn)))
            verdict, fails, warns, ident = run_unit(args, sn, outdir, mb, slaves, cam, prev)
            npass += 0 if fails else 1
            prev = ident or prev
            csv_row(summary, [time.strftime('%Y-%m-%d %H:%M:%S'), sn, verdict,
                              '；'.join('%s：%s' % f for f in fails), '；'.join(w[0] for w in warns),
                              (ident or {}).get('serial', ''), (ident or {}).get('mac', ''), os.path.join(outdir, 'report.txt')])
            print('（已测 %d 套：通过 %d、不通过 %d）' % (n, npass, n - npass))
            sn = ''
        print('\n共测 %d 套：通过 %d、不通过 %d。汇总：%s' % (n, npass, n - npass, os.path.abspath(summary)))
        return 0 if n == npass else 1
    except KeyboardInterrupt:
        print('\n（Ctrl+C，退出）')
        return 1
    finally:
        if port:
            port.close()
        restore()


if __name__ == '__main__':
    sys.exit(main())
