"""补丁 H 的直接检验：局放没装的通道在 q 里标 absent；同一设备几路传感器的 q 取并集（弧光的 "{}" 不再冲掉局放的标记）。
   docker run --rm --network none -v <工作目录>:/ct -e PYTHONPATH=/ct/deps:/ct/app python:3.12-slim python3 /ct/test_h.py
   prep.sh 准备的工作目录（打了补丁的 app/）；--no-patch 的对照版应该失败（没有 q、q 被覆盖）。"""
import asyncio
import json
import sys

sys.argv = ['x']
from src.core.app import Application  # noqa: E402
from src.drivers.pd import PartialDischargeDriver  # noqa: E402

fails = 0


def check(ok, msg):
    global fails
    print(('✓ ' if ok else '✗ ') + msg)
    if not ok:
        fails += 1


def raw(tev, uhf):
    return {'us_amp_raw': 258, 'us_cnt_raw': 4, 'us_type_raw': 1, 'us_level_raw': 0,
            'tev_amp_raw': tev, 'tev_cnt_raw': 0, 'tev_type_raw': 0, 'tev_level_raw': 0,
            'uhf_amp_raw': uhf, 'uhf_cnt_raw': 0, 'uhf_type_raw': 0, 'uhf_level_raw': 0}


async def main():
    pd = PartialDischargeDriver(None, {'name': 'partial_discharge', 'slave_id': 2, 'device': 'SAM-AH01-B', 'enabled': True})

    # 1. S19 的二合一（超声 + 地电波）：特高频没装
    r = pd.parse(raw(123, 269))
    q = json.loads(r.get('q', 'null') or 'null')
    check(r.get('tev.amp') == 12.3 and 'uhf.amp' not in r and q == {'uhf.amp': 'absent', 'uhf.level': 'absent'},
          '地电波装了、特高频没装（269）：发 tev.amp 12.3、不发 uhf.*，q = %s' % r.get('q'))

    # 2. 现场 AH01-B：地电波也没装（寄存器 6 = 187）
    r = pd.parse(raw(187, 269))
    q = json.loads(r.get('q', 'null') or 'null')
    check('tev.amp' not in r and q == {'tev.amp': 'absent', 'tev.level': 'absent', 'uhf.amp': 'absent', 'uhf.level': 'absent'},
          '地电波读出 187：不发 tev.*，q 标 tev.amp / tev.level absent（%s）' % r.get('q'))

    # 3. 都装了：q 是 "{}"（原来标过的跟着清掉）
    r = pd.parse(raw(123, 300))
    check(r.get('q') == '{}' and r.get('uhf.amp') == 30.0, '三路都装了：q = "{}"（%s）' % r.get('q'))

    # 4. 同一设备几路的 q 取并集：弧光每 2 s 一条 "{}" 不冲掉局放的 absent
    app = Application.__new__(Application)
    app._device_buffer = {}
    app._device_buffer_lock = asyncio.Lock()
    app._sensor_q = {}
    dev = 'SAM-AH01-B'
    await app._buffer_device_data(dev, 1, {'us.amp': 25.8, 'q': json.dumps({'tev.amp': 'absent', 'tev.level': 'absent'})}, 'partial_discharge')
    await app._buffer_device_data(dev, 1, {'uv.int': 0.3, 'q': '{}'}, 'arc_light')
    q1 = json.loads(app._device_buffer[dev]['values']['q'])
    check(q1 == {'tev.amp': 'absent', 'tev.level': 'absent'}, '同一轮里局放 absent + 弧光 "{}"：发出去的 q = %s' % q1)
    app._device_buffer.clear()
    await app._buffer_device_data(dev, 2, {'uv.int': 0.2, 'q': json.dumps({'uv.int': 'warmup'})}, 'arc_light')
    q2 = json.loads(app._device_buffer[dev]['values']['q'])
    check(q2 == {'tev.amp': 'absent', 'tev.level': 'absent', 'uv.int': 'warmup'}, '下一轮只有弧光（warmup）：局放的 absent 还在（%s）' % q2)
    app._device_buffer.clear()
    await app._buffer_device_data(dev, 3, {'us.amp': 25.8, 'tev.amp': 12.3, 'q': '{}'}, 'partial_discharge')
    q3 = json.loads(app._device_buffer[dev]['values']['q'])
    check(q3 == {'uv.int': 'warmup'}, '局放装好以后报 "{}"：只剩弧光自己的标记（%s）' % q3)
    other = {'env.t': 25.1}
    await app._buffer_device_data('SAM-AH01-A', 3, other, 'temperature_humidity')
    check('q' not in app._device_buffer['SAM-AH01-A']['values'], '没发 q 的传感器不凭空加 q')
    src = {'us.amp': 1.0, 'q': '{"tev.amp": "absent"}'}
    await app._buffer_device_data(dev, 4, src, 'partial_discharge')
    check(src['q'] == '{"tev.amp": "absent"}', '不改传进来的那份（缓存里存的还是这一路自己的 q）')

    # 5. 每一路的 q 有自己的新鲜窗口：局放（3 s 一轮 → 60 s）停了以后，弧光再怎么发也不给它续命
    import src.core.app as appmod
    clock = [1000.0]
    appmod.time.monotonic = lambda: clock[0]
    app2 = Application.__new__(Application)
    app2._device_buffer = {}
    app2._device_buffer_lock = asyncio.Lock()
    app2._sensor_q = {}

    class Drv:
        def __init__(self, interval, priority):
            self.poll_interval = interval
            self.priority = priority
    app2._drivers = {'partial_discharge': Drv(3, 'fast'), 'arc_light': Drv(0, 'fast')}
    check(app2._q_ttl('partial_discharge') == 60 and app2._q_ttl('arc_light') == 60 and app2._q_ttl('没配的') == 100,
          '新鲜窗口同 EG：max(30, 5 × 周期) × 2 —— 局放 3 s / 弧光 fast 2 s → 60 s，没配的按 slow 10 s → 100 s')
    await app2._buffer_device_data(dev, 1, {'us.amp': 1.0, 'q': json.dumps({'tev.amp': 'absent'})}, 'partial_discharge')
    for i in range(20):  # 局放不再报（转换程序这一路挂了），弧光每 2 s 一条，共 40 s
        clock[0] += 2
        app2._device_buffer.clear()
        await app2._buffer_device_data(dev, 2 + i, {'uv.int': 0.1, 'q': '{}'}, 'arc_light')
    q40 = json.loads(app2._device_buffer[dev]['values']['q'])
    check(q40 == {'tev.amp': 'absent'}, '局放停了 40 s（窗口 60 s 内）：absent 还在（%s）' % q40)
    for i in range(12):  # 再 24 s，局放那一路已经 64 s 没报
        clock[0] += 2
        app2._device_buffer.clear()
        await app2._buffer_device_data(dev, 30 + i, {'uv.int': 0.1, 'q': '{}'}, 'arc_light')
    q64 = json.loads(app2._device_buffer[dev]['values']['q'])
    check(q64 == {} and 'partial_discharge' not in app2._sensor_q[dev], '局放 64 s 没报（过了 60 s 窗口）：它的 absent 作废、记录删掉，弧光的发送不给它续命（%s）' % q64)

    sys.exit(1 if fails else 0)


asyncio.run(main())
