import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
AT_SOURCE = Path(os.environ.get('AT_SOURCE', ROOT.parent))
sys.path[:0] = [str(ROOT / 'scripts'), str(AT_SOURCE / 'shared/lib')]
import matrix_bridge


class FailureLoggingTests(unittest.TestCase):
    def test_native_failures_keep_reason_without_credentials_or_task(self):
        for mode in ('401', 'timeout', 'missing'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                launcher = root / 'agentteams-dsh'
                launcher.write_text('#!/bin/sh\n' + ('sleep 10\n' if mode == 'timeout' else 'echo "Error: HTTP 401 Unauthorized api_key=private-test-key" >&2\nexit 1\n'))
                launcher.chmod(0o755)
                env = {'PATH': str(root) + os.pathsep + os.environ['PATH'],
                       'AGENTTEAMS_LOG_DIR': str(root / 'logs'), 'DEEPSEEK_API_KEY': 'private-test-key'}
                with patch.dict(os.environ, env), patch.object(matrix_bridge, 'trace_event', wraps=__import__('runtime_observability').event):
                    with self.assertRaises((RuntimeError, TimeoutError, OSError)):
                        if mode == 'missing':
                            with patch.object(matrix_bridge.subprocess, 'Popen', side_effect=FileNotFoundError('agentteams-dsh missing')):
                                matrix_bridge.run_dsh('PRIVATE TASK', root, 2, session_id='session', resume=False, event_id='$one', attempt=1)
                        else:
                            matrix_bridge.run_dsh('PRIVATE TASK', root, 0 if mode == 'timeout' else 2,
                                                  session_id='session', resume=False, event_id='$one', attempt=1)
                raw = (root / 'logs/events.jsonl').read_text()
                self.assertNotIn('private-test-key', raw)
                self.assertNotIn('PRIVATE TASK', raw)
                records = [json.loads(line) for line in raw.splitlines()]
                failure = next(item for item in records if item['event'] == 'inference.failed')
                self.assertEqual(failure['event_id'], '$one')
                self.assertIn({'401': '401 Unauthorized', 'timeout': 'timed out', 'missing': 'missing'}[mode], failure['error'])
