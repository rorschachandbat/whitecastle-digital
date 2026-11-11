"""验证原始回放解析、身份隔离、断点校验和凭据请求边界；不访问网络。"""
import gzip
import contextlib
import io
import importlib.util
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("bga_crawl", ROOT / "scripts/crawl-bga.py")
CRAWL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CRAWL)


def fixture(table="123", player="456", terminal=True):
    initial = {"players": {player: {"id": player}}, "gamestate": {"id": 1}}
    config = {"tableId": table, "gamename": "thewhitecastle", "isArchiveMode": True,
              "players": [{"id": player}], "userPreferences": {"secret": "exclude-me"}}
    packets = [{"table_id": table, "packet_id": "1", "move_id": "1",
                "data": [{"type": "gameStateChange", "args": {"id": 99 if terminal else 1}},
                         {"type": "resourcePaid", "args": {"isUndo": True}}]}]
    logs = {"status": 1, "data": {"valid": 1, "data": packets}}
    args = ["thewhitecastle", "姬路城", int(table), int(player), 0, "0", "", initial]
    return (
        "globalThis.g_release = '261104-1709'; globalThis.g_gameversion = '260825-0951';"
        f"globalThis.bgaGameData = {json.dumps(config)};"
        f"globalThis.g_gamelogs = {json.dumps(logs)};"
        f"globalThis.gameui.completesetup({','.join(map(json.dumps, args))});"
    )


class ReplayTests(unittest.TestCase):
    def parse(self, text):
        return CRAWL.parse_replay(text, "123", "456", {"table_id": "123"},
                                  "https://boardgamearena.com/archive/replay/261104-1709/")

    def test_archive_contains_game_data_and_never_claims_training_eligibility(self):
        result = self.parse(fixture())
        self.assertEqual(result["initialData"]["gamestate"]["id"], 1)
        self.assertEqual(result["validation"]["packetCount"], 1)
        self.assertEqual(result["validation"]["undoNotifications"], 1)
        self.assertFalse(result["trainingEligible"])
        self.assertNotIn("exclude-me", json.dumps(result))
        self.assertEqual(result["source"]["versions"]["asset"], "260825-0951")

    def test_wrong_table_or_perspective_is_rejected(self):
        for text in (fixture(table="999"), fixture(player="999")):
            with self.assertRaisesRegex(CRAWL.CrawlError, "IDENTITY_MISMATCH"):
                self.parse(text)
        with self.assertRaisesRegex(CRAWL.CrawlError, "PACKET_TABLE_MISMATCH"):
            self.parse(fixture().replace('"table_id": "123"', '"table_id": "999"'))

    def test_legacy_globals_keep_initial_state_without_inventing_options(self):
        text = fixture()
        start = text.index("globalThis.bgaGameData = ")
        end = text.index(";globalThis.g_gamelogs", start)
        text = (text[:start] + "g_gamename='thewhitecastle';g_archive_mode=true;"
                "gameui.game_id=2242" + text[end:])
        result = self.parse(text)
        self.assertEqual(result["validation"]["frameFormat"], "legacy-globals")
        self.assertEqual(result["validation"]["missingConfigurationFields"], ["tableOptions"])
        self.assertNotIn("tableOptions", result["configuration"])
        self.assertEqual(result["configuration"]["tableId"], "123")
        for broken in (text.replace("g_archive_mode=true", "g_archive_mode=false"),
                       text.replace("gameui.game_id=2242", "gameui.game_id=999"),
                       text.replace("g_gamename='thewhitecastle'", "g_gamename='other'")):
            with self.assertRaisesRegex(CRAWL.CrawlError, "CONFIGURATION_MISMATCH"):
                self.parse(broken)

    def test_malformed_current_configuration_never_falls_back_to_legacy(self):
        text = ("g_gamename='thewhitecastle';g_archive_mode=true;gameui.game_id=2242;"
                + fixture().replace('bgaGameData = {', 'bgaGameData = unsafe({'))
        with self.assertRaisesRegex(CRAWL.CrawlError, "JSON_INVALID"):
            self.parse(text)

    def test_missing_terminal_or_invalid_json_is_not_saved_as_complete(self):
        with self.assertRaisesRegex(CRAWL.CrawlError, "TERMINAL_STATE_MISSING"):
            self.parse(fixture(terminal=False))
        with self.assertRaisesRegex(CRAWL.CrawlError, "JSON_INVALID"):
            self.parse(fixture().replace('g_gamelogs = {', 'g_gamelogs = (() => {'))

    def test_json_parser_handles_nested_braces_quotes_and_unicode(self):
        value = {"cards": [{"text": '中文 " } , ); </script>', "nested": {"k": [1, 2]}}]}
        self.assertEqual(CRAWL.read_assignment(
            "globalThis.testData = " + json.dumps(value) + "; unsafe();", "testData"), value)
        with self.assertRaises(CRAWL.CrawlError):
            CRAWL.read_assignment("globalThis.testData = dangerousFunction();", "testData")

    def test_review_links_and_destinations_are_scoped(self):
        parser = CRAWL.ReviewLinks()
        parser.feed('<a id="choosePlayerLink_456" href="/archive/replay/1/?table=123&amp;player=456">')
        self.assertIn("&player=456", parser.links["456"])
        for url in ("https://boardgamearena.com.evil.test/", "http://boardgamearena.com/",
                    "https://evil.test/", "https://user:pass@boardgamearena.com/"):
            with self.assertRaises(CRAWL.CrawlError):
                CRAWL.validate_url(url)
        self.assertEqual(CRAWL.validate_url("https://en.boardgamearena.com/"),
                         "https://en.boardgamearena.com/")

    def test_saved_archives_detect_corruption_and_path_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            path = folder / "replays/123.json.gz"
            digest = CRAWL.atomic_json(path, self.parse(fixture()), compress=True)
            record = {"path": "replays/123.json.gz", "sha256": digest}
            self.assertTrue(CRAWL.verify_saved(folder, "123", record))
            self.assertEqual(json.loads(gzip.decompress(path.read_bytes()))["version"], 1)
            self.assertFalse(CRAWL.verify_saved(folder, "123", {**record, "path": "../other.json"}))
            path.write_bytes(b"corrupted")
            self.assertFalse(CRAWL.verify_saved(folder, "123", record))

    def test_cookie_header_stays_in_cookie_jar_and_bad_format_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / "cookie.txt"
            cookie.write_text("Cookie: fake-session=fake-secret", encoding="utf-8")
            client = CRAWL.Client(cookie)
            self.assertIsNone(client.token)
            cookie.write_text("header\nunexpected", encoding="utf-8")
            with self.assertRaises(CRAWL.AuthenticationError):
                CRAWL.Client(cookie)

    def test_gzip_transport_and_access_denial(self):
        class Response:
            url = "https://boardgamearena.com/gamestats"
            headers = {"Content-Encoding": "gzip"}

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self, _):
                return gzip.compress('{"message":"中文"}'.encode())

        class Opener:
            request = None
            denied = False

            def open(self, request, **_):
                self.request = request
                if self.denied:
                    raise urllib.error.HTTPError(request.full_url, 403, "deny", {}, None)
                return Response()

        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / "cookie.txt"
            cookie.write_text("fake-session=fake-secret", encoding="utf-8")
            client = CRAWL.Client(cookie, interval=0)
            opener = Opener()
            client.opener = opener
            self.assertEqual(json.loads(client.request("/gamestats"))["message"], "中文")
            self.assertEqual(opener.request.get_header("Accept-encoding"), "gzip")
            opener.denied = True
            with self.assertRaisesRegex(CRAWL.AuthenticationError, "ACCESS_DENIED"):
                client.request("/gamestats")
            self.assertTrue(client.stop.is_set())

    def test_replay_quota_stops_without_retry_or_logging_body(self):
        class Opener:
            calls = 0

            def open(self, request, **_):
                self.calls += 1
                body = gzip.compress('<html>你已经达到上限（replay）</html>'.encode())
                raise urllib.error.HTTPError(request.full_url, 500, "server",
                                             {"Content-Encoding": "gzip"}, io.BytesIO(body))

        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / "cookie.txt"
            cookie.write_text("fake-session=fake-secret", encoding="utf-8")
            client = CRAWL.Client(cookie, interval=0)
            client.opener = Opener()
            with self.assertRaisesRegex(CRAWL.ReplayLimitError, "^BGA_REPLAY_LIMIT_RETRY_LATER$"):
                client.request("/archive/archive/frame.html")
            self.assertEqual(client.opener.calls, 1)
            self.assertTrue(client.stop.is_set())
        self.assertFalse(CRAWL.replay_limit_response(b"<script>reached limit (replay)</script>unexpected"))

    def test_discovery_keeps_all_outcomes_and_stops_on_empty_page(self):
        class FakeClient:
            def api(self, route, params):
                if params["page"] > 1:
                    return {"tables": []}
                return {"tables": [{"table_id": "123", "game_id": 2242, "players": "456,789",
                                    "concede": 1}], "stats": {"general": {"played": "1"}}}

        with tempfile.TemporaryDirectory() as directory:
            manifest = {"player": "456", "endDate": 1, "tables": {},
                        "discovery": {"nextPage": 1, "complete": False}}
            CRAWL.discover(FakeClient(), Path(directory), manifest, lambda: None, 3)
            self.assertTrue(manifest["discovery"]["complete"])
            self.assertEqual(manifest["tables"]["123"]["history"]["concede"], 1)

    def test_refresh_accepts_pages_with_only_previously_known_tables(self):
        class FakeClient:
            def api(self, route, params):
                if params["page"] > 1:
                    return {"tables": []}
                return {"tables": [{"table_id": "123", "game_id": 2242, "players": "456,789"}]}

        with tempfile.TemporaryDirectory() as directory:
            manifest = {"player": "456", "endDate": 1,
                        "tables": {"123": {"status": "downloaded", "history": {"old": True}}},
                        "discovery": {"nextPage": 1, "complete": False}}
            CRAWL.discover(FakeClient(), Path(directory), manifest, lambda: None, 3)
            self.assertTrue(manifest["discovery"]["complete"])
            self.assertEqual(manifest["tables"]["123"]["status"], "downloaded")

    def test_identical_repeated_history_page_is_rejected(self):
        class FakeClient:
            def api(self, route, params):
                return {"tables": [{"table_id": "123", "game_id": 2242, "players": "456,789"}]}

        with tempfile.TemporaryDirectory() as directory:
            manifest = {"player": "456", "endDate": 1, "tables": {},
                        "discovery": {"nextPage": 1, "complete": False}}
            with self.assertRaisesRegex(CRAWL.CrawlError, "REPEATED_PAGE"):
                CRAWL.discover(FakeClient(), Path(directory), manifest, lambda: None, 3)

    def test_five_service_failures_stop_before_remaining_tables(self):
        class FakeClient:
            def __init__(self, *_):
                self.stop = threading.Event()

            def bootstrap(self, _):
                pass

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            manifest = {"format": "whitecastle-bga-crawl", "version": 1, "player": "456",
                        "gameId": 2242, "endDate": 1, "discovery": {"complete": True},
                        "tables": {str(i): {"history": {}, "status": "pending"} for i in range(10)}}
            CRAWL.atomic_json(folder / "manifest.json", manifest)
            arguments = ["crawl-bga.py", "--player", "456", "--out-dir", directory, "--workers", "1"]
            with patch("sys.argv", arguments), patch.object(CRAWL, "Client", FakeClient), patch.object(
                    CRAWL, "fetch_archive", side_effect=CRAWL.CrawlError("BGA_HTTP_500")), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(CRAWL.main(), 1)
            result = CRAWL.load_json(folder / "manifest.json")
            self.assertEqual(result["summary"], {"failed": 5, "pending": 5})
            self.assertEqual(result["error"], "BGA_SERVICE_UNAVAILABLE_RETRY_LATER")


if __name__ == "__main__":
    unittest.main()
