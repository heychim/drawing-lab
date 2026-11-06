# Codex development drawing input

`current.drawing.json` is the fixed V1-B development input consumed by Drawing Lab.

Workflow:

1. Codex writes a strict `AgentDrawingPayload` to `current.drawing.json`.
2. Vite notices the imported JSON change during development.
3. The user selects **Codex 示例** in the existing sample panel.
4. Drawing Lab passes the parsed JSON through the existing `applyPayload` boundary.
5. A valid payload becomes a canonical `DrawingDocument` and replays; an invalid payload is rejected without changing the current document.

The other `*.drawing.json` files are V1-B acceptance fixtures. The `*.steps.json`
files are compact inputs for the MCP tool `create_drawing_result`. They can be
replayed from their resulting DrawingDocuments. See the [Agent Guide](../../docs/AGENT_GUIDE.md#compact-mcp-input).

- [Wind Letter](wind-letter.steps.json) is the portrait on the project README.
- [Calico Nap](calico-nap.steps.json) and the [coat study](calico-coat.steps.json)
  show the effect of changing grain on selected fills and adding directional fur strokes.
