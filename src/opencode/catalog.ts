// 模型目录。
//
// 上游 /zen/v1/models 返回的是**混着付费和免费**的清单，这里只挑免费车道
// （id 里带 free 的，以及两个历史遗留的白名单 id），再叠加一张本地能力表。
//
// 能力表是从 zen-gate 的 internal/lane/catalog.go 抄过来的实测值：上下文和
// 输出上限是对着活的上游一点点顶出来的，不是抄模型卡。

import { gatewayHeaders, sessionForConversation, mintRequestId } from './identity';
import { request, readAll, errorSnippet } from './http';

export type Wire = 'chat' | 'responses' | 'messages' | 'systemone';

export interface ModelSpec {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  reasoning: boolean;
  wire: Wire;
  regionSensitive: boolean;
  blurb?: string;
}

// 名字里不带 free 但确实免费的：官方文档标注为"限时免费"的隐身模型
// （big-pickle）和历史遗留的 union-alpha。
const ALWAYS_FREE = new Set(['union-alpha', 'space-bunny-free', 'big-pickle']);
const FREE_RE = /(?:^|[-_])free(?:$|[-_.])/;

/** 去掉 "(light)" / "(deep)" 这类 effort 后缀，拿回基础 id。 */
export function baseModelId(id: string): string {
  const s = id.trim();
  if (s.length > 1 && s.endsWith(')')) {
    const open = s.lastIndexOf('(');
    if (open > 0) {
      return s.slice(0, open).trim();
    }
  }
  return s;
}

export function isFreeLane(id: string): boolean {
  const base = baseModelId(id);
  return ALWAYS_FREE.has(base) || FREE_RE.test(base);
}

/**
 * 哪些模型走哪条线。当前扩展只实现了 chat/completions，
 * 其余几条线上的模型会被过滤掉（见 hideUnsupported 设置）。
 */
export function wireFor(id: string): Wire {
  const base = baseModelId(id);
  if (/^muse[-_]?spark(?:$|[-_:.\s])/i.test(base) || base.startsWith('muse-spark')) {
    return 'responses';
  }
  if (base === 'union-alpha') {
    return 'messages';
  }
  if (base.startsWith('jev')) {
    return 'systemone';
  }
  return 'chat';
}

interface Capability {
  match: RegExp;
  vision: boolean;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
}

const CAPABILITIES: Capability[] = [
  { match: /^mimo.*v2\.6/, vision: true, contextWindow: 1048576, maxOutput: 131072, reasoning: true },
  { match: /^mimo.*v2\.5/, vision: true, contextWindow: 1048576, maxOutput: 131072, reasoning: true },
  { match: /^mimo/, vision: true, contextWindow: 262144, maxOutput: 131072, reasoning: true },
  { match: /^muse.?spark/, vision: true, contextWindow: 1048576, maxOutput: 943718, reasoning: true },
  { match: /^step/, vision: false, contextWindow: 1000000, maxOutput: 64000, reasoning: true },
  { match: /^nemotron.*super.?vl/, vision: true, contextWindow: 1048576, maxOutput: 262144, reasoning: true },
  { match: /^nemotron/, vision: false, contextWindow: 128000, maxOutput: 32768, reasoning: true },
  { match: /^ling/, vision: false, contextWindow: 262144, maxOutput: 32768, reasoning: true },
  { match: /^space.?bunny/, vision: true, contextWindow: 1048576, maxOutput: 65536, reasoning: true },
  { match: /^union/, vision: true, contextWindow: 262144, maxOutput: 131072, reasoning: false },
  { match: /^deepseek.*v4\.1/, vision: true, contextWindow: 1048576, maxOutput: 262144, reasoning: true },
  { match: /^deepseek/, vision: false, contextWindow: 1048576, maxOutput: 65536, reasoning: true },
  { match: /^ll.?alpha/, vision: true, contextWindow: 1048576, maxOutput: 131072, reasoning: true },
  { match: /^glm/, vision: false, contextWindow: 524288, maxOutput: 262144, reasoning: true },
  { match: /^longcat/, vision: true, contextWindow: 1048576, maxOutput: 262144, reasoning: true },
  { match: /^fledge/, vision: false, contextWindow: 131072, maxOutput: 32768, reasoning: true },
  { match: /^jev/, vision: false, contextWindow: 32768, maxOutput: 4096, reasoning: false }
];

const REGION_SENSITIVE = [/^muse.?spark/, /^beam/];

const DISPLAY_NAMES: Record<string, string> = {
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'mimo-v2.5-free': 'MiMo V2.5',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning',
  'nemotron-3.5-super-vl-free': 'Nemotron 3.5 Super VL',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'space-bunny-free': 'Space Bunny',
  'union-alpha': 'Union Alpha',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
  'deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash',
  'll-alpha-free': 'LL Alpha',
  'glm-5.3-flash-free': 'GLM 5.3 Flash',
  'beam-free': 'Beam',
  'jev-1.13-free': 'Jev 1.13',
  'longcat-2.5-preview-free': 'LongCat 2.5 Preview',
  'fledge-alpha-free': 'Fledge Alpha',
  'big-pickle': 'Big Pickle'
};

const BLURBS: Record<string, string> = {
  'mimo-v2.6-flash-free': '开源权重里智能指数第一，1M 上下文，综合最稳的主力',
  'deepseek-v4.1-flash-free': '1M+ 上下文、256K 输出，长文档与大输出首选',
  'deepseek-v4-flash-free': '首字快、输出快，1M 上下文，追求速度选它',
  'space-bunny-free': '匿名 1M 上下文模型，OpenCode 用量榜常年前列',
  'nemotron-3.5-super-vl-free': 'NVIDIA 多模态，1M 上下文 + 256K 输出',
  'glm-5.3-flash-free': '智谱轻量版，上游偶发 429，可用性波动',
  'ling-3.0-flash-fin-free': '蚂蚁 Ling 3.0 Flash，轻快可靠',
  'longcat-2.5-preview-free': '美团万亿级稀疏 MoE，百万上下文',
  'beam-free': '国内出口会被地区门拦下，需要海外线路',
  'll-alpha-free': '来路不明的免费模型，可试水',
  'fledge-alpha-free': '新上架，社区评价还少',
  'mimo-v2.5-free': '上一代旗舰，已被 V2.6 接替',
  'nemotron-3-ultra-free': 'NVIDIA 开源旗舰，国内直连稳',
  'nemotron-3.5-lightning-free': '轻快版，适合短任务',
  'big-pickle': '隐身模型（stealth），限时免费，供应商未公开'
};

function capabilityFor(base: string): { vision: boolean; contextWindow: number; maxOutput: number; reasoning: boolean } {
  for (const cap of CAPABILITIES) {
    if (cap.match.test(base)) {
      return { vision: cap.vision, contextWindow: cap.contextWindow, maxOutput: cap.maxOutput, reasoning: cap.reasoning };
    }
  }
  // 不知道就什么都不承诺，别在 UI 上编造能力徽章。
  return { vision: false, contextWindow: 131072, maxOutput: 32768, reasoning: false };
}

function displayName(base: string): string {
  const known = DISPLAY_NAMES[base];
  if (known) {
    return known;
  }
  return base
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => (/^[0-9]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** 网络不通时的兜底名单，保证模型选择器不会是空的。 */
export const FALLBACK_IDS = [
  'mimo-v2.6-flash-free',
  'deepseek-v4.1-flash-free',
  'space-bunny-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'll-alpha-free',
  'glm-5.3-flash-free',
  'longcat-2.5-preview-free',
  'beam-free',
  'fledge-alpha-free'
];

export interface CatalogOptions {
  baseUrl: string;
  signal?: AbortSignal;
}

/** 拉上游清单。只取 id，能力信息由本地表补齐。 */
export async function fetchModelIds(opts: CatalogOptions): Promise<string[]> {
  const session = sessionForConversation('catalog:opencode-free-copilot');
  const res = await request({
    method: 'GET',
    path: '/zen/v1/models',
    baseUrl: opts.baseUrl,
    signal: opts.signal,
    idleTimeoutMs: 30000,
    headers: gatewayHeaders(session, false, 'application/json')
  });
  const body = await readAll(res.stream);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`拉取模型列表失败：HTTP ${res.status} — ${errorSnippet(body)}`);
  }
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('模型列表不是合法 JSON');
  }
  const rows: any[] = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === 'string' && row.trim()) {
      ids.push(row.trim());
    } else if (row && typeof row.id === 'string' && row.id.trim()) {
      ids.push(row.id.trim());
    }
  }
  return ids;
}

/** id 列表 → 可用的模型规格，去重、过滤，保持上游顺序。 */
export function buildCatalog(ids: string[], opts: { keepUnsupported: boolean }): ModelSpec[] {
  const seen = new Set<string>();
  const out: ModelSpec[] = [];
  for (const raw of ids) {
    if (!isFreeLane(raw)) {
      continue;
    }
    const base = baseModelId(raw);
    if (seen.has(base)) {
      continue;
    }
    seen.add(base);
    const wire = wireFor(base);
    // 当前实现了 chat 与 responses 两条线；messages / systemone 还没有。
    const supported = wire === 'chat' || wire === 'responses';
    if (!supported && !opts.keepUnsupported) {
      continue;
    }
    const cap = capabilityFor(base);
    out.push({
      id: base,
      name: displayName(base),
      contextWindow: cap.contextWindow,
      maxOutput: cap.maxOutput,
      vision: cap.vision,
      reasoning: cap.reasoning,
      wire,
      regionSensitive: REGION_SENSITIVE.some((re) => re.test(base)),
      blurb: BLURBS[base]
    });
  }
  return out;
}

export function fallbackCatalog(opts: { keepUnsupported: boolean }): ModelSpec[] {
  return buildCatalog(FALLBACK_IDS, opts);
}

export { mintRequestId };
