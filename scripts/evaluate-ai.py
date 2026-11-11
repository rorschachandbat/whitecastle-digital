"""固定测试种子、交换座位评估完整对局；不使用攻略分数评价模型胜负。"""
import argparse
import json
import math
import random
import time
from pathlib import Path

import torch

from ai_model import ROOT, RulesProcess, infer, load_checkpoint


def wilson(wins, games):
    z = 1.96
    p = wins / games
    center = (p + z * z / (2 * games)) / (1 + z * z / games)
    radius = z * math.sqrt(p * (1 - p) / games + z * z / (4 * games * games)) / (1 + z * z / games)
    return [max(0, center - radius), min(1, center + radius)]


def evaluate(model_path, output, pairs=4, opponents=("random", "guide"), imitation_path=None,
             prefix="ai-eval-v1", catalog=None, weights=None, forbidden_seeds=(), stop=None):
    """评估种子只作选模用途；调用方负责保留最终一次性测试集。"""
    output = Path(output)
    if output.exists():
        raise ValueError("AI_OUTPUT_EXISTS")
    if pairs < 1 or not opponents or any(item not in ("random", "guide", "imitation") for item in opponents):
        raise ValueError("AI_BAD_EVALUATION")
    started = time.monotonic()
    games = []
    with RulesProcess(catalog, weights) as rules:
        meta = rules.request(op="info")
        model, checkpoint = load_checkpoint(model_path, meta)
        seen = set(checkpoint.get("seenGames", [])) | set(forbidden_seeds)
        imitation = None
        if "imitation" in opponents:
            if not imitation_path:
                raise ValueError("AI_MISSING_OPPONENT")
            imitation, rival = load_checkpoint(imitation_path, meta)
            seen.update(rival.get("seenGames", []))
        for opponent in opponents:
            for pair in range(pairs):
                seed = f"{prefix}-{pair}"
                if seed in seen:
                    raise ValueError("AI_EVALUATION_SEED_OVERLAP")
                for seat in ("0", "1"):
                    if stop and stop():
                        raise InterruptedError("AI_STOP_REQUESTED")
                    rng = random.Random(f"{seed}:{opponent}")
                    observation = rules.request(op="reset", seed=seed, playOrder=["0", "1"])
                    while not observation["done"]:
                        actor = observation["actor"]
                        if actor == seat or opponent == "imitation":
                            network = model if actor == seat else imitation
                            with torch.no_grad():
                                logits, _ = infer(network, observation)
                                index = logits.argmax().item()
                        elif opponent == "guide":
                            index = max(range(len(observation["heuristic"])), key=observation["heuristic"].__getitem__)
                        else:
                            index = rng.randrange(len(observation["candidates"]))
                        observation = rules.request(op="step", index=index)
                    if observation["placements"] != 18 or not observation["score"]["complete"]:
                        raise RuntimeError("AI_INCOMPLETE_EVALUATION")
                    own = observation["score"]["players"][seat]["total"]
                    other = observation["score"]["players"]["1" if seat == "0" else "0"]["total"]
                    game = {"opponent": opponent, "seed": seed, "seat": seat, "win": observation["score"]["winner"] == seat,
                            "ownScore": own, "opponentScore": other, "margin": own - other,
                            "decisions": observation["decisions"]}
                    games.append(game)
                    print(json.dumps(game), flush=True)
        replays = rules.request(op="replay")
    summary = {}
    for opponent in opponents:
        subset = [game for game in games if game["opponent"] == opponent]
        wins = sum(game["win"] for game in subset)
        summary[opponent] = {"games": len(subset), "wins": wins, "winRate": wins / len(subset),
                             "wilson95Approx": wilson(wins, len(subset)),
                             "averageScore": sum(game["ownScore"] for game in subset) / len(subset),
                             "averageOpponentScore": sum(game["opponentScore"] for game in subset) / len(subset),
                             "averageMargin": sum(game["margin"] for game in subset) / len(subset)}
    report = {"meta": meta, "model": str(model_path), "summary": summary, "games": games,
              "seconds": time.monotonic() - started,
              "limitations": ["local-practice-v1", "small-sample", "paired-games-not-independent",
                             "selection-evaluation-not-final-holdout"]}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.with_suffix(".last-replay.json").write_text(json.dumps(replays), encoding="utf-8")
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2), encoding="utf-8")
    temporary.replace(output)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    parser.add_argument("--pairs", type=int, default=4)
    parser.add_argument("--opponents", nargs="+", choices=["random", "guide", "imitation"], default=["random", "guide"])
    parser.add_argument("--imitation", type=Path)
    parser.add_argument("--prefix", default="ai-eval-v1")
    parser.add_argument("--out", type=Path, default=ROOT / ".local/ai/evaluation.json")
    parser.add_argument("--catalog")
    parser.add_argument("--weights")
    args = parser.parse_args()
    if args.pairs < 1:
        parser.error("pairs >= 1")
    torch.set_num_threads(2)
    report = evaluate(args.model, args.out, args.pairs, args.opponents, args.imitation,
                      args.prefix, args.catalog, args.weights)
    print(json.dumps({"summary": report["summary"], "report": str(args.out)}), flush=True)


if __name__ == "__main__":
    main()
