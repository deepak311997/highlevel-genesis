# Genesis — brand assets

Three logo directions for Genesis, the AI-powered HighLevel app builder. All marks are
hand-authored SVG on a 96-unit grid, drawn from the same idea: something half-assembled
with a live point at its centre.

| File | What it is |
|---|---|
| `genesis-seed.svg` | **Primary mark** (recommended). Two colour. |
| `genesis-seed-mono.svg` | Primary mark using `currentColor` — reversals, one-colour print. |
| `genesis-seed-lockup.svg` | Primary mark + wordmark, horizontal. |
| `genesis-prompt.svg` / `-lockup.svg` | Direction two: caret + streaming output. |
| `genesis-blocks.svg` / `-lockup.svg` | Direction three: interface assembling on the diagonal. |
| `genesis-logo-800.png` | **Raster logo**, 800 × 800, primary mark on white. For upload fields — HighLevel marketplace app logo, favicons, anywhere SVG isn't accepted. |

The PNG is the Seed mark at 640px inside an 800px white square (80px of clear space
on every side). Regenerate it at another size by editing the two lengths in
`../scratchpad/render-800.html` and re-screenshotting, or scale the SVG directly.

## Palette

| Name | Hex | Use |
|---|---|---|
| Cobalt | `#2B4BF2` | Structure, the mark, primary actions |
| Ember | `#FF6A2B` | The live point — one element per mark, never a fill |
| Ink | `#10131A` | Wordmark, body copy |
| Paper | `#F1F3F7` | App background, reversal colour on dark |

## Usage

- Clear space: one dot-diameter (8.5 units at the source scale) on every side.
- Minimum size: 16px for `seed` and `prompt`; 20px for `blocks`.
- On dark grounds use `genesis-seed-mono.svg` with `color` set to Paper, or keep the
  two-colour mark — both hold.
- Never recolour Ember, never apply it to more than one element, never add a gradient.

## Open items

- The wordmark in the lockups is set in the **system sans** via `<text>`, so it renders
  differently per machine. Before public use, set it once in a licensed geometric
  grotesque and convert to outlines.
- No PNG / ICO exports yet.
