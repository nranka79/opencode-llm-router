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
// optional local `.env` file next to this plugin (or in the working directory)
// as a convenient place to keep them. `.env` is gitignored — never commit keys.

import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const DOT_ENV_CANDIDATES = [
  join(process.cwd(), ".env"),
  join(dirname(fileURLToPath(import.meta.url)), ".env"),
]

function loadDotEnv(): void {
  for (const path of DOT_ENV_CANDIDATES) {
    if (!existsSync(path)) continue
    try {
      const raw = readFileSync(path, "utf8")
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq < 0) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = value
        }
      }
    } catch {
      // ignore unreadable .env — fall back to real env vars
    }
  }
}

loadDotEnv()

type Entry = {
  id: string
  base: string // chat/completions endpoint base, no trailing slash
  key: string
  model: string
  authHeader?: "bearer" | "api-key"
}

let freeIndex = 0
let subIndex = 0
let apiIndex = 0

const DEAD_STATUSES = new Set([401, 402, 403, 429])

// Test-only: reset round-robin indices between test cases.
export function resetForTests(): void {
  freeIndex = 0
  subIndex = 0
  apiIndex = 0
}

function env(name: string): string {
  return (process.env[name] || "").trim()
}

// base env is entry 1; base_2, base_3, ... follow until first unset.
function envSeries(base: string, max = 8): string[] {
  const out: string[] = []
  const first = env(base)
  if (first) out.push(first)
  for (let i = 2; i <= max; i++) {
    const v = env(`${base}_${i}`)
    if (!v) break
    out.push(v)
  }
  return out
}

function buildPools() {
  const freeKeys = envSeries("TOKENHARBOR_API_KEY")
  const freePool: Entry[] = freeKeys.map((k, i) => ({
    id: `tokenharbor-free-${i}`,
    base: "https://tokenharbor.ai/v1",
    key: k,
    model: "deepseek-v4-flash:free",
  }))

  const goKeys = [
    env("OPENCODE_GO_KEY_1"),
    env("OPENCODE_GO_KEY_2"),
    env("OPENCODE_GO_KEY_3"),
    env("OPENCODE_GO_KEY_4"),
    env("OPENCODE_GO_KEY_5"),
  ].filter(Boolean)
  const subscriptionPool: Entry[] = goKeys.map((k, i) => ({
    id: `opencode-go-${i}`,
    base: "https://opencode.ai/zen/go/v1",
    key: k,
    model: "deepseek-v4-flash",
  }))

  const orKeys = envSeries("OPENROUTER_API_KEY")
  const orModel = env("OPENROUTER_MODEL") || "deepseek/deepseek-chat"
  const apiPool: Entry[] = orKeys.map((k, i) => ({
    id: `openrouter-${i}`,
    base: "https://openrouter.ai/api/v1",
    key: k,
    model: orModel,
  }))
  if (freeKeys.length) {
    apiPool.push({
      id: "tokenharbor-paid",
      base: "https://tokenharbor.ai/v1",
      key: freeKeys[0],
      model: "deepseek-v4-flash",
    })
  }
  const azKey = env("AZURE_OPENAI_API_KEY")
  const azEndpoint = env("AZURE_OPENAI_ENDPOINT")
  const azDeployment = env("AZURE_OPENAI_DEPLOYMENT")
  const azApiVersion = env("AZURE_OPENAI_API_VERSION") || "2024-08-01-preview"
  if (azKey && azEndpoint && azDeployment) {
    apiPool.push({
      id: "azure",
      base: `${azEndpoint.replace(/\/$/, "")}/openai/deployments/${azDeployment}?api-version=${azApiVersion}`,
      key: azKey,
      model: "deepseek-v4-flash",
      authHeader: "api-key",
    })
  }

  return { freePool, subscriptionPool, apiPool }
}

export async function routeChat(
  rawBody: Record<string, unknown>,
  init: RequestInit | undefined,
  doFetch: typeof globalThis.fetch,
): Promise<Response> {
  const { freePool, subscriptionPool, apiPool } = buildPools()

  const tiers: { name: string; pool: Entry[]; next: () => number }[] = [
    { name: "free", pool: freePool, next: () => freeIndex++ },
    { name: "subscription", pool: subscriptionPool, next: () => subIndex++ },
    { name: "api", pool: apiPool, next: () => apiIndex++ },
  ]

  let lastStatus = 503
  let lastDetail = "no LLM keys configured in any tier"

  for (const tier of tiers) {
    const n = tier.pool.length
    if (n === 0) continue

    const start = tier.next() % n
    for (let i = 0; i < n; i++) {
      const entry = tier.pool[(start + i) % n]
      const headers = new Headers(init?.headers)
      if (entry.authHeader === "api-key") {
        headers.delete("Authorization")
        headers.set("api-key", entry.key)
      } else {
        headers.set("Authorization", `Bearer ${entry.key}`)
      }
      const payload = { ...rawBody, model: entry.model }
      const out = JSON.stringify(payload)
      headers.set("Content-Length", String(out.length))
      headers.set("Content-Type", "application/json")

      let res: Response
      try {
        res = await doFetch(`${entry.base.replace(/\/$/, "")}/chat/completions`, {
          ...init,
          method: "POST",
          headers,
          body: out,
        })
      } catch (e) {
        lastStatus = 502
        lastDetail = `${entry.id}: ${e}`
        continue
      }

      if (DEAD_STATUSES.has(res.status) || res.status >= 500) {
        lastStatus = res.status
        lastDetail = `${entry.id}: HTTP ${res.status}`
        continue
      }
      return res
    }
  }

  throw Object.assign(new Error(`All LLM router tiers exhausted: ${lastDetail}`), {
    status: lastStatus,
  })
}

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
            return routeChat(rawBody, init, globalThis.fetch)
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
