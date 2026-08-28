# Drawing Lab

Drawing Lab 是一个 local-first 的“真实操作绘画”实验项目。外部 AI 不提交
bitmap 成品，而是生成严格的 DrawingDocument operations：选择工具、设置颜色和
画笔粗细，再按顺序提交 stroke、erase、undo、redo 与 complete。Drawing Lab
验证这些操作、执行 Drawing Engine，并让用户看到同一份 canonical history 的
真实 Replay。

普通聊天客户端如果支持 Remote MCP 和工具调用，可以让 AI 直接创建或续画，
返回可点击 Result，并通过同一 DrawingDocument 派生的 PNG Preview 检查自己实际
画出的成品。Drawing Lab 本身不内置模型，也不提供模型额度。

![Drawing Lab mobile UI](artifacts/mobile-ux1-1/final-mobile-page.png)

## 功能

- 固定 1000 × 750（4:3）canonical canvas。
- 严格、fail-closed 的 AgentDrawingPayload / DrawingDocument validation。
- 按 operation 顺序执行 Pencil、Brush、Eraser、颜色、粗细、Undo 与 Redo。
- Bézier 派生曲线路径、逐笔 Replay、Latest Replay 与跳过动画。
- 当前浏览器内的本地画作保存、更新、切换与删除。
- PNG 导出，以及可恢复 canonical history 的分享 Result。
- Provider-neutral Remote MCP：`create_drawing_result`、`continue_drawing_result`。
- 基于旧 Result 创建新 DrawingDocument 分支；源作品保持 immutable。
- 可选 Cloudflare Browser Run 派生 512 × 384 PNG Preview；失败不影响 Result。
- 小型网页分享可使用 self-contained Fragment；Hosted relay 使用加密临时结果。

当前网页 canvas 是 operations 的查看与回放界面，不提供手指或鼠标自由绘制输入。
Agent Guide 中的 “Free Draw” 指 AI 自主决定题材并调用
`create_drawing_result`，不是第三套工具或手动画布模式。

## Quick start

要求 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址即可使用基础 Drawing Lab。基础 UI、示例、validation、
Replay、本地保存和 PNG 导出不要求 Cloudflare 账号。

```bash
npm test
npm run build
npm run preview
```

`dist/` 是可重新构建的输出，默认不提交。

## AI / Remote MCP

公开协议说明见 [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md)，机器可读 schema
见 [`public/drawing-schema.json`](public/drawing-schema.json)。自托管 MCP endpoint：

```text
https://YOUR_HOST/mcp
```

MCP 使用 Streamable HTTP，提供两个写工具：

- `create_drawing_result`：从真实 operations 创建新作品。
- `continue_drawing_result`：严格恢复 Drawing Lab Result，以新 ID 创建分支并追加
  operations；旧 Result 对应的 canonical document 不变。

Free Draw 是 `create_drawing_result` 的模型 guidance：用户不指定题材时，模型自行
决定构图、工具、颜色、粗细、stroke order 与完成时机。

### 模型用量提醒

Drawing Lab 不调用图像生成模型直接产出成品图。AI 会自行输出实际的结构化绘画
操作，包括工具、颜色、画笔粗细和笔画路径/坐标，再由 Drawing Lab Engine 执行并
Replay。

因此，复杂画作可能需要模型输出较多 structured operations，并消耗更多模型 token
或使用额度。实际消耗取决于模型、客户端、画作复杂度和修改轮数；这不是 Drawing
Lab 额外收取的费用。

聊天客户端能否调用这些工具、是否展示 MCP ImageContent，取决于客户端当前是否
支持 Remote MCP、write tool calls 与 image content；本项目不声称所有 ChatGPT、
Claude 或其他客户端版本都具备这些能力。

## Storage 与隐私

- **Local Drawings** 只保存在当前浏览器/设备，不是账号数据或云同步。清除站点
  数据、浏览器 profile 或 local storage 可能删除它们。
- 网页小作品分享可将压缩 canonical document 放在 URL fragment；拿到完整链接的
  人可以读取作品。
- Hosted encrypted relay 的 Result 默认保留 7 天。D1 只保存 ciphertext、IV 和
  必要 envelope metadata，不保存 encryption key 或 plaintext DrawingDocument。
- Relay key 只在 Result URL fragment 中。链接泄露意味着在有效期内可读取作品。
- MCP Worker 在 request 生命周期内会瞬时看到并验证 plaintext operations，但不应
  记录或持久化 plaintext、完整 Result URL 或 key。
- Preview 是同一 DrawingDocument 的 request-lifetime 派生 PNG，不写入 D1，不建立
  图片历史。Preview 不可用时，Drawing Result 仍可成功。

## Sharing

- **保存到本地**：保存完整 DrawingDocument，可 Replay，并可作为后续本地版本。
- **导出图片**：只导出当前最终画面的 4:3 PNG，不包含网页 UI。
- **分享**：创建可恢复 DrawingDocument 并自动 Replay 的 Result，不是 PNG 分享。

Core canonical hard cap 为 2 MiB。公开 Hosted handoff eligibility cap 为 1 MiB；
Hosted 限制不会改变 Core validator。

## Deployment

### Local-only / basic

运行 Vite 即可使用基础 Drawing Lab。没有 D1、Browser Run 或 Cloudflare binding 时，
不要期待公网 relay、Remote MCP 或云端 Preview。

### Full hosted / MCP / relay

当前参考部署为 Cloudflare Worker + Workers Static Assets + D1；Browser Run 是
Preview 的可选增强。Cloudflare 不是 DrawingDocument 或 Engine 的技术前提。

1. 构建前端：`npm run build`。
2. 复制 [`wrangler.example.jsonc`](wrangler.example.jsonc) 为被 gitignore 的
   `wrangler.local.jsonc`。
3. 只在本机配置自己的 `YOUR_D1_DATABASE_ID`、
   `YOUR_RATE_LIMIT_NAMESPACE_ID` 与精确 `YOUR_HOSTED_ORIGIN`。
4. 用 [`worker/d1-schema.sql`](worker/d1-schema.sql) 初始化自己的 D1。
5. 使用 Wrangler dry-run 检查后，再由维护者明确执行部署。

配置不应包含 Cloudflare token、登录邮箱、account ID、真实私有 URL 或任何
`VITE_*` secret。D1 只能通过 Worker binding 访问。没有 `BROWSER` binding 时，
MCP Preview 会明确降级为 unavailable，Result 仍保持成功。

完整 binding、TTL、cleanup 与防滥用说明见
[`worker/README.md`](worker/README.md)。

## Architecture

```text
Chat / Agent / MCP
        ↓
AgentDrawingPayload → strict validation → canonical DrawingDocument
                                              ↓
                              Drawing Engine → Replay / PNG export

Hosted Worker
├─ Static Assets
├─ /mcp
├─ encrypted result relay → D1 ciphertext + 7-day TTL
└─ optional Browser Run → derived PNG Preview
```

DrawingDocument / operation history 始终是作品真身；Fragment、checkpoint、Result、
PNG 与 Preview 都只是 transport 或 derived artifact。

## Public docs

- [Agent Guide](docs/AGENT_GUIDE.md)
- [AgentDrawingPayload schema](public/drawing-schema.json)
- [Worker deployment guide](worker/README.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

Drawing Lab 原创代码、明确标注的原创文档、pixel icon JSX 与示例 DrawingDocument
采用 [MIT License](LICENSE)。Copyright 使用中性主体
“Drawing Lab contributors”。

第三方字体、JavaScript dependencies 和其他第三方材料不因本项目采用 MIT 而改变
许可证。详情及字体完整 OFL 文本见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
