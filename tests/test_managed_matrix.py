import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(os.environ.get("AT_SOURCE", Path(__file__).resolve().parents[2])) / "shared/lib"))
import matrix_bridge as bridge
from task_recovery import RecoveryConflict


class ManagedMatrixTest(unittest.TestCase):
    def setUp(self):
        self.event = {"event_id": "$source", "room_id": "!dm", "input": {
            "sender": "@owner", "type": "m.room.message", "content": {"msgtype": "m.text", "body": "build"}}}
        self.native = {**self.event, "sender": "@owner", "kind": "text", "source_key": "key"}
        self.temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.workspace = Path(self.temporary)
        self.matrix = Mock()
        self.identity = {"event_key": "key", "instance_id": "new", "process_id": "p", "generation": 3}
        self.claim = {"identity": self.identity, "input": self.event, "recovery": "resume",
                      "execution": {"checkpoint": {}}, "checkpoint_digest": "cp3", "resume_text": "continue two"}
        self.matrix.message_claim.return_value = self.claim
        self.sessions, self.client = Mock(), Mock()
        self.sessions.load.return_value = {"generation": 3, "checkpoint_digest": "cp3"}

    def test_projected_sender_policy_before_discovery_and_control_classification(self):
        def classify(transport):
            return bridge.managed_matrix_event(self.event, {"!dm": "personal"}, "@agent", set(), transport)
        self.assertIsNone(classify({"dm": {"policy": "allowlist", "allowFrom": ["@other"]}}))
        self.assertIsNone(classify({"dm": {"policy": "disabled"}}))
        self.assertEqual(classify({"dm": {"policy": "allowlist", "allowFrom": ["@owner"]}})[0], "message")
        self.event["input"]["content"]["com.agentteams.control"] = {"action": "stop"}
        self.assertEqual(classify({})[0], "control")
        self.event["input"]["unsigned"] = {"redacted_because": {"event_id":"$redaction"}}
        self.assertIsNone(classify({}))

    def recover(self):
        return bridge.recover_message(self.client, self.matrix, self.sessions, self.native, "@agent", set(), "worker", self.workspace, 10)

    def test_saved_result_and_unknown_side_effect_do_not_start_dsh(self):
        native = self.enterContext(patch.object(bridge, "run_dsh"))
        deliver = self.enterContext(patch.object(bridge, "deliver_managed_message"))
        for mode in ("verify", "done", "backfill", "deliver"):
            self.claim["recovery"] = mode
            self.recover()
        native.assert_not_called()
        deliver.assert_called_once()
        self.sessions.load.assert_not_called()

    def test_missing_message_session_uses_shared_prompt_and_saves_before_matrix_send(self):
        native = self.enterContext(patch.object(bridge, "run_dsh", return_value="answer"))
        self.enterContext(patch.object(bridge, "sync_sessions"))
        self.enterContext(patch.object(bridge, "native_session_digest", return_value=None))
        timeline = []
        def save(identity, text):
            timeline.append(("save", identity, text))
            return {"execution": {"checkpoint": {"version": 4}}}
        self.matrix.message_save_reply.side_effect = save
        deliver = self.enterContext(patch.object(bridge, "deliver_managed_message", side_effect=lambda *args: timeline.append(("send",))))
        self.recover()
        self.assertEqual(native.call_args.args[0], "continue two")
        self.assertFalse(native.call_args.kwargs["resume"])
        self.assertEqual(native.call_args.kwargs["source_key"], "key")
        self.assertEqual(native.call_args.kwargs["identity"], self.identity)
        self.assertEqual(timeline, [("save", self.identity, "answer"), ("send",)])
        self.sessions.remember.assert_not_called()

    def test_stale_session_revision_prevents_inference(self):
        self.sessions.load.return_value["checkpoint_digest"] = "old"
        with patch.object(bridge, "run_dsh") as native, self.assertRaises(RecoveryConflict):
            self.recover()
        native.assert_not_called()

    def test_managed_loop_consumes_shared_pending_with_no_new_native_timeline(self):
        runtime = self.workspace / "runtime.yaml"
        runtime.write_text("member:\n  matrixUserId: '@agent'\n  personalRoomId: '!dm'\n")
        stop, order = threading.Event(), []
        rec = Mock(process="p")
        rec.discover.side_effect = lambda: order.append("discover") or {"tasks":[]}
        self.client.request.return_value = {"joined_rooms": ["!dm", "!unwatched"]}
        self.matrix.pending.return_value = [{**self.event, "intent":"message"}]
        def receiver(matrix, client, own, classify, observe):
            def poll(_):
                order.append("sync")
                self.assertEqual(observe({"rooms": {}}), {"!dm"})
                return {"state": {"rooms": {"!dm": {}}, "pending": ["key"]}}, {}
            return Mock(poll=poll)
        def tasks(*args, on_scan, **kwargs):
            order.append("claim")
            on_scan()
        with patch.dict(os.environ, {"AGENTTEAMS_MATRIX_DOMAIN":"hs"}), patch("task_recovery.Recovery", return_value=rec), \
                patch("worker_matrix_state.WorkerMatrix", return_value=self.matrix), patch("worker_matrix_raw.RawWorkerSync", side_effect=receiver), \
                patch.object(bridge, "refresh_runtime_config"), patch.object(bridge.subprocess, "run"), \
                patch("worker_handoff.recovery_scanned", side_effect=lambda: order.append("scanned")), \
                patch.object(bridge, "recover_tasks", side_effect=tasks), patch.object(bridge, "direct_member", return_value=False), \
                patch.object(bridge, "recover_message", side_effect=lambda *args, **kwargs: order.append("message") or stop.set()):
            bridge.run_managed_worker(self.client, "agent", runtime, self.workspace, 10, "@agent", stop)
        self.matrix.start.assert_called_once()
        self.assertEqual(order, ["discover", "sync", "claim", "scanned", "message"])
        self.assertFalse((self.workspace / "matrix-bridge-state.json").exists())
