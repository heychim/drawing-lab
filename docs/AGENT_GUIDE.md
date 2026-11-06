# Drawing Lab Agent Guide

Drawing Lab accepts provider-neutral drawing operations. It does not call a
model API. An external Agent can use the web Agent Mode during development or
the Remote MCP endpoint in an ordinary chat client.

The public machine-readable input schema is `/drawing-schema.json`. Runtime
validation remains authoritative: payloads, restored Results, and continuation
branches are strictly validated before they can become a canonical
DrawingDocument.

## Remote MCP

Connect a compatible client to:

```text
https://YOUR_HOST/mcp
```

The endpoint uses Streamable HTTP and exposes:

- `create_drawing_result`: create a completed new drawing from
  AgentDrawingPayload 0.1 operations.
- `continue_drawing_result`: restore an existing Drawing Lab Result and create
  a new branch document containing the old operations plus a new bounded batch.

Client support for Remote MCP, write tools, Markdown links, and MCP ImageContent
varies. Do not assume every model plan or client version supports them.

### Compact MCP input

For either MCP tool, send exactly one of `steps` or `operations`. Prefer
`steps` for new calls. The server expands them before canonical validation.

```json
{
  "schemaVersion": "0.1",
  "documentAction": "new_drawing",
  "title": "Two hills",
  "steps": [
    {"tool":"watercolor"}, {"color":"#83BBD2"}, {"brushSize":24},
    {"paths":[
      {"id":"far-hill","xy":[[60,410],[265,230],[470,410]]},
      {"id":"near-hill","xy":[[410,440],[610,310],[870,440]],"t":[0,0.4,1]}
    ]},
    "complete"
  ]
}
```

Each path is a separate pen lift and undo target. Coordinates are absolute.
With omitted `t`, point i of N has progression i/(N−1). Supply exact `t`
values to preserve a custom curve. For erasure, select `eraser` and supply
paths. History steps are `"undo"`, `"redo"`, and final `"complete"`.
New drawings start with pencil, #6B4F4F and size 3. For continuation, replace
`documentAction` with `sourceResultUrl`; paths inherit the restored source's
tool, color and size until a step changes them. Limits apply after expansion.
The web Agent Mode accepts canonical `operations`.

### Paint a region with one path

Choose `wash_fill` for transparent glazes that show earlier colors, or
`gouache_fill` for matte, nearly opaque coverage. Send the perimeter once.
For example, these steps put a clay-colored roof over a blue wash:

```json
[
  {"tool":"wash_fill"},{"color":"#83BBD2"},
  {"paths":[{"id":"sky","xy":[[90,90],[910,90],[910,540],[90,540]]}]},
  {"tool":"gouache_fill"},{"color":"#A55543"},
  {"paths":[{"id":"roof","xy":[[280,470],[490,310],[730,455],[705,478]]}]},
  "complete"
]
```

Use at least three non-collinear vertices, in boundary order. Edges are
straight and the last joins the first automatically. Add vertices around
curves and use the even-odd rule for crossing outlines. Each region is one
undo target. Draw transparent layers, opaque shapes and line tools in the
order you want them to cover one another. Size controls the wash rim or the
length of dry gouache marks; it does not expand the boundary. Replay spreads
paint from the first vertex; optional `t` changes its pacing. Leave it out
for the default. Line tools still paint along the path, including on closed loops.

## New drawing

`create_drawing_result` uses the existing AgentDrawingPayload fields and
requires a title plus a final `complete` operation:

```json
{
  "schemaVersion": "0.1",
  "documentAction": "new_drawing",
  "title": "Small hill",
  "operations": [
    { "type": "select_tool", "tool": "pencil" },
    { "type": "set_color", "color": "#6B4F4F" },
    { "type": "set_brush_size", "brushSize": 8 },
    {
      "type": "stroke",
      "semanticId": "hill-outline",
      "tool": "pencil",
      "color": "#6B4F4F",
      "brushSize": 8,
      "points": [{ "x": 180, "y": 520 }, { "x": 500, "y": 250 }, { "x": 820, "y": 520 }],
      "tValues": [0, 0.5, 1]
    },
    { "type": "complete" }
  ]
}
```

`complete` must be final. A completed canonical document cannot be unsealed or
appended to.

## Continue the active web document

In web Agent Mode, read `drawingId` from Agent Context and submit only the new
bounded operation batch:

```json
{
  "schemaVersion": "0.1",
  "documentAction": "continue_current",
  "documentId": "drawing-id-from-agent-context",
  "operations": [
    { "type": "select_tool", "tool": "brush" },
    { "type": "set_color", "color": "#F3B84B" },
    { "type": "set_brush_size", "brushSize": 18 },
    {
      "type": "stroke",
      "semanticId": "sun-ray-1",
      "tool": "brush",
      "color": "#F3B84B",
      "brushSize": 18,
      "points": [{ "x": 760, "y": 150 }, { "x": 825, "y": 90 }],
      "tValues": [0, 1]
    }
  ]
}
```

A successful `continue_current` preserves the canonical prefix and records
exactly this appended batch in `latestPlaybackRange`.

## Continue an existing Result through MCP

`continue_drawing_result` is intentionally separate from `create_drawing_result`:

```json
{
  "schemaVersion": "0.1",
  "sourceResultUrl": "https://YOUR_HOST/?relayResult=RESULT_ID#relay-key=FRAGMENT_KEY",
  "title": "Small hill with a star",
  "operations": [
    { "type": "select_tool", "tool": "pencil" },
    { "type": "set_color", "color": "#F08FA8" },
    { "type": "set_brush_size", "brushSize": 7 },
    {
      "type": "stroke",
      "semanticId": "new-pink-star",
      "tool": "pencil",
      "color": "#F08FA8",
      "brushSize": 7,
      "points": [{ "x": 720, "y": 150 }, { "x": 735, "y": 180 }, { "x": 770, "y": 184 }],
      "tValues": [0, 0.5, 1]
    },
    { "type": "complete" }
  ]
}
```

The source URL must be a recognized Result on the same Drawing Lab origin; the
server does not perform generic fetches or follow arbitrary redirects. Drawing
Lab strictly restores the source, creates a new document ID, copies its real
operations, removes only a terminal `complete` from the branch copy, and applies
the delta through the existing validator. The source document remains byte and
semantically unchanged. If an encrypted source has expired, the tool returns
`source_result_expired`; it cannot read a user's Local Drawings.

## Modify an old mark

Canonical history is append-only. Express a modification with actual operations:

```json
{
  "schemaVersion": "0.1",
  "documentAction": "continue_current",
  "documentId": "drawing-id-from-agent-context",
  "operations": [
    { "type": "select_tool", "tool": "eraser" },
    { "type": "set_brush_size", "brushSize": 24 },
    {
      "type": "erase",
      "semanticId": "erase-old-ray",
      "tool": "eraser",
      "brushSize": 24,
      "points": [{ "x": 755, "y": 155 }, { "x": 830, "y": 85 }],
      "tValues": [0, 1]
    },
    { "type": "select_tool", "tool": "pencil" },
    { "type": "set_color", "color": "#D989A3" },
    { "type": "set_brush_size", "brushSize": 7 },
    {
      "type": "stroke",
      "semanticId": "replacement-ray",
      "tool": "pencil",
      "color": "#D989A3",
      "brushSize": 7,
      "points": [{ "x": 755, "y": 150 }, { "x": 820, "y": 105 }],
      "tValues": [0, 1]
    }
  ]
}
```

Semantic IDs describe intent but never replace operation history.

## Free Draw guidance

Free Draw is ordinary `create_drawing_result`, not a separate MCP tool and not
manual pointer drawing. If the user asks the Agent to “draw anything”, the Agent
should choose the subject, composition, tools, colors, brush sizes, stroke
order, semantic IDs, optional erase/undo, and completion without requiring a
theme from the user.

## Path fields

- `points`: canonical samples in the fixed 1000 × 750 logical canvas. `x` is
  within 0..1000 and `y` within 0..750.
- `tValues`: exactly the same length as `points`, starting at 0, ending at 1,
  and strictly increasing. They describe progression, not milliseconds.
- `semanticId`: stable Agent-chosen intent matching
  `^[a-z0-9][a-z0-9_-]{0,79}$`.
- A stroke repeats its effective `tool`, `color`, and `brushSize`; they must
  match the preceding tool-state operations.
- Choose `soft_pencil` for grainy, pressure-shaped sketch lines and `ink_brush`
  for broad downstrokes, fine turns and tapered releases. Both accept the same
  coordinates, progression and size as the other tools. Use `pencil` or
  `brush` for an even outline.
- Other drawing tools include `graphite`, `watercolor`, and `marker`;
  `eraser` is used only with `erase`. `graphite` adds a dry broken texture,
  `watercolor` builds translucent overlapping washes, and `marker` produces a
  broad squared color band. These are deterministic derived render effects;
  canonical points remain unchanged.

## Limits and result lifecycle

- Core canonical hard cap: **2 MiB (2,097,152 bytes)**.
- Public Hosted handoff eligibility cap: **1 MiB (1,048,576 bytes)** canonical
  JSON. The Hosted policy never lowers the Core validator.
- Operation cap: 1,500. Point cap: 60,000.
- The website's Fragment threshold is a configurable transport constant marked
  temporary pending real mobile-chat validation. Small website shares can use a
  self-contained Fragment; larger eligible documents use the encrypted relay.
- MCP drawing tools always return the compact encrypted-relay Result, including
  for small works. Relay Results are immutable and expire after 7 days.
- D1 stores ciphertext and non-secret envelope metadata only. The encryption key
  is in the URL fragment, not D1.
- Local Drawings exist only in the current browser and are not cloud sync.

## Preview

When the optional Browser Run binding is available, each successful MCP tool
call makes at most one request-lifetime 512 × 384 PNG Preview from the same final
DrawingDocument render plan. The tool returns it as MCP ImageContent plus source
document ID/revision metadata. It is not persisted in D1 or image history.

Missing binding, quota exhaustion, or render failure yields
`previewStatus: unavailable`; the Drawing Result and Result URL still succeed.

## Fail-closed and executable-content rules

- Unknown fields, operation types, invalid state transitions, coordinates,
  `points`/`tValues`, limits, JSON, fragments, gzip, ciphertext, and documents
  are rejected as a whole.
- Rejected input cannot partially modify a canonical DrawingDocument or create a
  half Result.
- Agent input cannot write local storage, checkpoints, files, or D1 directly.
- Never submit scripts, JavaScript, HTML, executable SVG, bitmap results, `eval`
  input, arbitrary commands, or external drawing-service output. Drawing Lab
  accepts DrawingDocument operations, not executable or pre-rendered artwork.
