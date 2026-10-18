# 更新日志

版本号遵循语义化版本，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.2.0] - 2026-10-18

### 新增

- responses 线路：`/inference/v1/responses`、扁平工具定义、`instructions` 承载提示、SSE 事件解码
  （`output_text.delta` / `output_item.added` / `function_call_arguments.delta` / `completed` / `incomplete` / `failed`）
- 线路自动纠正：上游回 `400 Model does not support this protocol` 时自动换另一条线重试一次，并记住结果
- 限流兜底：撞到 429（或上游 5xx）且尚未输出任何内容时，自动换下一个免费模型接手，最多 3 个候选；
  带图的一轮只会换到支持图片的模型
- 补上漏掉的免费模型 `big-pickle`（官方标注限时免费，但 id 里不含 `free`，原先被过滤）
- 扩展图标（按 opencode 官方 favicon 的矢量几何复刻，含 SVG 源文件）

### 变更

- 移除代理支持：免费车道会按出口 IP 的性质放行，机房/公共 VPN 的出口会被整体拒绝，
  这个开关只会让原本能用的模型一起失效
- README 精简为安装、使用、设置、原理、限制、维护六节

### 修复

- 不带任何工具的请求返回 403：指纹工具必须**无条件**追加，之前只在有工具时才加。
  Copilot 的普通问答模式正好不带工具，会因此完全不可用

## [0.1.0] - 2026-10-18

### 新增

- 初始开发版（未发布）。chat 线路、身份头与工具指纹、会话 id 铸造、免费模型目录、
  Copilot 模型提供方（`languageModelChatProviders`）
