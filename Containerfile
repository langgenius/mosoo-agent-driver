ARG BUN_VERSION=1.4.0
FROM docker.io/oven/bun:${BUN_VERSION}@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS bun-runtime

FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe

# Keep this pin in sync with downstream mosoo apps/api/package.json -> @cloudflare/sandbox.
ARG CLAUDE_AGENT_SDK_VERSION=0.3.252
ARG BUN_VERSION
ARG OPENAI_RUNTIME_VERSION=0.152.0
ARG OPENCODE_VERSION=1.18.25

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN test "$(bun --version)" = "$BUN_VERSION"

# Install the Python runtime behind writable pip package declarations.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python-is-python3 \
    && rm -rf /var/cache/apt/* /var/lib/apt/lists/*

COPY environment-package-managers.json /etc/mosoo/environment-package-managers.json
COPY scripts/environment-package-manager-check.mjs /usr/local/libexec/mosoo/environment-package-manager-check.mjs

# Environment writes expose only package managers verified by this image.
# Check executables, parseable versions, and runtime aliases here so capability
# failures surface while building the image rather than during a user Run.
RUN node /usr/local/libexec/mosoo/environment-package-manager-check.mjs verify

# Native agent CLIs pre-installed so the driver can spawn them via PATH.
# Installed in a single npm invocation to keep the agent packages in one layer.
#
# Package -> binary -> runtime:
#   Claude native package                 -> claude           -> claude-agent-sdk
#   OpenAI app-server package             -> OpenAI CLI       -> openai-runtime
#   OpenCode baseline package             -> opencode         -> acp-fallback
#   bun (bun-runtime stage)               -> bun              -> driver launcher
#
RUN npm install -g --ignore-scripts \
      @anthropic-ai/claude-agent-sdk-linux-x64@${CLAUDE_AGENT_SDK_VERSION} \
      opencode-linux-x64-baseline@${OPENCODE_VERSION} \
      @openai/codex@${OPENAI_RUNTIME_VERSION} \
    && ln -s /usr/local/lib/node_modules/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode \
    && ln -s /usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/mosoo-claude-code \
    && codex --version \
    && codex app-server --help >/dev/null \
    && opencode --version \
    && opencode acp --help >/dev/null \
    && mosoo-claude-code --version \
    && rm -rf /root/.npm

ENV MOSOO_CLAUDE_CODE_EXECUTABLE=/usr/local/bin/mosoo-claude-code
ENV MOSOO_ACP_FALLBACK_COMMAND=opencode
ENV MOSOO_ACP_FALLBACK_ARGS=[\"acp\",\"--pure\"]

EXPOSE 20000-59999

COPY dist/driver.mjs /usr/local/bin/agent-driver
RUN chmod +x /usr/local/bin/agent-driver
