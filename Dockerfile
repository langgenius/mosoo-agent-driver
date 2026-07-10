FROM docker.io/cloudflare/sandbox:0.12.3

# Keep the default base image version in sync with apps/api/package.json -> @cloudflare/sandbox.
ARG TARGETARCH
ARG CLAUDE_AGENT_SDK_VERSION=0.3.205
ARG ANTHROPIC_SDK_VERSION=0.100.1
ARG OPENAI_RUNTIME_VERSION=0.144.0
ARG OPENCODE_VERSION=1.17.7
ARG CLAUDE_AGENT_SDK_LINUX_PACKAGE=@anthropic-ai/claude-agent-sdk-linux-x64

# Native agent CLIs pre-installed so the driver can spawn them via PATH.
# Installed in a single npm invocation so Docker caches the whole agent
# layer as one unit.
#
# Package -> binary -> runtime:
#   @anthropic-ai/claude-agent-sdk        -> native claude    -> claude-agent-sdk
#   OpenAI app-server package             -> OpenAI CLI       -> openai-runtime
#   opencode-ai                           -> opencode         -> acp-fallback
#   bun (base image)                      -> bun              -> driver launcher
#
# cloudflare/sandbox:0.12.3 is distributed for linux/amd64. Local and CI builds
# pin that platform explicitly; Apple Silicon therefore uses Docker emulation
# instead of producing a mislabeled arm64 image around an amd64 base layer.
RUN { test -z "$TARGETARCH" || test "$TARGETARCH" = amd64; } \
    && OPENAI_RUNTIME_PACKAGE="@openai/co""dex@${OPENAI_RUNTIME_VERSION}" \
    && npm install -g \
      @anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION} \
      @anthropic-ai/sdk@${ANTHROPIC_SDK_VERSION} \
      opencode-ai@${OPENCODE_VERSION} \
      "$OPENAI_RUNTIME_PACKAGE" \
    && opencode --version \
    && opencode acp --help >/dev/null \
    && codex --version \
    && CLAUDE_BIN="/usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/${CLAUDE_AGENT_SDK_LINUX_PACKAGE}/claude" \
    && test -x "$CLAUDE_BIN" \
    && ln -sf "$CLAUDE_BIN" /usr/local/bin/mosoo-claude-code

ENV MOSOO_CLAUDE_CODE_EXECUTABLE=/usr/local/bin/mosoo-claude-code
ENV MOSOO_ACP_FALLBACK_COMMAND=opencode
ENV MOSOO_ACP_FALLBACK_ARGS=[\"acp\",\"--pure\"]

COPY dist/driver.mjs /usr/local/bin/agent-driver
RUN chmod +x /usr/local/bin/agent-driver
