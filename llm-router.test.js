// Tests for the LLM router: a thin forward-and-relay to the AI Model Gateway.
// Run with: node --experimental-strip-types --test llm-router.test.js
//
// There used to be tiered free -> subscription -> api fallback logic HERE,
// with its own keys and its own round-robin. That decision now belongs
// entirely to the gateway (https://llm.ahfl.in/v1) — one place, used by
// every caller, not duplicated per-integration. These tests reflect that:
// they pin "the request reaches the gateway correctly, and whatever the
// gateway decides comes back unchanged" rather than any tiering behaviour.

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert"
import { routeChat } from "./llm-router-core.ts"

const ENV_KEYS = ["LLM_GATEWAY_API_KEY", "LLM_GATEWAY_BASE_URL"]

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

beforeEach(() => {
  clearEnv()
})

describe("forwarding to the gateway", () => {
  it("posts the exact body the AI SDK sent, unchanged — including model and stream", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-test"
    const calls = []
    const fetchMock = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const sentBody = { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }
    const res = await routeChat(sentBody, { headers: {} }, fetchMock)

    assert.strictEqual(res.status, 200)
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].url, "https://llm.ahfl.in/v1/chat/completions")
    assert.deepStrictEqual(calls[0].body, sentBody)
  })

  it("never substitutes a model name — the gateway decides what 'auto' means", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-test"
    let seenModel
    const fetchMock = async (_url, init) => {
      seenModel = JSON.parse(init.body).model
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    await routeChat({ model: "auto", messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(seenModel, "auto")
  })

  it("authenticates with Bearer <LLM_GATEWAY_API_KEY>", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-abc123"
    let seenAuth
    const fetchMock = async (_url, init) => {
      seenAuth = init.headers.get("Authorization")
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(seenAuth, "Bearer sk-gw-abc123")
  })

  it("preserves other headers the AI SDK sent (e.g. a session header), not just adding Authorization", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-test"
    let seenSession
    const fetchMock = async (_url, init) => {
      seenSession = init.headers.get("x-opencode-session")
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    await routeChat({ messages: [] }, { headers: { "x-opencode-session": "conv-42" } }, fetchMock)
    assert.strictEqual(seenSession, "conv-42")
  })

  it("defaults to https://llm.ahfl.in/v1 when LLM_GATEWAY_BASE_URL is unset", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-test"
    let seenUrl
    const fetchMock = async (url) => {
      seenUrl = url
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(seenUrl, "https://llm.ahfl.in/v1/chat/completions")
  })

  it("respects LLM_GATEWAY_BASE_URL when set, trailing slash and all", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-test"
    process.env.LLM_GATEWAY_BASE_URL = "https://staging.example.com/v1/"
    let seenUrl
    const fetchMock = async (url) => {
      seenUrl = url
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(seenUrl, "https://staging.example.com/v1/chat/completions")
  })
})

describe("the gateway's decision is relayed unchanged", () => {
  it("a successful response passes through verbatim", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-test"
    const upstreamBody = JSON.stringify({ choices: [{ message: { content: "hello" } }] })
    const fetchMock = async () => new Response(upstreamBody, { status: 200 })
    const res = await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(await res.text(), upstreamBody)
  })

  it("an error FROM THE GATEWAY (it already tried every tier) is relayed, not retried or rewritten", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-test"
    const errorBody = JSON.stringify({ error: { message: "no LLM keys configured", type: "no_provider" } })
    let calls = 0
    const fetchMock = async () => {
      calls++
      return new Response(errorBody, { status: 503 })
    }
    const res = await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(res.status, 503)
    assert.strictEqual(await res.text(), errorBody)
    assert.strictEqual(calls, 1, "no client-side retry — the gateway's 'everything failed' is final")
  })
})

describe("failure modes that never reach the gateway at all", () => {
  it("rejects cleanly, without calling fetch, when LLM_GATEWAY_API_KEY is not set", async () => {
    let called = false
    await assert.rejects(
      () => routeChat({ messages: [] }, { headers: {} }, async () => { called = true; return new Response(null) }),
      (err) => err.message.includes("LLM_GATEWAY_API_KEY") && err.status === 500,
    )
    assert.strictEqual(called, false)
  })

  it("turns a network-level failure (gateway unreachable) into a clean 502, not a crash", async () => {
    process.env.LLM_GATEWAY_API_KEY = "sk-gw-test"
    const fetchMock = async () => { throw new Error("ECONNREFUSED") }
    await assert.rejects(
      () => routeChat({ messages: [] }, { headers: {} }, fetchMock),
      (err) => err.status === 502 && err.message.includes("unreachable"),
    )
  })
})
