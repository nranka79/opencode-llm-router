// Core routing logic for the llm-router plugin, kept in a separate module
// from llm-router.ts on purpose.
//
// opencode's plugin loader scans EVERY named export of a .ts file sitting in
// the plugins directory and, for exports whose shape matches a fetch-style
// transport, invokes them directly as part of its own bootstrap self-test —
// bypassing whatever try/catch wrapping exists inside the real auth.loader
// closure entirely. Our test suite needs `routeChat` as a named export, but
// opencode must never see them: if it does, it calls `routeChat(body, init)`
// itself with only 2 args (no fetch impl), which throws, and an uncaught
// throw during that bootstrap probe corrupts opencode's whole plugin/event
// system for the rest of the process — not just this provider (confirmed by
// testing on 2026-09-18/19).
//
// So: this file holds the real logic and IS exported for `node --test`.
// llm-router.ts (the file actually deployed into opencode's plugins dir)
// imports from here and exports nothing but the `LlmRouterPlugin` factory.

import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import * as http from "node:http"
import * as https from "node:https"

// One metering session per opencode process. The AI SDK does not expose a
// conversation id to this transport, so this groups the process's calls.
const PLUGIN_SESSION_ID = `opencode-${randomUUID()}`

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

function env(name: string): string {
  return (process.env[name] || "").trim()
}

// ---------------------------------------------------------------------------
// This plugin is a thin forward-and-relay, nothing more.
//
// It used to run its OWN free -> subscription -> api fallback locally, with
// its own keys for Token Harbor / OpenCode Go / OpenRouter / Azure. That
// duplicated — and could drift from — the exact same tiering logic already
// implemented, and kept current, on the AI Model Gateway (the Hermes VPS
// service at https://llm.ahfl.in/v1, source: `vps 2 residential tunnel/
// llm-gateway/server.py`). There is now exactly one place that decides which
// provider/bucket serves a request: the gateway. This plugin's only job is
// to get opencode's request there and relay whatever comes back, unchanged.
//
// Concretely: forward the body exactly as the AI SDK sent it — including
// `model` (opencode.jsonc configures this provider's one model as "auto",
// which the gateway already treats as "no preference, you decide, currently
// defaults to deepseek-v4-flash" — see `_requested_model` / DEFAULT_MODEL in
// server.py) and `stream` — to POST /v1/chat/completions, authenticated with
// a static key issued at admin.ahfl.in/gateway-keys (LLM_GATEWAY_API_KEY).
// That endpoint is the SAME one Hermes and every other first-party caller
// already use; nothing here is a second, parallel integration.
//
// A non-2xx response FROM THE GATEWAY (it has already tried every tier and
// given up) is relayed to the AI SDK exactly as received — the gateway's own
// error body is already OpenAI-shaped. Only a genuine failure to reach the
// gateway at all (DNS, TLS, connection refused) is caught and turned into a
// synthetic error here, because in that case there is no real response to
// relay.
export async function routeChat(
  rawBody: Record<string, unknown>,
  init: RequestInit | undefined,
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<Response> {
  const apiKey = env("LLM_GATEWAY_API_KEY")
  if (!apiKey) {
    throw Object.assign(
      new Error(
        "LLM_GATEWAY_API_KEY is not set. Issue one at https://admin.ahfl.in/gateway-keys and put it in .env — see .env.example.",
      ),
      { status: 500 },
    )
  }
  const base = (env("LLM_GATEWAY_BASE_URL") || "https://llm.ahfl.in/v1").replace(/\/$/, "")

  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${apiKey}`)
  headers.set("Content-Type", "application/json")
  // Usage-metering identity. The gateway records "unknown" when these are
  // absent; set LLM_GATEWAY_USER_ID / LLM_GATEWAY_USER_LABEL in .env.
  headers.set("X-Hermes-Client", "opencode")
  headers.set("X-Hermes-Platform", "opencode")
  const userId = env("LLM_GATEWAY_USER_ID")
  const userLabel = env("LLM_GATEWAY_USER_LABEL")
  if (userId) headers.set("X-Hermes-User-Id", userId)
  if (userLabel) headers.set("X-Hermes-User-Label", userLabel)
  const bodySession = typeof rawBody.session_id === "string" ? rawBody.session_id : ""
  const incomingSession = new Headers(init?.headers).get("x-opencode-session") || ""
  headers.set("X-Hermes-Session-Id", bodySession || incomingSession || PLUGIN_SESSION_ID)
  const out = JSON.stringify(rawBody)
  headers.set("Content-Length", String(Buffer.byteLength(out)))

  let res: Response
  try {
    res = await doFetch(`${base}/chat/completions`, {
      ...init,
      method: "POST",
      headers,
      body: out,
    })
  } catch (e) {
    throw Object.assign(new Error(`AI Model Gateway unreachable at ${base}: ${e}`), { status: 502 })
  }
  return res
}
