import os
import json
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
    def test_flush_only_confirmed_handoffs_and_retry_after_storage_failure(self):
        folder = self.workspace / 'sessions/.task-handoffs'
        folder.mkdir(parents=True)
        session = 'session-task-' + 'a' * 32
        path = folder / (session + '.json')
        assignment = {'eventId': '1' * 32, 'taskId': 'next', 'status': 'queued'}
        notice = {'eventId': '2' * 32, 'status': 'queued'}
        result = {'task': {'id': 'node'}, 'assignments': [assignment], 'notification': notice}
        path.write_text(json.dumps({'sessionId': session, 'result': result}))
        confirmed = [{'receiptId': json.dumps(['dispatch', assignment['eventId'], 'matrix:$sent']), 'fact': 'sent'}]
        with patch.dict(os.environ, {'DSH_HOME': str(self.workspace)}), \
                patch.object(bridge, 'confirmed_task_handoffs', side_effect=[[], confirmed, confirmed]) as check, \
                patch.object(bridge.subprocess, 'run') as runner, \
                patch.object(bridge, 'sync_sessions', side_effect=[OSError('offline'), None]):
            bridge.flush_task_handoffs('worker', '@worker:test')
            runner.assert_not_called()
            bridge.flush_task_handoffs('worker', '@worker:test')
            self.assertEqual(json.loads(path.read_text())['result'], result)
            bridge.flush_task_handoffs('worker', '@worker:test')
            self.assertEqual(check.call_args.args[1], '@worker:test')
            submitted = json.loads(runner.call_args.kwargs['env']['TEAMHARNESS_DSH_CONFIRMED_HANDOFF'])
            self.assertEqual(submitted['pending']['result'], result)
            self.assertEqual(json.loads(path.read_text())['result'], {**result, 'assignments': []})
            self.assertEqual(runner.call_count, 2)
            self.assertEqual(runner.call_args.kwargs['env']['TEAMHARNESS_DSH_SESSION_ID'], session)

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
        self.client.request.return_value = {"event": {"room_id": "!dm", "event_id": "$source"}, "events_before": []}
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

    def test_control_in_a_new_joined_task_room_does_not_require_static_room_mapping(self):
        self.event["input"]["content"]["org.agentteams.coordination"] = {}
        packet = {"text": "Review the submitted task", "session_id": "coordination-submission:id",
                  "meta": {"teamharness_coordination": {"kind": "task_submitted", "id": "a" * 32, "task_id": "T"}}}
        with patch("task_coordination.notification", return_value=packet):
            self.assertEqual(bridge.managed_matrix_event(self.event, {}, "@agent", set(), {})[:2], ("message", None))
        self.event["input"]["content"].pop("org.agentteams.coordination")
        self.assertIsNone(bridge.managed_matrix_event(self.event, {}, "@agent", set(), {}))

    def test_authorized_task_room_invite_is_joined_before_assignment(self):
        self.client.request.return_value = {"joined_rooms": ["!task"]}
        event = {"type": "m.room.member", "state_key": "@agent", "sender": "@leader",
                 "content": {"membership": "invite"}}
        transport = {"groupPolicy": "allowlist", "groupAllowFrom": ["@leader"]}
        bridge.managed_rooms(self.client, {"rooms": {"invite": {"!task": {"invite_state": {"events": [event]}}}}}, {}, "@agent", transport)
        self.client.request.assert_any_call("POST", "/_matrix/client/v3/join/%21task", {})

    def recover(self):
        return bridge.recover_message(self.client, self.matrix, self.sessions, self.native, "@agent", set(), "worker", self.workspace, 10, admit=lambda *_: True)

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

    def test_verified_task_controls_do_not_replay_room_or_raw_envelope(self):
        self.native.update(body="核对最终交付", kind="text",
            _task_protocol_meta={"teamharness_coordination": {"kind": "main_task_ready"}})
        native = self.enterContext(patch.object(bridge, "run_dsh", return_value="NO_REPLY"))
        history = self.enterContext(patch("worker_matrix_raw.raw_room_history", return_value=["another agent"]))
        self.enterContext(patch.object(bridge, "sync_sessions"))
        self.recover()
        self.assertEqual(native.call_args.args[0], "核对最终交付")
        history.assert_not_called()

    def test_settled_planning_is_completed_quietly_including_delivery_recovery(self):
        self.native.update(body="规划当前任务", coordination_session="coordination-handoff:main",
            _task_protocol_meta={"teamharness_coordination": {"kind": "handoff", "id": "a" * 32}})
        native = self.enterContext(patch.object(bridge, "run_dsh", return_value="NO_REPLY"))
        self.enterContext(patch.object(bridge, "sync_sessions"))
        self.matrix.recovery.request.return_value = {"settled": True}
        self.recover()
        self.matrix.recovery.request.assert_called_once_with("POST", "coordination/events/" + "a" * 32 + "/phase",
            {"action": "begin", "native_event_id": "$source", "process_id": "p"})
        self.matrix.message_complete.assert_called_once_with(self.identity)
        identity, receipt = self.matrix.message_save_reply.call_args.args
        self.assertEqual(identity, self.identity)
        self.assertIn("$source", receipt)
        self.claim.update(recovery="deliver", saved_result=receipt)
        self.recover()
        self.assertEqual(self.matrix.message_complete.call_count, 2)
        self.matrix.message_cancel.assert_not_called()
        self.client.send_content.assert_not_called()
        native.assert_called_once()

    def test_room_encrypted_after_upload_blocks_native_file_event(self):
        from matrix_channel import MatrixClient
        native = MatrixClient("http://unused", "unused")
        native.upload_media = Mock(return_value=("mxc://hs/id", "text/plain", 2))
        native.send_content = Mock()
        with self.assertRaises(RecoveryConflict):
            native.send_file("!dm", self.workspace / "note.txt", "$source", "stable",
                before_send=Mock(side_effect=RecoveryConflict("room now requires E2EE")))
        native.upload_media.assert_called_once()
        native.send_content.assert_not_called()

    def test_stale_session_revision_prevents_inference(self):
        self.sessions.load.return_value["checkpoint_digest"] = "old"
        with patch.object(bridge, "run_dsh") as native, self.assertRaises(RecoveryConflict):
            self.recover()
        native.assert_not_called()

    def test_managed_loop_consumes_shared_pending_with_no_new_native_timeline(self):
        self.check_managed_pending("message")

    def test_backfilled_coordination_control_uses_controller_redelivery(self):
        self.event["input"]["content"]["org.agentteams.coordination"] = {}
        packet = {"text": "Review submission", "session_id": "coordination-submission:id",
                  "meta": {"teamharness_coordination": {"kind": "task_submitted", "id": "a" * 32, "task_id": "T"}}}
        with patch("task_coordination.notification", return_value=packet):
            self.check_managed_pending("control")

    def test_managed_registration_failure_keeps_loop_alive_for_retry(self):
        self.check_managed_pending("message", registration_failures=1)

    def check_managed_pending(self, stored_intent, registration_failures=0):
        self.matrix.start.side_effect = [OSError("Controller unavailable")] * registration_failures + [None]
        runtime = self.workspace / "runtime.yaml"
        runtime.write_text("member:\n  matrixUserId: '@agent'\n  personalRoomId: '!dm'\n")
        stop, order = threading.Event(), []
        rec = Mock(process="p")
        rec.discover.side_effect = lambda: order.append("discover") or {"tasks":[]}
        self.client.request.return_value = {"joined_rooms": ["!dm", "!unwatched"]}
        self.matrix.pending.return_value = [{**self.event, "intent":stored_intent}]
        def receiver(matrix, client, own, classify, observe, *, event_types):
            self.assertEqual(event_types, ("m.room.message", "org.agentteams.coordination"))
            def poll(_):
                if "sync" in order:
                    stop.set()
                order.append("sync")
                self.assertEqual(observe({"rooms": {}}), {"!dm", "!unwatched"})
                self.assertEqual(classify("!unwatched", self.event["input"] | {"event_id": "$followup", "content": {"msgtype": "m.text", "body": "@agent status?", "m.mentions": {"user_ids": ["@agent"]}}}), ("message", None))
                return {"state": {"rooms": {"!dm": {}}, "pending": ["key"]}}, {}
            return Mock(poll=poll)
        def redeliver(method, route, body):
            self.assertEqual((method, route), ("POST", "coordination/events/" + "a" * 32 + "/phase"))
            self.assertEqual(body, {"action": "retry", "native_event_id": "$source", "process_id": "p"})
            order.append("redelivery")
            stop.set()
            return {"retry_queued": True}
        rec.request.side_effect = redeliver
        def tasks(*args, on_scan, **kwargs):
            order.append("claim")
            on_scan()
        with patch.dict(os.environ, {"AGENTTEAMS_MATRIX_DOMAIN":"hs"}), patch("task_recovery.Recovery", return_value=rec), \
                patch("task_coordination.controller_json", return_value={"taskId": "completed-task", "status": "completed"}), \
                patch("worker_matrix_state.WorkerMatrix", return_value=self.matrix), patch("worker_matrix_raw.RawWorkerSync", side_effect=receiver), \
                patch.object(bridge, "refresh_runtime_config"), patch.object(bridge.subprocess, "run"), \
                patch("worker_handoff.recovery_scanned", side_effect=lambda: order.append("scanned")), \
                patch.object(bridge, "trace_event", side_effect=lambda event, **_: order.append(event)), \
                patch.object(bridge, "recover_tasks", side_effect=tasks), patch.object(bridge, "direct_member", return_value=False), \
                patch.object(bridge, "recover_message", side_effect=lambda *args, **kwargs: order.append("message") or stop.set()):
            bridge.run_managed_worker(self.client, "agent", runtime, self.workspace, 10, "@agent", stop)
        self.assertEqual(self.matrix.start.call_count, 1 + registration_failures)
        if stored_intent == "control":
            self.assertEqual(order, ["matrix.failed"] * registration_failures + ["discover", "sync", "redelivery", "claim", "scanned", "runtime.ready"])
        else:
            self.assertEqual(order, ["matrix.failed"] * registration_failures + ["discover", "sync", "claim", "scanned", "runtime.ready", "message"])
        self.assertFalse((self.workspace / "matrix-bridge-state.json").exists())

    def test_new_authorized_direct_room_is_joined_and_watched(self):
        rooms = {"!known": "team"}
        transport = {"dm": {"policy": "allowlist", "allowFrom": ["@owner"]}}
        invite = lambda sender: {"invite_state": {"events": [{
            "type": "m.room.member", "state_key": "@agent", "sender": sender,
            "content": {"membership": "invite", "is_direct": True}}]}}
        payload = {"rooms": {"invite": {"!new": invite("@owner"), "!untrusted": invite("@other")}}}
        def request(method, path, *args):
            if path.endswith("/joined_rooms"):
                return {"joined_rooms": ["!known", "!new", "!group", "!untrusted"]}
            if path.endswith("/joined_members"):
                members = ["@agent", "@owner"] if "%21new/" in path else ["@agent", "@other", "@owner"]
                return {"joined": {user: {} for user in members}}
            return {}
        self.client.request.side_effect = request
        watched = bridge.managed_rooms(self.client, payload, rooms, "@agent", transport)
        self.assertEqual(watched, {"!known", "!new", "!group", "!untrusted"})
        self.assertNotIn("!group", rooms)
        self.assertNotIn("!untrusted", rooms)
        self.assertEqual(rooms["!new"], "personal")
        self.client.request.assert_any_call("POST", "/_matrix/client/v3/join/%21new", {})
        self.assertFalse(any("%21untrusted" in call.args[1] and call.args[0] == "POST"
                             for call in self.client.request.call_args_list))

    def test_disabled_direct_policy_does_not_discover_rooms(self):
        self.client.request.return_value = {"joined_rooms": ["!new"]}
        self.assertEqual(bridge.managed_rooms(self.client, {}, {}, "@agent", {"dm": {"policy": "disabled"}}), {"!new"})
