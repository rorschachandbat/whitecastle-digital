"""攻略模仿预热后进行终局胜负驱动的自我对弈；只支持当前练习规则。"""
import argparse
import copy
import gzip
import json
import math
import random
import time
from pathlib import Path

import torch
from torch import nn
from torch.distributions import Categorical

from ai_model import (ROOT, META_KEYS, PolicyValue, RulesProcess, batch_tensors,
                      infer, save_checkpoint, load_checkpoint)


def load_dataset(path):
    manifest_path = Path(str(path) + ".report.json")
    if not manifest_path.exists():
        raise ValueError("AI_DATA_INCOMPLETE_MANIFEST")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["games"] != manifest["completed"]:
        raise ValueError("AI_DATA_INCOMPLETE_GAMES")
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    if not rows:
        raise ValueError("AI_EMPTY_DATA")
    meta = {key: rows[0][key] for key in META_KEYS}
    if (len(rows) != manifest["records"] or len({row["game"] for row in rows}) != manifest["completed"]
            or any(manifest[key] != meta[key] for key in META_KEYS)):
        raise ValueError("AI_DATA_MANIFEST_MISMATCH")
    dimensions = len(rows[0]["state"]), len(rows[0]["candidates"][0])
    for row in rows:
        if any(row[key] != meta[key] for key in META_KEYS):
            raise ValueError("AI_MIXED_DATA_VERSIONS")
        if len(row["state"]) != dimensions[0] or not row["candidates"]:
            raise ValueError("AI_BAD_STATE")
        if not 0 <= row["teacher"] < len(row["candidates"]) or row["z"] not in (-1, 1):
            raise ValueError("AI_BAD_TARGET")
        flat = row["state"] + [value for option in row["candidates"] for value in option]
        if any(len(option) != dimensions[1] for option in row["candidates"]) or not all(map(math.isfinite, flat)):
            raise ValueError("AI_BAD_FEATURES")
    return rows, meta, dimensions


def split_games(rows, rng):
    games = sorted({row["game"] for row in rows})
    if len(games) < 4:
        raise ValueError("AI_NEED_FOUR_GAMES")
    rng.shuffle(games)
    validation_games = set(games[:max(1, len(games) // 4)])
    return ([row for row in rows if row["game"] not in validation_games],
            [row for row in rows if row["game"] in validation_games],
            sorted(validation_games))


@torch.no_grad()
def metrics(model, rows):
    model.eval()
    policy_loss = value_loss = correct = decisions = 0
    for offset in range(0, len(rows), 64):
        batch = rows[offset:offset + 64]
        logits, values = model(*batch_tensors(batch))
        labels = torch.tensor([row["teacher"] for row in batch])
        targets = torch.tensor([row["z"] for row in batch], dtype=torch.float32)
        policy_loss += nn.functional.cross_entropy(logits, labels, reduction="sum").item()
        value_loss += nn.functional.mse_loss(values, targets, reduction="sum").item()
        multiple = torch.tensor([len(row["candidates"]) > 1 for row in batch])
        correct += ((logits.argmax(-1) == labels) & multiple).sum().item()
        decisions += multiple.sum().item()
    return {"policyLoss": policy_loss / len(rows), "valueMSE": value_loss / len(rows),
            "teacherTop1Nontrivial": correct / max(1, decisions), "nontrivialDecisions": decisions}


def distill(model, optimizer, train, validation, epochs, rng):
    initial = metrics(model, validation)
    best_loss = float("inf")
    best_state = None
    history = []
    for epoch in range(epochs):
        model.train()
        rng.shuffle(train)
        for offset in range(0, len(train), 32):
            batch = train[offset:offset + 32]
            logits, values = model(*batch_tensors(batch))
            labels = torch.tensor([row["teacher"] for row in batch])
            targets = torch.tensor([row["z"] for row in batch], dtype=torch.float32)
            loss = nn.functional.cross_entropy(logits, labels) + 0.25 * nn.functional.mse_loss(values, targets)
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1)
            optimizer.step()
        evaluated = metrics(model, validation)
        history.append({"epoch": epoch + 1, **evaluated})
        if evaluated["policyLoss"] < best_loss:
            best_loss = evaluated["policyLoss"]
            best_state = copy.deepcopy(model.state_dict())
        print(json.dumps({"phase": "imitation", **history[-1]}), flush=True)
    model.load_state_dict(best_state)
    return {"initialValidation": initial, "train": metrics(model, train),
            "validation": metrics(model, validation), "history": history}


def reinforce(model, optimizer, rules, games, seed_prefix, output, meta, seen_games, resume=None):
    history = []
    # 固定预热快照作为对手，每局交换网络方座位；一半对局为共享网络自我对弈。
    opponent = copy.deepcopy(model).eval()
    previous = (resume or {}).get("selfplayTotal", 0)
    if resume and resume.get("opponentState"):
        opponent.load_state_dict(resume["opponentState"])
    if resume and resume.get("optimizer"):
        optimizer.load_state_dict(resume["optimizer"])
        torch.set_rng_state(resume["torchRng"])
    next_seed = 0
    for game in range(games):
        while f"{seed_prefix}-{next_seed}" in seen_games:
            next_seed += 1
        seed = f"{seed_prefix}-{next_seed}"
        next_seed += 1
        observation = rules.request(op="reset", seed=seed, playOrder=["0", "1"])
        trajectory = []
        while not observation["done"]:
            actor = observation["actor"]
            learner = (previous + game) % 2 == 0 or actor == str(((previous + game) // 2) % 2)
            if learner:
                model.train()
                logits, value = infer(model, observation)
                distribution = Categorical(logits=logits)
                action = distribution.sample()
                trajectory.append((actor, distribution.log_prob(action), value, distribution.entropy()))
                index = action.item()
            else:
                with torch.no_grad():
                    logits, _ = infer(opponent, observation)
                    index = Categorical(logits=logits).sample().item()
            observation = rules.request(op="step", index=index)
        if observation["placements"] != 18 or not observation["score"]["complete"]:
            raise RuntimeError("AI_INCOMPLETE_ROLLOUT")
        if not trajectory:
            raise RuntimeError("AI_EMPTY_ROLLOUT")
        log_probs = torch.stack([item[1] for item in trajectory])
        values = torch.stack([item[2] for item in trajectory])
        entropy = torch.stack([item[3] for item in trajectory]).mean()
        targets = torch.tensor([1.0 if observation["score"]["winner"] == item[0] else -1.0 for item in trajectory])
        advantages = targets - values.detach()
        loss = -(log_probs * advantages).mean() + 0.5 * nn.functional.mse_loss(values, targets) - 0.01 * entropy
        optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1)
        optimizer.step()
        result = {"game": game + 1, "seed": seed, "loss": loss.item(), "entropy": entropy.item(),
                  "decisions": observation["decisions"], "score": observation["score"]}
        history.append(result)
        seen_games.add(seed)
        save_checkpoint(output, model, meta, phase="selfplay", selfplayTotal=previous + game + 1,
                        seenGames=sorted(seen_games), optimizer=optimizer.state_dict(),
                        torchRng=torch.get_rng_state(), opponentState=opponent.state_dict())
        Path(str(output) + ".progress.json").write_text(json.dumps(history, indent=2), encoding="utf-8")
        print(json.dumps({"phase": "selfplay", "game": game + 1, "loss": loss.item(),
                          "scores": {key: item["total"] for key, item in result["score"]["players"].items()}}), flush=True)
    return history


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--out-dir", type=Path, default=ROOT / ".local/ai/run1")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--selfplay-games", type=int, default=8)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--prefix", default="ai-selfplay-v1")
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--catalog")
    parser.add_argument("--weights")
    args = parser.parse_args()
    if args.epochs < 1 or args.selfplay_games < 0:
        parser.error("epochs >= 1; selfplay-games >= 0")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if any((args.out_dir / name).exists() for name in ("imitation.pt", "selfplay.pt")):
        raise ValueError("AI_OUTPUT_EXISTS")
    started = time.monotonic()
    random.seed(args.seed)
    rng = random.Random(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(2)
    rows, meta, dimensions = load_dataset(args.input)
    train, validation, validation_games = split_games(rows, rng)
    with RulesProcess(args.catalog, args.weights) as rules:
        current_meta = rules.request(op="info")
        if meta != current_meta:
            raise ValueError("AI_DATA_CONFIG_MISMATCH")
        seen_games = {row["game"] for row in rows}
        resume = None
        if args.resume:
            model, resume = load_checkpoint(args.resume, meta)
            if (model.state_size, model.option_size) != dimensions:
                raise ValueError("AI_RESUME_DIMENSION_MISMATCH")
            seen_games.update(resume.get("seenGames", []))
            imitation = {"resumedFrom": str(args.resume), "validation": metrics(model, validation)}
        else:
            model = PolicyValue(*dimensions)
            optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
            imitation = distill(model, optimizer, train, validation, args.epochs, rng)
            save_checkpoint(args.out_dir / "imitation.pt", model, meta, phase="imitation",
                            seenGames=sorted(seen_games))
        # 使用新优化器，避免把模仿阶段的动量混入首次终局奖励更新。
        optimizer = torch.optim.Adam(model.parameters(), lr=0.0001)
        selfplay = reinforce(model, optimizer, rules, args.selfplay_games, args.prefix,
                             args.out_dir / "selfplay.pt", meta, seen_games, resume)
    # 从磁盘重新载入，核验权重产物可供独立评估使用。
    if selfplay or not args.resume:
        load_checkpoint(args.out_dir / ("selfplay.pt" if selfplay else "imitation.pt"), meta)
    report = {"meta": meta, "seed": args.seed, "torch": torch.__version__, "device": "cpu",
              "stateSize": dimensions[0], "optionSize": dimensions[1],
              "trainGames": sorted({row["game"] for row in train}), "validationGames": validation_games,
              "trainDecisions": len(train), "validationDecisions": len(validation),
              "imitation": imitation, "selfplay": selfplay, "seconds": time.monotonic() - started}
    (args.out_dir / "training-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(args.out_dir / "training-report.json"),
                      "seconds": report["seconds"]}), flush=True)


if __name__ == "__main__":
    main()
