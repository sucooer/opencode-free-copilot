// VS Code 的模型消息 ↔ OpenAI chat/completions 的消息。
//
// Copilot 的 agent 模式会把工具定义和工具结果都塞进来：assistant 消息里带
// LanguageModelToolCallPart，user 消息里带 LanguageModelToolResultPart。
// 这两样在 OpenAI 协议里分别是 tool_calls 和独立的 role:"tool" 消息，位置不
// 能乱——顺序错了模型会读不明白自己上一轮干了什么。

import * as vscode from 'vscode';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
}

function flattenContent(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    } else if (typeof part === 'string') {
      parts.push(part);
    } else if (part && typeof part === 'object' && typeof (part as any).value === 'string') {
      parts.push((part as any).value);
    }
  }
  return parts.join('');
}

function imageDataUrl(part: vscode.LanguageModelDataPart): string | undefined {
  if (!part.mimeType?.startsWith('image/')) {
    return undefined;
  }
  return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

/** 把一段对话转成上游要的形状。 */
export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const message of messages) {
    const texts: string[] = [];
    const images: string[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    const toolResults: vscode.LanguageModelToolResultPart[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        texts.push(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push(part);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        const url = imageDataUrl(part);
        if (url) {
          images.push(url);
        }
      } else if (typeof part === 'string') {
        texts.push(part);
      }
    }

    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const msg: OpenAIMessage = { role: 'assistant', content: texts.join('') };
      if (toolCalls.length) {
        msg.tool_calls = toolCalls.map((call) => ({
          id: call.callId,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {})
          }
        }));
        // 带工具调用时 content 允许为空串，但有些上游要求 null；空串更稳。
      }
      if (!msg.content && !msg.tool_calls?.length) {
        continue;
      }
      out.push(msg);
      continue;
    }

    // user 侧的 tool result 必须先单独成消息，且顺序在用户文本之前。
    for (const result of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: result.callId,
        content: flattenContent(result.content as readonly unknown[]) || '(no output)'
      });
    }

    if (images.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: texts.join('') || ' ' },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
        ]
      });
    } else if (texts.length) {
      out.push({ role: 'user', content: texts.join('') });
    }
  }
  return out;
}

/** Copilot 传下来的工具定义 → OpenAI function 工具。 */
export function convertTools(tools: readonly vscode.LanguageModelChatTool[]): any[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: (tool.inputSchema as object) ?? { type: 'object', properties: {} }
    }
  }));
}

/** 同一批工具，responses 线要的扁平形状。 */
export function convertFlatTools(tools: readonly vscode.LanguageModelChatTool[]): any[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: (tool.inputSchema as object) ?? { type: 'object', properties: {} }
  }));
}

export interface ResponseInput {
  instructions: string;
  items: any[];
}

/**
 * responses 线的输入不是 messages，而是一串"条目"：普通消息、函数调用、
 * 函数结果各占一条，平铺排列。工具结果必须排在同一轮的文本之前，否则模型
 * 会把它当成上一轮的残留。
 */
export function toResponseInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponseInput {
  const items: any[] = [];
  const instructions: string[] = [];

  for (const message of messages) {
    const texts: string[] = [];
    const images: string[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    const toolResults: vscode.LanguageModelToolResultPart[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        texts.push(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push(part);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        const url = imageDataUrl(part);
        if (url) {
          images.push(url);
        }
      } else if (typeof part === 'string') {
        texts.push(part);
      }
    }

    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      if (texts.join('').trim()) {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text: texts.join('') }] });
      }
      for (const call of toolCalls) {
        items.push({
          type: 'function_call',
          call_id: call.callId,
          name: call.name,
          arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {})
        });
      }
      continue;
    }

    for (const result of toolResults) {
      items.push({
        type: 'function_call_output',
        call_id: result.callId,
        output: flattenContent(result.content as readonly unknown[]) || '(no output)'
      });
    }

    if (texts.join('').trim() || images.length) {
      const content: any[] = [];
      if (texts.join('').trim()) {
        content.push({ type: 'input_text', text: texts.join('') });
      }
      for (const url of images) {
        content.push({ type: 'input_image', image_url: url });
      }
      items.push({ role: 'user', content });
    }
  }

  return { instructions: instructions.join('\n\n'), items };
}

/** 整段对话里第一条用户消息的文本，用来算会话 seed。 */
export function firstUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  for (const message of messages) {
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart && part.value.trim()) {
        return part.value;
      }
    }
  }
  return '';
}

export interface CompletedToolCall {
  id: string;
  name: string;
  args: string;
}

/** 流式拼装 tool_calls（上游是按 index 分片吐的）。 */
export class ToolCallAccumulator {
  private readonly items = new Map<number, CompletedToolCall>();

  push(deltas: any[]): void {
    for (const delta of deltas) {
      const index = typeof delta?.index === 'number' ? delta.index : this.items.size;
      const current = this.items.get(index) ?? { id: '', name: '', args: '' };
      if (typeof delta?.id === 'string' && delta.id) {
        current.id = delta.id;
      }
      const fn = delta?.function;
      if (fn) {
        if (typeof fn.name === 'string' && fn.name) {
          // 多数上游只在首片给完整名字；少数分片发。三种情况都要兼容。
          if (!current.name) {
            current.name = fn.name;
          } else if (fn.name.startsWith(current.name)) {
            current.name = fn.name; // 累积型：后一片包含前一片
          } else if (!current.name.endsWith(fn.name)) {
            current.name += fn.name; // 真分片
          }
        }
        if (typeof fn.arguments === 'string') {
          current.args += fn.arguments;
        }
      }
      this.items.set(index, current);
    }
  }

  finish(): CompletedToolCall[] {
    return [...this.items.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  }
}

/**
 * responses 线的工具调用是按 output_index 组织的事件流：
 * output_item.added 给出 call_id 和名字，后续 arguments.delta 只带增量。
 */
export class ResponsesAccumulator {
  private readonly calls = new Map<number, CompletedToolCall>();

  handle(frame: any): void {
    const type = typeof frame?.type === 'string' ? frame.type : '';
    if (type === 'response.output_item.added') {
      const item = frame.item;
      if (item?.type === 'function_call') {
        const index = typeof frame.output_index === 'number' ? frame.output_index : this.calls.size;
        this.calls.set(index, {
          id: item.call_id || item.id || '',
          name: typeof item.name === 'string' ? item.name : '',
          // 有的上游在这一帧就把完整参数给了
          args: typeof item.arguments === 'string' ? item.arguments : ''
        });
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const index = typeof frame.output_index === 'number' ? frame.output_index : 0;
      const call = this.calls.get(index) ?? { id: '', name: '', args: '' };
      if (typeof frame.delta === 'string') {
        call.args += frame.delta;
      }
      this.calls.set(index, call);
    }
  }

  finish(): CompletedToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.name);
  }
}
