"""验证BGA按桌号分区、策略微调梯度及工作流身份解析，不访问网络。"""
import importlib.util
import contextlib
import gzip
import hashlib
import io
import json
import sys
import tempfile
import unittest
import subprocess
from unittest.mock import patch
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


TRAIN = module("test_train_bga", "train-bga.py")
FLOW = module("test_flow_bga", "bga-workflow.py")


class TrainingTests(unittest.TestCase):
    def test_bga_loss_does_not_supervise_value_head(self):
        model = TRAIN.TRAIN.PolicyValue(2, 2)
        rows = [{"state": [1, 2], "candidates": [[1, 0], [0, 1]],
                 "teacher": 1, "z": 0, "valueWeight": 0}]
        TRAIN.mixed_loss(model, rows).backward()
        for parameter in model.value.parameters():
            self.assertTrue(parameter.grad is None or parameter.grad.abs().sum().item() == 0)
        self.assertGreater(sum(parameter.grad.abs().sum().item() for parameter in model.policy.parameters()), 0)

    def test_table_partition_is_stable_when_corpus_grows(self):
        rows = [{"game": f"bga:{game}", "step": step} for game in range(40) for step in range(2)]
        train, valid, _ = TRAIN.split_bga(rows)
        train_more, valid_more, _ = TRAIN.split_bga(rows + [{"game": "bga:9999", "step": 0}])
        self.assertFalse({row["game"] for row in train} & {row["game"] for row in valid})
        self.assertTrue({row["game"] for row in train} <= {row["game"] for row in train_more})
        self.assertTrue({row["game"] for row in valid} <= {row["game"] for row in valid_more})

    def test_target_id_link_and_cached_name_never_guess_similar_names(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory)
            folder = database / "123"
            folder.mkdir()
            (folder / "manifest.json").write_text(json.dumps({"tables": {"456": {"history": {
                "players": "123,789", "player_names": "Example,Other"}}}}), encoding="utf-8")
            cookie = database / "missing-cookie"
            self.assertEqual(FLOW.resolve_target("123", database, cookie), "123")
            self.assertEqual(FLOW.resolve_target("eXaMpLe", database, cookie), "123")
            self.assertEqual(FLOW.resolve_target("https://boardgamearena.com/gamestats?player=123", database, cookie), "123")
            with self.assertRaises(FLOW.CRAWL.CrawlError):
                FLOW.resolve_target("https://evil.test/?player=123", database, cookie)
            with self.assertRaisesRegex(ValueError, "PLAYER_PARAMETER"):
                FLOW.resolve_target("https://boardgamearena.com/table?table=123", database, cookie)

    def test_partial_dataset_requires_dedicated_loader_and_valid_hash(self):
        meta = {key: "test" for key in TRAIN.TRAIN.META_KEYS}
        row = {**meta, "game": "bga:123", "state": [1], "candidates": [[1], [2]], "teacher": 0,
               "z": 0, "valueWeight": 0, "provenance": {"kind": "bga-verified-draft-v1", "table": "123",
                                                      "legalityVerified": True, "resourcesVerified": True}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rows.jsonl.gz"
            path.write_bytes(gzip.compress((json.dumps(row) + "\n").encode()))
            manifest = {**meta, "datasetFormat": "bga-verified-draft-v1", "scope": "starting-draft-only",
                        "policyOnly": True, "games": 1, "completed": 1, "records": 1,
                        "datasetSha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            report = Path(str(path) + ".report.json")
            report.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "PARTIAL_DATA"):
                TRAIN.TRAIN.load_dataset(path)
            self.assertEqual(len(TRAIN.TRAIN.load_dataset(path, allow_partial=True)[0]), 1)
            manifest["datasetSha256"] = "changed"
            report.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "BGA_MANIFEST_MISMATCH"):
                TRAIN.TRAIN.load_dataset(path, allow_partial=True)

    def test_all_stage_uses_saved_snapshot_after_replay_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "database/123"
            folder.mkdir(parents=True)
            (folder / "manifest.json").write_text(json.dumps({
                "phase": "error", "error": "BGA_REPLAY_LIMIT_RETRY_LATER",
                "summary": {"downloaded": 4}, "tables": {}}), encoding="utf-8")
            checkpoint = root / "baseline.pt"
            checkpoint.write_bytes(b"synthetic")
            output = root / "run"
            commands = []

            def command(args):
                args = list(map(str, args))
                commands.append(args)
                if any(arg.endswith("crawl-bga.py") for arg in args):
                    raise subprocess.CalledProcessError(1, args)
                if any(arg.endswith("prepare-bga-training.mjs") for arg in args):
                    dataset = output / "bga-draft.jsonl.gz"
                    Path(str(dataset) + ".report.json").write_text(json.dumps({
                        "games": 4, "records": 8, "rejected": {}, "teacherPlayers": ["123"]}), encoding="utf-8")

            arguments = ["bga-workflow.py", "123", "--database", str(root / "database"),
                         "--checkpoint", str(checkpoint), "--run-dir", str(output)]
            with patch("sys.argv", arguments), patch.object(FLOW, "run", side_effect=command), contextlib.redirect_stdout(io.StringIO()):
                FLOW.main()
            state = FLOW.read(output / "workflow.json")
            self.assertEqual(state["phase"], "complete")
            self.assertFalse(state["downloadComplete"])
            self.assertEqual(state["crawlError"], "BGA_REPLAY_LIMIT_RETRY_LATER")
            self.assertEqual(len(commands), 3)


if __name__ == "__main__":
    torch.set_num_threads(2)
    unittest.main()
