# Image for running Conductor agents in per-issue containers.
#
# Contains git, bun, node and the four agent CLIs (codex, claude, grok, agy), installed from
# their official sources. It holds no credentials: Conductor copies each agent's login into
# the container at run time, and never GitHub tokens or SSH keys.
#
# Build (Apple Silicon -> linux/arm64):
#   docker build -f docker/agent.Dockerfile -t conductor-agent:latest .

ARG BUN_VERSION=1.3.11
FROM oven/bun:${BUN_VERSION} AS bun

FROM debian:bookworm-slim

ARG CODEX_VERSION=0.163.0
ARG CLAUDE_VERSION=2.1.307
ARG GROK_VERSION=1.0.62

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less procps ripgrep unzip xz-utils \
      nodejs npm python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# codex: npm package ships a native linux-arm64 / linux-x64 binary.
RUN npm install -g "@openai/codex@${CODEX_VERSION}" && npm cache clean --force

# Everything else installs per user under ~/.local/bin.
RUN useradd --create-home --shell /bin/bash --uid 1000 agent
USER agent
ENV HOME=/home/agent
ENV PATH=/home/agent/.local/bin:/home/agent/.grok/bin:$PATH
WORKDIR /home/agent

# claude: official installer, pinned version (checksum verified by the installer).
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}"
# grok: official installer, pinned version.
RUN curl -fsSL https://x.ai/cli/install.sh | bash -s "${GROK_VERSION}" \
 && mkdir -p /home/agent/.local/bin \
 && ln -sf /home/agent/.grok/bin/grok /home/agent/.local/bin/grok
# agy: official installer (always latest; sha512 verified by the installer).
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Git identity for local commits made inside the container. Pushing is done by Conductor
# on the host, so no credentials are configured here.
RUN git config --global user.name "Conductor Agent" \
 && git config --global user.email "conductor-agent@users.noreply.github.com" \
 && git config --global init.defaultBranch main \
 && git config --global --add safe.directory '*'

# Print versions at build time so the build log records what was installed.
RUN set -e; codex --version; claude --version; grok --version; agy --version; bun --version; git --version

WORKDIR /work
CMD ["sleep", "infinity"]
