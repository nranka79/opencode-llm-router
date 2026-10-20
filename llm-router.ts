import type { Plugin } from "@opencode-ai/plugin"

// Tiered LLM router — mirrors the Hermes VPS llm-gateway routing order:
//   1. free          — Token Harbor free deepseek-v4-flash (TOKENHARBOR_API_KEY[,_2,_3,...])
//   2. subscription  — OpenCode Go keys, round-robin (OPENCODE_GO_KEY_1..5)
//   3. api (paid)    — OpenRouter, then Token Harbor paid, then Azure OpenAI (if configured)
//
// A tier is skipped entirely when it has zero usable keys. Within a tier,
// entries are tried in round-robin order (persisted across calls) and any
// entry that 401/402/403/429/5xx's is skipped in favor of the next one, then
// the next tier. Azure uses `api-key` header instead of `Authorization: Bearer`.
//
// Keys are never hardcoded. They are read from environment variables, with an
// optional local `.env` file next to llm-router-core.ts (or in the working
// directory) as a convenient place to keep them. `.env` is gitignored — never
// commit keys.
//
// IMPORTANT — deploy layout: this file is what opencode actually loads from
// its plugins directory, and it must export NOTHING except `LlmRouterPlugin`.
// All routing logic lives in llm-router-core.ts, which must be deployed ONE
// LEVEL UP from the plugins directory (i.e. next to opencode.jsonc), NOT
// inside plugins/ alongside this file. opencode's plugin loader scans and
// auto-invokes exports from EVERY .ts file sitting directly inside plugins/,
// not just ones exporting a real Plugin — confirmed by testing: putting
// llm-router-core.ts inside plugins/ made opencode call its exported
// nodeFetch() with bogus args at bootstrap, and an uncaught rejection there
// corrupted opencode's whole plugin/event system for the rest of the
// process (broke every provider, not just this one). See SETUP.md.

import { routeChat, nodeFetch } from "../llm-router-core.ts"

export const LlmRouterPlugin: Plugin = async () => {
  return {
    auth: {
      provider: "llm-router",

      loader: async (getAuth) => {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}

        return {
          apiKey: "",
          async fetch(request, init) {
            let rawBody: Record<string, unknown> = {}
            try {
              rawBody = init?.body ? JSON.parse(init.body as string) : {}
            } catch {
              rawBody = {}
            }
            // Never let this throw / reject. opencode calls this transport
            // once at bootstrap (a live GET .../models discovery probe) for
            // any custom npm-provider with a plugin-supplied auth loader,
            // before any real chat happens. An uncaught rejection here
            // during that probe corrupts opencode's whole plugin/event
            // system for the rest of the process (confirmed by testing --
            // it broke every provider, not just this one). Always resolve
            // to a Response; real chat failures still surface to the user
            // via the AI SDK parsing this error body normally.
            try {
              return await routeChat(rawBody, init, nodeFetch)
            } catch (e: any) {
              const message = e?.message || String(e)
              const status = typeof e?.status === "number" ? e.status : 503
              return new Response(
                JSON.stringify({ error: { message, type: "llm_router_error" } }),
                { status, headers: { "content-type": "application/json" } },
              )
            }
          },
        }
      },

      methods: [
        {
          type: "api",
          label: "LLM Router (dummy value OK — real keys come from env vars)",
          authorize: async (inputs) => ({
            type: "success" as const,
            key: inputs?.key ?? "router",
          }),
        },
      ],
    },
  }
}
