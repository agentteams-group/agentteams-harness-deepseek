import importlib.util
import os
import sys
from pathlib import Path
import tempfile
import unittest


sys.path.insert(0, str(Path(os.environ.get("AT_SOURCE", Path(__file__).resolve().parents[2])) / "shared/lib"))
MODULE_PATH = Path(__file__).parents[1] / "scripts" / "runtime_env.py"
SPEC = importlib.util.spec_from_file_location("dsh_runtime_env", MODULE_PATH)
runtime_env = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runtime_env)


class DeepSeekBaseUrlTests(unittest.TestCase):
    def test_explicit_deepseek_url_wins_without_openai_path_rewrite(self) -> None:
        self.assertEqual(
            runtime_env.deepseek_base_url("https://api.deepseek.com/", "http://higress:80"),
            "https://api.deepseek.com",
        )

    def test_agentteams_gateway_root_gets_openai_v1_prefix(self) -> None:
        self.assertEqual(
            runtime_env.deepseek_base_url("", "http://higress:80/"),
            "http://higress:80/v1",
        )

    def test_existing_v1_prefix_is_not_duplicated(self) -> None:
        self.assertEqual(
            runtime_env.deepseek_base_url("", "http://higress:80/v1/"),
            "http://higress:80/v1",
        )

    def test_empty_values_keep_dsh_public_default_available(self) -> None:
        self.assertEqual(runtime_env.deepseek_base_url("", ""), "")

    def test_runtime_gateway_overrides_cluster_default(self) -> None:
        self.assertEqual(
            runtime_env.deepseek_base_url("", "http://cluster-gateway", "http://provider-route"),
            "http://provider-route/v1",
        )


class DesiredModelTests(unittest.TestCase):
    def test_reads_controller_generated_model_and_gateway(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.yaml"
            path.write_text(
                """member:\n  runtimeName: dsh-a\ndesired:\n  model:\n    providerId: agentteams-gateway\n    model: 'deepseek-chat'\n    gatewayUrl: \"http://gateway/route\"\n  state: Running\nstorage:\n  provider: minio\n""",
                encoding="utf-8",
            )
            self.assertEqual(
                runtime_env.desired_model(path),
                ("deepseek-chat", "http://gateway/route"),
            )

    def test_missing_model_returns_empty_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.yaml"
            path.write_text("desired:\n  state: Running\n", encoding="utf-8")
            self.assertEqual(runtime_env.desired_model(path), ("", ""))


class WorkerProjectionTests(unittest.TestCase):
    def test_managed_worker_uses_yaml_transport_and_bound_credentials(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.yaml"
            path.write_text("""apiVersion: agentteams.io/v1beta1
kind: MemberRuntimeConfig
member: {runtime: deepseek-harness, runtimeName: a, matrixUserId: '@a:test', role: team_leader}
team: {name: protocol-team}
matrix: {transport: {homeserver: 'https://worker-matrix', encryption: false}}
desired: {model: {model: shared-model, gatewayUrl: 'https://worker-gateway'}}
storage: {memberPrefix: agents/a}
credentials: {gatewayKeyEnv: MODEL_BINDING, matrixTokenEnv: MATRIX_BINDING}
""")
            with patch.dict(os.environ, {"AGENTTEAMS_CONTROLLER_URL": "http://controller", "MODEL_BINDING": "gateway-test",
                    "MATRIX_BINDING": "matrix-test", "AGENTTEAMS_AGENT_ROLE": "standalone", "DEEPSEEK_BASE_URL": "https://stale", "DEEPSEEK_API_KEY": "stale"}, clear=True):
                env = runtime_env.worker_environment(path, "a")
                self.assertEqual(env, {"TEAMHARNESS_DSH_MODEL": "shared-model", "DEEPSEEK_BASE_URL": "https://worker-gateway/v1",
                    "DEEPSEEK_API_KEY": "gateway-test", "AGENTTEAMS_MATRIX_URL": "https://worker-matrix",
                    "AGENTTEAMS_WORKER_MATRIX_TOKEN": "matrix-test", "AGENTTEAMS_MATRIX_USER_ID": "@a:test",
                    "AGENTTEAMS_AGENT_ROLE": "team_leader", "AGENTTEAMS_WORKER_ROLE": "team_leader",
                    "AGENTTEAMS_TEAM_NAME": "protocol-team"})
                with self.assertRaisesRegex(ValueError, "identity"):
                    runtime_env.worker_environment(path, "another")
                path.write_text(path.read_text().replace("encryption: false", "encryption: true"))
                with self.assertRaisesRegex(ValueError, "E2EE"):
                    runtime_env.worker_environment(path, "a")


if __name__ == "__main__":
    unittest.main()
