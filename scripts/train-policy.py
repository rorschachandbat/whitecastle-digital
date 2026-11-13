"""攻略模仿预热后以自身终局分数优化策略，并用公开路线搜索探索后续联动。"""
import argparse
import copy
import gzip
import hashlib
import json
import math
import random
import time
from pathlib import Path

import torch
from torch import nn
from torch.distributions import Categorical

from ai_model import (ROOT, META_KEYS, PolicyValue, RulesProcess, batch_tensors,
                      infer, save_checkpoint, load_checkpoint, REWARD_VERSION, SCORE_SCALE, SCORE_PARTS)


def parts_targets(rows):
    """辅助标签必须是同一席位的实际终局分项，且总和与终局总分相符。"""
    for row in rows:
        parts = row.get("finalParts", {})
        if (set(parts) != set(SCORE_PARTS)
                or not all(isinstance(parts[key], (int, float)) and math.isfinite(parts[key])
                           and parts[key] >= 0 for key in SCORE_PARTS)
                or abs(sum(parts.values()) - row["finalScore"]) > 1e-6):
            raise ValueError("AI_BAD_PARTS_TARGET")
    return torch.tensor([[row["finalParts"][key] / SCORE_SCALE for key in SCORE_PARTS] for row in rows])


def auxiliary_loss(model, rows):
    if not model.score_parts:
        return torch.tensor(0.0)
    state = torch.tensor([row["state"] for row in rows], dtype=torch.float32)
    return nn.functional.mse_loss(model.predict_parts(state), parts_targets(rows))


def load_dataset(path, allow_partial=False):
    manifest_path = Path(str(path) + ".report.json")
    if not manifest_path.exists():
        raise ValueError("AI_DATA_INCOMPLETE_MANIFEST")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    partial = manifest.get("datasetFormat") == "bga-verified-draft-v1"
    if partial and not allow_partial:
        raise ValueError("AI_PARTIAL_DATA_USE_BGA_TRAINER")
    if partial:
        if (manifest.get("scope") != "starting-draft-only" or manifest.get("policyOnly") is not True
                or hashlib.sha256(Path(path).read_bytes()).hexdigest() != manifest.get("datasetSha256")):
            raise ValueError("AI_BGA_MANIFEST_MISMATCH")
    if manifest["games"] != manifest["completed"]:
        raise ValueError("AI_DATA_INCOMPLETE_GAMES")
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    if not rows:
        raise ValueError("AI_EMPTY_DATA")
    if any(key not in rows[0] for key in META_KEYS):
        raise ValueError("AI_DATA_METADATA_VERSION_MISMATCH")
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
        valid_target = (row["z"] == 0 if partial else
                        (isinstance(row.get("finalScore"), (int, float))
                         and math.isfinite(row["finalScore"]) and row["finalScore"] >= 0
                         and abs(row["z"] - row["finalScore"] / SCORE_SCALE) < 1e-6)
                        if meta.get("rewardVersion") == REWARD_VERSION else row["z"] in (-1, 1))
        if not 0 <= row["teacher"] < len(row["candidates"]) or not valid_target:
            raise ValueError("AI_BAD_TARGET")
        importance = row.get("policyWeight", 1.0)
        if not isinstance(importance, (int, float)) or not math.isfinite(importance) or not 0 < importance <= 3:
            raise ValueError("AI_BAD_POLICY_WEIGHT")
        if "finalParts" in row:
            parts_targets([row])
        if partial and (row.get("valueWeight") != 0
                        or row.get("provenance", {}).get("kind") != "bga-verified-draft-v1"
                        or row["provenance"].get("legalityVerified") is not True
                        or row["provenance"].get("resourcesVerified") is not True
                        or row["game"] != "bga:" + row["provenance"].get("table", "")):
            raise ValueError("AI_BGA_UNVERIFIED_ROW")
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
    policy_loss = value_loss = correct = decisions = parts_loss = 0
    for offset in range(0, len(rows), 64):
        batch = rows[offset:offset + 64]
        logits, values = model(*batch_tensors(batch))
        labels = torch.tensor([row["teacher"] for row in batch])
        targets = torch.tensor([row["z"] for row in batch], dtype=torch.float32)
        policy_loss += nn.functional.cross_entropy(logits, labels, reduction="sum").item()
        value_loss += nn.functional.mse_loss(values, targets, reduction="sum").item()
        if model.score_parts:
            parts_loss += auxiliary_loss(model, batch).item() * len(batch)
        multiple = torch.tensor([len(row["candidates"]) > 1 for row in batch])
        correct += ((logits.argmax(-1) == labels) & multiple).sum().item()
        decisions += multiple.sum().item()
    return {"policyLoss": policy_loss / len(rows), "valueMSE": value_loss / len(rows),
            "teacherTop1Nontrivial": correct / max(1, decisions), "nontrivialDecisions": decisions,
            "partsMSE": parts_loss / len(rows) if model.score_parts else None}


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
            # 高分样本略提高模仿权重，始终保留普通局；不是把一条高分路线当成唯一最优解。
            importance = torch.tensor([row.get("policyWeight", 1.0) for row in batch], dtype=torch.float32)
            policy_loss = (nn.functional.cross_entropy(logits, labels, reduction="none") * importance).mean()
            loss = policy_loss + 0.25 * nn.functional.mse_loss(values, targets) + auxiliary_loss(model, batch)
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


def reinforce(model, optimizer, rules, games, seed_prefix, output, meta, seen_games, resume=None,
              league=None, experience_dir=None, search_config=None):
    history = []
    # 固定预热快照作为对手，每局交换网络方座位；一半对局为共享网络自我对弈。
    opponent = copy.deepcopy(model).eval()
    previous = (resume or {}).get("selfplayTotal", 0)
    score_stats = copy.deepcopy((resume or {}).get("scoreStats", {
        "count": 0, "total": 0, "max": 0, "atLeast60": 0, "atLeast80": 0}))
    if model.score_parts:
        score_stats.setdefault("partTotals", {key: 0 for key in SCORE_PARTS})
        score_stats.setdefault("atLeast100", 0)
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
        # 长期循环按固定节奏混合共享网络、攻略与历史对手；普通命令保留原有行为。
        mode = (previous + game) % 4 if league else None
        rival = league[((previous + game) // 4) % len(league)] if mode in (2, 3) else opponent
        trajectory = []
        records = []
        search_targets = []
        search_nodes = 0
        search_stats = {"calls": 0, "terminal": 0, "cutoff": 0, "failed": 0, "unfinished": 0,
                        "seconds": 0.0, "maxSeconds": 0.0, "workers": 1}
        game_started = time.monotonic()
        diagnostics_log = Path(str(output) + ".decisions.jsonl")
        def log_event(event):
            if not experience_dir:
                return
            with diagnostics_log.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"game": seed, "step": observation.get("decisions", len(records)),
                                         "at": time.time(), **event}, ensure_ascii=False) + "\n")
        def top_choices(probabilities):
            choices = observation.get("choices", [None] * len(probabilities))
            return [{"index": index, "choice": choices[index], "probability": float(probabilities[index]),
                     "heuristic": observation["heuristic"][index]}
                    for index in sorted(range(len(probabilities)), key=lambda i: float(probabilities[i]),
                                        reverse=True)[:3]]
        log_event({"event": "game-start", "opponentMode": mode})
        while not observation["done"]:
            actor = observation["actor"]
            league_seat = str(((previous + game) // 4 + int(mode == 3)) % 2)
            learner = ((mode == 0 or actor == league_seat) if league
                       else (previous + game) % 2 == 0 or actor == str(((previous + game) // 2) % 2))
            if learner:
                model.train()
                logits, value = infer(model, observation)
                base = logits.softmax(-1)
                search = None
                if search_config and len(base) > 1:
                    # 常规训练先在放骰及轮末根节点搜索；子选择由策略学习，深搜配置可另设 decisionScope=all。
                    use_search = search_config.get("decisionScope", "all") == "all" or observation.get("boundary", False)
                    if use_search:
                        log_event({"event": "search-start", "actor": actor, "request": observation["request"],
                                   "diagnostics": observation.get("diagnostics")})
                        search = rules.request(op="search", policy=base.detach().tolist(),
                                               settings={**search_config, "seed": f"{seed}:{observation.get('decisions', len(trajectory))}"})
                if search:
                    search_nodes += search["nodes"]
                    search_stats["calls"] += 1
                    for key in ("terminal", "cutoff", "failed", "unfinished"):
                        search_stats[key] += search.get(key, 0)
                    search_stats["seconds"] += search.get("seconds", 0)
                    search_stats["maxSeconds"] = max(search_stats["maxSeconds"], search.get("seconds", 0))
                    search_stats["workers"] = max(search_stats["workers"], search.get("workers", 1))
                if search and search["searched"]:
                    target = torch.tensor(search["policy"], dtype=base.dtype)
                    # 搜索分布与网络混合作为实际采样策略；对该分布求对数，避免离策略更新。
                    distribution = Categorical(probs=0.9 * target + 0.1 * base)
                    search_targets.append(-(target * logits.log_softmax(-1)).sum())
                else:
                    distribution = Categorical(logits=logits)
                action = distribution.sample()
                trajectory.append((actor, distribution.log_prob(action), value, distribution.entropy(),
                                   observation["state"]))
                index = action.item()
                log_event({"event": "decision", "actor": actor, "request": observation["request"],
                           "learner": True, "choiceIndex": index, "candidateCount": len(base),
                           "boundary": observation.get("boundary", False),
                           "choice": observation.get("choices", [None] * len(base))[index],
                           "valueScore": value.item() * SCORE_SCALE,
                           "policyProbability": base[index].item(),
                           "samplingProbability": distribution.probs[index].item(),
                           "policyEntropy": Categorical(probs=base.detach()).entropy().item(),
                           "samplingEntropy": distribution.entropy().item(),
                           "topChoices": top_choices(base.detach()),
                           "search": search, "diagnostics": observation.get("diagnostics")})
            else:
                if mode == 1:
                    index = max(range(len(observation["heuristic"])), key=observation["heuristic"].__getitem__)
                    probabilities = [float(i == index) for i in range(len(observation["candidates"]))]
                    rival_value = None
                    rival_entropy = 0.0
                else:
                    with torch.no_grad():
                        logits, rival_value = infer(rival, observation)
                        distribution = Categorical(logits=logits)
                        index = distribution.sample().item()
                        probabilities = distribution.probs.tolist()
                        rival_value = rival_value.item() * SCORE_SCALE
                        rival_entropy = distribution.entropy().item()
                log_event({"event": "decision", "actor": actor, "request": observation["request"],
                           "learner": False, "choiceIndex": index, "candidateCount": len(probabilities),
                           "boundary": observation.get("boundary", False),
                           "choice": observation.get("choices", [None] * len(probabilities))[index],
                           "valueScore": rival_value, "policyProbability": probabilities[index],
                           "samplingProbability": probabilities[index], "policyEntropy": rival_entropy,
                           "samplingEntropy": rival_entropy, "topChoices": top_choices(probabilities),
                           "search": None, "diagnostics": observation.get("diagnostics")})
            if experience_dir:
                records.append({**meta, "game": seed, "step": len(records), "actor": actor,
                                "state": observation["state"], "candidates": observation["candidates"],
                                "action": index, "learner": learner, "request": observation["request"],
                                "diagnostics": observation.get("diagnostics")})
            observation = rules.request(op="step", index=index)
        if observation["placements"] != 18 or not observation["score"]["complete"]:
            raise RuntimeError("AI_INCOMPLETE_ROLLOUT")
        if not trajectory:
            raise RuntimeError("AI_EMPTY_ROLLOUT")
        log_probs = torch.stack([item[1] for item in trajectory])
        values = torch.stack([item[2] for item in trajectory])
        entropy = torch.stack([item[3] for item in trajectory]).mean()
        targets = torch.tensor([observation["score"]["players"][item[0]]["total"] / SCORE_SCALE
                                for item in trajectory])
        advantages = targets - values.detach()
        loss = -(log_probs * advantages).mean() + 0.5 * nn.functional.mse_loss(values, targets) - 0.01 * entropy
        part_loss = torch.tensor(0.0)
        if model.score_parts:
            part_rows = [{"state": item[4], "finalScore": observation["score"]["players"][item[0]]["total"],
                          "finalParts": observation["score"]["players"][item[0]]["parts"]} for item in trajectory]
            part_loss = auxiliary_loss(model, part_rows)
            loss = loss + part_loss
        if search_targets:
            loss = loss + 0.25 * torch.stack(search_targets).mean()
        optimizer.zero_grad()
        loss.backward()
        gradient_norm = nn.utils.clip_grad_norm_(model.parameters(), 1)
        optimizer.step()
        search_stats["nodesPerSecond"] = search_nodes / search_stats["seconds"] if search_stats["seconds"] > 0 else None
        result = {"game": previous + game + 1, "seed": seed, "loss": loss.item(), "entropy": entropy.item(),
                  "decisions": observation["decisions"], "score": observation["score"],
                  "searchNodes": search_nodes,
                  "search": search_stats, "seconds": time.monotonic() - game_started,
                  "partsMSE": part_loss.item(), "valueMSE": nn.functional.mse_loss(values, targets).item(),
                  "advantageMean": advantages.mean().item(), "advantageStd": advantages.std(unbiased=False).item(),
                  "gradientNorm": float(gradient_norm), "diagnostics": observation.get("diagnostics"),
                  "learnerSeats": sorted({item[0] for item in trajectory}),
                  "opponent": "self" if mode == 0 else "guide" if mode == 1 else "history" if league else "legacy"}
        history.append(result)
        for seat in result["learnerSeats"]:
            final_score = result["score"]["players"][seat]["total"]
            score_stats["count"] += 1
            score_stats["total"] += final_score
            score_stats["max"] = max(score_stats["max"], final_score)
            score_stats["atLeast60"] += int(final_score >= 60)
            score_stats["atLeast80"] += int(final_score >= 80)
            if model.score_parts:
                score_stats["atLeast100"] += int(final_score >= 100)
                for key in SCORE_PARTS:
                    score_stats["partTotals"][key] += result["score"]["players"][seat]["parts"][key]
        score_stats["average"] = score_stats["total"] / score_stats["count"]
        if model.score_parts:
            score_stats["averageParts"] = {key: value / score_stats["count"] for key, value in score_stats["partTotals"].items()}
        if experience_dir:
            # 完整终局按种子写独立分片；当前优化器不重复采样旧经验。
            folder = Path(experience_dir)
            folder.mkdir(parents=True, exist_ok=True)
            shard = folder / (hashlib.sha256(seed.encode()).hexdigest() + ".jsonl.gz")
            temporary = shard.with_suffix(shard.suffix + ".tmp")
            with gzip.open(temporary, "wt", encoding="utf-8") as handle:
                for row in records:
                    row["finalScore"] = observation["score"]["players"][row["actor"]]["total"]
                    if "parts" in observation["score"]["players"][row["actor"]]:
                        row["finalParts"] = observation["score"]["players"][row["actor"]]["parts"]
                    row["z"] = row["finalScore"] / SCORE_SCALE
                    handle.write(json.dumps(row) + "\n")
            temporary.replace(shard)
            shard.with_suffix(".manifest.json").write_text(
                json.dumps({**meta, "format": "selfplay-experience-v1", "game": seed,
                            "records": len(records), "placements": 18, "complete": True,
                            "training": result}), encoding="utf-8")
        seen_games.add(seed)
        save_checkpoint(output, model, meta, phase="selfplay", selfplayTotal=previous + game + 1,
                        seenGames=sorted(seen_games), optimizer=optimizer.state_dict(),
                        torchRng=torch.get_rng_state(), opponentState=opponent.state_dict(), scoreStats=score_stats)
        # 循环每次只调用一局，不能把前面完整对局的诊断覆盖成最后一局。
        progress_path = Path(str(output) + ".progress.json")
        progress = json.loads(progress_path.read_text(encoding="utf-8")) if progress_path.exists() else []
        progress = [entry for entry in progress if entry["seed"] != seed] + [result]
        temporary_progress = progress_path.with_suffix(progress_path.suffix + ".tmp")
        temporary_progress.write_text(json.dumps(progress, indent=2), encoding="utf-8")
        temporary_progress.replace(progress_path)
        log_event({"event": "game-finished", "scores": result["score"], "search": search_stats,
                   "seconds": result["seconds"], "scoreStats": score_stats,
                   "valueMSE": result["valueMSE"], "partsMSE": result["partsMSE"]})
        print(json.dumps({"phase": "selfplay", "game": previous + game + 1, "loss": loss.item(),
                          "learnerSeats": result["learnerSeats"], "searchNodes": search_nodes,
                          "search": search_stats, "partsMSE": result["partsMSE"],
                          "valueMSE": result["valueMSE"], "gradientNorm": result["gradientNorm"],
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
            model = PolicyValue(*dimensions, score_parts=all("finalParts" in row for row in rows))
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
