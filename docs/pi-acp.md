# Pi through the shared ACP backend (first Driver contribution)

## Scope

This port follows upstream `main` at `fd87f89c649cb7b7f81432375b67aa5401388bcb`, including protocol **3** and its durable SDK interfaces. It adds the additive `pi-acp` runtime and transport to the Driver registry and boot/native-resume contracts. It uses the existing ACP backend, event publication, process supervision, and durable terminal admission. There is no Pi RPC backend or parallel event translator. OpenCode retains runtime/transport `acp-fallback`, its platform fallback command/arguments, and its existing capabilities.

This is a bounded, **full-access sandbox** integration, not a claim of complete Pi/ACP or Mosoo product support. The host must not offer capabilities marked unsupported below.

### Tested pair

| Package                           | Exact version | Published source gitHead                   |
| --------------------------------- | ------------- | ------------------------------------------ |
| `pi-acp`                          | `0.0.34`      | `b0581c9c1d675e634234674484247008b03d69b4` |
| `@earendil-works/pi-coding-agent` | `1.0.0`       | `a13d35a742c6ef8462812a28fbe1d8c8b7431c32` |

Both are exact devDependency and image pins. `pi-acp` remains version 0.0.34 with the reviewed local patch at `patches/pi-acp@0.0.34.patch`: Bun applies it through `patchedDependencies`, and the production image applies the same patch after checking the published JavaScript hash. The image checks installed package versions, executable versions, actual ACP initialize capabilities, and the installed patched `dist/index.js` against `runtime-images.json`'s `sourceSha256`. The published gitHead identifies the base package, not the local patch. The `pi` image profile includes both packages; `all` includes Pi alongside OpenCode. The fixed platform adapter is `/usr/local/bin/pi-acp`; it starts `/usr/local/bin/mosoo-pi`, a platform wrapper around `/usr/local/bin/pi`. Agent configuration cannot choose executables, argv, startup hooks, or library search paths.

## Pi v1.0.0 upgrade contract

Given the exact Pi 1.0.0 / patched pi-acp 0.0.34 pair, when the fixed launcher starts ACP and the adapter starts Pi RPC, then every stdout frame remains JSON and the frozen model is selected before readiness. Given persisted native state, when a fresh Driver loads it, then instructions, skills, tools and conversation resume without stale resource execution. Given a running shell tool, when cancellation arrives, then no delayed side effect survives. These scenarios are covered by the installed-pair contract suite and production-image smoke checks.

Pi 1.0.0 changes fullscreen TUI defaults, codemode image generation, OAuth and deferred MCP tool restoration. The upstream RPC implementation and wire docs are unchanged from 0.99.2. The fixed profile still disables project resources and extensions, verifies selected model/thinking settings and refreshes managed bootstrap files. New native features do not imply support in the frozen Driver profile: it still requires full access, text-only input, no MCP and no extra directories. Pi requires Node >=22.19.0.

`bun run test:pi-acp` is the current-pair contract. The additional `bun run test:pi-upgrade` is a one-time migration gate: the Linux fixture image retains Pi 0.99.2 at `/opt/pi-previous/node_modules/.bin/pi` and sets `PI_ACP_PREVIOUS_PI_COMMAND` accordingly. Enabling this gate without that previous executable fails explicitly. It creates old native state, switches to the installed 1.0.0 executable and validates history, tools and refreshed instructions using the same persisted paths. Production images contain only the current Pi version.

## Proxy and frozen configuration

The first contribution supports **only `execution.provider = "openai-compatible"` with the existing Mosoo Chat Completions proxy**. It consumes the host-generated variables `OPENAI_COMPATIBLE_API_KEY` (a short-lived Mosoo action grant, despite the historical name) and `OPENAI_COMPATIBLE_BASE_URL`. It does not accept a raw provider API key, discover models remotely, use ambient login state, or install anything at startup.

The URL is `/api/driver/llm/proxy/<credentialId>` under the host origin; Pi appends `/chat/completions`, **not `/v1`**. HTTPS is required except for loopback HTTP test fixtures. Remove only the leading selected provider prefix from `execution.model`; preserve any remaining slashes. The generated Pi provider `mosoo` contains exactly that wire model and an environment reference `$MOSOO_PI_PROXY_GRANT`, never the grant itself. ACP explicitly selects `mosoo/<wire model>` and verifies the returned current value before readiness, on both new and restored sessions. No hidden bootstrap inference request occurs.

Driver structural validation checks the two-segment action token, expiry, model, Chat Completions protocol, credential URL, Driver ID and generation. **This does not verify authenticity.** Only the Mosoo host verifies HMAC, app/credential authorization and the active generation. Driver accepts both current `projectId` and legacy `appId` claim shapes; at least one nonempty ownership field is required. No signing key is present in the sandbox. The proxy origin is trusted host-owned boot configuration: the host strips agent-supplied vendor variables and overwrites them with its generated proxy URL and grant. Driver structural validation does not independently authenticate that origin. The existing host grant is currently valid for 24 hours; expired input fails and the host must issue a new execution grant. A grant can expire during a turn; the proxy remains authoritative.

Supported frozen options are `providerOptions.pi.thinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`; default `off`). Other option keys are rejected, not silently ignored. Thinking configuration is selected/read back through ACP when offered; non-off effort requires the option. Generic custom model metadata, alternate APIs, fallback models, images and model switching are outside this contribution. The initial custom model uses a 128,000 context window and 16,384 output-token ceiling; these are integration limits, not inferred provider capabilities.

The Pi process environment is platform-allowlisted. Agent environment variables and artifact executable/Node/Python paths are not forwarded to this initial profile. This deliberately prevents model endpoints, executable hooks or ambient credentials from overriding the frozen configuration, but also means environment customizations need a later explicit policy. `PI_OFFLINE=1` disables Pi startup network operations. `npm_config_offline=true` suppresses pi-acp's separate `npm view` update check; npm invoked by a tool inherits this offline setting.

## Readiness and unsupported capabilities

| Capability                              | First contribution                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Text and thinking streaming             | Verified against the exact pair with a deterministic loopback model                                                                                          |
| Real write/edit/read and shell activity | Verified; tools execute inside Pi, not through ACP client filesystem approval                                                                                |
| Ordinary tool permissions               | **Unsupported**; `supervised` fails readiness. Extension UI confirmation is not an ordinary-tool security boundary                                           |
| Built-in tool restrictions              | Fail readiness; no claim of selective enforcement                                                                                                            |
| MCP                                     | **Unsupported**; any configured server fails readiness, including unavailable entries. Adapter storing `mcpServers` is not integration                       |
| Additional directories                  | Fail readiness; adapter does not advertise support                                                                                                           |
| Structured usage                        | Context-window occupancy is supported through ACP `usage_update` (`used`, `size`). Billed token totals and cost are not reported                             |
| Native continuation                     | Pi JSONL plus adapter map required; model/effort reselected before input                                                                                     |
| Cancellation and terminal outcomes      | Actual pair cancellation verified; shared backend load/recycle tests require Linux                                                                           |
| User slash commands                     | Rejected before ACP prompt. Adapter independently expands project templates and implements session/model commands, even when Pi template loading is disabled |

Pi's standard built-ins do not include every host catalog tool (for example web search). No per-tool parity claim is made. `full_access` means the sandbox is the isolation boundary; neither the wrapper nor the process supervisor is a sandbox or a defense against malicious shell code. Pi tools can read files and make network calls with sandbox permissions. The wrapper disables discovered and built-in extensions (including Pi 0.99 MCP/codemode), project approval and Pi prompt templates; it does not make arbitrary generated shell commands safe.

The pinned adapter emits anonymous assistant text chunks. The shared translator accepts their final aggregate under a Driver message identity only for `pi-acp`; generic ACP retains its native-message identity requirement. Whitespace-only output still fails as `acp.empty_turn`, and cancellation does not become successful completion.

The local adapter patch preserves Pi's final assistant outcome even after partial text: provider errors reject ACP `session/prompt` with a `RequestError`, which the shared backend admits as `run.failed`; native `length` becomes ACP `max_tokens` and then `run.failed`. A successful retry replaces an earlier error, while exhausted retries preserve failure. Explicit cancellation takes precedence over a concurrent provider error. Settlement and late RPC rejection check the pending turn's identity so they cannot settle the next queued turn. Error messages are bounded and do not expose arbitrary provider fields as ACP error data.

Main treats a failed `input.start` as fatal: the packed Driver reports the failed run, command and control-plane status before exiting with code 1. The production contract tests retain this behavior.

## State, instructions and Skills

Pi owns `<homePath>/pi-acp/.pi/agent/sessions/**`. pi-acp separately owns `<homePath>/pi-acp/.pi/pi-acp/session-map.json`. Preserve **both**, with the same absolute workspace/home layout, for cold continuation. Native references use `{ runtimeId: "pi-acp", kind: "acp_session_id", value }` and are incompatible with OpenCode references. Missing/stale native state fails restore rather than starting an unrelated session.

Generated `models.json`, `settings.json`, `mosoo-skills.sh`, `auth.json`, `trust.json`, `SYSTEM.md` and `APPEND_SYSTEM.md` are rebuilt before every backend start with mode 0600 through the existing Linux descriptor-relative atomic writer. The grant remains only in the child environment; auth/trust are reset. Session JSONL and the adapter map are not reset. Native instructions use the shared system-context builder, not a one-shot `READY` bootstrap message. Skills are materialized by the existing Host port. The wrapper sources `mosoo-skills.sh` to pass each selected absolute markdown path through an explicit `--skill` argument, with literal shell quoting. `--no-skills` disables native HOME/project discovery and `settings.skills` loading in Pi 1.0.0; explicit CLI Skills remain enabled. Rebuilding the argument file with an empty or refreshed selection revokes stale Skills while preserving native conversation and the adapter map. Project trust remains `never`.

The raw exact-pair contract fixture verifies new/cold restored model requests contain refreshed instructions and Skills and that hostile project settings, shell prefixes and discovered extensions are not loaded. It writes generated bytes to an isolated HOME so it can also run on macOS. A separate Linux Driver contract executes the production bootstrap writer and supervised backend against the real pinned adapter: it checks mode 0600, text-only completion, cold continuation, refreshed instructions, and absence of replayed output. Only the local executable resolution and test-owned child environment are replaced to use installed test dependencies.

Concurrent Drivers must not share a Pi runtime home. The host's existing single-owner/generation fencing and immutable workspace binding are required; the adapter map is not a multiwriter database. Process-tree cleanup does not replace sandbox teardown for escaped descendants.

## Verification on main

Given a valid managed grant and supported frozen configuration, when Pi starts, then it selects and verifies the single configured model before readiness. Given an unavailable native reference, when restoration fails, then startup fails without creating a replacement session. Given a completed turn, when a fresh Driver resumes the same Pi home and reference, then conversation memory survives without replayed output. Main's protocol-3 and durable SDK contracts remain authoritative.

Run `bun run test:pi-acp` for the installed patched pair, `bun test tests/pi-*.test.ts` for focused admission, bootstrap and adapter regression tests, and the repository's `bun run check` gate before publishing. Outcome contracts cover partial provider errors and truncation; adapter fixtures cover retries, cancellation races and queued-turn settlement; Skills contracts cover cold restore with empty and refreshed Host selections against ambient HOME/project Skills. These suites use deterministic fixtures and do not certify a live model or deployed Host.

CI additionally runs the production packed Driver contract in both `pi` and `all` images, with external networking disabled and a loopback model fixture. Run `bun run test:image:pi` only inside a production image containing the current `/usr/local/bin/agent-driver`, adapter and Pi executables, with the source checkout available. It checks that the installed Driver matches `dist/driver.mjs`, then exercises partial provider failure, truncation, native tools, cold conversation continuation and Skill revocation through the protocol. Installed-package admission and native tool smoke remain separate image checks. Test coverage and commands describe the required gates, not a claim that every gate has passed for this revision. Previous protocol-6 results do not certify the current merge.

## Mosoo product integration

The companion [Mosoo draft PR #654](https://github.com/langgenius/mosoo/pull/654) contains catalog admission, Cloudflare `SandboxPi` bindings/images, managed grant mapping, capability gating and checkpointed Pi-home persistence for the prior protocol-6 Driver. Its Host must be adapted to main's protocol-3 interfaces before consuming this merge. See [upstream compatibility](upstream-compatibility.md). This Driver change alone does not certify current Mosoo public-API or deployed cloud execution. Ordinary supervised tool approvals, MCP, images, additional directories and billed token/cost totals remain unsupported.
