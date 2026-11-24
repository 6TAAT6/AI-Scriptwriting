"""OpenRouter's in-flight budget 402 is admission control, not an empty account.

When the remaining balance cannot cover the requests still running, OpenRouter refuses a new one
with HTTP 402 ``in_flight_budget_exhausted`` and ``Retry-After``; it succeeds once those settle.
A depleted balance keeps answering "insufficient credits", which must stay terminal billing.
"""

from types import SimpleNamespace

from agent.error_classifier import FailoverReason, classify_api_error


class _OpenRouterStatusError(Exception):
    """Shaped like the OpenAI SDK's APIStatusError: ``str()`` carries the status and body repr."""

    def __init__(self, status_code, body, headers=None):
        super().__init__(f"Error code: {status_code} - {body!r}")
        self.status_code = status_code
        self.body = body["error"]
        self.response = SimpleNamespace(headers=headers or {})


def _openrouter_402(message, metadata=None):
    return {"error": {"message": message, "code": 402, **({"metadata": metadata} if metadata else {})}}


def test_in_flight_budget_402_is_retryable_rate_limit():
    body = _openrouter_402(
        "This request would exceed your available credits given your current in-flight requests. "
        "Retry after in-flight requests settle, or add credits.",
        {"reason": "in_flight_budget_exhausted", "limit_source": "openrouter_in_flight_budget",
         "headers": {"Retry-After": "120"}},
    )
    result = classify_api_error(
        _OpenRouterStatusError(402, body, {"Retry-After": "120"}),
        provider="custom", model="google/gemini-4-neon", base_url="http://127.0.0.1:18081/api/v1",
    )
    assert result.reason == FailoverReason.rate_limit
    assert result.retryable is True


def test_depleted_balance_402_stays_terminal_billing():
    body = _openrouter_402("Insufficient credits. Add more using https://openrouter.ai/settings/credits")
    result = classify_api_error(
        _OpenRouterStatusError(402, body),
        provider="custom", model="google/gemini-4-neon", base_url="http://127.0.0.1:18081/api/v1",
    )
    assert result.reason == FailoverReason.billing
    assert result.retryable is False
