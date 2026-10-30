"""A scripted OpenAI-compatible AI provider, for the built-in assistant's VM test.

A user message "CALL <tool> <json arguments>" makes the model call that tool;
after a tool result or a note from HSI it answers in text. Usage: port.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def reply_for(messages):
    last = messages[-1]
    content = last.get("content") or ""
    if last["role"] == "user" and content.startswith("CALL "):
        _, name, args = content.split(" ", 2)
        return "", [(name, json.loads(args))]
    if last["role"] == "tool":
        return "Result received: " + content[:200], []
    if content.startswith("[HSI]"):
        return "Noted. " + content, []
    return "Hello from the test model.", []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "test/model"}]}).encode()
        self.send_response(200 if self.path.endswith("/models") else 404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["content-length"])))
        text, calls = reply_for(request["messages"])
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def send(chunk):
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")

        if text:
            send({"choices": [{"delta": {"content": text}}]})
        for i, (name, args) in enumerate(calls):
            send({"choices": [{"delta": {"tool_calls": [{"index": i, "id": f"call_{i}", "type": "function",
                                                          "function": {"name": name, "arguments": json.dumps(args)}}]}}]})
        send({"choices": [{"delta": {}, "finish_reason": "tool_calls" if calls else "stop"}]})
        self.wfile.write(b"data: [DONE]\n\n")


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
