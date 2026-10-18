// 指纹门。
//
// 这是整套东西里最"脏"的一块：上游要求请求体的 tools 里必须声明它自己的
// read / shell 两个工具，而且 description 和 JSON Schema 要**一字不差**。少一
// 个字、改一个字段，换来的就是 403 FreeTierError。
//
// 移植自 zen-gate 的 internal/lane/upstream.go。这里的描述文本是从它代码里
// 抄下来的 OpenCode v2.0.26 CLI 原文——不要"顺手润色"，改了就不通了。

export const FINGERPRINT_TOOLS = ['read', 'shell'] as const;
type FingerprintName = (typeof FINGERPRINT_TOOLS)[number];

/**
 * 工具声明的三种形状：chat 是嵌套的 {type,function}，responses 是扁平的
 * {type,name,parameters}，Claude 是 {name,input_schema}。指纹门对形状也挑。
 */
export type WireStyle = 'chat' | 'flat' | 'claude';

const READ_DESC =
  'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.';

const SHELL_DESC =
  'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.';

function fingerprintDef(name: FingerprintName): { description: string; parameters: any } {
  if (name === 'read') {
    return {
      description: READ_DESC,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory to read' },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'The line or directory entry to start reading from (1-based)'
          },
          limit: {
            type: 'integer',
            minimum: 0,
            description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)'
          }
        },
        required: ['path'],
        additionalProperties: false
      }
    };
  }
  return {
    description: SHELL_DESC,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: {
          type: 'string',
          description:
            'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.'
        },
        timeout: {
          type: 'integer',
          minimum: 0,
          description:
            'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.'
        },
        background: {
          type: 'boolean',
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."
        }
      },
      required: ['command'],
      additionalProperties: false
    }
  };
}

/** 稳定序列化：键排序，保证等价 schema 比较不会因键序误判。 */
function stableStringify(value: any): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

function toolNameOf(tool: any): string {
  if (!tool || typeof tool !== 'object') {
    return '';
  }
  const direct = typeof tool.name === 'string' ? tool.name.trim() : '';
  if (direct) {
    return direct;
  }
  const fn = tool.function;
  return fn && typeof fn.name === 'string' ? fn.name.trim() : '';
}

function fingerprintKey(name: string): FingerprintName | '' {
  const trimmed = name.trim();
  return (FINGERPRINT_TOOLS as readonly string[]).includes(trimmed) ? (trimmed as FingerprintName) : '';
}

function isExactDefinition(tool: any, key: FingerprintName): boolean {
  const def = tool.function ?? tool;
  const want = fingerprintDef(key);
  if (!def || typeof def !== 'object') {
    return false;
  }
  if (def.description !== want.description) {
    return false;
  }
  return stableStringify(def.parameters) === stableStringify(want.parameters);
}

function renameTool(tool: any, name: string): any {
  if (tool.function) {
    return { ...tool, function: { ...tool.function, name } };
  }
  return { ...tool, name };
}

export interface FingerprintResult {
  /** 发出去的别名 → 调用方原本的名字，回来时要还原。 */
  renames: Record<string, string>;
  /** 本次追加的占位工具名；模型如果真调了它们，必须丢掉。 */
  appended: string[];
}

/**
 * 就地改写 body.tools，使其同时满足指纹门和调用方的真实工具集。
 *
 * 调用方如果自己也有一个叫 read / shell 的工具（定义和上游不同），会被改名成
 * read_client 送去，避免和指纹工具重名——上游见到同名不同义会直接拒。
 */
export function applyFingerprint(body: any, style: WireStyle = 'chat'): FingerprintResult {
  const renames: Record<string, string> = {};
  const appended: string[] = [];
  const tools: any[] = Array.isArray(body.tools) ? body.tools : [];

  const taken = new Set<string>();
  for (const t of tools) {
    const n = toolNameOf(t);
    if (n) {
      taken.add(n);
    }
  }

  const out: any[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = toolNameOf(tool);
    const key = fingerprintKey(name);
    if (!key) {
      out.push(tool);
      continue;
    }
    if (seen.has(key)) {
      continue; // 同名重复声明，上游会拒，只留第一个
    }
    seen.add(key);
    if (isExactDefinition(tool, key)) {
      out.push(tool);
      continue;
    }
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) {
      alias = `${key}_client${i}`;
    }
    taken.add(alias);
    renames[alias] = name;
    out.push(renameTool(tool, alias));
  }

  for (const name of FINGERPRINT_TOOLS) {
    const present = out.some((t) => fingerprintKey(toolNameOf(t)) === name);
    if (present) {
      continue;
    }
    const def = fingerprintDef(name);
    if (style === 'claude') {
      out.push({ name, description: def.description, input_schema: def.parameters });
    } else if (style === 'flat') {
      out.push({ type: 'function', name, description: def.description, parameters: def.parameters, strict: false });
    } else {
      out.push({
        type: 'function',
        function: { name, description: def.description, parameters: def.parameters }
      });
    }
    seen.add(name);
    appended.push(name);
  }

  body.tools = out;

  retargetToolChoice(body, renames);
  aliasHistoryToolCalls(body, renames);

  if (appended.length > 0) {
    notePlaceholders(body, appended, style);
  }
  return { renames, appended };
}

/** 有人显式指定 tool_choice 时，把名字换成别名。 */
function retargetToolChoice(body: any, renames: Record<string, string>): void {
  if (Object.keys(renames).length === 0) {
    return;
  }
  const aliases: Record<string, string> = {};
  for (const [alias, orig] of Object.entries(renames)) {
    aliases[orig] = alias;
  }
  const choice = body.tool_choice;
  if (choice && typeof choice === 'object') {
    if (typeof choice.name === 'string' && aliases[choice.name.trim()]) {
      choice.name = aliases[choice.name.trim()];
    } else if (choice.function && typeof choice.function.name === 'string' && aliases[choice.function.name.trim()]) {
      choice.function.name = aliases[choice.function.name.trim()];
    }
  }
}

/** 历史轮次里的工具调用也要跟着改名，否则模型会把自己的旧调用读串。 */
function aliasHistoryToolCalls(body: any, renames: Record<string, string>): void {
  if (Object.keys(renames).length === 0 || !Array.isArray(body.messages)) {
    return;
  }
  const aliases: Record<string, string> = {};
  for (const [alias, orig] of Object.entries(renames)) {
    aliases[orig] = alias;
  }
  for (const msg of body.messages) {
    if (!msg || !Array.isArray(msg.tool_calls)) {
      continue;
    }
    for (const call of msg.tool_calls) {
      const fn = call?.function;
      if (fn && typeof fn.name === 'string' && aliases[fn.name]) {
        fn.name = aliases[fn.name];
      }
    }
  }
}

/**
 * 告诉模型别去调那两个占位工具。没有这段提示，模型会真的去调 read/shell —
 * 而这两个工具在 VS Code 这边根本不存在，调用会直接失败。
 */
function notePlaceholders(body: any, names: string[], style: WireStyle): void {
  const quoted = names.map((n) => '`' + n + '`').join(' or ');
  const note = `Do not call the ${quoted} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`;

  // responses 线没有 messages 里的 system 位，提示词走 instructions。
  if (style === 'flat') {
    body.instructions = typeof body.instructions === 'string' && body.instructions.trim()
      ? body.instructions + '\n\n' + note
      : note;
    return;
  }

  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  if (first && first.role === 'system' && typeof first.content === 'string') {
    messages[0] = { ...first, content: first.content + '\n\n' + note };
    return;
  }
  messages.unshift({ role: 'system', content: note });
}

/** 把上游回来的名字映射回调用方的名字。 */
export function restoreToolName(name: string, renames: Record<string, string>): string {
  return renames[name] ?? name;
}
