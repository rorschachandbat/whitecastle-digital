"""使用用户授权的本机认证文件，保存指定玩家已结束的姬路城回放原始资料。"""
import argparse
import concurrent.futures
import gzip
import hashlib
import http.cookiejar
import io
import json
import math
import os
import re
import signal
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://boardgamearena.com"
GAME_ID = 2242
GAME_NAME = "thewhitecastle"
DECODER = json.JSONDecoder()


class CrawlError(Exception):
    """错误消息只使用固定标识，不回显凭据、响应正文或请求头。"""


class AuthenticationError(CrawlError):
    pass


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value, compress=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    content = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    temporary.write_bytes(gzip.compress(content, mtime=0) if compress else content)
    temporary.replace(path)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.username or parsed.password
            or parsed.port not in (None, 443)
            or not (host == "boardgamearena.com" or host.endswith(".boardgamearena.com"))):
        raise CrawlError("BGA_UNSAFE_DESTINATION")
    return url


class BgaRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


class Client:
    def __init__(self, cookie_file, interval=1.0, timeout=40):
        value = cookie_file.read_text(encoding="utf-8-sig").strip()
        if value.lower().startswith("cookie:"):
            value = value.split(":", 1)[1].strip()
        if not value or "\r" in value or "\n" in value:
            raise AuthenticationError("BGA_COOKIE_FILE_FORMAT")
        jar = http.cookiejar.CookieJar()
        for pair in value.split(";"):
            name, separator, content = pair.strip().partition("=")
            if separator and name:
                jar.set_cookie(http.cookiejar.Cookie(
                    0, name, content, None, False, ".boardgamearena.com", True, True,
                    "/", True, True, None, True, None, None, {}, False))
        if not list(jar):
            raise AuthenticationError("BGA_COOKIE_FILE_FORMAT")
        self.opener = urllib.request.build_opener(
            BgaRedirect(), urllib.request.HTTPCookieProcessor(jar))
        self.interval = interval
        self.timeout = timeout
        self.request_lock = threading.Lock()
        self.next_request = 0
        self.token = None
        self.stop = threading.Event()

    def pause(self, seconds):
        if self.stop.wait(seconds):
            raise InterruptedError("BGA_STOP_REQUESTED")

    def request(self, route, params=None, ajax=False):
        url = validate_url(urllib.parse.urljoin(ORIGIN, route))
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        headers = {"User-Agent": "Mozilla/5.0 WhitecastlePersonalArchive/1.0",
                   "Referer": ORIGIN + "/gamestats", "Accept-Encoding": "gzip"}
        if ajax and self.token:
            headers["X-Request-Token"] = self.token
        for attempt in range(3):
            if self.stop.is_set():
                raise InterruptedError("BGA_STOP_REQUESTED")
            with self.request_lock:
                self.pause(max(0, self.next_request - time.monotonic()))
                self.next_request = time.monotonic() + self.interval
            try:
                with self.opener.open(urllib.request.Request(url, headers=headers),
                                      timeout=self.timeout) as response:
                    if urllib.parse.urlsplit(response.url).path.startswith(("/account", "/premium")):
                        raise AuthenticationError("BGA_LOGIN_OR_PERMISSION_REQUIRED")
                    body = response.read(64 * 1024 * 1024 + 1)
                    if len(body) > 64 * 1024 * 1024:
                        raise CrawlError("BGA_RESPONSE_TOO_LARGE")
                    if response.headers.get("Content-Encoding", "").lower() == "gzip":
                        # 限制解压后的体积，压缩传输也不能绕过响应大小上限。
                        with gzip.GzipFile(fileobj=io.BytesIO(body)) as compressed:
                            body = compressed.read(64 * 1024 * 1024 + 1)
                        if len(body) > 64 * 1024 * 1024:
                            raise CrawlError("BGA_RESPONSE_TOO_LARGE")
                    return body.decode("utf-8-sig")
            except urllib.error.HTTPError as error:
                error.close()
                if error.code in (401, 403):
                    self.stop.set()
                    raise AuthenticationError("BGA_HTTP_AUTH_OR_ACCESS_DENIED") from None
                if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise CrawlError(f"BGA_HTTP_{error.code}") from None
                retry = error.headers.get("Retry-After", "")
                if retry.isdigit():
                    if int(retry) > 60:
                        self.stop.set()
                        raise CrawlError("BGA_RETRY_LATER") from None
                    delay = max(int(retry), 2 ** (attempt + 1))
                else:
                    delay = 2 ** (attempt + 1)
                # 限流后的退避同时约束所有工作线程。
                with self.request_lock:
                    self.next_request = max(self.next_request, time.monotonic() + delay)
                self.pause(delay)
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError):
                if attempt == 2:
                    raise CrawlError("BGA_NETWORK_FAILED") from None
                self.pause(2 ** (attempt + 1))

    def bootstrap(self, player):
        text = self.request("/gamestats", {
            "player": player, "opponent_id": 0, "game_id": GAME_ID, "finished": 1})
        match = re.search(r"""requestToken\s*:\s*['"]([^'"]+)['"]""", text)
        if not match or "see_more_tables" not in text:
            raise AuthenticationError("BGA_AUTHENTICATED_HISTORY_MISSING")
        self.token = match[1]

    def api(self, route, params):
        try:
            result = json.loads(self.request(route, params, ajax=True))
        except json.JSONDecodeError:
            raise CrawlError("BGA_EXPECTED_JSON") from None
        if not isinstance(result, dict) or str(result.get("status")) != "1":
            # 不保存服务器错误正文，避免把鉴权信息混入数据或日志。
            raise CrawlError("BGA_API_REJECTED")
        return result["data"]


class ReviewLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and attrs.get("id", "").startswith("choosePlayerLink_"):
            self.links[attrs["id"].removeprefix("choosePlayerLink_")] = attrs.get("href", "")


def read_assignment(text, name):
    match = re.search(r"(?:globalThis\.)?" + re.escape(name) + r"\s*=\s*", text)
    if not match:
        raise CrawlError("BGA_REPLAY_ASSIGNMENT_MISSING")
    try:
        value, _ = DECODER.raw_decode(text[match.end():])
        return value
    except json.JSONDecodeError:
        raise CrawlError("BGA_REPLAY_JSON_INVALID") from None


def read_setup(text):
    match = re.search(r"(?:globalThis\.)?gameui\.completesetup\s*\(", text)
    if not match:
        raise CrawlError("BGA_REPLAY_SETUP_MISSING")
    position = match.end()
    result = []
    try:
        for index in range(8):
            whitespace = re.match(r"\s*", text[position:]).end()
            position += whitespace
            if index:
                if text[position] != ",":
                    raise ValueError
                position += 1
                position += re.match(r"\s*", text[position:]).end()
            value, length = DECODER.raw_decode(text[position:])
            result.append(value)
            position += length
    except (json.JSONDecodeError, ValueError, IndexError):
        raise CrawlError("BGA_REPLAY_SETUP_INVALID") from None
    return result


def parse_replay(text, table, player, history, replay_url):
    setup = read_setup(text)
    if setup[0] != GAME_NAME or str(setup[2]) != table or str(setup[3]) != player:
        raise CrawlError("BGA_REPLAY_IDENTITY_MISMATCH")
    initial = setup[7]
    if not isinstance(initial, dict) or not initial.get("players") or not initial.get("gamestate"):
        raise CrawlError("BGA_REPLAY_INITIAL_STATE_MISSING")
    has_configuration = re.search(r"(?:globalThis\.)?bgaGameData\s*=", text)
    if has_configuration:
        configuration = read_assignment(text, "bgaGameData")
        if (not isinstance(configuration, dict) or str(configuration.get("tableId")) != table
                or configuration.get("gamename") != GAME_NAME
                or configuration.get("isArchiveMode") is not True):
            raise CrawlError("BGA_REPLAY_CONFIGURATION_MISMATCH")
        frame_format = "bgaGameData"
    else:
        # 旧回放没有集中配置；仅提取实际存在的游戏标识，不读取后续账号参数或猜测桌面选项。
        legacy_checks = (
            r"(?<![\w.])g_gamename\s*=\s*['\"]thewhitecastle['\"]\s*;",
            r"(?<![\w.])g_archive_mode\s*=\s*true\s*;",
            r"(?<![\w.])gameui\.game_id\s*=\s*2242\s*;",
        )
        if not all(re.search(pattern, text) for pattern in legacy_checks):
            raise CrawlError("BGA_REPLAY_CONFIGURATION_MISMATCH")
        configuration = {"gamename": GAME_NAME, "tableId": table}
        if "playerorder" in initial:
            configuration["playerOrder"] = initial["playerorder"]
        frame_format = "legacy-globals"
    envelope = read_assignment(text, "g_gamelogs")
    data = envelope.get("data", {})
    packets = data.get("data")
    if (str(envelope.get("status")) != "1" or str(data.get("valid")) != "1"
            or not isinstance(packets, list) or not packets):
        raise CrawlError("BGA_REPLAY_PACKETS_MISSING")
    packet_ids = []
    types = Counter()
    terminal = False
    undo = 0
    for packet in packets:
        if str(packet.get("table_id")) != table:
            raise CrawlError("BGA_REPLAY_PACKET_TABLE_MISMATCH")
        packet_ids.append(str(packet.get("packet_id")))
        for notification in packet.get("data", []):
            types[notification.get("type", "unknown")] += 1
            arguments = notification.get("args")
            if isinstance(arguments, dict):
                undo += int(bool(arguments.get("isUndo")))
                if notification.get("type") == "gameStateChange" and str(arguments.get("id")) == "99":
                    terminal = True
    if len(set(packet_ids)) != len(packet_ids):
        raise CrawlError("BGA_REPLAY_DUPLICATE_PACKET")
    if not terminal:
        raise CrawlError("BGA_REPLAY_TERMINAL_STATE_MISSING")
    versions = {}
    for field, key in (("site", "g_release"), ("asset", "g_gameversion")):
        match = re.search(r"(?:globalThis\.)?" + key + r"""\s*=\s*['"]([\d-]+)['"]""", text)
        versions[field] = match[1] if match else None
    # 只保存游戏设置和游戏状态；不保存账号偏好、订阅、Cookie及整个HTML。
    selected_config = {key: configuration[key] for key in (
        "tableOptions", "playerOrder", "players", "isCoop", "gameVersion", "gamename", "tableId")
        if key in configuration}
    return {
        "format": "whitecastle-bga-raw-replay", "version": 1,
        "source": {"table": table, "player": player, "game": GAME_NAME,
                   "replayUrl": replay_url, "capturedAt": timestamp(), "versions": versions},
        "history": history, "configuration": selected_config, "initialData": initial,
        "replayData": data, "trainingEligible": False,
        "validation": {"initialStatePresent": True, "terminalStatePresent": terminal,
                       "packetCount": len(packets), "notificationCount": sum(types.values()),
                       "notificationTypes": dict(types), "undoNotifications": undo,
                       "playerCount": len(initial["players"]), "frameFormat": frame_format,
                       "missingConfigurationFields": [
                           key for key in ("tableOptions",) if key not in selected_config],
                       "actionReconstruction": "not-performed"},
    }


def fetch_archive(client, table, player, history, folder):
    review = client.request("/gamereview", {"table": table})
    for _ in range(4):
        if "loading_table_id" not in review:
            break
        client.api("/gamereview/gamereview/requestTableArchive.html", {"table": table})
        client.pause(5)
        review = client.request("/gamereview", {"table": table})
    if "loading_table_id" in review:
        raise CrawlError("BGA_ARCHIVE_NOT_READY")
    if 'id="not_allowed_beacon"' in review or 'id="temporarily_disabled_beacon"' in review:
        raise CrawlError("BGA_ARCHIVE_UNAVAILABLE")
    links = ReviewLinks()
    links.feed(review)
    if player not in links.links:
        raise CrawlError("BGA_REPLAY_PERSPECTIVE_UNAVAILABLE")
    replay_url = validate_url(urllib.parse.urljoin(ORIGIN, links.links[player]))
    parsed = urllib.parse.urlsplit(replay_url)
    match = re.fullmatch(r"/archive/replay/(\d{6}-\d{4})/?", parsed.path)
    query = urllib.parse.parse_qs(parsed.query)
    if not match or query.get("table") != [table] or query.get("player") != [player]:
        raise CrawlError("BGA_REPLAY_LINK_MISMATCH")
    frame = client.request("/archive/archive/frame.html", {
        "version": match[1], "table": table, "player": player, "comments": ""})
    archive = parse_replay(frame, table, player, history, replay_url)
    path = folder / "replays" / (table + ".json.gz")
    digest = atomic_json(path, archive, compress=True)
    return {"status": "downloaded", "path": path.relative_to(folder).as_posix(),
            "sha256": digest, "bytes": path.stat().st_size,
            "validation": archive["validation"], "versions": archive["source"]["versions"],
            "updatedAt": timestamp()}


def verify_saved(folder, table, record):
    try:
        path = folder / "replays" / (table + ".json.gz")
        if record.get("path") != path.relative_to(folder).as_posix():
            return False
        return hashlib.sha256(path.read_bytes()).hexdigest() == record.get("sha256")
    except OSError:
        return False


def discover(client, folder, manifest, save, max_pages):
    discovery = manifest["discovery"]
    if discovery["complete"]:
        return
    for _ in range(max_pages):
        if (folder / "STOP").exists():
            raise InterruptedError("BGA_STOP_REQUESTED")
        page = discovery["nextPage"]
        data = client.api("/gamestats/gamestats/getGames.html", {
            "player": manifest["player"], "opponent_id": 0, "game_id": GAME_ID,
            "finished": 1, "page": page, "updateStats": int(page == 1),
            "end_date": manifest["endDate"]})
        tables = data.get("tables")
        if not isinstance(tables, list):
            raise CrawlError("BGA_HISTORY_TABLES_MISSING")
        atomic_json(folder / "history" / f"page-{page:05d}.json", data)
        if page == 1:
            discovery["reportedPlayed"] = data.get("stats", {}).get("general", {}).get("played")
        added = 0
        for history in tables:
            table = str(history.get("table_id", ""))
            players = str(history.get("players", "")).split(",")
            if (not table.isdigit() or str(history.get("game_id")) != str(GAME_ID)
                    or manifest["player"] not in players):
                raise CrawlError("BGA_HISTORY_IDENTITY_MISMATCH")
            if table not in manifest["tables"]:
                manifest["tables"][table] = {"history": history, "status": "pending"}
                added += 1
        discovery["nextPage"] = page + 1
        discovery["complete"] = not tables
        discovery["lastPageSize"] = len(tables)
        save()
        print(json.dumps({"phase": "discovery", "page": page, "added": added,
                          "tables": len(manifest["tables"]), "complete": discovery["complete"]}),
              flush=True)
        if not tables:
            return
        if added == 0:
            raise CrawlError("BGA_HISTORY_REPEATED_PAGE")
    raise CrawlError("BGA_HISTORY_PAGE_LIMIT")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--player", required=True)
    parser.add_argument("--cookie-file", type=Path, default=ROOT / ".local/bga-cookie.txt")
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--max-pages", type=int, default=2000)
    parser.add_argument("--limit", type=int, default=0, help="本次最多下载局数；0表示所有已发现对局")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if (not args.player.isdigit() or not 1 <= args.workers <= 4
            or not math.isfinite(args.interval) or args.interval < 0.5
            or args.max_pages < 1 or args.limit < 0):
        parser.error("BGA_INVALID_ARGUMENTS")
    folder = (args.out_dir or ROOT / ".local/bga-database" / args.player).resolve()
    path = folder / "manifest.json"
    if args.status:
        manifest = load_json(path)
        print(json.dumps({key: manifest[key] for key in (
            "player", "phase", "discovery", "summary", "updatedAt", "pid")}, ensure_ascii=False))
        return 0
    folder.mkdir(parents=True, exist_ok=True)
    # 独立文件锁仅使用标准库，同一资料库不可被两个进程同时写入。
    lock = (folder / "crawl.lock").open("a+b")
    if (folder / "crawl.lock").stat().st_size == 0:
        lock.write(b"0")
        lock.flush()
    lock.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise CrawlError("BGA_CRAWL_ALREADY_RUNNING") from None
    manifest = load_json(path) if path.exists() else {
        "format": "whitecastle-bga-crawl", "version": 1, "player": args.player,
        "gameId": GAME_ID, "finished": 1, "endDate": int(time.time()),
        "discovery": {"nextPage": 1, "complete": False},
        "tables": {}, "createdAt": timestamp(),
    }
    if manifest["player"] != args.player or manifest["gameId"] != GAME_ID:
        raise CrawlError("BGA_CRAWL_CONFIG_MISMATCH")
    client = Client(args.cookie_file, args.interval)
    signal.signal(signal.SIGINT, lambda *_: client.stop.set())
    signal.signal(signal.SIGTERM, lambda *_: client.stop.set())
    manifest["pid"] = os.getpid()
    manifest["phase"] = "authenticating"
    manifest.pop("error", None)

    def save():
        manifest["updatedAt"] = timestamp()
        manifest["summary"] = dict(Counter(record["status"] for record in manifest["tables"].values()))
        atomic_json(path, manifest)

    save()
    try:
        client.bootstrap(args.player)
        manifest["phase"] = "discovery"
        save()
        discover(client, folder, manifest, save, args.max_pages)
        manifest["phase"] = "downloading"
        pending = []
        for table, record in manifest["tables"].items():
            if record["status"] == "downloaded" and verify_saved(folder, table, record):
                continue
            if record["status"] == "downloaded":
                record["status"] = "pending"
            if record["status"] == "failed" and not args.retry_failed:
                continue
            pending.append((table, record))
        if args.limit:
            pending = pending[:args.limit]
        save()
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {}
            iterator = iter(pending)

            def submit():
                if client.stop.is_set() or (folder / "STOP").exists():
                    client.stop.set()
                    return
                item = next(iterator, None)
                if item is not None:
                    table, record = item
                    futures[pool.submit(fetch_archive, client, table, args.player,
                                        record["history"], folder)] = table

            for _ in range(args.workers):
                submit()
            while futures:
                done, _ = concurrent.futures.wait(
                    futures, timeout=1, return_when=concurrent.futures.FIRST_COMPLETED)
                if (folder / "STOP").exists():
                    client.stop.set()
                for future in done:
                    table = futures.pop(future)
                    record = manifest["tables"][table]
                    try:
                        record.update(future.result())
                        record.pop("error", None)
                    except AuthenticationError as error:
                        client.stop.set()
                        manifest["error"] = str(error)
                    except InterruptedError:
                        pass
                    except CrawlError as error:
                        record.update(status="failed", error=str(error), updatedAt=timestamp())
                    except Exception:
                        client.stop.set()
                        manifest["error"] = "BGA_UNEXPECTED_FAILURE"
                    save()
                    print(json.dumps({"phase": "download", "table": table,
                                      "status": record["status"], "summary": manifest["summary"]}),
                          flush=True)
                    submit()
        if client.stop.is_set():
            manifest["phase"] = "error" if manifest.get("error") else "stopped"
        else:
            manifest["phase"] = ("partial" if any(
                record["status"] != "downloaded" for record in manifest["tables"].values())
                else "complete")
    except InterruptedError:
        manifest["phase"] = "stopped"
    except CrawlError as error:
        manifest.update(phase="error", error=str(error))
    finally:
        manifest["pid"] = None
        save()
        lock.close()
    print(json.dumps({"phase": manifest["phase"], "summary": manifest["summary"],
                      "error": manifest.get("error")}), flush=True)
    return int(manifest["phase"] == "error")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CrawlError, OSError):
        raise SystemExit("BGA_CRAWL_START_FAILED")
