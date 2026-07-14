# FORGE Visual Identity

**Many specialists. One coordinated system.**

The FORGE mark is a small machine made from six identical outer modules and one
central core. The modules stand for specialist workers. The core stands for the
orchestration that turns their separate work into one system.

The hidden “F” is created through negative space and must not be replaced by an
obvious overlaid letter. It is a detail to notice, not the first thing the mark
shouts.

## Components

Import components and types from `@/components/brand`.

| Component | Use |
|---|---|
| `ForgeMark` | Static symbol for compact product chrome and standalone identity use. |
| `ForgeWordmark` | Symbol plus selectable `FORGE` text. Use `horizontal`, `compact`, or `symbol` layout. |
| `ForgeMotionMark` | One-shot assembly for a meaningful first-run moment. It does not loop by default. |
| `ForgeStatusMark` | Symbol plus a visible status label. Use only when the state belongs to FORGE orchestration. |

`ForgeMark` accepts `size`, `className`, `title`, `decorative`, `appearance`,
`status`, and `detail`. `detail` can be `auto`, `full`, or `simplified`.
Automatic mode simplifies numeric sizes at 20 pixels and below, and safely
recognises explicit pixel strings such as `"16px"`. Use `detail="simplified"`
when a small size is expressed in another CSS unit. `ForgeWordmark` accepts
`size`, `layout`, `showTagline`, and
`appearance`. The tagline is reserved for setup, marketing, and suitable empty
states; it does not belong in the navigation bar.

`ForgeMotionMark` accepts `size`, `autoplay`, `loop`, `showWordmark`,
`onComplete`, `reducedMotionFallback`, `appearance`, `detail`, and
`playOnceKey`. Give a
first-run surface a stable `playOnceKey` to prevent a route remount from
replaying the sequence in the same browser tab.

Appearances are explicit when the surrounding surface is known:

- `default` follows the app theme.
- `light` draws a light mark for a dark surface.
- `dark` draws a dark mark for a light surface.
- `monochrome` uses `currentColor` and keeps the mark legible without a gradient.

Decorative marks are the default and use `aria-hidden`. Set `decorative={false}`
when a standalone mark needs the accessible name `FORGE`. A wordmark keeps the
symbol decorative because the visible text already provides that name.

## Motion

The full sequence takes about 1.8 seconds:

1. Six separate module outlines appear.
2. The modules move inward and rotate into their 60-degree positions.
3. They settle with a small mechanical lock.
4. Connection traces reach the centre.
5. The central core ignites once and immediately settles.
6. The optional wordmark resolves and the exact static mark remains.

Opt-in looping restarts this same one-shot structure on the shared 1.825-second
clock. React remounts the assembly for each cycle, so modules, traces, core, and
the completion callback cannot drift onto different timelines.

The sequence uses CSS opacity, transforms, stroke offsets, and one short core
filter. It never blocks the page. Continuous full-logo rotation, route-change
replays, autoplay sound, large glows, and default looping are prohibited.

People who prefer reduced motion receive the completed static mark immediately.
The status animations are also disabled.

## Status Meanings

`ForgeStatus` is a strict union: `idle`, `planning`, `awaiting-approval`,
`executing`, `reviewing`, `completed`, `failed`, or `disconnected`.

| Status | Treatment |
|---|---|
| Idle | Dim cyan core; assembled and still. |
| Planning | Slow blue core breath. |
| Awaiting approval | Amber core and an internal attention cue. |
| Executing | Directional trace movement inside the assembled mark. |
| Reviewing | Quiet violet exchange between core and boundaries. |
| Completed | One mint confirmation, then the normal cyan core. |
| Failed | Static red core and an internal cross; no shake or flash. |
| Disconnected | Hollow, broken core and reduced-saturation modules. |

Colour is never the only status signal. `ForgeStatusMark` shows a text label by
default, and its core cue changes shape. When a nearby surface already displays
the same text, hide the component label and make the mark decorative so screen
readers do not hear duplicate information.

To add a future status, add it to `FORGE_STATUSES`, give it a plain-language
label and a non-colour cue, define restrained token-based styling, then add it
to the all-status component test. Do not silently coerce application states at
call sites; map them deliberately at the integration boundary.

## Canonical Geometry and Assets

`web/lib/brand/forge-identity.ts` is the source of truth for the 120 by 120
geometry. It defines one module path, rendered six times at 60-degree
increments, plus the processor-like core, traces, and one negative-space
channel applied across the composed modules and core. At 16 pixels the
component and favicon suppress traces and the hidden cut so the silhouette stays
clear.

Generate the checked-in assets from the `web` directory:

```bash
npm run brand:generate
npm run brand:check
```

The deterministic script creates:

- `web/public/brand/forge-mark.svg`
- `web/public/brand/forge-wordmark-dark.svg`
- `web/public/brand/forge-wordmark-light.svg`
- `web/public/brand/forge-app-icon.svg`
- `web/public/brand/forge-favicon.svg`
- `web/public/brand/forge-og.png`

It also refreshes the Next.js `web/app/favicon.ico` from the simplified mark.
Do not hand-edit these outputs or draw separate module variants.

## Product Use

The static wordmark appears in the desktop sidebar, mobile navigation, mobile
header, login, and registration. The setup page plays the assembly once without
delaying interaction. The sidebar task strip maps the task summary to a
status-aware mark while preserving its visible summary and accessible link
label. Root metadata points browsers and social previews to the generated
favicon, app icon, and Open Graph image.

Do not turn the mark into a generic spinner or replace unrelated loading icons.
Do not add flames, anvils, hammers, sparks, robot heads, brains, crypto styling,
decorative neon, or a foreground “F”. Keep the identity compact, calm, and
useful.
