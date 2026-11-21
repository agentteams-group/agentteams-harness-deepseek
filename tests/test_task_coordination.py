"""The bridge consumes authenticated controls before peer/own-echo gates."""
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from matrix_channel import matrix_events, MatrixClient

class CoordinationTest(unittest.TestCase):
    def packet(self, **content):
        return {'rooms': {'join': {'!task:test': {'timeline': {'events': [{'type': 'm.room.message', 'event_id': '$event', 'sender': '@self:test', 'content': {'msgtype': 'm.text', 'body': 'projection', **content}}]}}}}}
    def test_verified_self_closure_preserves_its_isolated_session(self):
        verified = {'teamharness_coordination': {'kind': 'main_task_ready', 'main_task_id': 'main'}}
        helper = SimpleNamespace(notification=Mock(return_value={'text': 'Canonical closure', 'session_id': 'coordination-close-task:main', 'meta': verified}), IgnoredNotification=ValueError)
        with patch.dict(sys.modules, {'task_coordination': helper}):
            events = matrix_events(self.packet(**{'org.agentteams.coordination': {}}), {'!task:test': 'team'}, '@self:test')
        self.assertEqual(events[0]['body'], 'Canonical closure')
        self.assertEqual(events[0]['coordination_session'], 'coordination-close-task:main')
        self.assertEqual(events[0]['_task_protocol_meta']['teamharness_coordination'], verified['teamharness_coordination'])
        self.assertEqual(matrix_events(self.packet(), {'!task:test': 'team'}, '@self:test'), [])
    def test_bad_control_never_falls_back_to_visible_body(self):
        helper = SimpleNamespace(notification=Mock(side_effect=ValueError('wrong scope')), IgnoredNotification=ValueError)
        with patch.dict(sys.modules, {'task_coordination': helper}):
            self.assertEqual(matrix_events(self.packet(**{'org.agentteams.coordination': {}}), {'!task:test': 'team'}, '@self:test'), [])
    def test_progress_is_visible_without_triggering_another_peer(self):
        client = MatrixClient('http://test', 'token'); client.send_content = Mock(return_value='$sent')
        client.send_text('!task:test', '@lead:test Done', mentioned_user_ids=['@lead:test'], progress_only=True)
        content = client.send_content.call_args.args[1]
        self.assertTrue(content['org.agentteams.progress_only'])
        self.assertFalse(content.get('m.mentions', {}).get('user_ids'))
