"""独立于卡牌 JSON 的策略及价值网络与本地规则协议。"""
import json
import subprocess
from pathlib import Path

import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
META_KEYS = ("profile", "featureVersion", "actionModelVersion", "catalogHash", "heuristicHash")


class PolicyValue(nn.Module):
    def __init__(self, state_size, option_size):
        super().__init__()
        self.state_size = state_size
        self.option_size = option_size
        self.state_encoder = nn.Sequential(nn.Linear(state_size, 64), nn.ReLU(), nn.Linear(64, 64), nn.ReLU())
        self.option_encoder = nn.Sequential(nn.Linear(option_size, 64), nn.ReLU())
        self.policy = nn.Sequential(nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, 1))
        self.value = nn.Sequential(nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, 1), nn.Tanh())

    def forward(self, state, options, mask):
        encoded_state = self.state_encoder(state)
        expanded = encoded_state[:, None, :].expand(-1, options.shape[1], -1)
        pairs = torch.cat((expanded, self.option_encoder(options)), dim=-1)
        logits = self.policy(pairs).squeeze(-1).masked_fill(~mask, -1e9)
        return logits, self.value(encoded_state).squeeze(-1)


def batch_tensors(rows):
    count = max(len(row["candidates"]) for row in rows)
    size = len(rows[0]["candidates"][0])
    options = torch.zeros((len(rows), count, size))
    mask = torch.zeros((len(rows), count), dtype=torch.bool)
    for index, row in enumerate(rows):
        actual = len(row["candidates"])
        options[index, :actual] = torch.tensor(row["candidates"], dtype=torch.float32)
        mask[index, :actual] = True
    state = torch.tensor([row["state"] for row in rows], dtype=torch.float32)
    return state, options, mask


def infer(model, observation):
    tensors = batch_tensors([observation])
    logits, value = model(*tensors)
    return logits[0, :len(observation["candidates"])], value[0]


def save_checkpoint(path, model, meta, **extra):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save({"model": model.state_dict(), "state_size": model.state_size,
                "option_size": model.option_size, "meta": meta, **extra}, temporary)
    temporary.replace(path)


def load_checkpoint(path, expected_meta=None):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if expected_meta:
        for key in META_KEYS:
            if checkpoint["meta"][key] != expected_meta[key]:
                raise ValueError(f"AI_MODEL_CONFIG_MISMATCH:{key}")
    model = PolicyValue(checkpoint["state_size"], checkpoint["option_size"])
    model.load_state_dict(checkpoint["model"])
    model.eval()
    return model, checkpoint


class RulesProcess:
    def __init__(self, catalog=None, weights=None):
        command = ["node", str(ROOT / "scripts/ai-env-server.mjs")]
        if catalog:
            command += ["--catalog", str(Path(catalog).resolve())]
        if weights:
            command += ["--weights", str(Path(weights).resolve())]
        self.process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, encoding="utf-8", bufsize=1)

    def request(self, **request):
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"AI_RULES_PROCESS_EXIT:{self.process.poll()}")
        result = json.loads(line)
        if not result["ok"]:
            raise RuntimeError(result["error"])
        return result["result"]

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
