"""Exercise the native DSH Matrix ingress with the shared assistant contract."""
import os
from pathlib import Path
import sys
import unittest

root = Path(__file__).resolve().parents[1]
core = Path(os.environ.get("AT_SOURCE", Path(__file__).resolve().parents[2]))
sys.path[:0] = [str(root / "scripts"), str(core / "shared/lib"), str(core / "tests/lib")]
from assistant_fixture import AssistantFixture
from matrix_bridge import managed_matrix_event, deliver_managed_message
from unittest.mock import Mock


class AssistantProtocolTest(unittest.TestCase):
    def test_background_outcome_never_publishes_a_native_reply(self):
        client, matrix = Mock(), Mock()
        identity = {"event_key":"assistant"}
        deliver_managed_message(client, matrix, {"identity":identity,"saved_result":"Nothing new"},
            {"coordination_session":"coordination-assistant:cycle"}, "@leader:test", set())
        matrix.message_cancel.assert_called_once_with(identity)
        client.request.assert_not_called()
        matrix.message_delivered.assert_not_called()

    def test_standard_self_mention_uses_controller_context_and_old_owner_is_rejected(self):
        with AssistantFixture() as f:
            source = {"room_id": f.room, "event_id": "$assistant", "input": {"sender": f.own, "content": f.content()}}
            def receive():
                return managed_matrix_event(source, {f.room: "personal"}, f.own, set(), {"dm": {"policy": "allowlist", "allowFrom": ["@admin:test"]}})
            intent, task, event = receive()
            self.assertEqual((intent, task), ("message", None))
            self.assertEqual(event["body"], f.text)
            self.assertEqual(event["coordination_session"], f.control["session_id"])
            f.context["owner"] = "replaced"
            self.assertIsNone(receive())
            f.context["owner"] = "current-role-instance"
            f.context["context"]["enabled"] = False
            self.assertIsNone(receive())
