// Tests for the tiered LLM router: free -> subscription -> api (paid).
// Run with: node --experimental-strip-types --test llm-router.test.js

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert"
import { routeChat, resetForTests } from "./llm-router.ts"

const ENV_KEYS = [
  "TOKENHARBOR_API_KEY", "TOKENHARBOR_API_KEY_2",
  "OPENCODE_GO_KEY_1", "OPENCODE_GO_KEY_2", "OPENCODE_GO_KEY_3", "OPENCODE_GO_KEY_4", "OPENCODE_GO_KEY_5",
  "OPENROUTER_API_KEY", "OPENROUTER_API_KEY_2", "OPENROUTER_MODEL",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT",
]

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

beforeEach(() => {
  resetForTests()
  clearEnv()
})

describe("tier order: free -> subscription -> api", () => {
  it("uses free tier when it succeeds, never touches other tiers", async () => {
    process.env.TOKENHARBOR_API_KEY = "thk_free"
    process.env.OPENCODE_GO_KEY_1 = "sk-sub"
    process.env.OPENROUTER_API_KEY = "sk-or"

    const calls = []
    const fetchMock = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const res = await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(calls.length, 1, "only free tier called")
    assert.ok(calls[0].url.includes("tokenharbor.ai"))
    assert.strictEqual(calls[0].body.model, "deepseek-v4-flash:free")
  })

  it("falls through free -> subscription when free tier is dead (402)", async () => {
    process.env.TOKENHARBOR_API_KEY = "thk_free_dead"
    process.env.OPENCODE_GO_KEY_1 = "sk-sub"

    const calls = []
    const fetchMock = async (url) => {
      calls.push(url)
      if (url.includes("tokenharbor.ai")) {
        return new Response(JSON.stringify({ error: "balance_zero" }), { status: 402 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const res = await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(calls.length, 2)
    assert.ok(calls[0].includes("tokenharbor.ai"))
    assert.ok(calls[1].includes("opencode.ai"))
  })

  it("falls through subscription -> api when all opencode-go keys are exhausted (429)", async () => {
    process.env.OPENCODE_GO_KEY_1 = "sk-a"
    process.env.OPENCODE_GO_KEY_2 = "sk-b"
    process.env.OPENROUTER_API_KEY = "sk-or"

    let subCalls = 0
    const fetchMock = async (url) => {
      if (url.includes("opencode.ai")) { subCalls++; return new Response(null, { status: 429 }) }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const res = await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(subCalls, 2, "both opencode-go keys tried before falling to api tier")
  })

  it("api tier tries openrouter before token-harbor-paid (once free tier is dead)", async () => {
    process.env.TOKENHARBOR_API_KEY = "thk_paid"
    process.env.OPENROUTER_API_KEY = "sk-or"

    const order = []
    const fetchMock = async (url, init) => {
      const body = JSON.parse(init.body)
      if (url.includes("tokenharbor.ai") && body.model.endsWith(":free")) {
        order.push("tokenharbor-free"); return new Response(null, { status: 402 })
      }
      if (url.includes("openrouter.ai")) { order.push("openrouter"); return new Response(null, { status: 429 }) }
      if (url.includes("tokenharbor.ai")) { order.push("tokenharbor-paid"); return new Response(JSON.stringify({ ok: true }), { status: 200 }) }
      return new Response(null, { status: 500 })
    }

    const res = await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(order, ["tokenharbor-free", "openrouter", "tokenharbor-paid"])
  })

  it("azure inactive without full config (endpoint+deployment missing) -> rejects", async () => {
    process.env.AZURE_OPENAI_API_KEY = "az-key"
    let called = false
    const fetchMock = async () => { called = true; return new Response(null, { status: 200 }) }
    await assert.rejects(() => routeChat({ messages: [] }, { headers: {} }, fetchMock))
    assert.strictEqual(called, false, "azure not called without full config")
  })

  it("azure uses api-key header, not Authorization, once fully configured", async () => {
    process.env.AZURE_OPENAI_API_KEY = "az-key"
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com"
    process.env.AZURE_OPENAI_DEPLOYMENT = "deploy1"

    const seen = { authHeader: null, apiKeyHeader: null }
    const fetchMock = async (url, init) => {
      seen.authHeader = init.headers.get("Authorization")
      seen.apiKeyHeader = init.headers.get("api-key")
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const res = await routeChat({ messages: [] }, { headers: {} }, fetchMock)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(seen.authHeader, null)
    assert.strictEqual(seen.apiKeyHeader, "az-key")
  })
})

describe("exhaustion", () => {
  it("throws when every configured tier/entry fails", async () => {
    process.env.TOKENHARBOR_API_KEY = "thk_dead"
    process.env.OPENCODE_GO_KEY_1 = "sk-dead"
    const fetchMock = async () => new Response(null, { status: 429 })
    await assert.rejects(
      () => routeChat({ messages: [] }, { headers: {} }, fetchMock),
      (err) => err.message.includes("All LLM router tiers exhausted"),
    )
  })

  it("throws immediately when zero keys configured anywhere", async () => {
    await assert.rejects(() => routeChat({ messages: [] }, { headers: {} }, async () => {
      throw new Error("should never be called")
    }))
  })
})
