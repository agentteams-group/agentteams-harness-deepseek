"""Task authority/admission contracts; native/model acceptance is separate."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(os.environ.get("AT_SOURCE", Path(__file__).resolve().parents[2])) / "shared/lib"))
from task_recovery import Recovery, RecoveryConflict
from matrix_bridge import BridgeState, MissingNativeSession, recover_tasks
import matrix_bridge


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.state = BridgeState.load(self.workspace / "state.json")
        self.state.next_batch = "retained-cursor"
        self.state.data["events"]["$backlog"] = {"status": "queued"}
        self.task = {"task_id": "stable", "status": "in_progress", "room_id": "!room:test",
            "execution": {"generation": 2, "checkpoint": {"version": 4, "completed_steps": ["one"]}}}
        self.client, self.recovery = Mock(), Mock(spec=Recovery)
        self.recovery.discover.return_value = {"instance_id": "actual-start", "tasks": [
            {"team_id": "team", "etag": "task-version", "task": self.task}]}
        self.recovery.claim.return_value = {"task": self.task, "spec": "portable description", "saved_result": "saved report"}
        self.recovery.current.return_value = self.task
        self.recovery.resume_text.return_value = "continue step two"
        self.recovery.digest = Recovery.digest
        self.recovery.session_usable = Recovery.session_usable
        self.pending = {"version": 5, "delivery": "pending", "reply_txn": "stable-transaction"}
        self.recovery.prepare_reply.return_value = ({"execution": {"checkpoint": self.pending}}, "canonical report")
        self.recovery.delivered.return_value = {"execution": {"checkpoint": {**self.pending, "version": 6, "delivery": "delivered"}}}
        self.client.send_text.return_value = "$reply"
        self.admitted = set()
        self.factory = self.enterContext(patch("task_recovery.Recovery", return_value=self.recovery))
        self.factory.digest = Recovery.digest
        self.enterContext(patch("task_recovery.enabled", return_value=True))
        self.run = self.enterContext(patch("matrix_bridge.run_dsh", return_value="native callback"))
        self.enterContext(patch("matrix_bridge.sync_sessions"))
        self.enterContext(patch("matrix_bridge.push_runtime_state"))

    def recover(self, **kwargs):
        return recover_tasks(self.client, self.state, "alice", self.workspace, 60, "@alice:test", self.admitted, **kwargs)

    def test_startup_resumes_once_without_a_matrix_message_and_keeps_backlog(self):
        self.recover()
        self.recover()
        self.run.assert_called_once()
        self.assertEqual(self.run.call_args.args[0], "continue step two")
        self.assertEqual(self.run.call_args.kwargs["source_event_ids"], [])
        self.assertEqual(self.recovery.resume_text.call_args.args[0]["spec"], "portable description")
        self.assertEqual(self.recovery.prepare_reply.call_args.args, ("stable", "team", "native callback"))
        self.assertEqual(self.client.send_text.call_args.args, ("!room:test", "canonical report"))
        self.assertEqual(self.client.send_text.call_args.kwargs["transaction_key"], "stable-transaction")
        self.assertEqual(self.state.next_batch, "retained-cursor")
        self.assertEqual(self.state.data["events"]["$backlog"]["status"], "queued")

    def test_saved_result_recovery_never_runs_the_model(self):
        self.task.update(status="submitted")
        self.task["execution"]["checkpoint"] = self.pending
        self.recover()
        self.run.assert_not_called()
        self.assertEqual(self.client.send_text.call_args.args, ("!room:test", "saved report"))
        self.recovery.delivered.assert_called_once_with("stable", "team", "$reply")

    def test_claim_only_never_starts_a_turn_or_delivery(self):
        self.recover(claim_only=True)
        self.recovery.claim.assert_called_once()
        self.run.assert_not_called()
        self.client.send_text.assert_not_called()

    def test_actual_assignment_retains_its_native_read_source(self):
        source = {"event_id": "$assignment", "sender": "@leader:test", "coordination_session": "coordination-task:stable:delivery"}
        self.recover(source_events=[source])
        self.assertEqual(self.run.call_args.kwargs["source_event_ids"], ["$assignment"])
        self.assertEqual(self.run.call_args.kwargs["sender"], "@leader:test")

    def test_only_compatible_checkpoint_matched_unexpired_cache_is_reused(self):
        marker = {"runtime": "deepseek-harness", "session_id": "existing", "expires_at": time.time()+3600,
            "checkpoint_digest": Recovery.digest(self.task["execution"]["checkpoint"])}
        for change, expected in (({}, True), ({"runtime": "codex"}, False),
                ({"expires_at": 0}, False), ({"checkpoint_digest": "old"}, False)):
            with self.subTest(change=change):
                self.state.data["task_sessions"] = {"team/stable": {**marker, **change}}
                self.admitted.clear()
                self.recover()
                self.assertEqual(self.run.call_args.kwargs["resume"], expected)
                self.assertEqual(self.run.call_args.kwargs["session_id"] == "existing", expected)

    def test_native_missing_session_rebuilds_before_any_model_execution(self):
        self.state.data["task_sessions"] = {"team/stable": {"runtime": "deepseek-harness", "session_id": "missing",
            "expires_at": time.time()+3600, "checkpoint_digest": Recovery.digest(self.task["execution"]["checkpoint"])}}
        self.run.side_effect = [MissingNativeSession("missing native cache"), "answer"]
        self.recover()
        self.assertEqual(self.run.call_count, 2)
        self.assertTrue(self.run.call_args_list[0].kwargs["resume"])
        self.assertFalse(self.run.call_args_list[1].kwargs["resume"])
        self.assertNotEqual(self.run.call_args_list[0].kwargs["session_id"], self.run.call_args_list[1].kwargs["session_id"])
        self.recovery.interrupted.assert_not_called()

    def test_unknown_failure_is_fenced_and_not_blindly_retried(self):
        self.run.side_effect = RuntimeError("tool outcome uncertain")
        with self.assertRaises(RuntimeError):
            self.recover()
        self.recover()
        self.run.assert_called_once()
        self.recovery.interrupted.assert_called_once_with("stable", "team")
        self.client.send_text.assert_not_called()

    def test_execution_conflict_or_reassignment_prevents_model_and_reply(self):
        self.recovery.claim.side_effect = RecoveryConflict("assignment changed")
        with self.assertRaises(RecoveryConflict):
            self.recover()
        self.run.assert_not_called()
        self.client.send_text.assert_not_called()

    def test_first_sync_is_processed_before_committing_its_cursor(self):
        runtime = self.workspace / "runtime.yaml"
        runtime.write_text("member:\n  role: worker\n  matrixUserId: '@alice:test'\n  personalRoomId: '!personal:test'\n")
        stop = threading.Event()
        batches = iter([{"next_batch": "after-pending", "rooms": {"join": {"!personal:test": {"timeline": {"events": [
            {"type": "m.room.message", "event_id": "$pending", "sender": "@human:test",
             "content": {"msgtype": "m.text", "body": "pending before startup"}}]}}}}}])
        def sync(*args):
            try:
                return next(batches)
            except StopIteration:
                stop.set()
                return {"next_batch": "empty", "rooms": {}}
        self.client.sync.side_effect = sync
        self.client.request.return_value = {"joined": {"@alice:test": {}, "@human:test": {}}}
        self.run.side_effect = lambda *args, **kwargs: (stop.set() or "answer")
        env = {"AGENTTEAMS_WORKER_NAME": "alice", "AGENTTEAMS_MATRIX_URL": "http://matrix.invalid",
            "AGENTTEAMS_WORKER_MATRIX_TOKEN": "fixture", "TEAMHARNESS_RUNTIME_CONFIG": str(runtime),
            "TEAMHARNESS_WORKSPACE": str(self.workspace), "AGENTTEAMS_MATRIX_DOMAIN": "test"}
        with patch.dict(os.environ, env, clear=True), patch.object(matrix_bridge, "STOP", stop), \
                patch.object(matrix_bridge, "MatrixClient", return_value=self.client), \
                patch.object(matrix_bridge.threading, "Thread"), patch.object(matrix_bridge, "recover_tasks") as recover, \
                patch.object(matrix_bridge, "refresh_runtime_config", return_value=False):
            self.assertEqual(matrix_bridge.main(), 0)
        self.assertEqual(self.run.call_args.args[0], "pending before startup")
        self.assertEqual(self.client.sync.call_count, 1)
        self.assertTrue(recover.call_args_list[0].kwargs["claim_only"])
        saved = json.loads((self.workspace / "matrix-bridge-state.json").read_text())
        self.assertEqual(saved["next_batch"], "after-pending")
        self.assertEqual(saved["events"]["$pending"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
