"""Tests for WebSocket client shot notes methods."""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from gaggimate_mcp.api.websocket import GaggimateWebSocketClient, generate_request_id
from gaggimate_mcp.config import GaggimateConfig
from gaggimate_mcp.errors import GaggimateError, ErrorCode


class TestGenerateRequestId:
    """Tests for request ID generation."""

    def test_generate_request_id_format(self):
        """Request ID should have correct format."""
        request_id = generate_request_id()
        assert request_id.startswith("mcp-")
        parts = request_id.split("-")
        assert len(parts) == 3
        # Timestamp part should be numeric
        assert parts[1].isdigit()
        # Random suffix should be alphanumeric
        assert parts[2].isalnum()
        assert len(parts[2]) == 9

    def test_generate_request_id_unique(self):
        """Request IDs should be unique."""
        ids = [generate_request_id() for _ in range(100)]
        assert len(set(ids)) == 100


class TestWebSocketClientShotNotes:
    """Tests for shot notes WebSocket methods."""

    @pytest.fixture
    def config(self, tmp_path):
        """Create isolated test configuration."""
        return GaggimateConfig(gaggimate_host="test.local", storage_path=tmp_path)

    @pytest.fixture
    def client(self, config):
        """Create WebSocket client with test config."""
        return GaggimateWebSocketClient(config)

    @pytest.mark.asyncio
    async def test_get_shot_notes_success(self, client):
        """Test successful retrieval of shot notes."""
        mock_notes = {
            "rating": 4,
            "notes": "Great shot, well balanced",
            "balanceTaste": "balanced",
            "grindSetting": "12",
            "doseIn": 18.0,
            "doseOut": 36.0
        }

        with patch.object(client, '_send_request', new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {"notes": mock_notes}

            result = await client.get_shot_notes("000100")

            assert result == mock_notes
            mock_send.assert_called_once()
            call_args = mock_send.call_args
            assert call_args[0][0] == "req:history:notes:get"
            # ID should be normalized (no leading zeros)
            assert call_args[1]["id"] == "100"

    @pytest.mark.asyncio
    async def test_get_shot_notes_normalizes_id(self, client):
        """Test that shot ID is normalized to integer string."""
        with patch.object(client, '_send_request', new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {"notes": None}

            # Various input formats should all normalize to "100"
            await client.get_shot_notes("100")
            assert mock_send.call_args[1]["id"] == "100"

            await client.get_shot_notes("000100")
            assert mock_send.call_args[1]["id"] == "100"

            await client.get_shot_notes("0100")
            assert mock_send.call_args[1]["id"] == "100"

    @pytest.mark.asyncio
    async def test_get_shot_notes_empty(self, client):
        """Test handling of empty notes response."""
        with patch.object(client, '_send_request', new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {"notes": None}

            result = await client.get_shot_notes("100")

            assert result is None

    @pytest.mark.asyncio
    async def test_get_shot_notes_invalid_id(self, client):
        """Test that invalid shot ID raises ValueError."""
        with pytest.raises(ValueError):
            await client.get_shot_notes("invalid")

        with pytest.raises(ValueError):
            await client.get_shot_notes("abc123")

    @pytest.fixture
    def note_transport(self):
        """Replacement-style firmware: omitted fields really would be erased."""
        state = {}

        async def request(kind, request_id, **kwargs):
            if kind == "req:history:notes:get":
                return {"notes": dict(state)}
            assert kind == "req:history:notes:save"
            state.clear()
            state.update(kwargs["notes"])
            return {"msg": "Notes saved successfully"}

        return AsyncMock(side_effect=request)

    @pytest.mark.asyncio
    async def test_save_shot_notes_success(self, client, note_transport):
        with patch.object(client, "_send_request", note_transport):
            result = await client.save_shot_notes(
                shot_id="100", rating=4, notes="Excellent extraction",
                balance_taste="balanced", grind_setting="12", dose_in=18.0,
                dose_out=36.0, bean_type="Ethiopia",
            )
        assert result["msg"] == "Notes saved successfully"
        assert note_transport.call_count == 3
        call_args = note_transport.call_args_list[1]
        assert call_args[0][0] == "req:history:notes:save"
        assert call_args[1]["id"] == "100"
        assert call_args[1]["notes"] == {
            "rating": 4, "notes": "Excellent extraction", "balanceTaste": "balanced",
            "grindSetting": "12", "doseIn": 18.0, "doseOut": 36.0, "beanType": "Ethiopia",
        }
        assert result["notes"] == call_args[1]["notes"]

    @pytest.mark.asyncio
    async def test_save_shot_notes_partial_fields(self, client, note_transport):
        with patch.object(client, "_send_request", note_transport):
            await client.save_shot_notes(shot_id="100", rating=3, notes="Slightly sour")
        assert note_transport.call_args_list[1][1]["notes"] == {
            "rating": 3, "notes": "Slightly sour",
        }

    @pytest.mark.asyncio
    async def test_save_shot_notes_rating_only(self, client, note_transport):
        with patch.object(client, "_send_request", note_transport):
            await client.save_shot_notes(shot_id="100", rating=5)
        assert note_transport.call_args_list[1][1]["notes"] == {"rating": 5}

    @pytest.mark.asyncio
    async def test_save_shot_notes_normalizes_id(self, client, note_transport):
        with patch.object(client, "_send_request", note_transport):
            await client.save_shot_notes(shot_id="000100", rating=4)
        assert all(call.kwargs["id"] == "100" for call in note_transport.call_args_list)

    @pytest.mark.asyncio
    async def test_save_shot_notes_invalid_id(self, client):
        with pytest.raises(ValueError):
            await client.save_shot_notes(shot_id="invalid", rating=4)

    @pytest.mark.asyncio
    async def test_save_shot_notes_zero_rating(self, client, note_transport):
        with patch.object(client, "_send_request", note_transport):
            await client.save_shot_notes(shot_id="100", rating=0)
        assert note_transport.call_args_list[1][1]["notes"]["rating"] == 0

    @pytest.mark.asyncio
    async def test_get_shot_notes_websocket_error(self, client):
        """Test handling of WebSocket errors during get."""
        with patch.object(client, '_send_request', new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = GaggimateError(
                ErrorCode.WEBSOCKET_ERROR,
                "Connection failed"
            )

            with pytest.raises(GaggimateError) as exc_info:
                await client.get_shot_notes("100")

            assert exc_info.value.code == ErrorCode.WEBSOCKET_ERROR

    @pytest.mark.asyncio
    async def test_save_shot_notes_timeout(self, client):
        """Test handling of timeout during save."""
        with patch.object(client, '_send_request', new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = GaggimateError(
                ErrorCode.TIMEOUT,
                "Request timed out"
            )

            with pytest.raises(GaggimateError) as exc_info:
                await client.save_shot_notes(shot_id="100", rating=4)

            assert exc_info.value.code == ErrorCode.TIMEOUT

    @pytest.mark.asyncio
    async def test_save_shot_notes_device_unreachable(self, client):
        """Test handling of unreachable device during save."""
        with patch.object(client, '_send_request', new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = GaggimateError(
                ErrorCode.DEVICE_UNREACHABLE,
                "Cannot connect to device"
            )

            with pytest.raises(GaggimateError) as exc_info:
                await client.save_shot_notes(shot_id="100", rating=4)

            assert exc_info.value.code == ErrorCode.DEVICE_UNREACHABLE


class TestWebSocketClientUrl:
    """Tests for WebSocket URL construction."""

    def test_ws_url_default(self):
        """Test default WebSocket URL construction."""
        config = GaggimateConfig(gaggimate_host="gaggimate.local")
        client = GaggimateWebSocketClient(config)
        assert client.ws_url == "ws://gaggimate.local/ws"

    def test_ws_url_with_ip(self):
        """Test WebSocket URL with IP address."""
        config = GaggimateConfig(gaggimate_host="192.168.1.100")
        client = GaggimateWebSocketClient(config)
        assert client.ws_url == "ws://192.168.1.100/ws"

    def test_ws_url_with_https(self):
        """Test WebSocket URL with WSS protocol."""
        config = GaggimateConfig(gaggimate_host="gaggimate.local", gaggimate_protocol="wss")
        client = GaggimateWebSocketClient(config)
        assert client.ws_url == "wss://gaggimate.local/ws"
