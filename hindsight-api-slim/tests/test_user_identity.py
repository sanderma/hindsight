"""
Integration tests for @me bank alias resolution middleware.

Tests that the @me bank alias is correctly resolved to the caller's identity
via a configurable trusted header (e.g. set by Istio after JWT validation).
"""
import os

import httpx
import pytest
import pytest_asyncio

from hindsight_api.api import create_app
from hindsight_api.config import clear_config_cache

_IDENTITY_HEADER = "x-auth-sub"
_IDENTITY_VALUE = "alice"


@pytest_asyncio.fixture
async def api_client_with_identity_header(memory):
    """Create a test client with HINDSIGHT_API_USER_IDENTITY_HEADER configured."""
    os.environ["HINDSIGHT_API_USER_IDENTITY_HEADER"] = _IDENTITY_HEADER
    clear_config_cache()

    app = create_app(memory, initialize_memory=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

    os.environ.pop("HINDSIGHT_API_USER_IDENTITY_HEADER", None)
    clear_config_cache()


@pytest_asyncio.fixture
async def api_client_without_identity_header(memory):
    """Create a test client with no HINDSIGHT_API_USER_IDENTITY_HEADER configured."""
    os.environ.pop("HINDSIGHT_API_USER_IDENTITY_HEADER", None)
    clear_config_cache()

    app = create_app(memory, initialize_memory=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

    clear_config_cache()


@pytest.mark.asyncio
async def test_me_alias_returns_400_when_header_not_configured(api_client_without_identity_header):
    """@me should return 400 when HINDSIGHT_API_USER_IDENTITY_HEADER is not set."""
    response = await api_client_without_identity_header.get(
        "/v1/default/banks/@me/stats"
    )
    assert response.status_code == 400
    data = response.json()
    assert "detail" in data
    assert "HINDSIGHT_API_USER_IDENTITY_HEADER" in data["detail"]


@pytest.mark.asyncio
async def test_me_alias_returns_401_when_identity_header_missing(api_client_with_identity_header):
    """@me should return 401 when the configured identity header is absent from the request."""
    # Send request without the identity header
    response = await api_client_with_identity_header.get(
        "/v1/default/banks/@me/stats"
    )
    assert response.status_code == 401
    data = response.json()
    assert "detail" in data
    assert _IDENTITY_HEADER in data["detail"]


@pytest.mark.asyncio
async def test_me_alias_resolves_to_identity_header_value(api_client_with_identity_header):
    """@me should be resolved to the identity header value and routed correctly.

    A GET to /v1/default/banks/@me/stats with x-auth-sub: alice should be
    routed identically to /v1/default/banks/alice/stats.
    """
    # Request via @me alias with identity header present
    response_via_alias = await api_client_with_identity_header.get(
        "/v1/default/banks/@me/stats",
        headers={_IDENTITY_HEADER: _IDENTITY_VALUE},
    )

    # Request directly using the resolved bank id
    response_direct = await api_client_with_identity_header.get(
        f"/v1/default/banks/{_IDENTITY_VALUE}/stats",
    )

    # Both should succeed and return identical bank_id in the response
    assert response_via_alias.status_code == response_direct.status_code
    assert response_via_alias.status_code == 200

    alias_data = response_via_alias.json()
    direct_data = response_direct.json()

    # Both responses should report bank_id as "alice" (the resolved identity)
    assert alias_data.get("bank_id") == _IDENTITY_VALUE
    assert direct_data.get("bank_id") == _IDENTITY_VALUE
