import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[1]
AT_SOURCE = Path(os.environ.get('AT_SOURCE', ROOT.parent))
sys.path[:0] = [str(ROOT / 'scripts'), str(AT_SOURCE / 'shared/lib')]
import matrix_bridge


class FailureLoggingTests(unittest.TestCase):
    def test_no_operator_deadline_allows_the_owned_native_process_to_finish(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);launcher=root/'agentteams-dsh'
            launcher.write_text('#!/bin/sh\nprintf finished\n');launcher.chmod(0o755)
            with patch.dict(os.environ, {'PATH':str(root)+os.pathsep+os.environ['PATH']}):
                self.assertEqual(matrix_bridge.run_dsh('task',root,None,
                    session_id='session',resume=False,event_id='$one',attempt=1),'finished')

    def test_temporary_authority_outage_does_not_stop_the_owned_native_process(self):
        from task_recovery import RecoveryUnavailable
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);launcher=root/'agentteams-dsh'
            launcher.write_text('#!/bin/sh\nsleep 0.7\nprintf finished\n');launcher.chmod(0o755)
            poll=Mock(side_effect=RecoveryUnavailable('temporary outage'))
            with patch.dict(os.environ, {'PATH':str(root)+os.pathsep+os.environ['PATH']}):
                self.assertEqual(matrix_bridge.run_dsh('task',root,2,poll_control=poll,
                    session_id='session',resume=False,event_id='$one',attempt=1),'finished')
            poll.assert_called_once()

    def test_confirmed_stop_and_ownership_change_still_reap_the_native_process(self):
        from task_recovery import RecoveryConflict
        for failure in ('human', 'ownership'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);launcher=root/'agentteams-dsh'
                launcher.write_text('#!/bin/sh\necho $$ > native.pid\nsleep 5\nprintf should-not-complete\n')
                launcher.chmod(0o755)
                poll=Mock(return_value=True) if failure=='human' else Mock(side_effect=RecoveryConflict('reassigned'))
                with patch.dict(os.environ, {'PATH':str(root)+os.pathsep+os.environ['PATH']}):
                    with self.assertRaises(InterruptedError if failure=='human' else RecoveryConflict):
                        matrix_bridge.run_dsh('task',root,None,poll_control=poll,
                            session_id='session',resume=False,event_id='$one',attempt=1)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int((root/'native.pid').read_text()),0)

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
