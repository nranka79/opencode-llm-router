# opencode-llm-router

A tiered LLM router plugin for [OpenCode](https://opencode.ai). It makes an
`llm-router` auth provider available to the OpenCode / Anti-Gravity extension.
Whenever the extension asks for an LLM, this plugin wraps the request and calls
the local LLM gateway routing order:

| Tier | Backing | Keys | Model |
|---|---|---|---|
| 1. free | Token Harbor | `TOKENHARBOR_API_KEY[,_2,_3,...]` | `deepseek-v4-flash:free` |
| 2. subscription | OpenCode Go (round-robin) | `OPENCODE_GO_KEY_1..5` | `deepseek-v4-flash` |
| 3. api (paid) | OpenRouter → Token Harbor paid → Azure OpenAI | `OPENROUTER_API_KEY[...]`, `AZURE_*` | `deepseek/deepseek-chat` |

A tier is skipped entirely when it has zero usable keys. Within a tier, entries
are tried round-robin and any entry that `401/402/403/429/5xx`'s is skipped in
favor of the next one, then the next tier.

## Why keys live in `.env` (never in git)

The router reads all credentials from environment variables. A convenient local
`.env` file is auto-loaded at plugin startup from the working directory or from
next to `llm-router-core.ts` (i.e. `~/.config/opencode/.env`, not inside
`plugins/`). `.env` is listed in `.gitignore` and must never be committed.

To set up your keys:

```powershell
Copy-Item .env.example .env
# edit .env, paste your real keys, save
```

Or set them as user environment variables:

```powershell
[Environment]::SetEnvironmentVariable("OPENCODE_GO_KEY_5", "sk-your-key", "User")
```

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

Then in OpenCode pick the `llm-router` provider with any dummy API key — the real
keys come from `.env` / env vars.

## Tests

```bash
node --experimental-strip-types --test llm-router.test.js
```

## License

MIT