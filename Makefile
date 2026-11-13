include versions.env

IMAGE ?= ghcr.io/agentteams-group/agentteams-harness-deepseek
VERSION ?= dev
PLATFORMS ?= linux/amd64,linux/arm64
AT_SOURCE ?= https://github.com/agentscope-ai/AgentTeams.git\#$(AT_REF)
SHARED_CONTEXT ?= $(AT_SOURCE):shared/lib
TEAMHARNESS_CONTEXT ?= $(AT_SOURCE):plugins/teamharness
DOCKER_BUILD_ARGS ?=
BUILD_ARGS = --build-context shared=$(SHARED_CONTEXT) --build-context teamharness=$(TEAMHARNESS_CONTEXT) --build-arg DSH_VERSION=$(DSH_VERSION) $(DOCKER_BUILD_ARGS)

.PHONY: test build push smoke
test:
	python3 -m unittest discover -s tests -p 'test_*.py' -v
	node --test tests/*.test.mjs

build:
	docker buildx build --pull --load $(BUILD_ARGS) -t $(IMAGE):$(VERSION) .

push:
	docker buildx build --pull --push --platform $(PLATFORMS) $(BUILD_ARGS) -t $(IMAGE):$(VERSION) .

smoke:
	docker run --rm --entrypoint python3 -v "$(CURDIR)/tests/headless_smoke.py:/tmp/headless_smoke.py:ro" $(IMAGE):$(VERSION) /tmp/headless_smoke.py

direct-control-smoke:
	docker run --rm --entrypoint python3 -v "$(CURDIR):/dm:ro" -e PYTHONPATH=/dm/scripts $(IMAGE):$(VERSION) /dm/tests/direct_control_smoke.py steer
	docker run --rm --entrypoint python3 -v "$(CURDIR):/dm:ro" -e PYTHONPATH=/dm/scripts $(IMAGE):$(VERSION) /dm/tests/direct_control_smoke.py stop
