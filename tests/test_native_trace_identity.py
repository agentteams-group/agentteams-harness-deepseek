"""Late public Task admission must update the real root and descendant tags."""
import importlib.util
import io
import json
from pathlib import Path
import time

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


def test_prepared_leader_identity_reaches_root_metadata_and_child_spans(monkeypatch):
    source = Path(__file__).resolve().parents[1] / 'plugins/teamharness/adapters/deepseek-harness/native-trace.py'
    spec = importlib.util.spec_from_file_location('native_identity_bridge', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.telemetry, 'configure', lambda: None)
    monkeypatch.setenv('AGENTTEAMS_WORKER_NAME', 'team-leader')
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(module.telemetry.IdentityProcessor())
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    now = time.time_ns()
    requests = [
        {'operation': 'start', 'id': 'root', 'kind': 'turn', 'sessionId': 'planning'},
        {'operation': 'enrich', 'id': 'root', 'fields': {'agentteams.task.id': 'main-one', 'agentteams.main_task.id': 'main-one'}},
        {'operation': 'start', 'id': 'child', 'kind': 'model', 'name': 'native-model', 'parent': 'root', 'timeNs': now},
        {'operation': 'end', 'id': 'child', 'timeNs': now + 100000000},
        {'operation': 'end', 'id': 'root', 'timeNs': now + 200000000},
    ]
    module.serve(io.StringIO('\n'.join(json.dumps(r) for r in requests)), io.StringIO())
    spans = exporter.get_finished_spans()
    assert len(spans) == 2
    for span in spans:
        assert span.attributes['langfuse.trace.metadata.agentteams.task.id'] == 'main-one'
        assert span.attributes['langfuse.trace.metadata.agentteams.main_task.id'] == 'main-one'
        assert 'main_task:main-one' in span.attributes['langfuse.trace.tags']
    assert spans[0].parent.span_id == spans[1].context.span_id
    provider.shutdown()
