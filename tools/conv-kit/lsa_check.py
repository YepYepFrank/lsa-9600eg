#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LSA-9600EG 转换程序自检工具 —— 按《EG 内部 MQTT 格式 v0.4》逐条检查总线上的消息。

只用 Python 标准库（3.8+），自带一个最小的 MQTT 5 客户端，不用 pip 装任何东西。

  python3 lsa_check.py                          # 连 127.0.0.1:1884，按设备名前缀自动认设备，一直检查到 Ctrl+C
  python3 lsa_check.py --cab AH03 --group mv    # 指定柜号与柜型：还会检查「该有的设备一台不少」
  python3 lsa_check.py --eg-yaml eg.yaml        # 按这台 EG 的设备清单检查（EG 上在 /opt/lsa-eg/config/eg.yaml）
  python3 lsa_check.py --duration 300 --report 自检报告.md   # 跑 5 分钟出报告（发回给我们看）
  python3 lsa_check.py demo --cab AH03          # 发一套正确的示范数据（看看对的长什么样）
  python3 lsa_check.py demo --cab AH03 --bad    # 发一套常见错误（看检查工具能不能抓到）
  python3 lsa_check.py clear-retained           # 清掉总线上残留的 retain 消息

点表来自同目录的 spec.json（由 @lsa/points 导出，pnpm conv-kit:spec）。
"""
import argparse
import json
import math
import os
import random
import re
import socket
import struct
import sys
import threading
import time
from collections import defaultdict

VERSION = '1.0'
HERE = os.path.dirname(os.path.abspath(__file__))

try:
    sys.stdout.reconfigure(errors='replace')
    sys.stderr.reconfigure(errors='replace')
except Exception:
    pass

# ───────────────────────── 最小 MQTT 5 客户端 ─────────────────────────


def _varint(n):
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _str(s):
    b = s.encode('utf-8')
    return struct.pack('!H', len(b)) + b


class MqttError(Exception):
    pass


class Mqtt:
    """够用就行：CONNECT / SUBSCRIBE / PUBLISH(QoS 0/1) / PUBACK / PING。线程安全的发送。"""

    def __init__(self, host, port, client_id, keepalive=30):
        self.host, self.port, self.client_id, self.keepalive = host, port, client_id, keepalive
        self.sock = None
        self.buf = b''
        self.lock = threading.Lock()
        self.pid = 0
        self.last_send = 0.0

    def connect(self, timeout=5):
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.buf = b''
        vh = _str('MQTT') + bytes([5, 0x02]) + struct.pack('!H', self.keepalive) + _varint(0)
        self._send(0x10, vh + _str(self.client_id))
        t, _flags, body = self.read(timeout)
        if t != 0x20:
            raise MqttError('没收到 CONNACK')
        if len(body) >= 2 and body[1] != 0:
            raise MqttError('服务器拒绝连接，原因码 0x%02x' % body[1])

    def close(self):
        try:
            self._send(0xE0, b'')
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass

    def _send(self, first, body):
        with self.lock:
            self.sock.sendall(bytes([first]) + _varint(len(body)) + body)
            self.last_send = time.time()

    def _next_pid(self):
        self.pid = self.pid % 65535 + 1
        return self.pid

    def subscribe(self, topic, qos=1, retain_as_published=True):
        opts = qos | (0x08 if retain_as_published else 0)
        self._send(0x82, struct.pack('!H', self._next_pid()) + _varint(0) + _str(topic) + bytes([opts]))

    def publish(self, topic, payload, qos=1, retain=False, user_props=None):
        if isinstance(payload, str):
            payload = payload.encode('utf-8')
        props = b''
        for k, v in (user_props or {}).items():
            props += b'\x26' + _str(k) + _str(v)
        vh = _str(topic) + (struct.pack('!H', self._next_pid()) if qos else b'') + _varint(len(props)) + props
        self._send(0x30 | (qos << 1) | (1 if retain else 0), vh + payload)

    def puback(self, pid):
        self._send(0x40, struct.pack('!H', pid))

    def ping_if_due(self):
        if time.time() - self.last_send > self.keepalive / 2:
            self._send(0xC0, b'')

    def read(self, timeout):
        """读一个包：(类型, 标志, 体)；超时返回 None。"""
        self.sock.settimeout(timeout)
        while True:
            pkt = self._parse()
            if pkt:
                return pkt
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                return None
            if not chunk:
                raise MqttError('服务器断开了连接')
            self.buf += chunk

    def _parse(self):
        b = self.buf
        if len(b) < 2:
            return None
        n, mul, i = 0, 1, 1
        while True:
            if i >= len(b):
                return None
            n += (b[i] & 0x7F) * mul
            mul *= 128
            i += 1
            if not b[i - 1] & 0x80:
                break
        if len(b) < i + n:
            return None
        self.buf = b[i + n:]
        return b[0] & 0xF0, b[0] & 0x0F, b[i:i + n]


def parse_publish(flags, body):
    """PUBLISH 体 → (topic, qos, retain, pid, user_props, payload)。"""
    qos, retain = (flags >> 1) & 3, flags & 1
    tl = struct.unpack('!H', body[:2])[0]
    topic = body[2:2 + tl].decode('utf-8', 'replace')
    p = 2 + tl
    pid = None
    if qos:
        pid = struct.unpack('!H', body[p:p + 2])[0]
        p += 2
    # 属性
    n, mul = 0, 1
    while True:
        c = body[p]
        p += 1
        n += (c & 0x7F) * mul
        mul *= 128
        if not c & 0x80:
            break
    end, props = p + n, {}
    while p < end:
        pid_ = body[p]
        p += 1
        if pid_ in (0x01,):
            p += 1
        elif pid_ in (0x02,):
            p += 4
        elif pid_ in (0x23,):
            p += 2
        elif pid_ in (0x03, 0x08, 0x09):
            ln = struct.unpack('!H', body[p:p + 2])[0]
            p += 2 + ln
        elif pid_ == 0x0B:
            while body[p] & 0x80:
                p += 1
            p += 1
        elif pid_ == 0x26:
            kl = struct.unpack('!H', body[p:p + 2])[0]
            k = body[p + 2:p + 2 + kl].decode('utf-8', 'replace')
            p += 2 + kl
            vl = struct.unpack('!H', body[p:p + 2])[0]
            v = body[p + 2:p + 2 + vl].decode('utf-8', 'replace')
            p += 2 + vl
            props[k] = v
        else:
            p = end
    return topic, qos, retain, pid, props, body[end:]


# ───────────────────────── 点表 ─────────────────────────


def load_spec():
    path = os.path.join(HERE, 'spec.json')
    with open(path, encoding='utf-8') as f:
        return json.load(f)


SPEC = None
ROOMS = {'mv': 'AB', 'tr': 'ABC', 'lv': 'A'}
ROOM_NAMES = {'mv': '中压开关柜', 'tr': '干式变压器', 'lv': '低压柜'}
KIND_NAMES = {'sam': '感知模块 SAM', 'meter': '多功能电表', 'pm': '颗粒物 / 烟气', 'eg': 'EG 级信号', 'camera': '摄像机'}
PERIOD_NAMES = {2000: '快 2 s', 10000: '慢 10 s', 60000: '分钟 60 s'}
DEV_ERR = {'', 'TIMEOUT', 'CRC', 'REFUSED', 'PARSE', 'AUTH'}
Q_VALUES = {'invalid', 'stale', 'warmup', 'calibrating'}
SOUTH5 = ['dev.req_24h', 'dev.timeout_24h', 'dev.crc_24h', 'dev.retry_24h', 'dev.rate_24h']
NAME_RE = [
    (re.compile(r'^SAM-([A-Za-z0-9]+)-([A-Z])$'), 'sam'),
    (re.compile(r'^PM6-([A-Za-z0-9]+)$'), 'pm'),
    (re.compile(r'^PM2?-([A-Za-z0-9]+)$'), 'meter'),
    (re.compile(r'^EG-([A-Za-z0-9]+)$'), 'eg'),
    (re.compile(r'^CAM-([A-Za-z0-9]+)$'), 'camera'),
]


def kind_of_name(name):
    for rx, kind in NAME_RE:
        m = rx.match(name)
        if m:
            return kind, m.group(1)
    return None, None


def keydefs(kind):
    """kind → {key: def}，含各设备通用的 dev.* / q。"""
    if kind == 'eg':
        return {d['key']: d for d in SPEC['eg']['send']}
    out = {d['key']: d for d in SPEC['devices'][kind]['send']}
    for d in SPEC['common']['send']:
        out[d['key']] = d
    return out


def forbidden(kind):
    if kind == 'eg':
        return set(SPEC['eg']['forbid'])
    return set(SPEC['devices'][kind]['forbid']) | set(SPEC['common']['forbid'])


def retired(kind, key):
    for pat in SPEC.get('retired', {}).get(kind, []):
        if pat.endswith('*') and key.startswith(pat[:-1]) or key == pat:
            return True
    return False


def read_eg_yaml(path):
    """只认 devices: 下的 `- name:` / `kind:` 两行（eg.yaml 由子站生成，格式固定），不依赖 PyYAML。"""
    devs, cab, cur, in_devs = {}, None, None, False
    with open(path, encoding='utf-8') as f:
        for line in f:
            s = line.rstrip('\n')
            if re.match(r'^\S', s):
                in_devs = s.startswith('devices:')
            m = re.match(r'^\s+code:\s*"?([A-Za-z0-9]+)"?', s)
            if m and not cab:
                cab = m.group(1)
            if not in_devs:
                continue
            m = re.match(r'^\s*-\s*name:\s*"?([^"\s]+)"?', s)
            if m:
                cur = m.group(1)
                continue
            m = re.match(r'^\s+kind:\s*"?(\w+)"?', s)
            if m and cur and cur not in devs:
                devs[cur] = m.group(1)
    if cab:
        devs['EG-' + cab] = 'eg'
    return cab, devs


def devices_for(cab, group, pm2=False):
    devs = {'SAM-%s-%s' % (cab, r): 'sam' for r in ROOMS[group]}
    devs['PM-' + cab] = 'meter'
    if pm2:
        devs['PM2-' + cab] = 'meter'
    devs['PM6-' + cab] = 'pm'
    devs['EG-' + cab] = 'eg'
    return devs


# ───────────────────────── 检查 ─────────────────────────

LEVELS = {'ERROR': '错误', 'WARN': '注意', 'INFO': '建议'}
COLOR = {'ERROR': '\033[31m', 'WARN': '\033[33m', 'INFO': '\033[36m', 'OK': '\033[32m'}
USE_COLOR = sys.stdout.isatty() and os.name != 'nt' or os.environ.get('WT_SESSION')


def c(level, s):
    return (COLOR[level] + s + '\033[0m') if USE_COLOR else s


def fmt_t(ms):
    return time.strftime('%H:%M:%S', time.localtime(ms / 1000)) + '.%03d' % (ms % 1000)


def short(payload, n=160):
    s = payload if isinstance(payload, str) else payload.decode('utf-8', 'replace')
    return s if len(s) <= n else s[:n] + '…'


class Dev:
    def __init__(self, name, kind, expected):
        self.name, self.kind, self.expected = name, kind, expected
        self.first = None          # 第一次收到（本机时刻 ms）
        self.msgs = 0
        self.last_arrive = {}      # key → 本机到达时刻 ms
        self.last_ts = {}          # key → 最近 ts
        self.gaps = defaultdict(int)   # key → 最大到达间隔 ms
        self.counts = defaultdict(int)
        self.delays = []           # 到达 − 采样，ms（最近 500 个）
        self.ts_msgs = defaultdict(int)  # ts → 条数（检查拆条）
        self.ep = None
        self.attrs = 0
        self.south_seen = set()
        self.stale_flagged = set()


class Checker:
    def __init__(self, args, devices):
        self.args = args
        self.devs = {}
        self.listed = devices is not None
        for name, kind in (devices or {}).items():
            if kind == 'camera':
                continue
            self.devs[name] = Dev(name, kind, True)
        self.issues = {}           # (level, device, code, key) → [次数, 首次信息, 示例]
        self.total = 0
        self.agent_msgs = 0
        self.ignored_topics = defaultdict(int)
        self.started = now_ms()
        self.subscribed_at = None
        self.retained = 0

    # —— 记一条问题：同一类只在第一次时打印，之后只计数 ——
    def issue(self, level, dev, code, msg, key='', example=None, once=False):
        k = (level, dev, code, key)
        it = self.issues.get(k)
        if it:
            if not once:
                it[0] += 1
            return
        self.issues[k] = [1, msg, example]
        if not self.args.quiet or level == 'ERROR':
            tag = c(level, '[%s]' % LEVELS[level])
            print('%s %s %s  %s' % (time.strftime('%H:%M:%S'), tag, dev or '-', msg))
            if example:
                print('           消息：%s' % short(example))

    def on_message(self, topic, qos, retain, props, payload):
        t = now_ms()
        # eg-agent / eg-video 自己发的（MQTT 5 用户属性 src=eg-agent / eg-video）不是转换程序的，略过
        if props.get('src', '').startswith('eg-'):
            self.agent_msgs += 1
            return
        self.total += 1
        if self.args.raw:
            print('%s  %s  q%d%s  %s' % (time.strftime('%H:%M:%S'), topic, qos, ' retain' if retain else '', short(payload, 400)))
        parts = topic.split('/')
        if len(parts) != 3 or parts[0] != 'lsa' or parts[2] not in ('telemetry', 'attributes'):
            self.ignored_topics[topic] += 1
            self.issue('ERROR', None, 'topic', '主题「%s」不对：只认 lsa/<设备名>/telemetry 与 lsa/<设备名>/attributes（§3），这条不会进 TB' % topic, topic, payload)
            return
        name, what = parts[1], parts[2]
        dev = self.devs.get(name)
        if not dev:
            kind, _cab = kind_of_name(name)
            if kind is None:
                self.issue('ERROR', name, 'name', '设备名「%s」不合规则（§3：SAM-<柜号>-<隔室字母> / PM-<柜号> / PM2-<柜号> / PM6-<柜号> / EG-<柜号>），不会上送' % name, name, payload)
                return
            if kind == 'camera':
                self.issue('ERROR', name, 'camera', '摄像机数据由 eg-video 发，转换程序不要发 CAM-*（§6）', name, payload)
                return
            if self.listed:
                self.issue('ERROR', name, 'unlisted', '「%s」不在这台 EG 的设备清单里（§3：不在清单的不会上送；清单以 eg.yaml 为准）' % name, name, payload)
            dev = self.devs[name] = Dev(name, kind, False)
        if dev.first is None:
            dev.first = t
            for k in [k for k in self.issues if k[1] == name and k[2] == 'absent']:
                del self.issues[k]
            print('%s %s %s 开始收到（%s）' % (time.strftime('%H:%M:%S'), c('OK', '[设备]'), name, KIND_NAMES.get(dev.kind, dev.kind)))
        dev.msgs += 1

        # QoS / retain
        if qos == 0:
            self.issue('ERROR', name, 'qos0', 'QoS 是 0，要用 1（§2：EG 重启、总线排队时 QoS 0 会丢）', '', payload)
        if retain:
            stored = self.subscribed_at and t - self.subscribed_at < 1500
            self.retained += 1
            self.issue('ERROR', name, 'retain',
                       ('总线上存着这台设备的 retain 消息（以前用 retain 发过）。' if stored else '用了 retain，') +
                       '不要用 retain（§2：EG 重启后会把旧值当新数据再收一遍）。改程序后可运行 `lsa_check.py clear-retained` 清掉', '', payload)

        try:
            data = json.loads(payload.decode('utf-8'))
        except UnicodeDecodeError:
            self.issue('ERROR', name, 'utf8', '载荷不是 UTF-8 文本', '', payload)
            return
        except ValueError as e:
            self.issue('ERROR', name, 'json', '载荷不是合法 JSON（%s）' % e, '', payload)
            return

        if what == 'attributes':
            dev.attrs += 1
            if not isinstance(data, dict):
                self.issue('ERROR', name, 'attr-shape', '属性载荷要是 JSON 对象，如 {"fw":"v2.1.0"}', '', payload)
            elif 'ts' in data and 'values' in data:
                self.issue('WARN', name, 'attr-ts', '属性不带 ts / values，直接发 {"fw":"v2.1.0"}（§3）', '', payload)
            return

        items = data if isinstance(data, list) else [data]
        if not items:
            self.issue('WARN', name, 'empty', '空数组，什么也没发', '', payload)
        for item in items:
            self.check_item(dev, item, t, payload)

    def check_item(self, dev, item, t, payload):
        name = dev.name
        if not isinstance(item, dict):
            self.issue('ERROR', name, 'shape', '载荷要是 {"ts":…, "values":{…}} 或它的数组（§4）', '', payload)
            return
        if 'values' not in item:
            self.issue('ERROR', name, 'no-values', '缺 "values"：要写成 {"ts":<毫秒>, "values":{…}}（§4）；直接把量平铺在顶层的话 ts 会被当成一个量', '', payload)
            return
        values = item['values']
        ts = item.get('ts')
        if 'ts' not in item:
            self.issue('ERROR', name, 'no-ts', '缺 "ts"：TB 会用到达时刻当采样时刻（§4 要求 ts = 采样时刻，毫秒）', '', payload)
            ts = t
        elif isinstance(ts, bool) or not isinstance(ts, (int, float)):
            self.issue('ERROR', name, 'ts-type', 'ts 要是数值（毫秒整数），现在是 %s' % type(ts).__name__, '', payload)
            ts = t
        elif ts < 1e11:
            self.issue('ERROR', name, 'ts-sec', 'ts 像是秒（%s），要毫秒（13 位）' % ts, '', payload)
            ts = int(ts * 1000)
        elif ts > 1e14:
            self.issue('ERROR', name, 'ts-us', 'ts 像是微秒 / 纳秒（%s），要毫秒（13 位）' % ts, '', payload)
            ts = t
        else:
            if ts != int(ts):
                self.issue('WARN', name, 'ts-frac', 'ts 带小数，发毫秒整数', '', payload)
            ts = int(ts)
            d = t - ts
            dev.delays.append(d)
            if len(dev.delays) > 500:
                del dev.delays[:250]
            if d < -1000:
                self.issue('WARN', name, 'ts-future', 'ts 比本机时间快 %.1f s：时钟没对上？（检查工具与转换程序不在同一台机器时可忽略）' % (-d / 1000), '', payload)
            elif d > 3000 and not self.args.lan:
                self.issue('WARN', name, 'ts-late', '采样到到达 %.1f s（> 3 s，§8）：ts 是不是用了旧缓存，或程序堵了？' % (d / 1000), '', payload)
        if not isinstance(values, dict):
            self.issue('ERROR', name, 'values-shape', '"values" 要是对象 {"key": 值, …}', '', payload)
            return
        if not values:
            self.issue('WARN', name, 'values-empty', '"values" 是空的', '', payload)
            return

        dev.ts_msgs[ts] += 1
        if dev.ts_msgs[ts] == 3:
            self.issue('WARN', name, 'split', '同一采样时刻拆成了好几条：本周期这台设备的全部量打成一条（§4）', '', payload)
        if len(dev.ts_msgs) > 2000:
            for k in sorted(dev.ts_msgs)[:1000]:
                del dev.ts_msgs[k]

        defs = keydefs(dev.kind)
        forb = forbidden(dev.kind)
        for key, v in values.items():
            dev.counts[key] += 1
            prev = dev.last_arrive.get(key)
            if prev is not None:
                dev.gaps[key] = max(dev.gaps[key], t - prev)
            dev.last_arrive[key] = t
            pts = dev.last_ts.get(key)
            if pts is not None and ts < pts:
                self.issue('WARN', name, 'ts-back', '%s 的 ts 往回走了（%s → %s）：ts 要单调' % (key, fmt_t(pts), fmt_t(ts)), key, payload)
            dev.last_ts[key] = ts
            dev.stale_flagged.discard(key)
            if key in forb or key.startswith('eg.') and dev.kind != 'eg' or key.startswith('cam.'):
                self.issue('ERROR', name, 'forbid', '「%s」由 eg-agent / eg-video 算，转换程序不要发（§6）' % key, key, payload)
                continue
            if retired(dev.kind, key):
                self.issue('ERROR', name, 'retired', '「%s」已退役：G4 起热像测温改由摄像机（eg-video），SAM 不再发 ir.*' % key, key, payload)
                continue
            d = defs.get(key)
            if not d:
                self.issue('WARN', name, 'unknown', '「%s」不在 %s 的点表里，子站不认（拼写？大小写？）' % (key, KIND_NAMES.get(dev.kind)), key, payload)
                continue
            self.check_value(dev, key, d, v, payload)
            if key in SOUTH5:
                dev.south_seen.add(key)

        # 同一条里要一起出现的
        if dev.kind == 'meter':
            ph = [k for k in ('el.Ia', 'el.Ib', 'el.Ic') if k in values]
            if ph and len(ph) < 3:
                self.issue('WARN', name, 'ph', '三相电流要放在同一条里（§5.2：负荷率按同一时刻的三相电流算），这条只有 %s' % '、'.join(ph), '', payload)
            if 'el.Ep' in values and isinstance(values['el.Ep'], (int, float)) and not isinstance(values['el.Ep'], bool):
                if dev.ep is not None and values['el.Ep'] < dev.ep:
                    self.issue('ERROR', name, 'ep-back', 'el.Ep 倒退了（%s → %s）：正向有功电能必须单调不减（§5.2）' % (dev.ep, values['el.Ep']), '', payload)
                dev.ep = values['el.Ep']
        if dev.kind == 'sam' and 'uv.pulse' in values and 'uv.int' not in values:
            self.issue('ERROR', name, 'pulse-int', '弧光脉冲那条要同时带 uv.int = 峰值（§5.1）', '', payload)
        if dev.kind == 'pm':
            m = [values.get(k) for k in ('pm.2.5', 'pm.5.0', 'pm.10')]
            if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in m) and not (m[0] <= m[1] <= m[2]):
                self.issue('WARN', name, 'pm-order', '质量浓度应 PM2.5 ≤ PM5.0 ≤ PM10，现在是 %s / %s / %s（寄存器对应错了？）' % tuple(m), '', payload)

    def check_value(self, dev, key, d, v, payload):
        name, typ = dev.name, d['type']
        if typ == 'number':
            if isinstance(v, bool):
                self.issue('ERROR', name, 'type', '%s 要发数值，现在是 true/false' % key, key, payload)
                return
            if isinstance(v, str):
                self.issue('ERROR', name, 'type', '%s 发成了字符串 "%s"：数值发数值（82.4，不是 "82.4"，§4）' % (key, v), key, payload)
                return
            if not isinstance(v, (int, float)):
                self.issue('ERROR', name, 'type', '%s 要发数值，现在是 %s' % (key, type(v).__name__), key, payload)
                return
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                self.issue('ERROR', name, 'nan', '%s 是 NaN / 无穷：采不到就不发这个 key（§4）' % key, key, payload)
                return
            if 'enum' in d and v not in d['enum']:
                self.issue('ERROR', name, 'enum', '%s 只能是 %s，现在是 %s（§5.4）' % (key, ' / '.join(map(str, d['enum'])), v), key, payload)
            self.check_range(dev, key, v, payload)
        elif typ == 'string':
            if not isinstance(v, str):
                self.issue('ERROR', name, 'type', '%s 要发字符串' % key, key, payload)
            elif key == 'dev.err' and v not in DEV_ERR and not re.match(r'^HTTP_\d{3}$', v):
                self.issue('WARN', name, 'dev-err', 'dev.err = "%s" 不在约定里：TIMEOUT / CRC / REFUSED / PARSE / AUTH / HTTP_<码>，成功后发 ""（§6b）' % v, key, payload)
        elif typ == 'json':
            if not isinstance(v, str):
                self.issue('ERROR', name, 'json-str', '%s 要发「字符串化的 JSON」（如 "%s"），现在直接发了 %s' % (key, json.dumps(json.dumps(v, ensure_ascii=False), ensure_ascii=False)[1:-1][:60], type(v).__name__), key, payload)
                return
            try:
                j = json.loads(v)
            except ValueError:
                self.issue('ERROR', name, 'json-bad', '%s 的字符串不是合法 JSON：%s' % (key, v[:60]), key, payload)
                return
            if key.startswith('el.hu.') or key.startswith('el.hi.'):
                if not (isinstance(j, list) and len(j) == 30 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in j)):
                    self.issue('ERROR', name, 'harm', '%s 要是 30 个数（2–31 次谐波含有率），现在是 %s' % (key, ('%d 项' % len(j)) if isinstance(j, list) else type(j).__name__), key, payload)
            elif key == 'uv.pulse':
                if not (isinstance(j, dict) and isinstance(j.get('peak'), (int, float)) and isinstance(j.get('ms'), (int, float))):
                    self.issue('ERROR', name, 'pulse', 'uv.pulse 要是 "{\\"peak\\":463,\\"ms\\":21}"（峰值、持续毫秒，§5.1）', key, payload)
            elif key == 'q':
                if not isinstance(j, dict):
                    self.issue('ERROR', name, 'q', 'q 要是对象：{"env.t":"invalid"}，好了发 "{}"（§6）', key, payload)
                else:
                    defs = keydefs(dev.kind)
                    for qk, qv in j.items():
                        if qv not in Q_VALUES:
                            self.issue('ERROR', name, 'q-val', 'q 里 %s = "%s"：只能是 invalid / stale / warmup / calibrating（§6）' % (qk, qv), 'q:' + qk, payload)
                        if qk not in defs:
                            self.issue('WARN', name, 'q-key', 'q 里的「%s」不是这台设备的量' % qk, 'q:' + qk, payload)
        if key in ('dev.last_ok', 'dev.last_try') and isinstance(v, (int, float)) and not isinstance(v, bool):
            if v < 1e11 or v > 1e14:
                self.issue('ERROR', name, 'dev-ts', '%s 要是毫秒时间戳（13 位），现在是 %s' % (key, v), key, payload)
        if key == 'dev.fails' and isinstance(v, (int, float)) and (v < 0 or v != int(v)):
            self.issue('ERROR', name, 'dev-fails', 'dev.fails 要是 ≥ 0 的整数', key, payload)

    RANGES = {
        'el.PF': (-1, 1), 'el.F': (45, 65), 'env.rh': (0, 100), 'env.t': (-40, 125),
        'el.THDu': (0, 100), 'el.THDi': (0, 100), 'dev.rate_24h': (0, 100), 'us.amp': (-20, 120),
    }

    def check_range(self, dev, key, v, payload):
        r = self.RANGES.get(key)
        if r and not (r[0] <= v <= r[1]):
            self.issue('WARN', dev.name, 'range', '%s = %s 超出合理范围 %s–%s（单位 / 小数位 / 寄存器换算对吗？）' % (key, v, r[0], r[1]), key, payload)

    # —— 每隔一段看周期：没来的、断了的 ——
    def tick(self):
        t = now_ms()
        for dev in self.devs.values():
            if dev.first is None:
                if dev.expected and t - self.started > 30000:
                    if dev.kind == 'eg':
                        self.issue('INFO', dev.name, 'absent', '没收到 EG 级信号（sw.cb 分合位 / eg.power 装置电源，§5.4）：子站还没接，可以以后再补', once=True)
                    else:
                        self.issue('ERROR', dev.name, 'absent', '30 s 内一条都没收到（设备名拼对了吗？§3）', once=True)
                continue
            if dev.kind == 'eg':
                continue
            for key, d in keydefs(dev.kind).items():
                p = d.get('periodMs')
                if not p or d['optional']:
                    continue
                last = dev.last_arrive.get(key)
                if last is None:
                    if t - dev.first > 3 * p + 2000:
                        self.issue('WARN' if key == 'uv.pulse' else 'ERROR', dev.name, 'missing', '一直没收到「%s」（%s，%s）%s' % (
                            key, d['label'], PERIOD_NAMES.get(p, '%d ms' % p),
                            '：没放电也要每 2 s 发背景值（§5.1）' if key == 'uv.int' else '：采不到可以不发，但会被标「无效」扣分（§4）'), key, once=True)
                    continue
                gap = t - last
                if gap > max(30000, 5 * p) and key not in dev.stale_flagged:
                    dev.stale_flagged.add(key)
                    self.issue('ERROR', dev.name, 'invalid', '「%s」已 %.0f s 没来（周期 %s）：EG 会标「无效」（§4）' % (key, gap / 1000, PERIOD_NAMES.get(p)), key)
                elif gap > 3 * p and key not in dev.stale_flagged:
                    dev.stale_flagged.add(key)
                    self.issue('WARN', dev.name, 'stale', '「%s」%.0f s 没来（周期 %s，超过 3 个周期）：EG 会标「陈旧」。数值没变也要按周期发（§4）' % (key, gap / 1000, PERIOD_NAMES.get(p)), key)
            if dev.south_seen and len(dev.south_seen) < 5:
                miss = [k for k in SOUTH5 if k not in dev.south_seen]
                if t - dev.first > 130000:
                    self.issue('ERROR', dev.name, 'south', '发了南向统计 dev.*_24h 就要五个一起发（§6），缺 %s' % '、'.join(miss), once=True)
            if t - dev.first > 70000 and 'dev.last_try' not in dev.counts:
                self.issue('INFO', dev.name, 'devstat', '没发 dev.last_try / last_ok / err / fails：建议每个轮询周期发（§6b、§9 第 1 条）；不发 EG 兜底，失败原因只能显示 TIMEOUT', once=True)

    # —— 汇总 ——
    def summary(self, final=False):
        t = now_ms()
        lines = []
        dur = (t - self.started) / 1000
        lines.append('LSA-9600EG 转换程序自检报告（lsa_check %s，点表 %s）' % (VERSION, SPEC.get('generatedFrom')))
        lines.append('')
        lines.append('- 时间：%s，检查了 %.0f s' % (time.strftime('%Y-%m-%d %H:%M:%S'), dur))
        lines.append('- 总线：%s:%d；收到转换程序消息 %d 条%s' % (self.args.host, self.args.port, self.total,
                     '，eg-agent 自己发的 %d 条已略过' % self.agent_msgs if self.agent_msgs else ''))
        lines.append('')
        lines.append('| 设备 | 类型 | 消息数 | key 数 | 平均延迟 | 快档最大间隔 | 属性 | 状态 |')
        lines.append('|---|---|---|---|---|---|---|---|')
        for dev in sorted(self.devs.values(), key=lambda d: d.name):
            errs = sum(v[0] for k, v in self.issues.items() if k[1] == dev.name and k[0] == 'ERROR')
            warns = sum(v[0] for k, v in self.issues.items() if k[1] == dev.name and k[0] == 'WARN')
            if dev.first is None:
                st = '没收到'
            elif errs:
                st = '错误 %d 次' % errs
            elif warns:
                st = '注意 %d 次' % warns
            else:
                st = '正常'
            delay = ('%.2f s' % (sum(dev.delays) / len(dev.delays) / 1000)) if dev.delays else '-'
            fast = [dev.gaps[k] for k, d in keydefs(dev.kind).items() if d.get('periodMs') == 2000 and k in dev.gaps]
            lines.append('| %s | %s | %d | %d | %s | %s | %s | %s |' % (
                dev.name, KIND_NAMES.get(dev.kind, dev.kind), dev.msgs, len(dev.counts), delay,
                ('%.1f s' % (max(fast) / 1000)) if fast else '-', dev.attrs or '-', st))
        lines.append('')
        if self.issues:
            lines.append('| 级别 | 设备 | 问题 | 次数 |')
            lines.append('|---|---|---|---|')
            order = {'ERROR': 0, 'WARN': 1, 'INFO': 2}
            for (lv, dv, _code, _k), (n, msg, _ex) in sorted(self.issues.items(), key=lambda x: (order[x[0][0]], x[0][1] or '')):
                lines.append('| %s | %s | %s | %d |' % (LEVELS[lv], dv or '-', msg.replace('|', '\\|'), n))
        else:
            lines.append('没有发现问题。')
        lines.append('')
        e = sum(v[0] for k, v in self.issues.items() if k[0] == 'ERROR')
        w = sum(v[0] for k, v in self.issues.items() if k[0] == 'WARN')
        verdict = '通过' if not e and self.total else ('没收到数据' if not self.total else '不通过')
        lines.append('结论：**%s**（错误 %d 次、注意 %d 次）' % (verdict, e, w))
        return '\n'.join(lines), e


def now_ms():
    return int(time.time() * 1000)


def run_check(args):
    devices = None
    if args.eg_yaml:
        cab, devices = read_eg_yaml(args.eg_yaml)
        print('设备清单（%s，柜号 %s）：%s' % (args.eg_yaml, cab, '、'.join(n for n, k in devices.items() if k != 'camera')))
    elif args.cab:
        devices = devices_for(args.cab, args.group, args.pm2)
        print('设备清单（%s %s）：%s' % (args.cab, ROOM_NAMES[args.group], '、'.join(devices)))
    else:
        print('没给设备清单（--cab / --eg-yaml）：按设备名前缀自动认设备，不检查「缺哪台」')
    ck = Checker(args, devices)
    deadline = time.time() + args.duration if args.duration else None
    next_tick = time.time() + 5
    next_sum = time.time() + args.every if args.every else None
    cli = None
    try:
        while True:
            if deadline and time.time() >= deadline:
                break
            if cli is None:
                try:
                    cli = Mqtt(args.host, args.port, 'lsa-check-%04x' % random.randrange(65536))
                    cli.connect()
                    # 订阅全部（不含 $SYS）：主题写错的也要看得到
                    cli.subscribe('#', 1, True)
                    ck.subscribed_at = now_ms()
                    print('%s 已连上 %s:%d，等转换程序的消息…（Ctrl+C 结束并出汇总）' % (time.strftime('%H:%M:%S'), args.host, args.port))
                except (OSError, MqttError) as e:
                    print('连不上 %s:%d（%s），3 s 后重试。总线起了吗？见 README「1. 装总线」' % (args.host, args.port, e))
                    cli = None
                    time.sleep(3)
                    continue
            try:
                pkt = cli.read(1.0)
                if pkt:
                    typ, flags, body = pkt
                    if typ == 0x30:
                        topic, qos, retain, pid, props, payload = parse_publish(flags, body)
                        if qos == 1 and pid:
                            cli.puback(pid)
                        ck.on_message(topic, qos, retain, props, payload)
                cli.ping_if_due()
            except (OSError, MqttError) as e:
                print('连接断了（%s），重连…' % e)
                cli = None
                continue
            if time.time() >= next_tick:
                next_tick = time.time() + 5
                ck.tick()
            if next_sum and time.time() >= next_sum:
                next_sum = time.time() + args.every
                print('\n' + ck.summary()[0] + '\n')
    except KeyboardInterrupt:
        pass
    finally:
        if cli:
            cli.close()
    ck.tick()
    text, errors = ck.summary(True)
    print('\n' + text)
    if args.report:
        with open(args.report, 'w', encoding='utf-8') as f:
            f.write('# ' + text + '\n')
        print('\n报告已写到 %s' % os.path.abspath(args.report))
    return 1 if errors or not ck.total else 0


# ───────────────────────── 示范数据 ─────────────────────────


def run_demo(args):
    cab, group = args.cab, args.group
    cli = Mqtt(args.host, args.port, 'lsa-conv-demo-%s' % cab)
    cli.connect()

    def reader():
        try:
            while True:
                if cli.read(1.0) is None:
                    cli.ping_if_due()
        except Exception:
            pass
    threading.Thread(target=reader, daemon=True).start()
    rooms = ROOMS[group]
    sams = ['SAM-%s-%s' % (cab, r) for r in rooms]
    pm, pm6, eg = 'PM-' + cab, 'PM6-' + cab, 'EG-' + cab
    bad = args.bad
    print('往 %s:%d 发 %s 的示范数据（%s）：%s；Ctrl+C 停' % (args.host, args.port, cab, '常见错误' if bad else '正确格式', '、'.join(sams + [pm, pm6, eg])))

    def pub(dev, values, ts=None, qos=1, retain=False, topic=None):
        msg = json.dumps({'ts': ts if ts is not None else now_ms(), 'values': values}, ensure_ascii=False)
        cli.publish(topic or 'lsa/%s/telemetry' % dev, msg, qos=qos, retain=retain)
        if args.verbose:
            print('  → %s %s' % (topic or dev, short(msg, 200)))

    for s in sams:
        cli.publish('lsa/%s/attributes' % s, json.dumps({'fw': 'v2.1.0'}), qos=1)
    cli.publish('lsa/%s/attributes' % pm, json.dumps({'fw': 'v1.0.3'}), qos=1)
    ep = 12345.6
    n = 0
    t0 = time.time()
    try:
        while not args.duration or time.time() - t0 < args.duration:
            ts = now_ms()
            n += 1
            for i, s in enumerate(sams):
                v = {'us.amp': round(random.uniform(8, 16), 1), 'us.cnt': random.randint(0, 6), 'uv.int': random.randint(1, 5)}
                if n % 5 == 1:
                    v.update({'env.t': round(26 + i + random.uniform(-0.3, 0.3), 1), 'env.rh': round(random.uniform(40, 50), 1)})
                v.update({'dev.last_try': ts, 'dev.last_ok': ts, 'dev.err': '', 'dev.fails': 0})
                if bad and i == 0:
                    v['us.amp'] = str(v['us.amp'])          # 数值发成字符串
                    v['ir.t_max'] = 62.1                     # 退役的 key
                    v.pop('uv.int')                          # 不发背景值
                if bad and i == 1:
                    pub(s, v, ts=ts // 1000)                 # ts 用秒
                else:
                    pub(s, v, ts=ts)
            if n % 15 == 7:
                s = sams[-1]
                peak = random.randint(300, 600)
                pv = {'uv.pulse': json.dumps({'peak': peak, 'ms': random.randint(5, 40)})}
                if not bad:
                    pv['uv.int'] = peak
                pub(s, pv, ts=now_ms())
            ia, ib, ic = [round(random.uniform(40, 48), 1) for _ in range(3)]
            ep += 0.05
            mv = {'el.Ua': 5773.5, 'el.Ub': 5770.1, 'el.Uc': 5776.0, 'el.Ia': ia, 'el.Ib': ib, 'el.Ic': ic,
                  'el.P': 760.2, 'el.Q': 210.4, 'el.S': 788.8, 'el.PF': 0.96, 'el.F': 50.01, 'el.Ep': round(ep, 2),
                  'el.THDu': 2.1, 'el.THDi': 6.3,
                  'dev.last_try': ts, 'dev.last_ok': ts, 'dev.err': '', 'dev.fails': 0}
            if bad:
                mv['el.load_pct'] = 61.0                     # eg-agent 算的量
                mv['el.Ep'] = round(ep - (0.5 if n % 3 == 0 else 0), 2)  # 电能倒退
                for k in ('el.Ia', 'el.Ib', 'el.Ic'):        # 一个量一条
                    pub(pm, {k: mv.pop(k)}, ts=ts, qos=0)
            pub(pm, mv, ts=ts)
            if n % 30 == 1:
                h = json.dumps([round(random.uniform(0, 3), 2) for _ in range(30 if not bad else 12)])
                pub(pm, {'el.hu.A': h, 'el.hu.B': h, 'el.hu.C': h, 'el.hi.A': h, 'el.hi.B': h, 'el.hi.C': h}, ts=ts)
            if n % 5 == 1:
                pub(pm6, {'pm.0.3': random.randint(800, 1200), 'pm.0.5': random.randint(300, 500), 'pm.1.0': random.randint(80, 150),
                          'pm.2.5': 12.0, 'pm.5.0': 18.5, 'pm.10': 25.3, 'dev.last_try': ts, 'dev.last_ok': ts, 'dev.err': '', 'dev.fails': 0},
                    ts=ts, retain=bad)
            if n % 30 == 1:
                pub(eg, {'sw.cb': 1 if not bad else 2, 'eg.power': 0}, ts=ts)
            if bad and n % 10 == 3:
                pub(None, {'env.t': 25}, ts=ts, topic='lsa/SAM%s-A/telemetry' % cab)   # 设备名写错
            time.sleep(max(0, 2 - (time.time() - t0) % 2))
    except KeyboardInterrupt:
        pass
    cli.close()
    print('已停，共发 %d 轮' % n)
    return 0


def run_clear(args):
    """订阅 2 s 收集带 retain 的主题，对每个发空的 retain 消息把它清掉。"""
    cli = Mqtt(args.host, args.port, 'lsa-check-clear-%04x' % random.randrange(65536))
    cli.connect()
    cli.subscribe('#', 1, True)
    topics = set()
    end = time.time() + 2
    while time.time() < end:
        pkt = cli.read(0.5)
        if pkt and pkt[0] == 0x30:
            topic, qos, retain, pid, _p, _pl = parse_publish(pkt[1], pkt[2])
            if qos and pid:
                cli.puback(pid)
            if retain:
                topics.add(topic)
    for tp in sorted(topics):
        cli.publish(tp, b'', qos=1, retain=True)
        print('已清 retain：%s' % tp)
    time.sleep(0.5)
    cli.close()
    print('共清 %d 个主题' % len(topics) if topics else '总线上没有 retain 消息')
    return 0


def main():
    global SPEC
    SPEC = load_spec()
    ap = argparse.ArgumentParser(description='LSA-9600EG 转换程序自检（EG 内部 MQTT 格式 v0.4）')
    ap.add_argument('cmd', nargs='?', default='check', choices=['check', 'demo', 'clear-retained'], help='check 检查（缺省）/ demo 发示范数据 / clear-retained 清 retain')
    ap.add_argument('--host', default=os.environ.get('LSA_BUS_HOST', '127.0.0.1'))
    ap.add_argument('--port', type=int, default=int(os.environ.get('LSA_BUS_PORT', '1884')))
    ap.add_argument('--cab', help='柜号，如 AH03（给了就按柜型列出该有的设备）')
    ap.add_argument('--group', default='mv', choices=list(ROOMS), help='柜型：mv 中压开关柜（SAM A/B）/ tr 干式变压器（A/B/C）/ lv 低压柜（A）')
    ap.add_argument('--pm2', action='store_true', help='这面柜有第二块电表 PM2-<柜号>')
    ap.add_argument('--eg-yaml', help='按这台 EG 的 eg.yaml 取设备清单（EG 上 /opt/lsa-eg/config/eg.yaml）')
    ap.add_argument('--duration', type=float, default=0, help='跑多少秒后自动结束（缺省一直跑到 Ctrl+C）')
    ap.add_argument('--every', type=float, default=0, help='每隔多少秒打印一次汇总')
    ap.add_argument('--report', help='结束时把汇总写成 Markdown 文件')
    ap.add_argument('--raw', action='store_true', help='逐条打印收到的消息')
    ap.add_argument('--quiet', action='store_true', help='只实时打印「错误」，注意 / 建议放到汇总里')
    ap.add_argument('--lan', action='store_true', help='检查工具与转换程序不在同一台机器（两边时钟不同步时不报延迟）')
    ap.add_argument('--bad', action='store_true', help='demo：故意发常见错误')
    ap.add_argument('--verbose', action='store_true', help='demo：打印发出的每条')
    args = ap.parse_args()
    if args.cmd == 'demo':
        if not args.cab:
            args.cab = 'AH03'
        return run_demo(args)
    if args.cmd == 'clear-retained':
        return run_clear(args)
    return run_check(args)


if __name__ == '__main__':
    sys.exit(main())
