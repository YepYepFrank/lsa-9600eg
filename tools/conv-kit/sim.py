#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Modbus RTU 从站模拟器（转换程序联调用，conv-kit v0.7）：在一个虚拟串口（pty）上模拟转换程序轮询的 5 台 RS485 传感器。
寄存器布局取自转换程序驱动里的「实测报文」注释与 ALS10 协议 V0.1.0。只用 Python 标准库（3.8+），**只能在 Linux 上跑**（要 pty）。

用法：
  python3 sim.py /tmp/ttyV0          # 建虚拟串口，链接到 /tmp/ttyV0，一直跑到 Ctrl+C
  python3 sim.py /tmp/ttyV0 --tev-absent   # 局放装置没装地电波（寄存器 6 读出 187）
然后把转换程序的串口改成 /tmp/ttyV0（9600 8N1），另开窗口跑检查工具：
  python3 lsa_check.py --cab AH03 --duration 260 --report 联调报告.md
模拟器与转换程序要在同一台机器 / 同一个容器里（pty 是本机的）；用容器跑转换程序时，把模拟器也放进那个容器跑。

从站（地址、功能码、寄存器）：
  1  FC03  红外：0x4F 最高 / 0x50 最低 / 0x51 平均（×0.1 ℃）—— 0.18.1 起 SAM 红外恢复（能力 samIr；本项目 SAM 没有自带红外，模拟器照样发，供装了红外的项目自检）：
           发 ir.t_max / ir.t_avg（只显示、上送，温升 / 过温仍以摄像机为准）
  2  FC03  局放（装置说明书、转换程序 pd.py）：超声 0 放电量（×0.1 dBμV）/ 1 次数 / 2 类型 / 3 等级；地电波 6 放电量（×0.1 dBmV）/ 9 等级；
           特高频 10 放电量 / 13 等级。缺省按 S19 的二合一（超声 + 地电波，D5）：地电波 12.3 dBmV 上下、特高频没装读出 269（不要发）；
           --tev-absent：地电波也没装，读出 187（不要发）。0.7.1 以前这里错放在 8 / 12，转换程序读寄存器 6 得 0、发了 tev.amp = 0
  3  FC03  气体：0x16 ppm、0x17 量程 1000（量程不用发）
  4  FC03  温湿度：0 湿度 ×0.1、1 温度 ×0.1（有符号）
  5  FC04  ALS10 弧光：0 设备状态、3 弧光等级、6 峰值；0x100–0x107 最近一次事件（序号、类型、…、峰值 ×0.01 %、…、持续 ms）
  6  FC03  多功能电表（补丁 0007 的占位寄存器表 meter.yaml，高字在前）：0x00–0x19 电压 / 电流 / P Q S / PF / F / THDu THDi（float32，
           二次值：相电压 57.7 V、电流 2.5 A 上下），0x1A 正向有功电能（uint32 ×0.01 kWh，一直往上走）；
           0x100–0x159 电压、0x200–0x259 电流 A/B/C 各 2–31 次谐波含有率（uint16 ×0.01 %）。电表型号定了，这里跟着换表

时间线（从模拟器启动算起，秒）—— 每一段对应检查工具 / EG 该看到的现象：
   0– 40  全部正常
  40      弧光：上电 / 复位事件（类型 3，峰值 0）—— 正确的转换程序只记日志，不发 uv.pulse
  70      弧光：真放电事件（类型 1，峰值 72.35 %，21 ms）—— 发 uv.pulse，同一条 uv.int = 72.35
  90–130  局放（从站 2）不应答 —— 只有局放这台的 dev.fails 往上数、停发局放量；别的传感器不能把它清 0
 100–160  气体 150 ppm
 140–220  温湿度（从站 4）不应答 —— 同上
"""
import os
import sys
import time
import tty

T0 = time.monotonic()
TEV_ABSENT = '--tev-absent' in sys.argv


def el():
    return time.monotonic() - T0


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def log(*a):
    print(f'[sim {el():6.1f}s]', *a, flush=True)


class Arc:
    def __init__(self):
        self.seq = 5
        self.ev = [0] * 8
        self.done = set()

    def tick(self):
        t = el()
        if t >= 40 and 'boot' not in self.done:
            self.done.add('boot')
            self.seq += 1
            # 序号、类型 3 上电、开始运行秒数 0、峰值 0、持续 0、故障快照 0
            self.ev = [self.seq, 3, 0, 0, 0, 0, 0, 0]
            log('弧光事件：类型 3（上电 / 复位），序号', self.seq)
        if t >= 70 and 'arc' not in self.done:
            self.done.add('arc')
            self.seq += 1
            self.ev = [self.seq, 1, 0, 1234, 7235, 0, 21, 0]
            log('弧光事件：类型 1（弧光告警），峰值 72.35 %，21 ms，序号', self.seq)


ARC = Arc()


def f32(v):
    """float32 → 两个字（高字在前）"""
    import struct
    return list(struct.unpack('>HH', struct.pack('>f', v)))


def meter():
    """从站 6：占位寄存器表（与转换程序 config/sensors/meter.yaml 一致）"""
    t = el()
    ia = 2.5 + 0.1 * ((int(t) // 10) % 3)
    r = {}
    for a, v in {0x00: 57.74, 0x02: 57.70, 0x04: 57.80, 0x06: ia, 0x08: 2.4, 0x0A: 2.6, 0x0C: 0.43, 0x0E: 0.12,
                 0x10: 0.45, 0x12: 0.96, 0x14: 50.01, 0x16: 2.1, 0x18: 6.3}.items():
        r[a], r[a + 1] = f32(v)
    ep = 123456 + int(t * 2)                              # ×0.01 kWh，单调往上
    r[0x1A], r[0x1B] = (ep >> 16) & 0xFFFF, ep & 0xFFFF
    for i in range(90):
        r[0x100 + i] = 100 + (i % 30) * 3                 # 电压谐波 1.00–1.87 %
        r[0x200 + i] = 300 + (i % 30) * 5                 # 电流谐波 3.00–4.45 %
    return r


def regs(slave: int, fc: int):
    """返回 {地址: 值}；None = 不应答"""
    t = el()
    if slave == 1 and fc == 3:  # 红外：0x4F 最高 / 0x50 最低 / 0x51 平均（×0.1 ℃）
        return {0x4F: 291 + int(t) % 5, 0x50: 265, 0x51: 277}
    if slave == 2 and fc == 3:  # 局放：超声 0–3；地电波 6 放电量 / 9 等级；特高频 10 / 13（没装：187 / 269）
        if 90 <= t < 130:
            return None
        tev = 187 if TEV_ABSENT else 120 + int(t) % 7
        return {0: 258, 1: 4, 2: 1, 3: 0, 6: tev, 9: 0, 10: 269, 13: 0}
    if slave == 3 and fc == 3:  # 气体：0x16 ppm、0x17 量程 1000
        return {0x16: 150 if 100 <= t < 160 else 6, 0x17: 1000}
    if slave == 4 and fc == 3:  # 温湿度：0 湿度 ×0.1、1 温度 ×0.1（有符号）
        if 140 <= t < 220:
            return None
        return {0: 349, 1: 270}
    if slave == 5 and fc == 4:  # ALS10：0 设备状态（READY|MEASURING）、3 弧光等级、6 峰值；0x100–0x107 最近一次事件
        ARC.tick()
        r = {0: 0x0003, 1: 0, 2: 0, 3: 3, 4: 0, 5: 0, 6: 12}
        for i, v in enumerate(ARC.ev):
            r[0x100 + i] = v
        return r
    if slave == 6 and fc == 3:  # 多功能电表（补丁 0007 占位寄存器表）
        return meter()
    return None


def main():
    link = sys.argv[1]
    master, slave_fd = os.openpty()
    tty.setraw(master)
    tty.setraw(slave_fd)
    name = os.ttyname(slave_fd)
    if os.path.lexists(link):
        os.unlink(link)
    os.symlink(name, link)
    log('pty', name, '→', link)
    buf = b''
    while True:
        chunk = os.read(master, 256)
        buf += chunk
        while len(buf) >= 8:
            frame, buf = buf[:8], buf[8:]
            if crc16(frame[:6]) != int.from_bytes(frame[6:8], 'little'):
                log('CRC 错，丢弃', frame.hex())
                buf = b''
                break
            sid, fc = frame[0], frame[1]
            addr = int.from_bytes(frame[2:4], 'big')
            cnt = int.from_bytes(frame[4:6], 'big')
            r = regs(sid, fc)
            if r is None:
                continue  # 不应答
            data = b''.join(int(r.get(addr + i, 0) & 0xFFFF).to_bytes(2, 'big') for i in range(cnt))
            body = bytes([sid, fc, len(data)]) + data
            os.write(master, body + crc16(body).to_bytes(2, 'little'))


if __name__ == '__main__':
    main()
