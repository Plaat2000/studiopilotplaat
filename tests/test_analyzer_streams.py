"""Per-track analyzer streams: each LivePilot_Analyzer instance announces its
host track with /stream_hello from the same UDP socket that carries its
perception data, and the bridge keeps track-local readings out of the master
cache."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

from mcp_server import m4l_bridge
from mcp_server.m4l_bridge import SpectralCache, SpectralReceiver

ROOT = Path(__file__).resolve().parents[1]
MASTER, TRACK, OTHER = 50001, 50002, 50003
BANDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]


def _receiver():
    cache = SpectralCache()
    return cache, SpectralReceiver(cache)


def _spectrum(receiver, source, value):
    receiver._handle_message("/spectrum", [value] * 9, source=source)


class TestReceiverRouting:
    def test_legacy_unlabelled_data_stays_master(self):
        cache, rx = _receiver()
        _spectrum(rx, MASTER, 0.3)
        assert cache.get("spectrum")["value"]["mid"] == 0.3
        assert not cache.streams_supported

    def test_track_stream_is_separate_from_master(self):
        cache, rx = _receiver()
        rx._handle_message("/stream_hello", ["master", -1, 7], source=MASTER)
        rx._handle_message("/stream_hello", ["track", 3, 42], source=TRACK)
        _spectrum(rx, MASTER, 0.2)
        _spectrum(rx, TRACK, 0.9)
        rx._handle_message("/rms", [0.5], source=TRACK)
        assert cache.get("spectrum")["value"]["mid"] == 0.2
        assert cache.get("rms") is None
        track = cache.stream("track:3")
        assert track.get("spectrum")["value"]["mid"] == 0.9
        assert track.get("rms")["value"] == 0.5
        status = cache.stream_status()
        assert status["streams_supported"] is True
        assert status["streams"][0]["track_index"] == 3
        assert status["streams"][0]["device_id"] == 42
        assert status["streams"][0]["has_data"] is True

    def test_return_stream_uses_negative_index(self):
        cache, rx = _receiver()
        rx._handle_message("/stream_hello", ["return", 1, 9], source=TRACK)
        assert cache.stream_status()["streams"][0]["track_index"] == -2

    def test_unannounced_sender_dropped_once_master_is_stream_aware(self):
        cache, rx = _receiver()
        rx._handle_message("/stream_hello", ["master", -1, 7], source=MASTER)
        _spectrum(rx, OTHER, 0.7)
        assert cache.get("spectrum") is None

    def test_old_master_with_new_track_instance_stays_separate(self):
        cache, rx = _receiver()
        rx._handle_message("/stream_hello", ["track", 0, 5], source=TRACK)
        _spectrum(rx, MASTER, 0.1)
        _spectrum(rx, TRACK, 0.6)
        assert cache.get("spectrum")["value"]["mid"] == 0.1
        assert cache.stream("track:0").get("spectrum")["value"]["mid"] == 0.6

    def test_reordered_track_drops_old_slot(self):
        cache, rx = _receiver()
        rx._handle_message("/stream_hello", ["track", 2, 5], source=TRACK)
        _spectrum(rx, TRACK, 0.6)
        rx._handle_message("/stream_hello", ["track", 4, 5], source=TRACK)
        assert cache.stream("track:2") is None
        _spectrum(rx, TRACK, 0.4)
        assert cache.stream("track:4").get("spectrum")["value"]["mid"] == 0.4

    def test_expired_identity_becomes_unknown(self, monkeypatch):
        cache, rx = _receiver()
        rx._handle_message("/stream_hello", ["track", 2, 5], source=TRACK)
        rx._sources[TRACK]["seen"] -= m4l_bridge.STREAM_HELLO_TTL + 1
        _spectrum(rx, TRACK, 0.6)
        assert cache.stream("track:2") is None
        assert cache.get("spectrum")["value"]["mid"] == 0.6

    def test_invalid_hello_ignored(self):
        cache, rx = _receiver()
        rx._handle_message("/stream_hello", ["track", -4], source=TRACK)
        rx._handle_message("/stream_hello", ["bogus", 1], source=TRACK)
        rx._handle_message("/stream_hello", ["track"], source=TRACK)
        assert not cache.streams_supported

    def test_datagram_source_port_feeds_routing(self):
        cache, rx = _receiver()
        hello = _osc("/stream_hello", "track", 1, 3)
        rx.datagram_received(hello, ("127.0.0.1", TRACK))
        rx.datagram_received(_osc("/rms", 0.25), ("127.0.0.1", TRACK))
        assert cache.stream("track:1").get("rms")["value"] == 0.25
        assert cache.get("rms") is None


def _osc(address, *args):
    import struct

    def pad(raw):
        raw += b"\x00"
        return raw + b"\x00" * (-len(raw) % 4)

    tags, payload = ",", b""
    for arg in args:
        if isinstance(arg, str):
            tags += "s"
            payload += pad(arg.encode())
        elif isinstance(arg, int):
            tags += "i"
            payload += struct.pack(">i", arg)
        else:
            tags += "f"
            payload += struct.pack(">f", arg)
    return pad(address.encode()) + pad(tags.encode()) + payload


def _ctx(cache, track_devices, loads):
    class _Ableton:
        def send_command(self, cmd, params=None):
            assert cmd == "get_track_info"
            return {"devices": track_devices}

    return SimpleNamespace(lifespan_context={"ableton": _Ableton(), "spectral": cache},
                           _loads=loads)


class TestTrackTools:
    def _supported(self):
        cache, rx = _receiver()
        rx._handle_message("/stream_hello", ["master", -1, 7], source=MASTER)
        return cache, rx

    def test_track_load_refused_without_stream_support(self, monkeypatch):
        from mcp_server.tools import analyzer

        loads = []
        monkeypatch.setattr(analyzer, "_load_analyzer_impl", lambda *a, **k: loads.append(k))
        result = analyzer.ensure_analyzer_on_track(_ctx(SpectralCache(), [], loads), 2)
        assert result["status"] == "streams_unsupported"
        assert loads == []

    def test_track_load_appends_analyzer(self, monkeypatch):
        from mcp_server.tools import analyzer

        cache, _ = self._supported()
        loads = []
        monkeypatch.setattr(analyzer, "_load_analyzer_impl",
                            lambda ctx, **k: loads.append(k) or {"device_index": 2})
        result = analyzer.ensure_analyzer_on_track(
            _ctx(cache, [{"name": "Simpler", "index": 0}], loads), 2)
        assert result == {"status": "loaded", "device_index": 2, "is_last_on_track": True,
                          "duplicate_count": 1, "stream": "track:2"}
        assert loads[0]["track_index"] == 2

    def test_track_already_loaded_reports_position(self, monkeypatch):
        from mcp_server.tools import analyzer

        cache, _ = self._supported()
        result = analyzer.ensure_analyzer_on_track(_ctx(cache, [
            {"name": "LivePilot_Analyzer", "index": 0}, {"name": "Reverb", "index": 1}], []), -1)
        assert result["status"] == "already_loaded"
        assert result["is_last_on_track"] is False
        assert result["stream"] == "return:0"
        assert "warning" in result

    def test_master_index_rejected(self):
        from mcp_server.tools import analyzer

        cache, _ = self._supported()
        assert analyzer.ensure_analyzer_on_track(_ctx(cache, [], []), -1000)["code"] == "INVALID_PARAM"

    def test_track_spectrum_reads_only_its_stream(self):
        from mcp_server.tools import analyzer

        cache, rx = self._supported()
        rx._handle_message("/stream_hello", ["track", 2, 5], source=TRACK)
        _spectrum(rx, MASTER, 0.1)
        _spectrum(rx, TRACK, 0.8)
        rx._handle_message("/peak", [0.9], source=TRACK)
        ctx = _ctx(cache, [], [])
        result = asyncio.run(analyzer.get_track_spectrum(ctx, 2))
        assert result["bands"]["mid"] == 0.8
        assert result["peak"] == 0.9
        assert result["stream"] == "track:2"
        missing = asyncio.run(analyzer.get_track_spectrum(ctx, 5))
        assert missing["code"] == "STATE_ERROR"

    def test_track_spectrum_windowed(self):
        from mcp_server.tools import analyzer

        cache, rx = self._supported()
        rx._handle_message("/stream_hello", ["track", 2, 5], source=TRACK)
        _spectrum(rx, TRACK, 0.8)
        result = asyncio.run(analyzer.get_track_spectrum(_ctx(cache, [], []), 2,
                                                         window_ms=20, samples=2))
        assert result["bands"]["mid"] == 0.8
        assert result["samples_collected"] == 2

    def test_stream_listing(self):
        from mcp_server.tools import analyzer

        cache, rx = self._supported()
        rx._handle_message("/stream_hello", ["track", 2, 5], source=TRACK)
        listing = analyzer.get_analyzer_streams(_ctx(cache, [], []))
        assert listing["streams_supported"] is True
        assert [s["stream"] for s in listing["streams"]] == ["track:2"]


NODE = shutil.which("node")

_HARNESS = textwrap.dedent(r"""
const fs = require('fs'), vm = require('vm');
const [src, devicePath, cmd] = process.argv.slice(2);
const out = [], ports = [];
const udp = { maxclass: 'udpreceive', message: (k, v) => ports.push([k, v]), nextobject: null };
const ctx = {
  post() {}, messnamed() {}, inlet: 0, messagename: '',
  outlet: (...a) => out.push(a),
  arrayfromargs: a => Array.prototype.slice.call(a),
  LiveAPI: function (cb, path) {
    this.path = path; this.id = 0;
    if (path === 'this_device') { this.unquotedpath = devicePath; this.id = 77; }
    this.get = () => [0];
  },
  Task: function (fn, self) {
    this.fn = fn; this.repeat = () => {}; this.cancel = () => {};
    this.schedule = () => fn.call(self);
  },
  Folder: function () {}, File: function () { this.isopen = false; },
  max: { apppath: '' },
};
ctx.patcher = { firstobject: udp };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(src, 'utf8'), ctx);
vm.runInContext('patcher = this.patcher; bang();', ctx);
if (cmd) { ctx.messagename = cmd; vm.runInContext('anything()', ctx); }
console.log(JSON.stringify({ out, ports }));
""")


def _run_bridge(tmp_path, device_path, cmd=""):
    harness = tmp_path / "harness.js"
    harness.write_text(_HARNESS)
    done = subprocess.run(
        [NODE, str(harness), str(ROOT / "m4l_device" / "livepilot_bridge.js"), device_path, cmd],
        capture_output=True, text=True, timeout=20, check=True,
    )
    return json.loads(done.stdout)


@pytest.mark.skipif(NODE is None, reason="node not installed")
class TestBridgeJs:
    def test_master_announces_and_keeps_command_port(self, tmp_path):
        result = _run_bridge(tmp_path, "live_set master_track devices 3")
        assert [0, "/stream_hello", "master", -1, 77] in result["out"]
        assert result["ports"] == [["port", 9881]]

    def test_track_announces_and_releases_command_port(self, tmp_path):
        result = _run_bridge(tmp_path, "live_set tracks 4 devices 0 chains 1 devices 2")
        assert [0, "/stream_hello", "track", 4, 77] in result["out"]
        assert len(result["ports"]) == 1
        assert result["ports"][0][1] != 9881

    def test_return_announces(self, tmp_path):
        result = _run_bridge(tmp_path, "live_set return_tracks 1 devices 0")
        assert [0, "/stream_hello", "return", 1, 77] in result["out"]

    def test_track_instance_refuses_master_only_commands(self, tmp_path):
        result = _run_bridge(tmp_path, "live_set tracks 4 devices 2", "get_key")
        import base64

        replies = [r[2] for r in result["out"] if r[:2] == [0, "/response"]]
        decoded = json.loads(base64.urlsafe_b64decode(replies[0] + "=" * (-len(replies[0]) % 4)))
        assert "master analyzer" in decoded["error"]
