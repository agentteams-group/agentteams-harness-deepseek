"""Packaged native DSH tool cancellation and same-session continuation.

The model endpoint is deterministic; the DSH tool, process, and session are real.
Run in the selected disposable Worker image with /dm/scripts on PYTHONPATH.
"""
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from matrix_bridge import run_dsh, poll_direct_control
from bridge_state import BridgeState

action = sys.argv[1] if len(sys.argv) > 1 else 'steer'
assert action in {'stop', 'steer'}


class Model(BaseHTTPRequestHandler):
    sent_tool = False
    requests = []

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        type(self).requests.append(request)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        if not type(self).sent_tool and any(t.get('function', {}).get('name') == 'bash' for t in request.get('tools', [])):
            type(self).sent_tool = True
            arguments = json.dumps({'command': f'echo $$ > {self.pidfile}; sleep 30; touch {self.marker}', 'description': 'Wait for direct control cancellation', 'timeout': 40000})
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call-control', 'type': 'function', 'function': {'name': 'bash', 'arguments': arguments}}]}
            finish = 'tool_calls'
        else:
            delta, finish = {'role': 'assistant', 'content': 'CONTINUED_OK'}, 'stop'
        data = {'id': 'control', 'object': 'chat.completion.chunk', 'model': request['model'], 'created': 1,
                'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
        self.wfile.write(('data: ' + json.dumps(data) + '\n\ndata: [DONE]\n\n').encode())

    def log_message(self, *_args):
        pass


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    home, workspace = root / 'dsh', root / 'workspace'
    shutil.copytree('/opt/agentteams/dsh-template', home)
    workspace.mkdir()
    plugin = Path('/opt/agentteams/plugins/teamharness')
    runtime = root / 'runtime.yaml'
    runtime.write_text((plugin / 'adapters/deepseek-harness/fixtures/runtime.yaml').read_text().replace('role: worker', 'role: standalone'))
    Model.pidfile, Model.marker = workspace / 'pid', workspace / 'must-not-run'
    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ.update(DSH_HOME=str(home), DEEPSEEK_API_KEY='local-test-only',
        DEEPSEEK_BASE_URL=f'http://127.0.0.1:{server.server_port}',
        AGENTTEAMS_PLUGIN_DIR=str(plugin), TEAMHARNESS_RUNTIME_CONFIG=str(runtime),
        TEAMHARNESS_WORKSPACE=str(workspace), TEAMHARNESS_DSH_SKILL_ROOT=str(root / 'skills'),
        TEAMHARNESS_DSH_MODEL='deepseek-v4-flash', TEAMHARNESS_PYTHON='/usr/bin/python3')
    active = {'event_id': '$original', 'room_id': '!dm:test', 'sender': '@human:test', 'body': 'ORIGINAL_TASK'}
    state = BridgeState.load(root / 'bridge.json')
    state.begin_event('$original', '!dm:test')
    statuses = []

    class Matrix:
        def request(self, *_args):
            return {'joined': {'@agent:test': {}, '@human:test': {}}}

        def sync(self, *_args):
            return {'rooms': {'join': {'!dm:test': {'timeline': {'events': [{
                'type': 'm.room.message', 'event_id': '$supplement', 'sender': '@human:test',
                'content': {'msgtype': 'm.text', 'body': 'SUPPLEMENT_HANGZHOU',
                    'com.agentteams.control': {'action': action, 'agent_id': '@agent:test', 'run_id': '$original'}}}]}}}}}

        def fill_timeline_gaps(self, *_args):
            pass

        def send_content(self, room, content, tx):
            statuses.append(content['com.agentteams.execution']['status'])

    def poll():
        return Model.pidfile.exists() and poll_direct_control(Matrix(), 'cursor', active, state,
            '@agent:test', {'!dm:test': 'personal'}, set(), None)

    try:
        try:
            run_dsh('ORIGINAL_TASK', workspace, 30, session_id='session-control', resume=False,
                event_id='$original', attempt=1, poll_control=poll)
            raise AssertionError('native DSH did not stop')
        except InterruptedError:
            pass
        assert statuses == ['stopping'], statuses
        assert Model.pidfile.exists(), 'native bash never started'
        pid = int(Model.pidfile.read_text())
        try:
            os.kill(pid, 0)
            stat = Path(f'/proc/{pid}/stat')
            assert stat.exists() and stat.read_text().split()[2] == 'Z', 'native tool survived stop'
        except ProcessLookupError:
            pass
        assert not Model.marker.exists()
        pending = state.data['events']['$supplement']
        if action == 'steer':
            inputs = pending['direct_inputs']
            assert pending['status'] == 'queued'
            assert inputs == ['ORIGINAL_TASK', 'SUPPLEMENT_HANGZHOU'], inputs
        else:
            assert pending['status'] == 'completed'
            inputs = ['ORIGINAL_TASK', 'SUPPLEMENT_HANGZHOU']
        result = run_dsh('\n'.join(inputs), workspace, 30, session_id='session-control', resume=True,
            event_id='$supplement', attempt=1)
        assert result == 'CONTINUED_OK', result
        assert any('ORIGINAL_TASK' in json.dumps(r['messages']) and 'SUPPLEMENT_HANGZHOU' in json.dumps(r['messages']) for r in Model.requests)
        print('PASS: native DSH bash stopped, control durable, session resumed with original and supplementary inputs')
    finally:
        server.shutdown()
