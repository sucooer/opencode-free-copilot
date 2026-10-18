// 出站 HTTP。
//
// 直连上游，不做代理转发。
//
// 为什么不提供代理设置：免费车道会按出口 IP 的「性质」放行，机房/公共 VPN 的 IP
// 会被整体拒绝（实测：同一请求从家宽直连 200，换美国/英国/西班牙机房出口一律
// 403 FreeTierError）。与其提供一个大概率让事情变糟的开关，不如不给。

import * as https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { URL } from 'node:url';

export interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
}

/** 发一个请求，拿到流式响应体。非 2xx 也照常返回，由调用方决定怎么报错。 */
export async function request(opts: RequestOptions): Promise<RawResponse> {
  const base = new URL(opts.baseUrl || 'https://opencode.ai');
  const host = base.hostname;
  const port = Number(base.port || (base.protocol === 'http:' ? 80 : 443));
  const path = opts.path.startsWith('/') ? opts.path : '/' + opts.path;

  return new Promise<RawResponse>((resolve, reject) => {
    const req = https.request({ host, port, path, method: opts.method, headers: opts.headers }, (res) =>
      resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res })
    );
    req.on('error', reject);
    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy(new Error('已取消'));
      } else {
        opts.signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
      }
    }
    // 空闲超时而不是总时长：流式回答本来就可能很长，但卡住不动要能自己断。
    req.setTimeout(opts.idleTimeoutMs ?? 300000, () => req.destroy(new Error('上游长时间无响应')));
    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

/** 把响应体整个读完（错误页、模型列表都用得上）。 */
export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk as Buffer);
    chunks.push(buf);
    total += buf.length;
    if (total > 4 * 1024 * 1024) {
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 逐行吐 SSE 的 data 负载。 */
export async function* sseData(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.from(chunk as Buffer).toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload) {
        yield payload;
      }
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim();
    if (payload) {
      yield payload;
    }
  }
}

/** 把上游错误体压成一行，用来提示用户。 */
export function errorSnippet(body: string): string {
  const text = (body || '').trim();
  if (!text) {
    return '(空响应)';
  }
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === 'string' && message.trim()) {
      return message.trim().slice(0, 300);
    }
  } catch {
    /* 不是 JSON，按原文截断 */
  }
  return text.slice(0, 300);
}
