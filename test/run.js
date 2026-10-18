// 测试运行器：逐个跑 test/*.test.js，汇总结果。
// 每个用例文件自己在失败时以非 0 退出；这里只负责收集。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

let failed = 0;
for (const file of files) {
  process.stdout.write(`\n▸ ${file}\n`);
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed++;
  }
}

console.log(`\n${failed ? `✗ ${failed} 个用例文件失败` : `✓ ${files.length} 个用例文件全部通过`}`);
process.exit(failed ? 1 : 0);
