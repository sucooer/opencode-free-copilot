# OpenCode Free Models

把 OpenCode Zen 的免费模型直接接进 VS Code Copilot 的模型选择器。

实现方式是用 VS Code 官方的 `languageModelChatProviders` 能力，由扩展在扩展宿主里完成协议适配。

## 安装

```bash
npm install
npm run compile     # 产物在 out/
npm run check       # 只做类型检查
npm test            # 离线用例（协议解码、指纹形状、限流切换）
```

- 开发：在 VS Code 里打开本目录，按 `F5`
- 安装：`npm run package:vsix` 后 `code --install-extension opencode-free-copilot-0.2.0.vsix`

要求 VS Code **1.109+**，并已安装 Copilot Chat。推送与 PR 会跑 GitHub Actions（三平台构建 + 测试 + 打包，见
`.github/workflows/ci.yml`）。

## 使用

模型选择器 → **管理模型** → **OpenCode Free** → 勾选要用的模型 → 回对话里选它。

> BYOK 只作用于聊天和 agent 模式；行内补全（Tab）仍走 Copilot 自己的模型，这是 VS Code 的设计。

## 设置

| 设置项                            | 默认                    | 说明                            |
| ------------------------------ | --------------------- | ----------------------------- |
| `opencodeFree.baseUrl`         | `https://opencode.ai` | 上游根地址，一般不用改                   |
| `opencodeFree.hideUnsupported` | `true`                | 隐藏未实现线路（messages / systemone）的模型 |

命令面板还有：**刷新免费模型列表**、**查看日志**。

## 工作原理

上游不认个人凭证，只认"你是不是一个真的 OpenCode 客户端"，所以每个请求都要满足四件事，缺一件就是 403：

1. **身份头** —— `authorization: Bearer public`、`user-agent: opencode/latest/2.0.26/cli`，以及一组  
   `x-opencode-*` / `x-session-*` 头。
2. **工具指纹** —— `tools` 里必须带上游自己的 `read` / `shell`，description 与 JSON Schema 逐字一致；  
   **哪怕这一轮不需要任何工具也要带**。调用方若有同名工具会被改名成 `read_client`，回来再还原。
3. **会话 id** —— 额度按会话计，一段对话复用一个 `ses_` id。这个 id 必须是**铸造**的  
   （`~(ms<<12|seq)` 时间戳前缀），哈希出来的上游解不开。
4. **线路** —— 先按本地表猜 chat 或 responses，上游回 `400 does not support this protocol` 就自动换  
   另一条重试一次并记住。线路怎么分配由上游决定。
5. **限流兜底** —— 撞到 429（或上游 5xx）且还没吐字时，自动换下一个免费模型接手，最多试 3 个候选；
   带图的一轮只会换到同样支持图片的模型。切换写进日志，状态栏也会短暂提示。

模型清单取自 `GET /zen/v1/models`，只保留免费车道；上下文、输出上限、多模态能力由本地实测表补齐。

## 已知限制

- 只实现 chat 与 responses 两条线；`messages`（`union-alpha`）和 `systemone`（`jev-*`）没有
- **出口 IP 决定成败**：机房/公共 VPN 的 IP 会让所有免费模型一起 403。系统级代理和 TUN 模式同样算——
  扩展本身不提供代理设置，就是因为挂了机房出口只会更糟
- 没有出口轮换，额度按「会话 + IP」计；打满返回 429，但多半是瞬时拥挤，几十秒到两分钟内会恢复
  （被拒的请求不消耗额度；扩展会自动换模型接手，只有全部候选都失败才会报错）
- 会话 id 存在内存里，VS Code 重启后同一段对话会换新 id
- 图片输入代码已支持，但没实测过上游是否接受

## 维护提示

上游的校验规则会变。一旦每次请求都 403，先看是不是出口 IP 的问题；排除后重新对齐  
`src/opencode/identity.ts`（UA、头、会话铸造）和 `src/opencode/fingerprint.ts`（`read`/`shell` 的定义与描述）。

另外这条免费车道的提示词可能被上游记录，别发机密内容；使用方式请自行确认符合上游条款。
