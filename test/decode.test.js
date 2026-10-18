// responses 线路的解码与指纹形状（离线，不依赖网络）。
// 事件序列对齐上游实测过的类型：output_item.added / output_text.delta /
// function_call_arguments.delta / output_item.done / completed。

require('./support/loader');

const { ResponsesAccumulator } = require('../src/opencode/openai.ts');
const { applyFingerprint } = require('../src/opencode/fingerprint.ts');

const frames = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', output_index: 0, delta: '好的，' },
  { type: 'response.output_text.delta', output_index: 0, delta: '我来看一下。' },
  { type: 'response.output_item.done', output_index: 0 },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' }
  },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"package.json"}' },
  { type: 'response.output_item.done', output_index: 1 },
  { type: 'response.completed', response: { status: 'completed' } }
];

// 复刻 provider 的 consumeResponses 处理顺序
const accumulator = new ResponsesAccumulator();
let text = '';
let terminal = '';
for (const frame of frames) {
  if (frame.type === 'response.output_text.delta' && typeof frame.delta === 'string') {
    text += frame.delta;
    continue;
  }
  if (frame.type === 'response.completed' || frame.type === 'response.done') {
    terminal = 'stop';
    continue;
  }
  accumulator.handle(frame);
}
const calls = accumulator.finish();

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

check('正文拼接', text === '好的，我来看一下。', JSON.stringify(text));
check('终止帧', terminal === 'stop', terminal);
check('工具数量', calls.length === 1, calls.length);
check('工具名', calls[0]?.name === 'read_file', calls[0]?.name);
check('call_id', calls[0]?.id === 'call_1', calls[0]?.id);
check('参数拼装', calls[0]?.args === '{"path":"package.json"}', calls[0]?.args);

// 指纹门在 responses 的扁平形状下：工具要被改名/追加成上游要的样子
const body = { model: 'muse-spark-1.3-contributor-free', input: [], tools: [], tool_choice: 'auto' };
const fingerprint = applyFingerprint(body, 'flat');

check(
  'flat 工具形状',
  body.tools.every((tool) => tool.type === 'function' && typeof tool.name === 'string' && !tool.function),
  JSON.stringify(body.tools[0]).slice(0, 80)
);
check(
  'flat 提示进 instructions',
  typeof body.instructions === 'string' && body.instructions.includes('placeholders'),
  (body.instructions || '').slice(0, 40)
);
check('flat 保留原工具名', body.tools.map((t) => t.name).join(',') === 'read,shell', body.tools.map((t) => t.name).join(','));
check('追加记录', fingerprint.appended.join(',') === 'read,shell', fingerprint.appended.join(','));

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) {
    failed++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
}
process.exit(failed ? 1 : 0);
