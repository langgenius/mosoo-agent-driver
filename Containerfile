FROM cloudflare/sandbox:0.12.3

# Keep the default base image version in sync with apps/api/package.json -> @cloudflare/sandbox.
ARG CLAUDE_AGENT_SDK_VERSION=0.3.211
ARG OPENAI_RUNTIME_VERSION=0.144.5
ARG OPENCODE_VERSION=1.18.4

# Environment package setup invokes `pip`, so the runtime image must provide it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip python-is-python3 \
    && rm -rf /var/cache/apt/* /var/lib/apt/lists/* \
    && python --version \
    && pip --version

# Native agent CLIs pre-installed so the driver can spawn them via PATH.
# Installed in a single npm invocation to keep the agent packages in one layer.
#
# Package -> binary -> runtime:
#   @anthropic-ai/claude-agent-sdk        -> native claude    -> claude-agent-sdk
#   OpenAI app-server package             -> OpenAI CLI       -> openai-runtime
#   opencode-ai                           -> opencode         -> acp-fallback
#   bun (base image)                      -> bun              -> driver launcher
#
# Install only the native Claude and OpenCode packages needed at runtime. The
# Driver bundle already contains the Claude SDK, while the x64 OpenCode baseline
# binary stays compatible with container hosts that do not expose AVX2.
RUN CLAUDE_ARCH_PACKAGE="$(node -p "'@anthropic-ai/claude-agent-sdk-linux-' + process.arch")" \
    && OPENCODE_ARCH_PACKAGE="$(node -p "'opencode-linux-' + process.arch + (process.arch === 'x64' ? '-baseline' : '')")" \
    && OPENAI_RUNTIME_PACKAGE="@openai/codex@${OPENAI_RUNTIME_VERSION}" \
    && npm install -g \
      "${CLAUDE_ARCH_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}" \
      "$OPENAI_RUNTIME_PACKAGE" \
    && npm install -g --ignore-scripts --omit=optional \
      opencode-ai@${OPENCODE_VERSION} \
      "${OPENCODE_ARCH_PACKAGE}@${OPENCODE_VERSION}" \
    && OPENCODE_PACKAGE_ROOT=/usr/local/lib/node_modules/opencode-ai \
    && OPENCODE_BIN="/usr/local/lib/node_modules/${OPENCODE_ARCH_PACKAGE}/bin/opencode" \
    && test -x "$OPENCODE_BIN" \
    && mkdir -p "$OPENCODE_PACKAGE_ROOT/bin" \
    && ln -f "$OPENCODE_BIN" "$OPENCODE_PACKAGE_ROOT/bin/opencode.exe" \
    && rm -rf "$OPENCODE_PACKAGE_ROOT/node_modules" \
    && codex --version \
    && codex app-server --help >/dev/null \
    && opencode --version \
    && opencode acp --help >/dev/null \
    && CLAUDE_BIN="/usr/local/lib/node_modules/${CLAUDE_ARCH_PACKAGE}/claude" \
    && test -x "$CLAUDE_BIN" \
    && ln -sf "$CLAUDE_BIN" /usr/local/bin/mosoo-claude-code \
    && npm cache clean --force

ENV MOSOO_CLAUDE_CODE_EXECUTABLE=/usr/local/bin/mosoo-claude-code
ENV MOSOO_ACP_FALLBACK_COMMAND=opencode
ENV MOSOO_ACP_FALLBACK_ARGS=[\"acp\",\"--pure\"]

EXPOSE 20000-59999

COPY dist/driver.mjs /usr/local/bin/agent-driver
RUN chmod +x /usr/local/bin/agent-driver
