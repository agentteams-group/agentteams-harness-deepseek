ARG HIGRESS_REGISTRY=higress-registry.cn-hangzhou.cr.aliyuncs.com
ARG AGENTTEAMS_CONTROLLER_IMAGE=higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-controller:v1.2.6

FROM ${HIGRESS_REGISTRY}/higress/mc:20260216 AS mc

FROM ${AGENTTEAMS_CONTROLLER_IMAGE} AS controller

FROM node:24-bookworm-slim

ARG DSH_VERSION=0.1.1-rc.2
ARG NODE_MIN_VERSION=24.22.1
# Reject a stale/floating Node or a non-24 major, and enforce the 2026-10-21 floor.
# The base tag is floating; use docker build --pull to refresh it.
RUN node -e 'const requiredMajor=24; const [a,b,c]=process.versions.node.split(".").map(Number); const [x,y,z]=process.argv[1].split(".").map(Number); if (a!==requiredMajor || a<x || (a===x&&b<y) || (a===x&&b===y&&c<z)) { console.error(`Node ${process.versions.node} is not Node ${requiredMajor}.x >= ${process.argv[1]}`); process.exit(1) }' "${NODE_MIN_VERSION}"


RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        jq \
        python3 \
        tini \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=mc /usr/bin/mc /usr/local/bin/mc.bin
COPY --from=shared . /opt/agentteams/scripts/lib/
COPY --from=controller /usr/local/bin/agt /usr/local/bin/agt

COPY package.json /opt/agentteams/dsh/package.json
# Keep rc.2's Cordis services at its tested source snapshot versions.
# Newer compatible-range packages changed the loader/HMR service APIs.
RUN npm install --global "pnpm@11.7.0" \
    && npm install --prefix /opt/agentteams/dsh --omit=dev "@deepseek-ai/dsh@${DSH_VERSION}" \
    && ln -s /opt/agentteams/dsh/node_modules/.bin/dsh /usr/local/bin/dsh \
    && npm cache clean --force

# rc.2 overwrites a streamed tool ID with empty continuation deltas. Keep
# the earlier ID so tool results remain valid when sessions are restored.
RUN python3 - <<'PY'
from pathlib import Path
path = Path('/opt/agentteams/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js')
source = path.read_text()
old = 'if (call.id !== void 0) block.callId = call.id;'
assert source.count(old) == 1, 'Revalidate the DSH tool-call ID compatibility fix'
path.write_text(source.replace(old, 'if (call.id) block.callId = call.id;'))
PY

COPY --from=teamharness . /opt/agentteams/plugins/teamharness/
COPY plugins/teamharness/adapters/deepseek-harness/ /opt/agentteams/plugins/teamharness/adapters/deepseek-harness/
RUN mkdir -p /opt/agentteams/dsh-template /tmp/adapter-pack \
    && DSH_HOME=/opt/agentteams/dsh-template pnpm --dir /opt/agentteams/plugins/teamharness/adapters/deepseek-harness pack --pack-destination /tmp/adapter-pack \
    && DSH_HOME=/opt/agentteams/dsh-template dsh plugin --profile headless add /tmp/adapter-pack/*.tgz \
    && rm -rf /tmp/adapter-pack

COPY scripts/deepseek-harness-worker-entrypoint.sh /opt/agentteams/scripts/deepseek-harness-worker-entrypoint.sh
COPY scripts/agentteams-dsh /usr/local/bin/agentteams-dsh
COPY scripts/bridge_state.py /opt/agentteams/scripts/bridge_state.py
COPY scripts/matrix_channel.py /opt/agentteams/scripts/matrix_channel.py
COPY scripts/matrix_bridge.py /opt/agentteams/scripts/matrix_bridge.py
COPY scripts/runtime_env.py /opt/agentteams/scripts/runtime_env.py

RUN chmod +x /opt/agentteams/scripts/lib/mc-wrapper.sh \
        /opt/agentteams/scripts/deepseek-harness-worker-entrypoint.sh \
        /opt/agentteams/scripts/matrix_bridge.py \
        /opt/agentteams/scripts/runtime_env.py \
        /usr/local/bin/agentteams-dsh \
    && ln -sf /opt/agentteams/scripts/lib/mc-wrapper.sh /usr/local/bin/mc \
    && mkdir -p /root/agentteams-fs/agents

WORKDIR /root/agentteams-fs/agents
EXPOSE 8088
COPY --from=controller \
    /opt/agentteams/agent/skills/worker-management/scripts/install-worker-skill.sh \
    /opt/agentteams/agent/skills/worker-management/scripts/safe-extract-worker-skill.py \
    /opt/agentteams/agent/skills/worker-management/scripts/push-worker-skills.sh \
    /opt/agentteams/agent/skills/worker-management/scripts/

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/agentteams/scripts/deepseek-harness-worker-entrypoint.sh"]
