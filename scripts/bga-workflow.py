"""输入BGA玩家名称、ID或个人链接，依次采集、核对选牌样本并微调本地AI。"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.parse
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_ERRORS = {"BGA_SERVICE_UNAVAILABLE_RETRY_LATER", "BGA_REPLAY_LIMIT_RETRY_LATER"}
SPEC = importlib.util.spec_from_file_location("workflow_crawl", ROOT / "scripts/crawl-bga.py")
CRAWL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CRAWL)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def resolve_target(target, database, cookie_file):
    value = target.strip()
    if value.isdigit():
        return value
    if "://" in value:
        CRAWL.validate_url(value)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(value).query)
        candidates = query.get("player", query.get("id", []))
        if len(candidates) != 1 or not candidates[0].isdigit():
            raise ValueError("BGA_LINK_NEEDS_PLAYER_PARAMETER")
        return candidates[0]
    # 已采集历程中的公开昵称可离线解析；只接受精确匹配，不猜测相似昵称。
    matches = set()
    if database.exists():
        for path in database.glob("*/manifest.json"):
            if not path.parent.name.isdigit():
                continue
            for record in read(path).get("tables", {}).values():
                history = record.get("history", {})
                ids = str(history.get("players", "")).split(",")
                names = str(history.get("player_names", "")).split(",")
                matches.update(pid for pid, name in zip(ids, names)
                               if name.casefold() == value.casefold() and pid.isdigit())
    if len(matches) == 1:
        return matches.pop()
    if len(matches) > 1:
        raise ValueError("BGA_NAME_AMBIGUOUS_USE_PLAYER_LINK")
    client = CRAWL.Client(cookie_file)
    result = json.loads(client.request("/player/player/findplayer.html",
                                      {"q": value, "nofriends": 1}, ajax=True))
    matches = {str(item.get("id")) for item in result.get("items", [])
               if str(item.get("q", "")).casefold() == value.casefold()
               and str(item.get("id", "")).isdigit() and str(item.get("id")) != "0"}
    if len(matches) != 1:
        raise ValueError("BGA_EXACT_NAME_NOT_FOUND_USE_PLAYER_LINK")
    return matches.pop()


def lock_busy(folder):
    path = folder / "crawl.lock"
    if not path.exists():
        return False
    with path.open("r+b") as handle:
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(handle, fcntl.LOCK_UN)
        except OSError:
            return True
    return False


def run(command):
    # 使用参数数组，不经过shell；昵称、链接和带空格路径不拼接成命令文本。
    subprocess.run([str(value) for value in command], cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", help="玩家精确昵称、ID或带player/id参数的BGA链接")
    parser.add_argument("--stage", choices=("all", "download", "prepare", "train", "status"), default="all")
    parser.add_argument("--database", type=Path, default=ROOT / ".local/bga-database")
    parser.add_argument("--cookie-file", type=Path, default=ROOT / ".local/bga-cookie.txt")
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--base-data", type=Path, default=ROOT / ".local/ai/guide-r4.jsonl.gz")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--refresh", action="store_true", help="重新分页发现新结束的对局，保留已下载文件")
    args = parser.parse_args()
    if not args.target:
        args.target = input("请输入BGA玩家名称、ID或链接：").strip()
    if args.epochs < 1 or args.limit < 0 or args.interval < 0.5:
        parser.error("epochs >= 1; limit >= 0; interval >= 0.5")
    args.database = args.database.resolve()
    player = resolve_target(args.target, args.database, args.cookie_file)
    folder = args.database / player
    manifest_path = folder / "manifest.json"
    latest_path = folder / "workflow-latest.json"
    if args.stage == "status":
        manifest = read(manifest_path)
        print(json.dumps({"player": player, "crawl": {key: manifest.get(key) for key in
                          ("phase", "summary", "updatedAt", "error")}, "crawlerLocked": lock_busy(folder),
                          "workflow": read(latest_path) if latest_path.exists() else None}, ensure_ascii=False))
        return
    if args.stage in ("all", "download"):
        if lock_busy(folder):
            print(json.dumps({"phase": "waiting-for-existing-crawler", "player": player}), flush=True)
            last_summary = None
            while lock_busy(folder):
                manifest = read(manifest_path)
                if manifest.get("summary") != last_summary:
                    last_summary = manifest.get("summary")
                    print(json.dumps({"phase": "crawl", "summary": last_summary}), flush=True)
                time.sleep(10)
            manifest = read(manifest_path)
            if manifest.get("phase") in ("error", "stopped") and manifest.get(
                    "error") not in SNAPSHOT_ERRORS:
                raise ValueError("BGA_EXISTING_CRAWLER_STOPPED_SEE_MANIFEST")
        else:
            stop_path = folder / "STOP"
            if stop_path.exists():
                stop_path.unlink()
            command = [sys.executable, "-u", ROOT / "scripts/crawl-bga.py", "--player", player,
                       "--cookie-file", args.cookie_file.resolve(), "--out-dir", folder,
                       "--retry-failed", "--limit", args.limit, "--interval", args.interval]
            if args.refresh:
                command.append("--refresh-history")
            try:
                run(command)
            except subprocess.CalledProcessError:
                manifest = read(manifest_path)
                if (args.stage != "all" or manifest.get("error") not in SNAPSHOT_ERRORS
                        or not manifest.get("summary", {}).get("downloaded")):
                    raise
                print(json.dumps({"phase": "using-downloaded-snapshot",
                                  "crawlError": manifest["error"], "summary": manifest["summary"]}), flush=True)
        if args.stage == "download":
            return
    if not manifest_path.exists():
        raise ValueError("BGA_NO_LOCAL_ARCHIVES_RUN_DOWNLOAD_FIRST")
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    output = (args.run_dir or ROOT / ".local/ai/bga-runs" / run_id).resolve()
    if (output / "workflow.json").exists():
        raise ValueError("BGA_RUN_EXISTS_USE_NEW_DIRECTORY")
    output.mkdir(parents=True, exist_ok=True)
    dataset = output / "bga-draft.jsonl.gz"
    state = {"player": player, "phase": "preparing", "run": str(output), "dataset": str(dataset),
             "scope": "starting-draft-only", "updatedAt": CRAWL.timestamp(),
             "downloadComplete": read(manifest_path).get("phase") == "complete",
             "crawlError": read(manifest_path).get("error")}
    folder.mkdir(parents=True, exist_ok=True)

    def save():
        state["updatedAt"] = CRAWL.timestamp()
        CRAWL.atomic_json(output / "workflow.json", state)
        CRAWL.atomic_json(latest_path, state)

    save()
    try:
        run(["node", ROOT / "scripts/prepare-bga-training.mjs", "--database", args.database, "--out", dataset])
        report = read(Path(str(dataset) + ".report.json"))
        state.update(phase="prepared", games=report["games"], records=report["records"],
                     rejected=report["rejected"], teacherPlayers=report["teacherPlayers"])
        save()
        if args.stage == "prepare":
            return
        checkpoint = args.checkpoint
        if not checkpoint:
            loop_state = ROOT / ".local/ai/continuous-r4/loop-state.json"
            if loop_state.exists():
                checkpoint = Path(read(loop_state).get("champion") or "")
            if not checkpoint or not checkpoint.is_file():
                checkpoint = ROOT / ".local/ai/continuous-r4/initial/imitation.pt"
        if not checkpoint.is_file():
            raise ValueError("AI_BASE_CHECKPOINT_MISSING_USE_CHECKPOINT")
        state.update(phase="training", baseline=str(checkpoint.resolve()))
        save()
        model_dir = output / "model"
        run([sys.executable, "-u", ROOT / "scripts/train-bga.py", dataset, "--base-data", args.base_data.resolve(),
             "--checkpoint", checkpoint.resolve(), "--out-dir", model_dir, "--epochs", args.epochs])
        state.update(phase="complete", checkpoint=str(model_dir / "imitation.pt"),
                     trainingReport=str(model_dir / "training-report.json"),
                     continuationConfig=str(model_dir / "next-loop-config.json"),
                     promotedToChampion=False)
        save()
        print(json.dumps(state, ensure_ascii=False), flush=True)
    except Exception:
        state.update(phase="error", error="BGA_WORKFLOW_STAGE_FAILED")
        save()
        raise


if __name__ == "__main__":
    try:
        main()
    except (ValueError, CRAWL.CrawlError, OSError, subprocess.CalledProcessError):
        raise SystemExit("BGA_WORKFLOW_FAILED_SEE_LOCAL_REPORT_OR_COMMAND_OUTPUT")
