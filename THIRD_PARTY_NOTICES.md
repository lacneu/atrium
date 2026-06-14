# Third-Party Notices

This file records notices for third-party **code or substantial implementation
portions incorporated into the source tree**, beyond ordinary package-manager
dependency metadata. Runtime/build dependencies installed via npm are declared in
`package.json` (and `bridge/package.json`); their licenses ship in
`node_modules/<pkg>/LICENSE` and are not duplicated here.

## shadcn/ui — UI primitives (`src/components/ui/`)

The components under `src/components/ui/` (button, dialog, dropdown-menu, popover,
card, input, checkbox, accordion, alert-dialog, badge, …) were generated/copied
into this repository using the [shadcn/ui](https://ui.shadcn.com) workflow (style
`radix-nova`, see `components.json`). They are owned, vendored source — adapted to
this project's tokens and conventions — not an npm dependency. The underlying
Radix UI primitives they wrap ARE npm dependencies (see `package.json`).

- Upstream: https://github.com/shadcn-ui/ui
- License: MIT
- Copyright (c) shadcn and contributors

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Acknowledgments (design inspiration — no code vendored)

These influenced the design/structure but no code was copied; they carry no
license obligation here and are credited in good faith (and referenced in source
comments where relevant):

- **Open WebUI** (https://github.com/open-webui/open-webui) — chat message layout
  and the receive-loop shaping that the bridge normalizer mirrors.
- **claude-monitor** — the Convex + Node-bridge project structure this app was
  modeled after.
- **OpenClaw** (https://github.com/openclaw/openclaw) — the gateway whose
  WebSocket protocol the bridge speaks; this is a community/companion project, not
  affiliated with or endorsed by OpenClaw.

If you believe code of yours was incorporated without proper attribution, please
open an issue or use the security contact in [SECURITY.md](SECURITY.md).
