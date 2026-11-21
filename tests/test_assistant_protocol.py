"""Exercise the native DSH Matrix ingress with the shared assistant contract."""
import os
from pathlib import Path
import sys
import unittest

root = Path(__file__).resolve().parents[1]
core = Path(os.environ["AT_SOURCE"])
sys.path[:0] = [str(root / "scripts"), str(core / "shared/lib"), str(core / "tests/lib")]
from assistant_fixture import AssistantFixture
from matrix_bridge import managed_matrix_event


class AssistantProtocolTest(unittest.TestCase):
    def test_standard_self_mention_uses_controller_context_and_old_owner_is_rejected(self):
        with AssistantFixture() as f:
            source = {"room_id": f.room, "input": {"sender": f.own, "content": f.content()}}
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
