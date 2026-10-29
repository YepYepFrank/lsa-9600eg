#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sam_check.py 本机自测（不要 EG、不要真传感器 / 摄像机；Windows / Linux 都能跑）：
  - 485 总线：TCP 上的 Modbus RTU 从站，寄存器取 tools/conv-kit/sim.py（与转换程序联调用的同一份）；
  - 摄像机：假 restv1（HTTP）+ 假 RTSP（Digest 鉴权、TCP 交错、H.264），画面用 ffmpeg 现做（没有 ffmpeg 跳过摄像机几项）。
跑几种场景，核对 sam_check.py 的结论和关键输出。

  python3 tools/sensor-check/test/selftest.py
"""
import base64
import hashlib
import http.server
import importlib.util
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', 'sam_check.py')
SIM = os.path.join(HERE, '..', '..', 'conv-kit', 'sim.py')
REST_USER, REST_PASS = 'restop', 'rest-secret'
RTSP_USER, RTSP_PASS = 'admin', 'rtsp-secret'

# ───────── 485 从站（sim.py 的寄存器；sim.py 要 tty，Windows 没有，塞个空模块）─────────
sys.modules.setdefault('tty', types.ModuleType('tty'))
spec = importlib.util.spec_from_file_location('sim', SIM)
sim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sim)


class Bus:
    remap = {}       # 真地址 → 应答的地址（模拟地址设错）
    echo = False     # 模拟 485 模块回显
    dead = False     # 总线上谁都不应答


def serve_bus(conn):
    buf = b''
    conn.settimeout(30)
    try:
        while True:
            d = conn.recv(256)
            if not d:
                return
            buf += d
            while len(buf) >= 8:
                frame, buf = buf[:8], buf[8:]
                if sim.crc16(frame[:6]) != int.from_bytes(frame[6:8], 'little'):
                    buf = b''
                    break
                sid, fc = frame[0], frame[1]
                if Bus.dead:
                    continue
                real = {v: k for k, v in Bus.remap.items()}.get(sid, sid)
                if sid in Bus.remap and Bus.remap[sid] != sid:
                    continue                       # 原地址不应答了
                addr = int.from_bytes(frame[2:4], 'big')
                cnt = int.from_bytes(frame[4:6], 'big')
                r = sim.regs(real, fc)
                if r is None:
                    if real in (1, 2, 3, 4, 5, 6) and fc in (3, 4):   # 功能码不对：异常应答（像真从站那样）
                        body = bytes([sid, fc | 0x80, 1])
                        conn.sendall((frame if Bus.echo else b'') + body + sim.crc16(body).to_bytes(2, 'little'))
                    continue
                data = b''.join(int(r.get(addr + i, 0) & 0xFFFF).to_bytes(2, 'big') for i in range(cnt))
                body = bytes([sid, fc, len(data)]) + data
                out = body + sim.crc16(body).to_bytes(2, 'little')
                if Bus.echo:
                    out = frame + out
                # 分两段发，验「分段到达」
                conn.sendall(out[:3])
                time.sleep(0.01)
                conn.sendall(out[3:])
    except OSError:
        return


def listen(handler):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', 0))
    s.listen(8)

    def loop():
        while True:
            c, _ = s.accept()
            threading.Thread(target=handler, args=(c,), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    return s.getsockname()[1]


# ───────── 假摄像机 ─────────
MEDIA = {}           # (ch, kind) → (nals, fps, sps, pps)
SNAP = {}            # ch → jpeg bytes
PORTS = {}


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def make_media(tmp):
    ff = shutil.which('ffmpeg')
    if not ff:
        return False
    plan = {(0, 'main'): (1280, 800, 25), (0, 'sub'): (704, 576, 25), (1, 'main'): (640, 480, 9), (1, 'sub'): (640, 480, 9)}
    for (ch, kind), (w, h, fps) in plan.items():
        fn = os.path.join(tmp, '%d-%s.h264' % (ch, kind))
        subprocess.run([ff, '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=%dx%d:rate=%d' % (w, h, fps), '-t', '3',
                        '-c:v', 'libx264', '-g', str(fps), '-bf', '0', '-pix_fmt', 'yuv420p', '-f', 'h264', fn], check=True)
        raw = open(fn, 'rb').read()
        nals = [n.rstrip(b'\x00') for n in re.split(b'\x00\x00\x01', raw) if n.strip(b'\x00')]
        sps = next(n for n in nals if n[0] & 0x1F == 7)
        pps = next(n for n in nals if n[0] & 0x1F == 8)
        MEDIA[(ch, kind)] = (nals, fps, sps, pps)
    for ch, (w, h) in ((0, (1280, 800)), (1, (640, 480))):
        fn = os.path.join(tmp, 'snap%d.jpg' % ch)
        subprocess.run([ff, '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=%dx%d' % (w, h), '-frames:v', '1', fn], check=True)
        SNAP[ch] = open(fn, 'rb').read()
    return True


class Rest(http.server.BaseHTTPRequestHandler):
    tokens = set()

    def log_message(self, *a):
        pass

    def send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        if self.path == '/restv1/token':
            if body.get('user') == md5(REST_USER) and body.get('key') == md5(REST_PASS):
                Rest.tokens.add('tok1')
                return self.send({'code': 200, 'msg': 'Success', 'data': {'accessToken': 'tok1', 'expireTime': 1800}})
            return self.send({'code': 10009, 'msg': 'auth'})
        self.send({'code': 10008})

    def do_GET(self):
        if self.headers.get('accessToken') not in Rest.tokens:
            return self.send({'code': 10009})
        p = self.path
        ok = lambda d: self.send({'code': 200, 'msg': 'Success', 'data': d})
        if p == '/restv1/device/info':
            return ok({'name': 'MOCK-CAM', 'serial': 'SN-1', 'version': {'firmwareVersion': '0000_B37_1.1.17', 'firmwareBuildTime': '2026-10-01'}})
        m = re.match(r'^/restv1/channel/rtsp/(\d)$', p)
        if m:
            ch = int(m.group(1))
            b = 'rtsp://127.0.0.1:%d/%d' % (PORTS['rtsp'], ch)
            return ok({'rtspUrlMain': b + '/main', 'rtspUrlSub': b + '/sub'})
        if p == '/restv1/measurement/globTemp':
            return ok({'max': {'value': 31.4, 'x': 1, 'y': 2}, 'min': {'value': 22.100000381469727}, 'avg': {'value': 25.0}})
        m = re.match(r'^/restv1/channel/snap/(\d)$', p)
        if m:
            return ok({'snapData': 'data:image/jpeg;base64,' + base64.b64encode(SNAP[int(m.group(1))]).decode()})
        self.send({'code': 10008})


def serve_rtsp(conn):
    nonce = 'abc123'
    realm = 'LoginTo8000E'
    lock = threading.Lock()
    state = {'play': False, 'media': None}
    buf = b''

    def send(b):
        with lock:
            conn.sendall(b)

    def stream():
        nals, fps, _, _ = state['media']
        seq, ts = 0, 0
        try:
            while state['play']:
                for n in nals:
                    if not state['play']:
                        return
                    t = n[0] & 0x1F
                    vcl = t in (1, 5)
                    pkts = [n] if len(n) <= 1200 else []
                    if not pkts:
                        ind = (n[0] & 0xE0) | 28
                        body = n[1:]
                        for i in range(0, len(body), 1200):
                            fu = (n[0] & 0x1F) | (0x80 if i == 0 else 0) | (0x40 if i + 1200 >= len(body) else 0)
                            pkts.append(bytes([ind, fu]) + body[i:i + 1200])
                    for i, p in enumerate(pkts):
                        mk = 0x80 if vcl and i == len(pkts) - 1 else 0
                        rtp = struct.pack('>BBHII', 0x80, mk | 96, seq & 0xFFFF, ts & 0xFFFFFFFF, 0x1234) + p
                        seq += 1
                        send(b'$\x00' + struct.pack('>H', len(rtp)) + rtp)
                    if vcl:
                        ts += 90000 // fps
                        time.sleep(1.0 / fps)
        except OSError:
            return

    try:
        while True:
            while b'\r\n\r\n' not in buf:
                d = conn.recv(4096)
                if not d:
                    state['play'] = False
                    return
                buf += d
            i = buf.index(b'\r\n\r\n')
            req, buf = buf[:i].decode(), buf[i + 4:]
            lines = req.split('\r\n')
            method, uri, _ = lines[0].split(' ')
            hdr = {l.split(':', 1)[0].lower(): l.split(':', 1)[1].strip() for l in lines[1:] if ':' in l}
            cseq = hdr.get('cseq', '0')
            if method != 'OPTIONS':
                az = hdr.get('authorization', '')
                kv = dict((k, v) for k, v in re.findall(r'(\w+)="([^"]*)"', az))
                good = kv.get('username') == RTSP_USER and kv.get('response') == md5('%s:%s:%s' % (
                    md5('%s:%s:%s' % (RTSP_USER, realm, RTSP_PASS)), nonce, md5('%s:%s' % (method, kv.get('uri', '')))))
                if not good:
                    send(('RTSP/1.0 401 Unauthorized\r\nCSeq: %s\r\nWWW-Authenticate: Digest realm="%s", nonce="%s"\r\n\r\n' % (cseq, realm, nonce)).encode())
                    continue
            if method == 'OPTIONS':
                send(('RTSP/1.0 200 OK\r\nCSeq: %s\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n' % cseq).encode())
            elif method == 'DESCRIBE':
                m = re.search(r'/(\d)/(main|sub)', uri)
                key = (int(m.group(1)), m.group(2)) if m else None
                if key not in MEDIA:
                    send(('RTSP/1.0 404 Not Found\r\nCSeq: %s\r\n\r\n' % cseq).encode())
                    continue
                state['media'] = MEDIA[key]
                _, _, sps, pps = MEDIA[key]
                sdp = ('v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=mock\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n'
                       'a=fmtp:96 packetization-mode=1;sprop-parameter-sets=%s,%s\r\na=control:trackID=0\r\n' % (
                           base64.b64encode(sps).decode(), base64.b64encode(pps).decode()))
                send(('RTSP/1.0 200 OK\r\nCSeq: %s\r\nContent-Base: %s/\r\nContent-Type: application/sdp\r\nContent-Length: %d\r\n\r\n%s' % (
                    cseq, uri.rstrip('/'), len(sdp), sdp)).encode())
            elif method == 'SETUP':
                send(('RTSP/1.0 200 OK\r\nCSeq: %s\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nSession: 66334873;timeout=60\r\n\r\n' % cseq).encode())
            elif method == 'PLAY':
                send(('RTSP/1.0 200 OK\r\nCSeq: %s\r\nSession: 66334873\r\nRange: npt=0.000-\r\n\r\n' % cseq).encode())
                state['play'] = True
                threading.Thread(target=stream, daemon=True).start()
            elif method == 'TEARDOWN':
                state['play'] = False
                send(('RTSP/1.0 200 OK\r\nCSeq: %s\r\n\r\n' % cseq).encode())
                return
    except OSError:
        state['play'] = False
    finally:
        try:
            conn.close()
        except OSError:
            pass


# ───────── 场景 ─────────

def run(tmp, name, extra, env_extra=None):
    out = os.path.join(tmp, 'out-' + name)
    env = dict(os.environ, NO_COLOR='1', PYTHONIOENCODING='utf-8', LSA_CAM_PASS=RTSP_PASS, LSA_CAM_REST_PASS=REST_PASS)
    env.update(env_extra or {})
    cmd = [sys.executable, TOOL, '--port', 'tcp://127.0.0.1:%d' % PORTS['bus'], '--rounds', '3', '--interval', '0.05',
           '--local-yaml', '', '--no-func', '--out', out, '--rtsp-secs', '3', '--rest-user', REST_USER,
           '--cam', '127.0.0.1', '--cam-http-port', str(PORTS['http']), '--cam-rtsp-port', str(PORTS['rtsp'])] + extra
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', env=env, stdin=subprocess.DEVNULL, timeout=180)
    return p.returncode, p.stdout + p.stderr


FAILS = []


def expect(name, cond, text=''):
    print('  %s %s' % ('ok  ' if cond else 'FAIL', name))
    if not cond:
        FAILS.append(name)
        if text:
            print('-' * 60 + '\n' + text + '\n' + '-' * 60)


def line(text, key):
    return next((l for l in text.splitlines() if key in l), '')


def main():
    tmp = tempfile.mkdtemp(prefix='samchk-')
    cam = make_media(tmp)
    PORTS['bus'] = listen(serve_bus)
    PORTS['rtsp'] = listen(serve_rtsp)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Rest)
    PORTS['http'] = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    if not cam:
        print('（没有 ffmpeg：摄像机几项跳过）')

    print('场景 1：全部正常')
    code, t = run(tmp, '1', [] if cam else ['--no-cam'])
    expect('退出码 0', code == 0, t)
    expect('温湿度读数 34.9 %RH / 27.0 ℃', '湿度 34.9 %RH' in t and '温度 27.0 ℃' in t, t)
    expect('局放从站 2 通过、地电波读到', '[通过] 局放（超声）（从站 2）' in t and '地电波 1' in t, t)
    expect('气体 6 ppm、量程 1000', '烟雾 6 ppm' in t and '量程 1000' in t, t)
    expect('弧光 READY MEASURING', 'READY MEASURING' in t, t)
    expect('报告写出', os.path.exists(os.path.join(tmp, 'out-1', 'report.txt')))
    if cam:
        expect('restv1 登录通过', '[通过] restv1 登录' in t, t)
        expect('热像全画面温度', '最高 31.4 ℃，最低 22.1 ℃' in t, t)
        expect('抓拍两张 JPEG 存下来', os.path.exists(os.path.join(tmp, 'out-1', 'snap-0-visible.jpg')) and '640×480' in line(t, '抓拍 · 热像'), t)
        for nm, size in (('可见光主码流', '1280×800'), ('可见光子码流', '704×576'), ('热像主码流', '640×480'), ('热像子码流', '640×480')):
            l = line(t, 'RTSP · ' + nm)
            expect('RTSP %s 通过、%s' % (nm, size), '[通过]' in l and size in l, t)
        fps = re.search(r'热像主码流.*?([\d.]+) 帧/秒', t)
        expect('热像帧率约 9', fps and 7 <= float(fps.group(1)) <= 11, t)
        expect('输出不带口令', RTSP_PASS not in t and REST_PASS not in t)

    print('场景 2：温湿度地址设成 14、485 模块回显、RTSP 口令错')
    Bus.remap, Bus.echo = {4: 14}, True
    code, t = run(tmp, '2', [] if cam else ['--no-cam'], {'LSA_CAM_PASS': 'wrong'})
    expect('退出码 1', code == 1, t)
    expect('温湿度不通过', '[不通过] 温湿度（从站 4）' in t, t)
    expect('自动扫出 14（不认识）', '14（不认识）' in t and '2（局放（超声））' in t, t)
    expect('回显也能读（局放照样通过）', '[通过] 局放（超声）（从站 2）' in t, t)
    if cam:
        expect('RTSP 401 不通过', '401 鉴权失败' in line(t, 'RTSP · 可见光主码流'), t)
    Bus.remap, Bus.echo = {}, False

    print('场景 3：--slave th=14 --only th,arc --no-cam')
    Bus.remap = {4: 14}
    code, t = run(tmp, '3', ['--slave', 'th=14', '--only', 'th,arc', '--no-cam'])
    expect('退出码 0', code == 0, t)
    expect('只查了两路', '温湿度（从站 14）' in t and '局放' not in t, t)
    Bus.remap = {}

    print('场景 4：总线上谁都不应答（A+/B- 接反 / 没供电）')
    Bus.dead = True
    code, t = run(tmp, '4', ['--no-cam', '--scan', '1-6'])
    Bus.dead = False
    expect('退出码 1，扫描说一个应答都没有', code == 1 and '一个应答都没有' in t, t)

    print('\n%s' % ('全部通过' if not FAILS else '不通过：%s' % '；'.join(FAILS)))
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
