// Core routing logic for the llm-router plugin, kept in a separate module
// from llm-router.ts on purpose.
//
// opencode's plugin loader scans EVERY named export of a .ts file sitting in
// the plugins directory and, for exports whose shape matches a fetch-style
// transport, invokes them directly as part of its own bootstrap self-test —
// bypassing whatever try/catch wrapping exists inside the real auth.loader
// closure entirely. Our test suite needs `routeChat`/`resetForTests` as
// named exports, but opencode must never see them: if it does, it calls
// `routeChat(body, init)` itself with only 2 args (no fetch impl), which
// throws, and an uncaught throw during that bootstrap probe corrupts
// opencode's whole plugin/event system for the rest of the process — not
// just this provider (confirmed by testing on 2026-09-18/19).
//
// So: this file holds the real logic and IS exported for `node --test`.
// llm-router.ts (the file actually deployed into opencode's plugins dir)
// imports from here and exports nothing but the `LlmRouterPlugin` factory.

import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import * as http from "node:http"
import * as https from "node:https"

// opencode's plugin sandbox does NOT expose a working `globalThis.fetch` at
// the point it invokes a provider's custom auth transport (confirmed by
// testing: fetch is a function at module-eval time but calling it inside the
// transport closure throws "doFetch is not a function" — the closure runs in
// a stripped context). `node:http`/`node:https` imports work fine in that
// same context, so we hand-roll a fetch-shaped function on top of them.
// `Response`/`Headers` globals ARE available (Web-standard classes, not
// network I/O), so we still return a real `Response` for the AI SDK to parse.
export function nodeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(url)
    } catch (e) {
      reject(e)
      return
    }
    const lib = target.protocol === "http:" ? http : https

    const headerObj: Record<string, string> = {}
    if (init.headers) {
      new Headers(init.headers as HeadersInit).forEach((value, key) => {
        headerObj[key] = value
      })
    }

    const bodyStr =
      typeof init.body === "string"
        ? init.body
        : init.body != null
          ? String(init.body)
          : undefined

    const req = lib.request(
      target,
      { method: init.method || "GET", headers: headerObj },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          const buf = Buffer.concat(chunks)
          const respHeaders = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const v of value) respHeaders.append(key, v)
            } else if (value !== undefined) {
              respHeaders.set(key, value)
            }
          }
          resolve(
            new Response(buf, {
              status: res.statusCode || 0,
              statusText: res.statusMessage || "",
              headers: respHeaders,
            }),
          )
        })
      },
    )
    req.on("error", reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

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
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
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
