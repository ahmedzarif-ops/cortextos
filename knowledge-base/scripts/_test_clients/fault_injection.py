"""Fault-injecting Gemini client for testing mmrag._retry_generate_content.

Wired via two env vars consumed by mmrag.get_genai_client:

    MMRAG_GEMINI_CLIENT_FACTORY=_test_clients.fault_injection:make_client
    MMRAG_FAULT_INJECTION_SCRIPT="503,503,200"

The script is a comma-separated list of one entry per generate_content() call.
Each entry is either "<code>" or "<code>:<message>". Code 200 returns a stub
success response; any other code raises an APIError with the corresponding
status name.

Code -> status mapping (set is intentionally narrow — covers what the retry
loop predicate distinguishes between transient and non-transient):

    429 -> RESOURCE_EXHAUSTED   (transient)
    500 -> INTERNAL             (transient by HTTP code)
    503 -> UNAVAILABLE          (transient)
    400 -> INVALID_ARGUMENT     (non-transient)
    401 -> UNAUTHENTICATED      (non-transient)
    403 -> PERMISSION_DENIED    (non-transient)
"""

import os
from google.genai.errors import APIError


_STATUS_FOR_CODE = {
    429: "RESOURCE_EXHAUSTED",
    500: "INTERNAL",
    503: "UNAVAILABLE",
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
}


class _InjectedAPIError(APIError):
    """APIError subclass that sets .code/.status/.message directly.

    Avoids invoking APIError.__init__ because the SDK's constructor expects a
    real HTTP response object and parses response_json in version-specific
    ways. Subclassing preserves `except google.genai.errors.APIError` catches
    in callers (an _InjectedAPIError is-a APIError).
    """
    def __init__(self, code, status, message=""):
        Exception.__init__(self, message)
        self.code = code
        self.status = status
        self.message = message


class _StubResponse:
    def __init__(self, text):
        self.text = text
        self.usage_metadata = None


class _StubModels:
    def __init__(self, script, embed_script=None):
        self._script = list(script)
        self._index = 0
        self._embed_script = list(embed_script) if embed_script is not None else None
        self._embed_index = 0

    def generate_content(self, model=None, contents=None, **kwargs):
        if self._index >= len(self._script):
            raise RuntimeError(
                f"fault_injection: script exhausted at attempt {self._index + 1} "
                f"(scripted {len(self._script)} responses)"
            )
        code, message = self._script[self._index]
        self._index += 1
        if code == 200:
            return _StubResponse(message or "[stub] fault-injection success")
        status = _STATUS_FOR_CODE.get(code, "UNKNOWN")
        raise _InjectedAPIError(code, status, message or f"injected {code} {status}")

    def embed_content(self, *a, **kw):
        """Scripted embedding responses.

        ⛔ THIS USED TO RAISE "embed_content is not scripted. Tests should target
        _retry_generate_content directly." That refusal was reasonable when the only
        retry loop was on generation — and it is also the reason the embedding path
        went untested and unretried. The harness was scoped to the half that already
        worked. (sentinel, 2026-09-04, task_1788512896309_59094644)

        Driven by MMRAG_EMBED_FAULT_SCRIPT, same grammar as the generate script. If
        that variable is unset the embed path always succeeds, so existing generate-
        only tests are unaffected.
        """
        if self._embed_script is None:
            return _StubEmbedResponse()
        if self._embed_index >= len(self._embed_script):
            raise RuntimeError(
                f"fault_injection: embed script exhausted at attempt "
                f"{self._embed_index + 1} (scripted {len(self._embed_script)} responses)"
            )
        code, message = self._embed_script[self._embed_index]
        self._embed_index += 1
        if code == 200:
            return _StubEmbedResponse()
        status = _STATUS_FOR_CODE.get(code, "UNKNOWN")
        raise _InjectedAPIError(code, status, message or f"injected {code} {status}")

    @property
    def embed_calls(self):
        """How many times the embed path was ENTERED — the count a retry test needs."""
        return self._embed_index


class _StubEmbedResponse:
    """Minimal shape of an embed_content response: .embeddings[0].values."""
    class _E:
        def __init__(self, values):
            self.values = values

    def __init__(self, dims=8):
        self.embeddings = [self._E([0.0] * dims)]


class FaultInjectionClient:
    def __init__(self, script, embed_script=None):
        self.models = _StubModels(script, embed_script)


def _parse_script(spec):
    entries = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" in chunk:
            code_s, message = chunk.split(":", 1)
        else:
            code_s, message = chunk, ""
        entries.append((int(code_s), message))
    return entries


def make_client(api_key=None):
    """Factory entry point. Signature matches the real Client constructor;
    api_key is accepted but ignored — fault injection is fully driven by
    MMRAG_FAULT_INJECTION_SCRIPT.
    """
    spec = os.environ.get("MMRAG_FAULT_INJECTION_SCRIPT", "200")
    embed_spec = os.environ.get("MMRAG_EMBED_FAULT_SCRIPT")
    embed_script = _parse_script(embed_spec) if embed_spec else None
    return FaultInjectionClient(_parse_script(spec), embed_script)
