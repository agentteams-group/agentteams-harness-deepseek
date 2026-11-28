"""Export actual DSH SDK boundaries through the shared OTel schema/transport."""
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import sys

lib = Path(os.getenv("AGENTTEAMS_LOG_LIB_DIR", "/opt/agentteams/scripts/lib"))
sys.path[:0] = [str(lib / "telemetry"), str(lib)]
from opentelemetry import context, propagate, trace
import at_telemetry as telemetry
from at_runtime_adapters import start_turn
from at_trace_transport import carrier, incoming


def serve(source, output):
    telemetry.configure()
    spans, fields = {}, {}
    for line in source:
        request = json.loads(line)
        identity = request["id"]
        operation = request["operation"]
        if operation == "flush":
            result = {"flushed": telemetry.flush()}
        elif operation == "start":
            parent = spans.get(request.get("parent"))
            if request["kind"] == "turn":
                fields = telemetry.turn_fields(request["sessionId"], metadata=request.get("metadata"))
                fields.update(incoming({"com.agentteams.trace": request.get("carrier", {})}))
                fields.update(request.get("fields") or {})
                span = start_turn(fields, None)
                span.set_attribute("agentteams.telemetry.adapter", "deepseek-native")
                span.set_attribute("agentteams.telemetry.coverage", "turn,model,tool")
                span.set_attribute("agentteams.telemetry.capture_content", os.getenv("AGENTTEAMS_OTEL_CAPTURE_CONTENT", "true"))
            else:
                token = telemetry._correlation.set({**fields, **(request.get("fields") or {})})
                try:
                    span = trace.get_tracer("agentteams.worker").start_span(request["name"],
                        context=trace.set_span_in_context(parent) if parent else context.Context(),
                        start_time=request["timeNs"], attributes=request.get("attributes") or {})
                finally:
                    telemetry._correlation.reset(token)
            telemetry.set_io(span, input=request.get("input"))
            spans[identity] = span
            if request.get("eventIds"):
                span.set_attribute("agentteams.input.event_ids", request["eventIds"])
                if parent:
                    parent.set_attribute("agentteams.input.event_ids", request["eventIds"])
            with trace.use_span(span, end_on_exit=False):
                token = telemetry._correlation.set(fields)
                try:
                    result = {"carrier": carrier()}
                finally:
                    telemetry._correlation.reset(token)
        elif operation == "enrich":
            fields.update(request["fields"])
            token = telemetry._correlation.set(fields)
            try:
                # Admission resolves planning identity after the root started.
                # Refresh query metadata and tags as well as native attributes.
                telemetry.IdentityProcessor().on_start(spans[identity])
            finally:
                telemetry._correlation.reset(token)
            result = {}
        elif operation == "end":
            span = spans.pop(identity)
            telemetry.set_io(span, output=request.get("output"))
            for key, value in (request.get("attributes") or {}).items():
                span.set_attribute(key, value)
            if request.get("error"):
                span.set_attribute("error.type", request["error"])
                span.set_status(trace.Status(trace.StatusCode.ERROR, request["error"]))
            span.end(end_time=request["timeNs"])
            result = {}
        else:
            raise ValueError("Unknown native SDK trace operation")
        output.write(json.dumps({"id": identity, **result}) + "\n")
        output.flush()


if __name__ == "__main__":
    output = sys.stdout
    with redirect_stdout(sys.stderr):
        serve(sys.stdin, output)
