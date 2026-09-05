/**
 * llm-call.mjs — the stream-vs-create client dispatch.
 *
 * The SDK hard-refuses a non-streaming create() at large max_tokens
 * ("Streaming is required for operations that may take longer than 10
 * minutes") — found live when WF_WRITEUP_IMPORT_MAX_TOKENS=49152 was first
 * actually used. callModelDetailed must prefer messages.stream() when the
 * client has one, and keep the create() path for SDK-shaped mocks/offline
 * clients that don't.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callModelDetailed } from "../mutation-engine/llm-call.mjs";

const MESSAGE = {
  content: [{ type: "text", text: '{"ok":true}' }],
  stop_reason: "end_turn"
};

test("prefers messages.stream().finalMessage() when the client provides stream", async () => {
  const calls = { stream: 0, create: 0 };
  let streamedRequest = null;
  const client = {
    messages: {
      stream(request) {
        calls.stream += 1;
        streamedRequest = request;
        return { finalMessage: async () => MESSAGE };
      },
      create: async () => {
        calls.create += 1;
        return MESSAGE;
      }
    }
  };

  const result = await callModelDetailed("prompt text", { client, model: "m", maxTokens: 49152 });

  assert.equal(calls.stream, 1);
  assert.equal(calls.create, 0);
  assert.equal(streamedRequest.max_tokens, 49152);
  assert.equal(streamedRequest.model, "m");
  assert.deepEqual(streamedRequest.messages, [{ role: "user", content: "prompt text" }]);
  assert.deepEqual(result, { text: '{"ok":true}', truncated: false });
});

test("falls back to messages.create for a client without stream (mocks/offline)", async () => {
  let createdRequest = null;
  const client = {
    messages: {
      create: async (request) => {
        createdRequest = request;
        return { content: [{ type: "text", text: "cut off" }], stop_reason: "max_tokens" };
      }
    }
  };

  const result = await callModelDetailed("prompt text", { client, model: "m" });

  assert.equal(createdRequest.max_tokens, 2048);
  assert.deepEqual(result, { text: "cut off", truncated: true });
});
