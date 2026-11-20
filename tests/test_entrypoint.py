import os
from pathlib import Path
import subprocess
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[1] / "scripts" / "deepseek-harness-worker-entrypoint.sh"
LAUNCHER = Path(__file__).resolve().parents[1] / "scripts" / "agentteams-dsh"
AT_SOURCE = Path(os.environ.get("AT_SOURCE", Path(__file__).resolve().parents[2]))


@unittest.skipIf(os.name == "nt", "requires POSIX bash")
class DeepSeekHarnessEntrypointTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        from unittest.mock import patch
        self.logs = tempfile.TemporaryDirectory()
        self.addCleanup(self.logs.cleanup)
        env = patch.dict(os.environ, {
            'AGENTTEAMS_LOG_LIB_DIR': str(AT_SOURCE / 'shared/lib'),
            'AGENTTEAMS_LOG_DIR': self.logs.name,
        })
        env.start()
        self.addCleanup(env.stop)

    def test_e2ee_configuration_fails_before_worker_startup(self) -> None:
        completed = subprocess.run(
            ["bash", str(ENTRYPOINT)],
            env={**os.environ, "AGENTTEAMS_MATRIX_E2EE": "1"},
            text=True,
            capture_output=True,
            timeout=10,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(
            "DeepSeek Harness does not support Matrix E2EE",
            completed.stdout + completed.stderr,
        )

    def test_e2ee_true_configuration_fails_before_worker_startup(self) -> None:
        completed = subprocess.run(
            ["bash", str(ENTRYPOINT)],
            env={**os.environ, "AGENTTEAMS_MATRIX_E2EE": "true"},
            text=True,
            capture_output=True,
            timeout=10,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(
            "DeepSeek Harness does not support Matrix E2EE",
            completed.stdout + completed.stderr,
        )

    def test_missing_llm_credential_fails_before_worker_startup(self) -> None:
        environment = {
            key: value
            for key, value in os.environ.items()
            if key not in {"DEEPSEEK_API_KEY", "AGENTTEAMS_WORKER_GATEWAY_KEY"}
        }
        completed = subprocess.run(
            ["bash", str(ENTRYPOINT)],
            env=environment,
            text=True,
            capture_output=True,
            timeout=10,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("no LLM credential available", completed.stdout + completed.stderr)

    def test_builtin_mcp_workspace_is_bound_without_model_supplied_paths(self):
        import sys
        lines = [line for line in ENTRYPOINT.read_text().splitlines()
                 if line.startswith("export TEAMHARNESS_SHARED_DIR=")]
        command = "\n".join(lines) + '\nexec "$TEST_PYTHON" -c "from mcp.common.paths import _workspace_dir; print(_workspace_dir({}))"'
        result = subprocess.run(["bash", "-e", "-c", command], capture_output=True, text=True,
            env={**os.environ, "WORKER_HOME": "/tmp/synthetic-worker", "TEST_PYTHON": sys.executable,
                 "TEAMHARNESS_SHARED_DIR": "", "AGENTTEAMS_SHARED_DIR": "", "QWENPAW_WORKING_DIR": "", "COPAW_WORKING_DIR": "",
                 "PYTHONPATH": str(AT_SOURCE / "plugins/teamharness")})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "/tmp/synthetic-worker")


class DeepSeekHarnessLauncherTest(unittest.TestCase):
    def test_extensionless_shell_launcher_uses_lf_line_endings(self) -> None:
        self.assertNotIn(b"\r\n", LAUNCHER.read_bytes())


if __name__ == "__main__":
    unittest.main()
