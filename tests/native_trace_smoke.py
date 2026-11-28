#!/usr/bin/env python3
"""Actual packaged SDK model/tool spans to a local OTLP receiver; synthetic data only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

spans = []
class Endpoint(BaseHTTPRequestHandler):
    called_tool = False
    task_phase = False
    phase_calls = 0
    fail_model = False
    output_limit = False
    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        if self.path == '/v1/traces':
            export = ExportTraceServiceRequest.FromString(data)
            spans.extend(span for resource in export.resource_spans for scope in resource.scope_spans for span in scope.spans)
            self.send_response(200)
            self.end_headers()
            return
        assert self.path == '/chat/completions', self.path
        request = json.loads(data)
        if type(self).task_phase:
            assert 'SECRET_RAW_TRANSPORT_SNAPSHOT_MUST_STAY_NATIVE' not in json.dumps(request.get('messages', []))
        if type(self).fail_model:
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"fixture unauthorized","type":"invalid_api_key"}}')
            return
        tools = request.get('tools', [])
        if tools:
            assert request.get('max_tokens') == 32768, request.get('max_tokens')
            assert any(t.get('function', {}).get('name') == 'mcp__teamharness__task' for t in tools), tools
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        if type(self).output_limit:
            delta, finish = {'role': 'assistant', 'reasoning_content': 'TRUNCATED_REASONING_FIXTURE'}, 'length'
        elif type(self).task_phase and tools:
            type(self).phase_calls += 1
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call-task-submit', 'type': 'function',
                'function': {'name': 'mcp__teamharness__task', 'arguments': json.dumps({'action': 'submit', 'taskId': 'own', 'summary': 'fixture'})}}]}
            finish = 'tool_calls'
        elif not type(self).called_tool and any(t.get('function', {}).get('name') == 'read' for t in tools):
            type(self).called_tool = True
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call-trace-read', 'type': 'function',
                'function': {'name': 'read', 'arguments': json.dumps({'file_path': str(self.fixture_file)})}}]}
            finish = 'tool_calls'
        else:
            delta, finish = {'role': 'assistant', 'content': 'TRACE_FIXTURE_OK', 'reasoning_content': 'TRACE_REASONING_FIXTURE'}, 'stop'
        chunk = {'id': 'trace-fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': request['model'],
            'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}],
            'usage': {'prompt_tokens': 14, 'prompt_cache_hit_tokens': 3, 'completion_tokens': 5, 'total_tokens': 19}}
        self.wfile.write(('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode())
    def log_message(self, *_args):
        pass

def value(attribute):
    item = attribute.value
    if item.HasField('array_value'):
        return [part.string_value for part in item.array_value.values]
    return item.string_value if item.HasField('string_value') else item.int_value

def fields(span):
    return {attribute.key: value(attribute) for attribute in span.attributes}

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    home = root / 'dsh'
    shutil.copytree('/opt/agentteams/dsh-template', home)
    adapter = home / 'profiles/headless/node_modules/agentteams-teamharness-dsh'
    source = Path(os.environ['AGENTTEAMS_TEST_ADAPTER_SOURCE'])
    for item in source.iterdir():
        if item.suffix in ('.js', '.py', '.yml') or item.name == 'package.json':
            shutil.copyfile(item, adapter / item.name)
    workspace = root / 'workspace'
    workspace.mkdir()
    Endpoint.fixture_file = workspace / 'fixture.txt'
    Endpoint.fixture_file.write_text('SECRET_SYNTHETIC_TRACE_BODY')
    runtime = root / 'runtime.yaml'
    runtime.write_text((source / 'fixtures/runtime.yaml').read_text())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {**os.environ, 'HOME': str(root), 'DSH_HOME': str(home), 'DEEPSEEK_API_KEY': 'fixture-not-a-key',
        'AGENTTEAMS_MODEL_MAX_TOKENS': '32768',
        'DEEPSEEK_BASE_URL': f'http://127.0.0.1:{server.server_port}',
        'TEAMHARNESS_RUNTIME_CONFIG': str(runtime), 'TEAMHARNESS_WORKSPACE': str(workspace),
        'TEAMHARNESS_DSH_SKILL_ROOT': str(root / 'skills'), 'TEAMHARNESS_DSH_MODEL': 'deepseek-v4-flash',
        'TEAMHARNESS_PYTHON': '/opt/venv/agentteams/bin/python3', 'TEAMHARNESS_DSH_SESSION_ID': 'opaque-trace-fixture',
        'TEAMHARNESS_MATRIX_EVENT_ID': '$native-trace-source', 'TEAMHARNESS_MATRIX_ROOM_ID': '!native-trace:test',
        'TEAMHARNESS_NATIVE_TASK_CONTEXT': json.dumps({'role': 'worker', 'meta': {'room_id': '!native-trace:test',
            'sender_id': '@human:test', 'event_id': '$native-trace-source'}}),
        'AGENTTEAMS_OTEL_ENABLED': 'true', 'AGENTTEAMS_OTEL_RUNTIME': 'deepseek-harness',
        'AGENTTEAMS_OTEL_CAPTURE_CONTENT': 'false', 'AGENTTEAMS_LOG_CAPTURED': '1',
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT': f'http://127.0.0.1:{server.server_port}/v1/traces',
        'OTEL_EXPORTER_OTLP_ENDPOINT': f'http://127.0.0.1:{server.server_port}',
        'OTEL_EXPORTER_OTLP_HEADERS': '', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS': ''}
    try:
        result = subprocess.run(['agentteams-dsh', 'Read fixture.txt and reply TRACE_FIXTURE_OK.'], cwd=workspace,
            env=env, capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == 'TRACE_FIXTURE_OK', result.stdout
        roots = [span for span in spans if span.name == 'worker.turn']
        models = [span for span in spans if fields(span).get('gen_ai.operation.name') == 'chat']
        tools = [span for span in spans if fields(span).get('gen_ai.tool.call.id') == 'call-trace-read']
        assert len(roots) == 1, (result.stderr, [(span.name, fields(span)) for span in spans])
        assert len(models) >= 2, [(span.name, fields(span)) for span in spans]
        assert tools, [(span.name, fields(span)) for span in spans]
        for span in models:
            assert fields(span)['gen_ai.usage.input_tokens'] == 14, fields(span)
            assert fields(span)['gen_ai.usage.output_tokens'] == 5, fields(span)
            assert span.parent_span_id == roots[0].span_id
        assert any(fields(span).get('agentteams.input.event_ids') == ['$native-trace-source'] for span in models)
        assert fields(roots[0])['agentteams.room.id'] == '!native-trace:test'
        assert fields(roots[0])['agentteams.runtime'] == 'deepseek-harness'
        assert fields(roots[0])['agentteams.runtime.session_id'] == 'opaque-trace-fixture'
        assert all('SECRET_SYNTHETIC_TRACE_BODY' not in str(span) for span in spans)
        assert all(not any(key in fields(span) for key in ('input', 'output', 'gen_ai.prompt', 'gen_ai.completion')) for span in spans)
        print(f'Actual native SDK model/tool spans, input IDs, token usage, OTLP transport and no content: PASS ({len(spans)} spans)')
        spans.clear()
        Endpoint.called_tool = False
        Endpoint.fixture_file.write_text('TRACE_TOOL_OUTPUT\nfixture-secret-key-123456')
        env.update(AGENTTEAMS_OTEL_CAPTURE_CONTENT='true', TRACE_FIXTURE_API_KEY='fixture-secret-key-123456',
                   TEAMHARNESS_DSH_SESSION_ID='opaque-content-fixture')
        captured = subprocess.run(['agentteams-dsh', 'Read fixture.txt and reply TRACE_FIXTURE_OK.'], cwd=workspace,
            env=env, capture_output=True, text=True, timeout=60)
        assert captured.returncode == 0, captured.stderr
        tool = next(span for span in spans if fields(span).get('gen_ai.tool.call.id') == 'call-trace-read')
        assert str(Endpoint.fixture_file) in fields(tool)['langfuse.observation.input']
        assert 'TRACE_TOOL_OUTPUT' in fields(tool)['langfuse.observation.output']
        assert 'fixture-secret-key-123456' not in str(spans)
        assert '[REDACTED]' in fields(tool)['langfuse.observation.output']
        model_outputs = [fields(span).get('langfuse.observation.output', '') for span in spans
                         if fields(span).get('gen_ai.operation.name') == 'chat']
        assert any('TRACE_REASONING_FIXTURE' in output for output in model_outputs), model_outputs
        assert any('TRACE_FIXTURE_OK' in output for output in model_outputs), model_outputs
        print('Actual model reasoning and tool input/output exported with credential redaction: PASS')
        env['AGENTTEAMS_OTEL_CAPTURE_CONTENT'] = 'false'
        spans.clear()
        output = root / 'tasks/own/workspace'
        output.mkdir(parents=True)
        begin = {'task': {'id': 'own', 'mainTaskId': 'main', 'projectId': '', 'status': 'in_progress',
            'assignmentId': 'dispatch', 'assignedTo': 'worker'}, 'taskDirectory': str(output.parent),
            'outputDirectory': str(output), 'scratchDirectory': str(output / '.scratch'), 'generation': 2}
        submission = {'task': {'id': 'own', 'status': 'submitted', 'submissionId': 'saved'},
            'notification': {'status': 'queued', 'recipient': 'leader', 'eventId': 'notice'}}
        binary = root / 'bin'
        binary.mkdir()
        agt = binary / 'agt'
        agt.write_text('#!/usr/bin/python3\nimport json,sys\nbegin=' + repr(begin) + '\nsubmission=' + repr(submission) +
            '\nprint(json.dumps(begin if sys.argv[2]=="begin" else submission))\n')
        agt.chmod(0o700)
        env['PATH'] = str(binary) + ':' + env['PATH']
        env['TEAMHARNESS_DSH_SESSION_ID'] = 'opaque-task-fixture'
        env['TEAMHARNESS_MATRIX_EVENT_ID'] = '$native-task-source'
        env['TEAMHARNESS_NATIVE_TASK_CONTEXT'] = json.dumps({'role': 'worker', 'meta': {'room_id': '!native-trace:test',
            'sender_id': '@controller:test', 'event_id': '$native-task-source', 'teamharness_coordination': {
                'kind': 'task_assigned', 'id': 'b' * 32, 'task_id': 'own', 'main_task_id': 'main',
                'project_id': '', 'delivery_id': 'dispatch'}}})
        seed = """import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm';
import { matrixEventMessageId } from '/opt/agentteams/dsh-template/profiles/headless/node_modules/agentteams-teamharness-dsh/message-id.js';
const ctx=new Context();
await ctx.plugin(SessionStore).await();
await ctx.plugin(JsonlSessionPersistence,{root:process.argv[1]+'/sessions',compression:'zstd'}).await();
const sessions=ctx.get('sessions');
const session=sessions.create('opaque-task-fixture',{meta:{cwd:process.argv[2]}});
session.append('user/message',freezeMessage({id:MessageId(matrixEventMessageId('agentteams-source-v1:$native-task-source',1)),
role:'user',source:{kind:'plugin',plugin:'agentteams.matrix-source'},
content:[{type:'text',text:'SECRET_RAW_TRANSPORT_SNAPSHOT_MUST_STAY_NATIVE'}]}),{surfaceOp:'append'});
await sessions.flush(session);
await ctx.registry.delete(JsonlSessionPersistence);await ctx.registry.delete(SessionStore);
"""
        seeded = subprocess.run(['node', '--input-type=module', '-e', seed, str(home), str(output)],
                                cwd='/opt/agentteams/dsh', env=env, capture_output=True, text=True)
        assert seeded.returncode == 0, seeded.stderr
        Endpoint.task_phase = True
        phase = subprocess.run(['agentteams-dsh', 'Execute this synthetic Task and submit.'], cwd=workspace,
            env=env, capture_output=True, text=True, timeout=60)
        assert phase.returncode == 0, phase.stderr
        assert phase.stdout.strip() == 'NO_REPLY', phase.stdout
        assert Endpoint.phase_calls == 1, Endpoint.phase_calls
        task_root = next(span for span in spans if span.name == 'worker.turn')
        assert fields(task_root)['agentteams.coordination.id'] == 'b' * 32
        assert fields(task_root)['agentteams.execution.generation'] == 2
        assert fields(task_root)['agentteams.task.id'] == 'own'
        # These are this fixture's own synthetic SDK rows, never a live session.
        decode = """const fs=require('node:fs'),z=require('node:zlib'),p=require('node:path');
const root=process.argv[1],lines=[];
for(const name of fs.readdirSync(root,{recursive:true})) {
 if(!name.endsWith('.jsonl')&&!name.endsWith('.jsonl.zstd'))continue;
 const bytes=fs.readFileSync(p.join(root,name));
 lines.push(...(name.endsWith('.zstd')?z.zstdDecompressSync(bytes):bytes).toString().trim().split('\\n').filter(Boolean).map(JSON.parse));
}
process.stdout.write(JSON.stringify(lines));"""
        readback = subprocess.run(['node', '-e', decode, str(home)], capture_output=True, text=True, check=True)
        records = json.loads(readback.stdout)
        assert any(record.get('type') == 'turn/end' and record['data']['reason']['kind'] == 'completed' for record in records), records
        assert any(record.get('type') == 'user/message' and record['data'].get('source', {}).get('plugin') == 'agentteams.task-phase' for record in records), records
        assert any(record.get('type') == 'tool/result' for record in records), records
        assert any(record.get('type') == 'user/message' and
                   'SECRET_RAW_TRANSPORT_SNAPSHOT_MUST_STAY_NATIVE' in str(record.get('data')) for record in records)
        print('Actual Task phase: one model call, normal native completion, durable tool/receipt and code final: PASS')
        spans.clear()
        Endpoint.output_limit = True
        Endpoint.task_phase = False
        env['TEAMHARNESS_DSH_SESSION_ID'] = 'opaque-output-limit-fixture'
        env['TEAMHARNESS_MATRIX_EVENT_ID'] = '$native-output-limit-source'
        env['TEAMHARNESS_NATIVE_TASK_CONTEXT'] = json.dumps({'role': 'worker', 'meta': {'room_id': '!native-trace:test',
            'sender_id': '@human:test', 'event_id': '$native-output-limit-source'}})
        limited = subprocess.run(['agentteams-dsh', 'Own synthetic output limit fixture.'], cwd=workspace,
            env=env, capture_output=True, text=True, timeout=45)
        assert limited.returncode == 76, (limited.returncode, limited.stderr)
        assert 'native turn ended: max-tokens' in limited.stderr
        assert next(span for span in spans if span.name == 'worker.turn').status.code == 2
        print('Actual native output limit returns a typed failure and ERROR turn span: PASS')
        spans.clear()
        Endpoint.output_limit = False
        Endpoint.fail_model = True
        env['TEAMHARNESS_DSH_SESSION_ID'] = 'opaque-error-fixture'
        env['TEAMHARNESS_MATRIX_EVENT_ID'] = '$native-error-source'
        env['TEAMHARNESS_NATIVE_TASK_CONTEXT'] = json.dumps({'role': 'worker', 'meta': {'room_id': '!native-trace:test',
            'sender_id': '@human:test', 'event_id': '$native-error-source'}})
        failure = subprocess.run(['agentteams-dsh', 'Own synthetic failure fixture.'], cwd=workspace,
            env=env, capture_output=True, text=True, timeout=45)
        assert failure.returncode != 0
        failed_model = next(span for span in spans if fields(span).get('gen_ai.operation.name') == 'chat')
        failed_turn = next(span for span in spans if span.name == 'worker.turn')
        assert failed_model.status.code == 2, failed_model
        assert failed_turn.status.code == 2, failed_turn
        assert fields(failed_model).get('error.type'), failed_model
        print('Actual model HTTP 401 exports ERROR on native model and turn spans: PASS')
    finally:
        server.shutdown()
