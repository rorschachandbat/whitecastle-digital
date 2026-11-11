"""长期自我对弈、历史对手和晋级评估；按完整对局保存，可在机器重启后续跑。"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import signal
import time
import uuid
from pathlib import Path

import torch

from ai_model import ROOT, RulesProcess, load_checkpoint, save_checkpoint


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


TRAIN = module("loop_train", "train-policy.py")
EVAL = module("loop_eval", "evaluate-ai.py")
DEFAULT_CONFIG = ROOT / "data/ai-training-loop.json"


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


@contextlib.contextmanager
def exclusive(path):
    """文件锁随进程退出释放，断电后的空锁文件不会阻止恢复。"""
    with Path(path).open("a+b") as handle:
        if Path(path).stat().st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError("AI_LOOP_ALREADY_RUNNING") from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def validate(config):
    for key in ("gamesPerGeneration", "epochs", "evaluationPairs", "minimumPromotionPairs",
                "historySize", "threads"):
        if type(config.get(key)) is not int or config[key] < 1:
            raise ValueError("AI_LOOP_BAD_INTEGER")
    if not 0.5 < config["promotionWinRate"] <= 1:
        raise ValueError("AI_LOOP_BAD_THRESHOLD")
    if not 0 <= config["guideRegressionTolerance"] <= 1 or config["maxDiskGB"] <= 0:
        raise ValueError("AI_LOOP_BAD_LIMIT")
    if not config["prefix"] or len(config["prefix"]) > 80:
        raise ValueError("AI_LOOP_BAD_PREFIX")
    return config


def promotion(candidate, baseline, config):
    """工程选模判据；重复选模的评估不能充当最终保留测试集。"""
    duel = candidate["summary"]["imitation"]
    guide = candidate["summary"]["guide"]
    previous = baseline["summary"]["guide"]
    reasons = []
    if duel["games"] < 2 * config["minimumPromotionPairs"]:
        reasons.append("insufficient-pairs")
    if duel["winRate"] < config["promotionWinRate"]:
        reasons.append("champion-win-rate")
    if duel["averageMargin"] <= 0:
        reasons.append("champion-score-margin")
    if guide["winRate"] + config["guideRegressionTolerance"] < previous["winRate"]:
        reasons.append("guide-regression")
    return {"promoted": not reasons, "reasons": reasons, "selectionOnly": True}


def disk_bytes(folder):
    return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--out-dir", type=Path, default=ROOT / ".local/ai/continuous-v2-final")
    parser.add_argument("--generations", type=int, default=0, help="总目标代数；0 为持续运行")
    args = parser.parse_args()
    if args.generations < 0:
        parser.error("generations >= 0")
    config = validate(read(args.config))
    for key in ("input", "initialCheckpoint", "catalog", "weights"):
        if config.get(key):
            config[key] = str((ROOT / config[key]).resolve())
    folder = args.out_dir.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    state_path = folder / "loop-state.json"
    stop_path = folder / "STOP"
    stopping = False

    def stop_signal(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)

    def stop():
        return stopping or stop_path.exists()

    torch.set_num_threads(config["threads"])
    with exclusive(folder / "loop.lock"):
        with RulesProcess(config.get("catalog"), config.get("weights")) as rules:
            meta = rules.request(op="info")
        manifest_path = Path(config["input"] + ".report.json")
        manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        with Path(config["input"]).open("rb") as source:
            input_hash = hashlib.file_digest(source, "sha256").hexdigest()
        if state_path.exists():
            state = read(state_path)
            if (state["config"] != config or state["meta"] != meta or state["manifestHash"] != manifest_hash
                    or state["inputHash"] != input_hash):
                raise ValueError("AI_LOOP_CONFIG_CHANGED_USE_NEW_DIRECTORY")
        else:
            state = {"version": 2, "run": uuid.uuid4().hex[:12], "config": config, "meta": meta,
                     "manifestHash": manifest_hash, "inputHash": input_hash,
                     "generation": 0, "history": [], "active": None,
                     "champion": None, "latest": None, "evaluatedSeeds": [], "phase": "initializing"}
        state["pid"] = os.getpid()
        state.pop("error", None)
        atomic_json(state_path, state)
        try:
            if not state["latest"]:
                initial = folder / "initial"
                initial.mkdir(exist_ok=True)
                initial_model = initial / "imitation.pt"
                if not initial_model.exists():
                    rows, dataset_meta, dimensions = TRAIN.load_dataset(config["input"])
                    if dataset_meta != meta:
                        raise ValueError("AI_DATA_CONFIG_MISMATCH")
                    if config.get("initialCheckpoint"):
                        model, initial_checkpoint = load_checkpoint(config["initialCheckpoint"], meta)
                        if dimensions != (model.state_size, model.option_size):
                            raise ValueError("AI_LOOP_INITIAL_DATA_MISMATCH")
                    else:
                        initial_checkpoint = {}
                        rng = TRAIN.random.Random(7)
                        train, validation, validation_games = TRAIN.split_games(rows, rng)
                        torch.manual_seed(7)
                        model = TRAIN.PolicyValue(*dimensions)
                        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
                        report = TRAIN.distill(model, optimizer, train, validation, config["epochs"], rng)
                        atomic_json(initial / "training-report.json",
                                    {"meta": meta, "validationGames": validation_games, **report})
                    save_checkpoint(initial_model, model, meta, phase="imitation",
                                    seenGames=sorted({row["game"] for row in rows}
                                                     | set(initial_checkpoint.get("seenGames", []))),
                                    selfplayTotal=initial_checkpoint.get("selfplayTotal", 0))
                load_checkpoint(initial_model, meta)
                state["latest"] = state["champion"] = str(initial_model)
                state["history"] = [str(initial_model)]
                atomic_json(state_path, state)
            while not stop() and (args.generations == 0 or state["generation"] < args.generations):
                if disk_bytes(folder) >= config["maxDiskGB"] * 1024 ** 3:
                    state["phase"] = "disk-limit"
                    break
                generation = state["generation"]
                current = folder / f"generation-{generation:05d}"
                current.mkdir(exist_ok=True)
                if not state["active"]:
                    _, previous = load_checkpoint(state["latest"], meta)
                    state["active"] = {"checkpoint": str(current / "candidate.pt"), "base": state["latest"],
                                       "targetTotal": previous.get("selfplayTotal", 0) + config["gamesPerGeneration"]}
                    atomic_json(state_path, state)
                active = state["active"]
                candidate_path = Path(active["checkpoint"])
                model, checkpoint = load_checkpoint(candidate_path if candidate_path.exists() else active["base"], meta)
                seen = set(checkpoint.get("seenGames", []))
                if seen & set(state["evaluatedSeeds"]):
                    raise ValueError("AI_TRAIN_EVALUATION_SEED_OVERLAP")
                optimizer = torch.optim.Adam(model.parameters(), lr=0.0001)
                paths = list(dict.fromkeys([state["champion"], *state["history"][-config["historySize"]:]]))
                league = [load_checkpoint(path, meta)[0] for path in paths]
                state["phase"] = "selfplay"
                atomic_json(state_path, state)
                with RulesProcess(config.get("catalog"), config.get("weights")) as rules:
                    while checkpoint.get("selfplayTotal", 0) < active["targetTotal"] and not stop():
                        if disk_bytes(folder) >= config["maxDiskGB"] * 1024 ** 3:
                            state["phase"] = "disk-limit"
                            return 0
                        TRAIN.reinforce(model, optimizer, rules, 1,
                                        f"{config['prefix']}-{state['run']}-g{generation}",
                                        candidate_path, meta, seen, checkpoint, league, current / "experience")
                        model, checkpoint = load_checkpoint(candidate_path, meta)
                        optimizer = torch.optim.Adam(model.parameters(), lr=0.0001)
                        state["completedSelfplayGames"] = checkpoint["selfplayTotal"]
                        state["updatedAt"] = time.time()
                        atomic_json(state_path, state)
                if stop():
                    break
                # 选模开局和训练前缀分离，完整记录，恢复后也不用于训练。
                prefix = f"selection-{state['run']}-g{generation}"
                evaluation_seeds = [f"{prefix}-{index}" for index in range(config["evaluationPairs"])]
                state["evaluatedSeeds"] = sorted(set(state["evaluatedSeeds"]) | set(evaluation_seeds))
                state["phase"] = "evaluation"
                atomic_json(state_path, state)
                candidate_report = current / "evaluation.json"
                baseline_report = current / "champion-evaluation.json"
                if not candidate_report.exists():
                    EVAL.evaluate(candidate_path, candidate_report, config["evaluationPairs"],
                                  ("guide", "imitation"), state["champion"], prefix,
                                  config.get("catalog"), config.get("weights"), stop=stop)
                if not baseline_report.exists():
                    EVAL.evaluate(state["champion"], baseline_report, config["evaluationPairs"],
                                  ("guide",), prefix=prefix, catalog=config.get("catalog"),
                                  weights=config.get("weights"), stop=stop)
                result = promotion(read(candidate_report), read(baseline_report), config)
                state["latest"] = str(candidate_path)
                if result["promoted"]:
                    state["champion"] = str(candidate_path)
                    state["history"].append(str(candidate_path))
                    state["history"] = state["history"][-config["historySize"]:]
                atomic_json(current / "result.json", {**result, "meta": meta, "generation": generation,
                                                     "candidate": str(candidate_path),
                                                     "champion": state["champion"]})
                state["generation"] += 1
                state["active"] = None
                state["phase"] = "ready"
                state["lastResult"] = result
                atomic_json(state_path, state)
                print(json.dumps({"generation": generation, **result}, ensure_ascii=False), flush=True)
            if state["phase"] != "disk-limit":
                state["phase"] = "stopped" if stop() else "target-complete"
        except InterruptedError:
            state["phase"] = "stopped"
        except Exception as error:
            state["phase"] = "error"
            state["error"] = str(error)
            raise
        finally:
            state["updatedAt"] = time.time()
            state["pid"] = None
            atomic_json(state_path, state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
