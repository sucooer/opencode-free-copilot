// 测试用的最小 VS Code 替身 + TS 转译钩子。
//
// 扩展的源码 import 了 'vscode'，而这个模块只在扩展宿主里存在；测试进程里
// 用一个最小的类替身顶上，好让 instanceof 判断能正常工作。
// 同时注册 .ts 的 require 钩子，用仓库自带的 typescript 在内存里转译，
// 这样测试跑的就是要发布的同一份源码，不需要先编译。

const fs = require('node:fs');
const path = require('node:path');
const ts = require(path.join(__dirname, '..', '..', 'node_modules', 'typescript'));
const Module = require('node:module');

class TextPart {
  constructor(value) {
    this.value = value;
  }
}

class ToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class ToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class DataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }
}

const vscodeStub = {
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelDataPart: DataPart,
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: {
    showInformationMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    setStatusBarMessage: () => ({ dispose() {} })
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
  }
};

Module._resolveFilename = ((original) =>
  function (request, ...rest) {
    if (request === 'vscode') {
      return 'vscode-stub';
    }
    return original.call(this, request, ...rest);
  })(Module._resolveFilename);

require.cache['vscode-stub'] = {
  id: 'vscode-stub',
  filename: 'vscode-stub',
  loaded: true,
  exports: vscodeStub
};

require.extensions['.ts'] = function (mod, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  }).outputText;
  mod._compile(output, filename);
};

module.exports = { vscodeStub, TextPart, ToolCallPart, ToolResultPart, DataPart };
