// 免费车道的身份层。
//
// 这块是从 zen-gate 的 internal/lane/upstream.go 逐行对照移植的：上游不认个人
// API Key，只认「你是不是一个真的 OpenCode 客户端」。所以每一次出站请求都得
// 现造一整套身份：UA、客户端标记、以及一个**必须能被解码**的会话 id。
//
// 移植时特别容易踩的两个坑，写在前面：
//  1) 会话 id 不能是哈希。上游会拆 ses_ 后面的 12 位 hex，还原成
//     ~(ms<<12|seq) 的时间戳，校验它是否"新鲜"。sha256 出来的前缀永远解不
//     出来，只会拿到 403 FreeTierError。
//  2) 会话 id 不能每个请求都新造。额度是按会话计的，每次都换等于每次都是新
//     额度，很快就 429。同一段对话必须复用同一个 id。

import { randomBytes, createHash } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 上游 v2 指纹门期望的 UA。 */
export const CLIENT_UA = 'opencode/latest/2.0.26/cli';

function base62From(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) {
    out += BASE62[b % 62];
  }
  return out;
}

let lastStamp = 0;
let seqCounter = 0;

function timestampPrefix(value: bigint): string {
  const raw = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    raw[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  }
  return raw.toString('hex');
}

/** 造一个上游形状的会话 id：ses_ + 取反时间戳(12 hex) + 14 位 base62。 */
export function mintSessionId(nowMs: number = Date.now()): string {
  const stamp = nowMs > 0 ? nowMs : Date.now();
  if (lastStamp !== stamp) {
    lastStamp = stamp;
    seqCounter = 0;
  }
  seqCounter += 1;
  const packed = (BigInt(stamp) << 12n) | BigInt(seqCounter & 0xfff);
  const value = BigInt.asUintN(64, ~packed);
  return 'ses_' + timestampPrefix(value) + base62From(randomBytes(14));
}

/** 造一个上游形状的单轮请求 id：msg_ + 取反时间戳 + 14 位 base62。 */
export function mintRequestId(nowMs: number = Date.now()): string {
  const stamp = nowMs > 0 ? nowMs : Date.now();
  const packed = (BigInt(stamp) << 12n) | 1n;
  const value = BigInt.asUintN(64, ~packed);
  return 'msg_' + timestampPrefix(value) + base62From(randomBytes(14));
}

const SESSION_REMINT_AFTER = 6 * 24 * 60 * 60 * 1000; // 上游容忍约一周，六天重铸
const SESSION_CACHE_CAP = 4096;

const sessions = new Map<string, { id: string; at: number }>();

/**
 * 一段对话一个会话。seed 用「第一条用户消息」算——同一个对话的第一条消息不
 * 会变，所以 id 稳定；换对话就换 id，额度互不干扰。
 */
export function sessionForConversation(seed: string): string {
  const key = seed.trim() || 'global';
  const now = Date.now();
  const hit = sessions.get(key);
  if (hit && now - hit.at < SESSION_REMINT_AFTER) {
    return hit.id;
  }
  if (sessions.size >= SESSION_CACHE_CAP) {
    sessions.clear();
  }
  const id = mintSessionId();
  sessions.set(key, { id, at: now });
  return id;
}

/** 对话 seed 的稳定摘要，避免把整段提示词当 Map 的 key。 */
export function seedOf(text: string): string {
  return createHash('sha256').update(text.slice(0, 2000)).digest('hex').slice(0, 32);
}

/**
 * 出站头。注意 authorization 是公开的 "Bearer public"——这条车道没有个人凭
 * 证，也不需要。x-opencode-request 故意不发，上游现在会因此拒收。
 */
export function gatewayHeaders(session: string, stream: boolean, accept = ''): Record<string, string> {
  const acc = accept || (stream ? 'text/event-stream' : '*/*');
  return {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-project': 'global',
    accept: acc,
  };
}
