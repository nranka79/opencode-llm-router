# opencode-llm-router

An [OpenCode](https://opencode.ai) plugin that makes an `llm-router` auth
provider available to the OpenCode / Anti-Gravity extension. Whenever the
extension asks for an LLM through that provider, this plugin forwards the
request to the AI Model Gateway — `https://llm.ahfl.in/v1`, the same
first-party service Hermes and every other caller use — and relays the
response back exactly as received.

**This plugin does not decide anything.** It used to run its own free ->
subscription -> paid fallback locally, with its own keys for Token Harbor,
OpenCode Go, OpenRouter and Azure. That has moved to the gateway, which
already implements the same tiering — one place that decision is made, kept
current, instead of a second copy here that could drift from it. The request
sent is whatever the AI SDK built, byte for byte (including `model` — this
provider's one configured model, `auto`, is a real model id the gateway
understands as "no preference, you choose, currently
`deepseek-v4-flash`" — see `llm-router-core.ts` for the model name and the
gateway's own `_requested_model` for where that convention lives).

## The one credential this needs

A static API key issued at **https://admin.ahfl.in/gateway-keys** — distinct
from `/keys-admin`, which manages the OUTBOUND keys the gateway itself spends
on upstream providers; this is an INBOUND key that lets a third-party caller
like this plugin reach the gateway at all. Shown once at issue time.

```powershell
Copy-Item .env.example .env
# edit .env, paste LLM_GATEWAY_API_KEY=<the key you were shown>, save
```

Or set it as a user environment variable instead:

```powershell
[Environment]::SetEnvironmentVariable("LLM_GATEWAY_API_KEY", "sk-gw-your-key", "User")
```

If you see `LLM_GATEWAY_API_KEY is not set` in a chat error, that's this —
nothing else needs configuring.

## Installation

Two files, two different places — opencode's plugin loader scans and
auto-invokes exports from *every* `.ts` file sitting directly inside
`plugins/`, not just ones exporting a real `Plugin`. Putting the routing
logic (`llm-router-core.ts`) in `plugins/` alongside the real plugin file
makes opencode call its internals directly at bootstrap with the wrong
arguments, and an uncaught rejection there corrupts opencode's whole
plugin/event system for the rest of the process — not just this provider.

`llm-router-core.ts` goes **one level up**, next to `opencode.jsonc`.
`llm-router.ts` — the only file that may sit inside `plugins/` — imports it
via `../llm-router-core.ts`, so the relative path only resolves if the two
are laid out exactly like this:

```
~/.config/opencode/
├── opencode.jsonc
├── llm-router-core.ts      <- all the routing logic
└── plugins/
    └── llm-router.ts       <- only this one goes in plugins/
```

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode\plugins" | Out-Null
Copy-Item llm-router-core.ts "$env:USERPROFILE\.config\opencode\llm-router-core.ts"
Copy-Item llm-router.ts "$env:USERPROFILE\.config\opencode\plugins\llm-router.ts"
```

Then in OpenCode pick the `llm-router` provider with any dummy API key for its
own auth prompt — it's never used; the real credential is `LLM_GATEWAY_API_KEY`
from `.env` / env vars.

## Tests

```bash
node --experimental-strip-types --test llm-router.test.js
```

## License

MIT