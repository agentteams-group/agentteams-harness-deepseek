# agentteams-harness-deepseek

DeepSeek Harness runtime integration for [AgentTeams](https://github.com/agentscope-ai/AgentTeams).
Migrated from `deepseek-harness/` and `plugins/teamharness/adapters/deepseek-harness/`
at AgentTeams commit `67c8e807c4d210537b753f8121710181825bdfac` (Apache-2.0).

This experimental harness supports Worker and Team Leader roles. It preserves
the tested `@deepseek-ai/dsh@0.1.1-rc.2` dependency overrides and tool-call ID
compatibility fix. Manager runtime support is not implemented.

## Build and test

Docker BuildKit is required. Shared environment scripts and the common
TeamHarness bundle are fetched from the commit pinned in `versions.env`;
the DeepSeek adapter in this repository is overlaid on that bundle.

```sh
make test
make build
make smoke
```

Unit tests need Python 3.11+ and Node.js 22+ and use no model credentials.
The image smoke test runs the real packaged DSH CLI with a deterministic
local model fixture, including tool execution and session continuation.

To develop against local shared dependencies:

```sh
make build SHARED_CONTEXT=../AgentTeams/shared/lib \
  TEAMHARNESS_CONTEXT=../AgentTeams/plugins/teamharness
```

Version tags (`v*`) publish amd64/arm64 images to
`ghcr.io/agentteams-group/agentteams-harness-deepseek` after unit and image
smoke tests. `make push VERSION=v0.1.0` publishes manually after registry login.
No release tag is created as part of the source migration.

## Layout and ownership

- `scripts/`: Matrix bridge, room sessions, workspace sync and entrypoint.
- `plugins/teamharness/adapters/deepseek-harness/`: DSH-native adapter.
- `tests/`: runtime unit tests, packaged CLI smoke and optional live checks.

Controller, CRDs, Helm, installers, role templates and the shared TeamHarness
bundle remain in AgentTeams. This repository owns runtime code and packaging.
The main repository must consume the pinned harness revision before its builds
switch to this source.

Startup retains the existing `AGENTTEAMS_WORKER_NAME`, `AGENTTEAMS_FS_*`,
`AGENTTEAMS_RUNTIME`, Matrix identity and per-worker object storage contract.
Finish active turns and sync workspace state before replacing an image.

The PowerShell compatibility probes require a built DSH checkout and a full
TeamHarness bundle (from the pinned AgentTeams source) alongside the adapter.
Live Kubernetes checks in `tests/k8s_lifecycle_smoke.ps1` and
`tests/team_e2e_smoke.ps1` require an existing stack and model credentials;
unit/image smoke tests do not claim to verify that live environment.
