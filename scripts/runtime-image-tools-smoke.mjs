// Real native CLI + real shell tool, with deterministic loopback model replies.
// No credentials, external model, or inference latency are involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = (await readFile("/etc/mosoo/runtime", "utf8")).trim();
const runtimes = profile === "all" ? ["claude", "openai", "opencode"] : [profile];
for (const runtime of runtimes) {
  const cwd = await mkdtemp(join(tmpdir(), "mosoo-native-image-"));
  await chmod(cwd, 0o777);
  const marker = join(cwd, "marker.txt");
  const command = `printf 'native-tool-ok' > ${marker}`;
  let called = false;
  let requests = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url?.includes("count_tokens")) {
        res.end(JSON.stringify({ input_tokens: 5 }));
        return;
      }
      if (
        !req.url?.includes("messages") &&
        !req.url?.includes("responses") &&
        !req.url?.includes("chat/completions")
      ) {
        res.end("{}");
        return;
      }
      requests += 1;
      const tool = body.tools?.find((entry) =>
        /^(Bash|bash|exec_command|shell_command|shell)$/.test(entry.name ?? entry.function?.name),
      );
      const useTool = !called && tool !== undefined;
      if (useTool) called = true;
      const name = tool?.name ?? tool?.function?.name;
      const args =
        name === "exec_command"
          ? { cmd: command }
          : name === "shell"
            ? { command: ["sh", "-c", command] }
            : { command, description: "Write native runtime smoke marker" };
      res.setHeader("Content-Type", "text/event-stream");
      const event = (type, value) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (runtime === "claude") {
        const content = useTool
          ? { type: "tool_use", id: "tool_marker", name, input: args }
          : { type: "text", text: "OK" };
        const message = {
          id: `msg_${requests}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [content],
          stop_reason: useTool ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        };
        if (!body.stream) {
          res.end(JSON.stringify(message));
          return;
        }
        event("message_start", {
          type: "message_start",
          message: { ...message, content: [], stop_reason: null },
        });
        event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: useTool ? { ...content, input: {} } : { type: "text", text: "" },
        });
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: useTool
            ? { type: "input_json_delta", partial_json: JSON.stringify(args) }
            : { type: "text_delta", text: "OK" },
        });
        event("content_block_stop", { type: "content_block_stop", index: 0 });
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        event("message_stop", { type: "message_stop" });
      } else if (req.url.includes("responses")) {
        const item = useTool
          ? {
              type: "function_call",
              id: "fc_marker",
              call_id: "call_marker",
              name,
              arguments: JSON.stringify(args),
              status: "completed",
            }
          : {
              type: "message",
              id: "message_ok",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            };
        const response = {
          id: `resp_${requests}`,
          object: "response",
          created_at: 1,
          model: body.model,
          status: "completed",
          output: [item],
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        };
        event("response.created", {
          type: "response.created",
          response: { ...response, status: "in_progress", output: [] },
        });
        event("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item,
        });
        event("response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item,
        });
        event("response.completed", { type: "response.completed", response });
      } else {
        const chunk = (delta, finish_reason = null) =>
          res.write(
            `data: ${JSON.stringify({ id: `chat_${requests}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        chunk(
          useTool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_marker",
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              }
            : { role: "assistant", content: "OK" },
        );
        chunk({}, useTool ? "tool_calls" : "stop");
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const prompt = "Use your shell tool to write the requested marker, then finish.";
  const env = {
    ...process.env,
    HOME: cwd,
    XDG_CONFIG_HOME: cwd,
    XDG_CACHE_HOME: cwd,
    XDG_DATA_HOME: cwd,
    ANTHROPIC_API_KEY: "fixture",
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: "fixture",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      permission: "allow",
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: { baseURL: `${base}/v1`, apiKey: "fixture" },
          models: {
            fixture: { name: "Fixture", tool_call: true, limit: { context: 200000, output: 4096 } },
          },
        },
      },
    }),
  };
  const commands = {
    claude: [
      "mosoo-claude-code",
      "-p",
      prompt,
      "--model",
      "claude-sonnet-4-6",
      "--dangerously-skip-permissions",
    ],
    openai: [
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model="fixture"',
      "-c",
      'model_provider="local"',
      "-c",
      'model_providers.local.name="Fixture"',
      "-c",
      `model_providers.local.base_url="${base}/v1"`,
      "-c",
      'model_providers.local.wire_api="responses"',
      "-c",
      'model_providers.local.env_key="OPENAI_API_KEY"',
      prompt,
    ],
    opencode: ["opencode", "run", "--model", "local/fixture", prompt],
  };
  try {
    const [executable, ...args] = commands[runtime];
    let output = "";
    const child = spawn(executable, args, {
      cwd,
      env,
      uid: 65534,
      gid: 65534,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    try {
      const status = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      assert.equal(status, 0, `${runtime}: ${output.slice(-8000)}`);
      assert.equal(
        await readFile(marker, "utf8").catch(() => "missing"),
        "native-tool-ok",
        `${runtime} (${requests} requests): ${output.slice(-8000)}`,
      );
      assert.ok(requests >= 2, "Native runtime must return the tool result to the model");
      console.log(
        `${runtime}: real native shell tool round trip passed (${requests} model fixture requests)`,
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
}
