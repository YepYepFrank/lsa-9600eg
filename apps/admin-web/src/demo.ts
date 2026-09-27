/** 只供开发预览的内存数据，不访问采集设备、子站或真实管理接口。 */
export function demoApi(path: string, method: string): unknown {
  if (method !== 'GET') throw new Error('演示模式不执行设备操作')
  const now = Date.now()
  switch (path) {
    case 'status':
      return {
        eg: 'EG-AH03（演示）', cabinet: { code: 'AH03', name: '1#出线柜' },
        station: { label: '本地界面预览' }, uptimeSec: 14760, rssMb: 86,
        state: 'online', bus: { url: '模拟本机总线', connected: true, msgs: 125680 },
        devices: [
          { name: 'SAM-AH03', kind: 'sam', label: '柜内 SAM', keys: 18 },
          { name: 'METER-AH03', kind: 'meter', label: '多功能电力仪表', keys: 24 },
          { name: 'CAM-AH03', kind: 'camera', label: '双光摄像头', keys: 6 },
        ].map(d => ({ ...d, msgs: 3600, lastTs: now - 1000, ageSec: 1, dead: false, q: {}, south: { req: 3600, timeout: 0, rate: 100 } })),
        unknownDevices: [],
      }
    case 'components':
      return [
        { key: 'agent', label: 'eg-agent（演示）', state: 'running', memMb: 86, cpuPct: 1.2, restartable: false },
        { key: 'mqtt', label: 'MQTT（演示）', state: 'running', memMb: 12, cpuPct: 0.3, restartable: false },
        { key: 'edge', label: 'TB Edge（未接入）', state: '不存在', memMb: null, cpuPct: null, restartable: false },
      ]
    case 'diag':
      return {
        uplink: { state: 'unknown', text: '未连接子站 · 本地演示' }, edge: {},
        sp: { host: '未配置', latMs: null, lossPct: null },
        clock: { server: '未检测', offsetMs: null },
      }
    default:
      throw new Error(`演示模式不支持此接口：${path}`)
  }
}
