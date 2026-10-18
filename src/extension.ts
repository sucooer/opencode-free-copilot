import * as vscode from 'vscode';
import { OpenCodeProvider } from './provider';

/** 必须与 package.json 里 contributes.languageModelChatProviders 的 vendor 一致。 */
const VENDOR = 'opencode-free';
const FIRST_RUN_KEY = 'opencodeFree.firstRunHintShown';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('OpenCode Free');
  const provider = new OpenCodeProvider(log);

  context.subscriptions.push(
    log,
    // 注册之后，模型会出现在 Copilot 的模型选择器里（需要在"管理模型"里勾选）。
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.commands.registerCommand('opencodeFree.refreshModels', () => provider.refresh(true)),
    vscode.commands.registerCommand('opencodeFree.showLog', () => log.show(true))
  );

  if (!context.globalState.get<boolean>(FIRST_RUN_KEY)) {
    void context.globalState.update(FIRST_RUN_KEY, true);
    void vscode.window
      .showInformationMessage(
        'OpenCode Free 已就绪。到聊天面板的模型选择器 → 管理模型 → 勾选 OpenCode Free 下的免费模型即可使用。',
        '打开模型选择器',
        '查看日志'
      )
      .then((choice) => {
        if (choice === '打开模型选择器') {
          void vscode.commands.executeCommand('workbench.action.chat.manageModels');
        } else if (choice === '查看日志') {
          log.show(true);
        }
      });
  }
}

export function deactivate(): void {
  /* 无需清理：注册的 disposable 都在 context.subscriptions 里 */
}
