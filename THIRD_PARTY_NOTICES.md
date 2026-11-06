# Third-party notices

## Fusion Pixel Font

- Official upstream: https://github.com/TakWolf/fusion-pixel-font
- Release: `2026.08.11`
- Bundled file: `public/fonts/fusion-pixel-12px-proportional-zh_hans.woff2`
- Copyright (c) 2022, TakWolf (https://takwolf.com).
- License: SIL Open Font License 1.1.
- Full license: `public/fonts/FUSION_PIXEL_FONT_OFL.txt`
- Reserved Font Name: none is declared after the copyright statement in the
  bundled upstream license text.
- Project use: embedded by `src/redesign.css` as the Simplified Chinese UI font.

The bundled 12-pixel proportional Simplified Chinese WOFF2 is from the official
release. The OFL permits web embedding and redistribution when its copyright
notice and license accompany the font. The font remains under OFL-1.1 and is
not relicensed under Drawing Lab's MIT License.

## JavaScript dependencies and build tools

The application uses React and React DOM (MIT). Development uses Vite and
`@vitejs/plugin-react` (MIT) and TypeScript (Apache-2.0). Exact resolved versions
and transitive packages are recorded in `package-lock.json`; their own license
terms remain unchanged.

## Drawing and agent design references

These references informed Drawing Lab's independently written TypeScript
implementation. Their source code, prompts and artwork are not bundled.

| Reference | What we studied |
| --- | --- |
| [SketchAgent](https://github.com/yael-vinker/SketchAgent) | Sequential drawing, semantic stroke identifiers and fitting curves to an ordered set of points. |
| [perfect-freehand](https://github.com/steveruizok/perfect-freehand) | How variable-width outlines and taper can express pressure along a stroke. |
| [p5.brush](https://github.com/acamposuribe/p5.brush) | How grain, pigment buildup at the edges and translucent layers distinguish drawing materials. |
| [Doodle Agent](https://github.com/YIFANK/DoodleAgent) and [tldraw Agent](https://github.com/tldraw/agent-template) | How a model can describe drawing actions that an application translates into editable marks. |

The preview uses the [W3C SVG path commands](https://www.w3.org/TR/SVG2/paths.html)
to describe the geometry shared with the Canvas renderer.

## Project-created material

The pixel icon JSX, example drawing inputs, the README screenshot and the artwork
in `docs/artwork/` were created for Drawing Lab and are covered by the project
license. The portrait and both cat studies were drawn with the operations in
`drawings/codex/`.
