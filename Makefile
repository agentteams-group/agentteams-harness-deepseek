include versions.env

IMAGE ?= ghcr.io/agentteams-group/agentteams-harness-deepseek
VERSION ?= dev
PLATFORMS ?= linux/amd64,linux/arm64
AT_SOURCE ?= https://github.com/agentscope-ai/AgentTeams.git\#$(AT_REF)
SHARED_CONTEXT ?= $(AT_SOURCE):shared/lib
TEAMHARNESS_CONTEXT ?= $(AT_SOURCE):plugins/teamharness
DOCKER_BUILD_ARGS ?=
BUILD_ARGS = --build-context agentteams=$(AT_SOURCE) --build-context shared=$(SHARED_CONTEXT) --build-context teamharness=$(TEAMHARNESS_CONTEXT) --build-arg DSH_VERSION=$(DSH_VERSION) $(DOCKER_BUILD_ARGS)

.PHONY: test build push smoke
test:
	npm install --prefix plugins/teamharness/adapters/deepseek-harness --ignore-scripts --no-package-lock --omit=optional
	PYTHONPATH="$(AT_SOURCE)/shared/lib:$(AT_SOURCE)/shared/lib/telemetry:$${PYTHONPATH:-}" python3 -m pytest tests -q
	node --test tests/*.test.mjs

build:
	docker buildx build --pull --load $(BUILD_ARGS) -t $(IMAGE):$(VERSION) .

push:
	docker buildx build --pull --push --platform $(PLATFORMS) $(BUILD_ARGS) -t $(IMAGE):$(VERSION) .

smoke:
	docker run --rm --network none --entrypoint python3 -v "$(CURDIR)/tests/git_bundle_smoke.py:/tmp/git_bundle_smoke.py:ro" $(IMAGE):$(VERSION) /tmp/git_bundle_smoke.py
	docker run --rm --entrypoint python3 -e PYTHONPATH=/opt/agentteams/scripts:/opt/agentteams/scripts/lib -v "$(CURDIR)/tests/headless_smoke.py:/tmp/headless_smoke.py:ro" $(IMAGE):$(VERSION) /tmp/headless_smoke.py
	docker run --rm --entrypoint node -e AGENTTEAMS_INTERACTIONS_MODULE=/opt/agentteams/plugins/teamharness/adapters/deepseek-harness/matrix-interactions.js -v "$(CURDIR)/tests/native/matrix-interactions.mjs:/opt/agentteams/dsh/test-matrix-interactions.mjs:ro" $(IMAGE):$(VERSION) --test /opt/agentteams/dsh/test-matrix-interactions.mjs
	docker run --rm --entrypoint node -e AGENTTEAMS_INTERACTIONS_MODULE=/opt/agentteams/plugins/teamharness/adapters/deepseek-harness/matrix-interactions.js -v "$(CURDIR)/tests/native/matrix-progress.mjs:/opt/agentteams/dsh/test-matrix-progress.mjs:ro" $(IMAGE):$(VERSION) --test /opt/agentteams/dsh/test-matrix-progress.mjs
	docker run --rm --entrypoint node -v "$(CURDIR)/tests/native/recovery-mcp.mjs:/opt/agentteams/dsh/test-recovery-mcp.mjs:ro" $(IMAGE):$(VERSION) --test /opt/agentteams/dsh/test-recovery-mcp.mjs
	# Direct module import needs the runtime peer dependencies normally provided by the DSH loader.
	docker run --rm --entrypoint /bin/sh -e AGENTTEAMS_MANAGED_NATIVE_MODULE=/opt/agentteams/dsh-template/profiles/headless/node_modules/agentteams-teamharness-dsh/managed-native.js -v "$(CURDIR)/tests/native/managed-input.mjs:/opt/agentteams/dsh/test-managed-input.mjs:ro" -v "$(CURDIR)/tests/native/sandbox-refusal.mjs:/opt/agentteams/dsh/test-sandbox-refusal.mjs:ro" -e AGENTTEAMS_DSH_PATCH=/opt/agentteams/plugins/teamharness/adapters/deepseek-harness/cordis.patch.yml -v "$(CURDIR)/tests/native/model-protocol.mjs:/opt/agentteams/dsh/test-model-protocol.mjs:ro" -v "$(CURDIR)/tests/native/read-failure.mjs:/opt/agentteams/dsh/test-read-failure.mjs:ro" $(IMAGE):$(VERSION) -ec 'ln -s /opt/agentteams/dsh/node_modules /opt/agentteams/dsh-template/node_modules; exec node --test /opt/agentteams/dsh/test-managed-input.mjs /opt/agentteams/dsh/test-sandbox-refusal.mjs /opt/agentteams/dsh/test-model-protocol.mjs /opt/agentteams/dsh/test-read-failure.mjs'
	docker run --rm --network none --entrypoint /bin/sh -e AGENTTEAMS_PUBLIC_TASK_MODULE=/opt/agentteams/dsh-template/profiles/headless/node_modules/agentteams-teamharness-dsh/public-task.js -e AGENTTEAMS_PLUGIN_DIR=/opt/agentteams/plugins/teamharness -v "$(CURDIR)/tests/native/public-task.mjs:/opt/agentteams/dsh/test-public-task.mjs:ro" $(IMAGE):$(VERSION) -ec 'ln -s /opt/agentteams/dsh/node_modules /opt/agentteams/dsh-template/node_modules; exec node --test /opt/agentteams/dsh/test-public-task.mjs'
	docker run --rm --network none --entrypoint /opt/venv/agentteams/bin/python3 -e PYTHONPATH=/opt/agentteams/scripts:/opt/agentteams/scripts/lib -e AGENTTEAMS_PLUGIN_DIR=/opt/agentteams/plugins/teamharness -e AGENTTEAMS_TEST_ADAPTER_SOURCE=/dm/plugins/teamharness/adapters/deepseek-harness -v "$(CURDIR):/dm:ro" $(IMAGE):$(VERSION) /dm/tests/native_trace_smoke.py

	# A real server-returned MCP error is terminal; a lost transport remains unconfirmed.
	docker run --rm --entrypoint /bin/sh -e PYTHONPATH=/opt/agentteams/scripts:/opt/agentteams/scripts/lib -v "$(CURDIR)/tests/native/mcp-policy.mjs:/opt/agentteams/tests/native/mcp-policy.mjs:ro" -v "$(CURDIR)/tests/native/mcp-session-recovery.mjs:/opt/agentteams/tests/native/mcp-session-recovery.mjs:ro" $(IMAGE):$(VERSION) -ec 'ln -s /opt/agentteams/dsh/node_modules /opt/agentteams/node_modules; exec node --test /opt/agentteams/tests/native/mcp-policy.mjs /opt/agentteams/tests/native/mcp-session-recovery.mjs'

direct-control-smoke:
	docker run --rm --entrypoint python3 -v "$(CURDIR):/dm:ro" -e PYTHONPATH=/dm/scripts $(IMAGE):$(VERSION) /dm/tests/direct_control_smoke.py steer
	docker run --rm --entrypoint python3 -v "$(CURDIR):/dm:ro" -e PYTHONPATH=/dm/scripts $(IMAGE):$(VERSION) /dm/tests/direct_control_smoke.py stop
