// 限流切换的候选筛选与失败处理（离线，不发请求）。

const { TextPart, DataPart } = require('./support/loader');

const { OpenCodeProvider } = require('../src/provider.ts');

const provider = new OpenCodeProvider({ appendLine: () => {}, show: () => {} });
provider.specs = [
  { id: 'mimo-v2.6-flash-free', name: 'MiMo', contextWindow: 1048576, maxOutput: 131072, vision: true, reasoning: true, wire: 'chat', regionSensitive: false },
  { id: 'space-bunny-free', name: 'Space', contextWindow: 1048576, maxOutput: 65536, vision: true, reasoning: true, wire: 'chat', regionSensitive: false },
  { id: 'big-pickle', name: 'Pickle', contextWindow: 131072, maxOutput: 32768, vision: false, reasoning: true, wire: 'chat', regionSensitive: false },
  { id: 'beam-free', name: 'Beam', contextWindow: 1048576, maxOutput: 32768, vision: false, reasoning: true, wire: 'chat', regionSensitive: true },
  { id: 'jev-1.13-free', name: 'Jev', contextWindow: 32768, maxOutput: 4096, vision: false, reasoning: false, wire: 'systemone', regionSensitive: false }
];

const plain = [{ role: 1, content: [new TextPart('hi')], name: undefined }];
const withImage = [
  { role: 1, content: [new TextPart('看看这张图'), new DataPart(Buffer.from('x'), 'image/png')], name: undefined }
];

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

let list = provider.failoverCandidates('mimo-v2.6-flash-free', plain);
check('纯文本：最多 3 个', list.length === 3, list.join(','));
check('纯文本：第一个是请求的模型', list[0] === 'mimo-v2.6-flash-free', list[0]);
check('排除地区受限', !list.includes('beam-free'), list.join(','));
check('排除 systemone', !list.includes('jev-1.13-free'), list.join(','));

list = provider.failoverCandidates('mimo-v2.6-flash-free', withImage);
check('带图：排除无视觉', !list.includes('big-pickle'), list.join(','));
check('带图：保留有视觉的', list.includes('space-bunny-free'), list.join(','));

(async () => {
  // 全部候选都返回 429 时，应抛出最后一次的错误而不是静默返回
  provider.runTurn = async () => ({ kind: 'retry', error: new Error('模拟限流（429）') });
  let thrown = '';
  try {
    await provider.provideLanguageModelChatResponse(
      { id: 'mimo-v2.6-flash-free' },
      plain,
      { tools: [], toolMode: 1, modelOptions: {} },
      { report: () => {} },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
    );
  } catch (err) {
    thrown = err.message;
  }
  check('全失败时抛出最后错误', thrown.includes('429'), thrown);

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) {
      failed++;
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
  }
  process.exit(failed ? 1 : 0);
})();
