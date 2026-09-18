FROM docker.io/cloudflare/sandbox:0.12.6@sha256:862aa35be41b1b56bc27acd66931c8ae668fce12ed401ecb2e5a83bcde41a3e6

# Keep this pin in sync with downstream mosoo apps/api/package.json -> @cloudflare/sandbox.
ARG CLAUDE_AGENT_SDK_VERSION=0.3.211
ARG OPENAI_RUNTIME_VERSION=0.144.5
ARG OPENCODE_VERSION=1.18.4

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

# One build definition, with common tool layers shared by every runtime. The
# default preserves existing consumers; new single-runtime subjects select a
# profile at build time, never install a runtime on the task startup path.
ARG RUNTIME=all
COPY runtime-images.json /etc/mosoo/runtime-images.json
RUN set -eu; \
    case "$RUNTIME" in all|claude|openai|opencode) ;; *) echo "Unsupported RUNTIME: $RUNTIME" >&2; exit 1 ;; esac; \
    if [ "$RUNTIME" = all ] || [ "$RUNTIME" = claude ]; then \
      npm install -g --ignore-scripts @anthropic-ai/claude-agent-sdk-linux-x64@${CLAUDE_AGENT_SDK_VERSION}; \
      ln -s /usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/mosoo-claude-code; \
    fi; \
    if [ "$RUNTIME" = all ] || [ "$RUNTIME" = openai ]; then \
      npm install -g --ignore-scripts @openai/codex@${OPENAI_RUNTIME_VERSION}; \
    fi; \
    if [ "$RUNTIME" = all ] || [ "$RUNTIME" = opencode ]; then \
      npm install -g --ignore-scripts opencode-linux-x64-baseline@${OPENCODE_VERSION}; \
      ln -s /usr/local/lib/node_modules/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode; \
    fi; \
    printf '%s\n' "$RUNTIME" > /etc/mosoo/runtime; \
    rm -rf /root/.npm

LABEL ai.mosoo.runtime="${RUNTIME}"
COPY scripts/runtime-image-check.mjs /usr/local/libexec/mosoo/runtime-image-check.mjs
RUN node /usr/local/libexec/mosoo/runtime-image-check.mjs

ENV MOSOO_CLAUDE_CODE_EXECUTABLE=/usr/local/bin/mosoo-claude-code
ENV MOSOO_ACP_FALLBACK_COMMAND=opencode
ENV MOSOO_ACP_FALLBACK_ARGS=[\"acp\",\"--pure\"]

EXPOSE 20000-59999

COPY dist/driver.mjs /usr/local/bin/agent-driver
RUN chmod +x /usr/local/bin/agent-driver
