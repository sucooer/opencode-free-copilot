// Copilot 的模型供给方。
//
// 一次请求的完整链路：
//   1. 把 Copilot 传来的消息/工具翻成上游要的形状（chat 或 responses）
//   2. 补齐指纹门要的东西（read/shell 工具 + 出站头）——**没有工具也要补**
//   3. 给这段对话派生一个稳定的会话 id（额度按会话计）
//   4. POST 出去，边收边吐
//   5. 把工具调用还原成调用方原本的名字，交回给 Copilot 执行

import * as vscode from 'vscode';
import { buildCatalog, fallbackCatalog, fetchModelIds, wireFor, type ModelSpec } from './opencode/catalog';
import { applyFingerprint, restoreToolName, type WireStyle } from './opencode/fingerprint';
import { gatewayHeaders, seedOf, sessionForConversation } from './opencode/identity';
import { errorSnippet, readAll, request, sseData } from './opencode/http';
import {
  convertFlatTools,
  convertMessages,
  convertTools,
  firstUserText,
  ResponsesAccumulator,
  toResponseInput,
  ToolCallAccumulator,
  type CompletedToolCall
} from './opencode/openai';

const CATALOG_TTL = 10 * 60 * 1000;
const DEFAULT_BASE_URL = 'https://opencode.ai';
const CHAT_PATH = '/inference/v1/chat/completions';
const RESPONSES_PATH = '/inference/v1/responses';

/** 一轮最多试几个模型：请求的那个 + 两个接盘的。 */
const FAILOVER_MAX_MODELS = 3;

/** 一次尝试的结果。'retry' 表示还没吐过内容，换模型是安全的。 */
type TurnOutcome = { kind: 'ok' } | { kind: 'wrong-wire' } | { kind: 'retry'; error: Error };

function settings() {
  const cfg = vscode.workspace.getConfiguration('opencode-free');
  return {
    baseUrl: (cfg.get<string>('baseUrl') || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
    hideUnsupported: cfg.get<boolean>('hideUnsupported') ?? true
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 当前版本能跑的线路。messages / systemone 还没实现。 */
function isSupported(wire: string): boolean {
  return wire === 'chat' || wire === 'responses';
}

export class OpenCodeProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  private specs: ModelSpec[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | undefined;
  /** 上游实测出来的线路覆盖：硬编码的 wire 表猜错了就靠这个纠正。 */
  private readonly wireOverrides = new Map<string, 'chat' | 'responses'>();

  constructor(private readonly log: vscode.OutputChannel) {}

  /** 供命令调用：强制重拉。 */
  async refresh(showFeedback: boolean): Promise<void> {
    this.fetchedAt = 0;
    await this.ensureCatalog(false);
    this.changeEmitter.fire();
    if (showFeedback) {
      void vscode.window.showInformationMessage(`OpenCode Free：已加载 ${this.specs.length} 个免费模型`);
    }
  }

  private async ensureCatalog(silent: boolean, token?: vscode.CancellationToken): Promise<void> {
    const stale = Date.now() - this.fetchedAt > CATALOG_TTL;
    if (this.specs.length && !stale) {
      return;
    }
    if (silent && !this.specs.length) {
      // 静默查询发生在 VS Code 启动/刷新 UI 时，不能卡在网络上：
      // 先给内置名单，真正的清单在后台拉，拉完再通知一次。
      this.specs = fallbackCatalog({ keepUnsupported: !settings().hideUnsupported });
      this.fetchedAt = Date.now() - CATALOG_TTL + 5000;
      void this.load(true);
      return;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.load(silent, token).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(silent: boolean, token?: vscode.CancellationToken): Promise<void> {
    const cfg = settings();
    const controller = new AbortController();
    token?.onCancellationRequested(() => controller.abort());
    try {
      const ids = await fetchModelIds({ baseUrl: cfg.baseUrl, signal: controller.signal });
      const specs = buildCatalog(ids, { keepUnsupported: !cfg.hideUnsupported });
      if (!specs.length) {
        throw new Error('上游清单里没有可用的免费模型');
      }
      this.specs = specs;
      this.fetchedAt = Date.now();
      this.log.appendLine(`[catalog] ${new Date().toLocaleTimeString()} 拉取成功，${specs.length} 个免费模型`);
      this.changeEmitter.fire();
    } catch (err) {
      this.log.appendLine(`[catalog] 拉取失败：${messageOf(err)}`);
      if (!this.specs.length) {
        // 冷启动失败也要给个名单，否则模型选择器是空的，用户以为插件坏了。
        this.specs = fallbackCatalog({ keepUnsupported: !cfg.hideUnsupported });
        this.fetchedAt = Date.now() - CATALOG_TTL + 60_000; // 一分钟后允许重试
      }
      if (!silent) {
        void vscode.window.showWarningMessage(
          `OpenCode Free：拉取模型列表失败（${messageOf(err)}）。已先用内置名单，稍后会自动重试。`
        );
      }
    }
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    await this.ensureCatalog(options.silent, token);
    return this.specs.map((spec) => {
      const details: string[] = [`id: ${spec.id}`];
      if (spec.blurb) {
        details.push(spec.blurb);
      }
      details.push(`上下文 ${Math.round(spec.contextWindow / 1000)}K · 输出上限 ${Math.round(spec.maxOutput / 1000)}K`);
      details.push(`线路：${spec.wire}`);
      if (spec.vision) {
        details.push('支持图片输入');
      }
      if (spec.regionSensitive) {
        details.push('国内出口可能被地区限制');
      }
      if (!isSupported(spec.wire)) {
        details.push('该线路尚未实现，无法使用');
      }
      return {
        id: spec.id,
        name: spec.name,
        family: 'opencode-free',
        version: '1.0.0',
        detail: spec.id,
        tooltip: details.join('\n'),
        maxInputTokens: Math.max(4096, spec.contextWindow - spec.maxOutput),
        maxOutputTokens: Math.max(1024, Math.min(spec.maxOutput, 262144)),
        capabilities: { imageInput: spec.vision, toolCalling: isSupported(spec.wire) }
      } satisfies vscode.LanguageModelChatInformation;
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const cfg = settings();
    // 会话按"对话"算，与模型无关：换模型接手时上游看到的仍是同一段对话。
    const sessionId = sessionForConversation(seedOf(firstUserText(messages) || 'opencode-free'));

    const candidates = this.failoverCandidates(model.id, messages);
    let lastFailure: Error | undefined;

    for (const candidateId of candidates) {
      // 线路不是我们能拍板的：上游按模型分配，猜错会回 400 "Model does not
      // support this protocol"。先按本地表猜，被拒就换另一条线，通了就记住。
      const primary = this.wireOverrides.get(candidateId) ?? wireFor(candidateId);
      const order: Array<'chat' | 'responses'> =
        primary === 'responses' ? ['responses', 'chat'] : ['chat', 'responses'];

      for (const wire of order) {
        const outcome = await this.runTurn(wire, candidateId, messages, options, progress, token, cfg.baseUrl, sessionId);
        if (outcome.kind === 'ok') {
          if (wire !== primary) {
            this.wireOverrides.set(candidateId, wire);
            this.log.appendLine(`[wire] ${candidateId} 实测走 ${wire}，已记住`);
          }
          if (candidateId !== model.id) {
            this.log.appendLine(`[failover] ${model.id} 不可用，本轮由 ${candidateId} 接手`);
            void vscode.window.setStatusBarMessage(
              `OpenCode Free：${model.id} 被限流，本轮改用 ${candidateId}`,
              8000
            );
          }
          return;
        }
        if (outcome.kind === 'wrong-wire') {
          continue; // 这条线不对，试下一条
        }
        // 限流或上游 5xx：这个模型这轮指望不上了，换下一个候选。
        lastFailure = outcome.error;
        this.log.appendLine(`[failover] ${candidateId}/${wire} 失败：${outcome.error.message.split('\n')[0]}`);
        break;
      }
    }

    throw lastFailure ?? new Error(`没有可用的免费模型（尝试过：${candidates.join(', ')}）`);
  }

  /**
   * 候选顺序：请求的那个排第一，后面是能接住它的免费模型。
   *
   * 429 多半是瞬时拥挤（实测最短 0.6 秒就恢复），换个模型往往立刻能用；
   * 但**流一旦开始吐字就不能换**，所以只有"还没收到任何内容"时才会走到这里。
   */
  private failoverCandidates(
    requested: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[]
  ): string[] {
    const needsVision = messages.some((message) =>
      message.content.some(
        (part) => part instanceof vscode.LanguageModelDataPart && part.mimeType?.startsWith('image/')
      )
    );
    const candidates = [requested];
    for (const spec of this.specs) {
      if (candidates.length >= FAILOVER_MAX_MODELS) {
        break;
      }
      if (spec.id === requested) {
        continue;
      }
      const wire = this.wireOverrides.get(spec.id) ?? spec.wire;
      if (!isSupported(wire)) {
        continue; // messages / systemone 顶不上
      }
      if (spec.regionSensitive) {
        continue; // 换过去也是地区拒绝，白等
      }
      if (needsVision && !spec.vision) {
        continue; // 这轮带图，接手的必须也能看图
      }
      candidates.push(spec.id);
    }
    return candidates;
  }

  /** 跑一次完整请求，把结果分成"成功 / 线路不对 / 值得换模型重试"三类。 */
  private async runTurn(
    wire: 'chat' | 'responses',
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    baseUrl: string,
    sessionId: string
  ): Promise<TurnOutcome> {
    const style: WireStyle = wire === 'responses' ? 'flat' : 'chat';
    // 上限按"这次实际用的模型"算：换到输出上限更小的模型时，
    // 沿用原来那个 max_tokens 会被上游 400 掉。
    const spec = this.specs.find((s) => s.id === modelId);
    const requestedMax = (options.modelOptions as any)?.max_tokens;
    const cap = spec?.maxOutput ?? 8192;
    const maxTokens =
      typeof requestedMax === 'number' && requestedMax > 0 ? Math.min(requestedMax, cap) : Math.min(cap, 16384);

    const body = this.buildBody(wire, modelId, messages, options, maxTokens);
    if (!body) {
      throw new Error('没有可发送的消息内容');
    }

    // 指纹门每次都要过——**即使不给任何工具**，上游也要求 tools 里带着它的
    // read / shell。少了就 403，这一点实测过。
    const fingerprint = applyFingerprint(body, style);

    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());

    try {
      const res = await request({
        method: 'POST',
        path: wire === 'responses' ? RESPONSES_PATH : CHAT_PATH,
        baseUrl,
        headers: gatewayHeaders(sessionId, true),
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (res.status < 200 || res.status >= 300) {
        const text = await readAll(res.stream);
        if (res.status === 400 && /does not support this protocol/i.test(text)) {
          this.log.appendLine(`[wire] ${modelId} 不走 ${wire}：${errorSnippet(text)}`);
          return { kind: 'wrong-wire' };
        }
        const error = this.describeFailure(res.status, text);
        // 429 和 5xx 还没吐过任何内容，换一个模型是安全的；其余直接抛。
        if (res.status === 429 || res.status >= 500) {
          return { kind: 'retry', error };
        }
        throw error;
      }

      const calls =
        wire === 'responses'
          ? await this.consumeResponses(res.stream, progress, token)
          : await this.consumeChat(res.stream, progress, token);

      this.emitToolCalls(calls, fingerprint, progress);
      return { kind: 'ok' };
    } finally {
      cancelSub.dispose();
    }
  }

  private buildBody(
    wire: string,
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    maxTokens: number
  ): any | undefined {
    if (wire === 'responses') {
      const { instructions, items } = toResponseInput(messages);
      if (!items.length) {
        return undefined;
      }
      const body: any = { model: modelId, stream: true, store: false, max_output_tokens: maxTokens, input: items };
      if (instructions.trim()) {
        body.instructions = instructions;
      }
      if (options.tools?.length) {
        body.tools = convertFlatTools(options.tools);
      }
      if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        body.tool_choice = 'required';
      } else {
        // responses 线显式给 auto；上游把 "none" 当拒绝。
        body.tool_choice = 'auto';
      }
      return body;
    }

    const converted = convertMessages(messages);
    if (!converted.length) {
      return undefined;
    }
    const body: any = {
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
      messages: converted,
      max_tokens: maxTokens
    };
    if (options.tools?.length) {
      body.tools = convertTools(options.tools);
      if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        body.tool_choice = 'required';
      }
    }
    return body;
  }

  /** chat/completions 的 SSE：choices[0].delta 里带正文和工具调用增量。 */
  private async consumeChat(
    stream: NodeJS.ReadableStream,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<CompletedToolCall[]> {
    const accumulator = new ToolCallAccumulator();
    let emitted = false;
    let finishReason = '';

    for await (const payload of sseData(stream)) {
      if (token.isCancellationRequested) {
        break;
      }
      if (payload === '[DONE]') {
        break;
      }
      let frame: any;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue;
      }
      if (frame?.error) {
        throw new Error(`上游返回错误：${errorSnippet(JSON.stringify(frame.error))}`);
      }
      const choice = frame?.choices?.[0];
      if (!choice) {
        continue;
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      const delta = choice.delta;
      if (!delta) {
        continue;
      }
      if (typeof delta.content === 'string' && delta.content) {
        progress.report(new vscode.LanguageModelTextPart(delta.content));
        emitted = true;
      }
      if (Array.isArray(delta.tool_calls)) {
        accumulator.push(delta.tool_calls);
      }
    }

    const calls = accumulator.finish();
    if (!emitted && !calls.length && !token.isCancellationRequested && finishReason !== 'stop') {
      throw new Error('上游返回了空响应（没有正文也没有工具调用），稍后再试一次。');
    }
    return calls;
  }

  /** responses 线的事件流：正文走 output_text.delta，工具调用走 output_item。 */
  private async consumeResponses(
    stream: NodeJS.ReadableStream,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<CompletedToolCall[]> {
    const accumulator = new ResponsesAccumulator();
    let emitted = false;
    let terminal = '';

    for await (const payload of sseData(stream)) {
      if (token.isCancellationRequested) {
        break;
      }
      if (payload === '[DONE]') {
        break;
      }
      let frame: any;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue;
      }
      const type = typeof frame?.type === 'string' ? frame.type : '';

      if (type === 'error' || (frame?.error && !type)) {
        throw new Error(`上游返回错误：${errorSnippet(JSON.stringify(frame.error ?? frame))}`);
      }
      if (type === 'response.failed') {
        const message = frame?.response?.error?.message ?? '上游标记本轮失败';
        throw new Error(`上游返回错误：${message}`);
      }
      if (type === 'response.output_text.delta' && typeof frame.delta === 'string' && frame.delta) {
        progress.report(new vscode.LanguageModelTextPart(frame.delta));
        emitted = true;
        continue;
      }
      if (type === 'response.completed' || type === 'response.done') {
        terminal = 'stop';
        continue;
      }
      if (type === 'response.incomplete') {
        terminal = frame?.response?.incomplete_details?.reason ?? 'stop';
        continue;
      }
      accumulator.handle(frame);
    }

    const calls = accumulator.finish();
    if (!emitted && !calls.length && !token.isCancellationRequested && terminal !== 'stop') {
      throw new Error('上游返回了空响应（没有正文也没有工具调用），稍后再试一次。');
    }
    return calls;
  }

  private emitToolCalls(
    calls: CompletedToolCall[],
    fingerprint: { renames: Record<string, string>; appended: string[] },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    let index = 0;
    for (const call of calls) {
      if (!call.name) {
        continue;
      }
      if (fingerprint.appended.includes(call.name)) {
        // 模型去调了指纹占位工具。这两个工具在 VS Code 这边不存在，
        // 报回去只会换来一个"工具不存在"的报错，直接丢掉。
        this.log.appendLine(`[turn] 丢弃对占位工具 ${call.name} 的调用`);
        continue;
      }
      let input: object = {};
      const raw = call.args.trim();
      if (raw) {
        try {
          input = JSON.parse(raw);
        } catch {
          this.log.appendLine(`[turn] 工具参数不是合法 JSON，已按空对象处理：${raw.slice(0, 200)}`);
        }
      }
      progress.report(
        new vscode.LanguageModelToolCallPart(
          call.id || `call_${Date.now()}_${index++}`,
          restoreToolName(call.name, fingerprint.renames),
          input
        )
      );
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const raw = typeof text === 'string' ? text : JSON.stringify(text);
    // 粗略估计即可：Copilot 只用它做上下文裁剪，不需要精确分词。
    return Math.ceil(raw.length / 3.5);
  }

  private describeFailure(status: number, body: string): Error {
    const snippet = errorSnippet(body);
    if (status === 403 && /free.?tier/i.test(body)) {
      return new Error(
        `上游拒绝了免费车道（403 FreeTierError）。两个常见原因：\n` +
          `① 出口 IP 被判定为机房/VPN —— 实测同一请求从家宽直连 200，换机房出口立刻 403；\n` +
          `   系统里开着代理或 VPN（含 TUN 模式）时，先关掉再试；\n` +
          `② 上游改了客户端校验（UA 或 read/shell 的工具定义）。\n` +
          `原始信息：${snippet}`
      );
    }
    if (status === 403 && /region/i.test(body)) {
      return new Error(
        `该模型不对当前出口地区开放（403）：${snippet}。换个模型；要换出口的话得用家宽性质的海外节点，` +
          `机房/公共 VPN 的 IP 会被免费车道整体拒绝。`
      );
    }
    if (status === 401 || status === 403) {
      return new Error(`上游拒绝访问（HTTP ${status}）：${snippet}`);
    }
    if (status === 429) {
      return new Error(`免费额度用尽或触发限流（429），换个模型或稍后再试：${snippet}`);
    }
    if (status >= 500) {
      return new Error(`上游服务异常（HTTP ${status}）：${snippet}`);
    }
    return new Error(`上游返回 HTTP ${status}：${snippet}`);
  }
}
