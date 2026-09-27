// 与子站播放器一致的流接口；监测接口落实后由数据适配层提供地址。
export interface StreamSrc { whep: string; hls?: string }
export interface DualStreams { vis: StreamSrc | null; ir: StreamSrc | null }
