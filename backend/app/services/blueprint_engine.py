
"""
Blueprint engine — the knowledge-base layer for infra generation.

Each resource is described by ONE data file in knowledge_base/<resource>.yaml (the "knowledge"):
its wizard questions, per-environment defaults, and a manifest of output files (templates with
{{placeholders}}). A generic engine reads it to (a) drive the wizard and (b) render the files
deterministically. Adding/changing a resource = edit a YAML, no code change. Rendering stays
deterministic, so it's reliable + token-cheap (the model never writes the HCL).
"""
import os
import re

import yaml

KB_DIR = os.path.join(os.path.dirname(__file__), "knowledge_base")
_CACHE: dict = {}
_PLACEHOLDER = re.compile(r"\{\{\s*(\w+)\s*\}\}")


# ── Loading ──────────────────────────────────────────────────────────────────
def list_resources() -> list:
    if not os.path.isdir(KB_DIR):
        return []
    return sorted(f[:-5] for f in os.listdir(KB_DIR) if f.endswith(".yaml"))


def load(resource: str) -> dict:
    """Return the blueprint dict for a resource, or None."""
    resource = (resource or "").lower()
    if resource in _CACHE:
        return _CACHE[resource]
    path = os.path.join(KB_DIR, f"{resource}.yaml")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        bp = yaml.safe_load(f)
    _CACHE[resource] = bp
    return bp


def detect(message: str) -> str:
    """Return the resource key whose aliases match the message (longest alias wins)."""
    msg = (message or "").lower()
    best, best_len = None, 0
    for r in list_resources():
        bp = load(r) or {}
        for alias in bp.get("aliases", [r]):
            a = alias.lower()
            if re.search(r"\b" + re.escape(a) + r"\b", msg) and len(a) > best_len:
                best, best_len = r, len(a)
    return best


def questions(resource: str) -> list:
    bp = load(resource) or {}
    return bp.get("questions", [])


# ── Rendering ────────────────────────────────────────────────────────────────
def _normalize(ctx: dict) -> dict:
    """HCL-friendly values: Python bools → lowercase true/false strings."""
    out = {}
    for k, v in ctx.items():
        if v is True:
            out[k] = "true"
        elif v is False:
            out[k] = "false"
        elif isinstance(v, (list, tuple)):
            # Multi-select answers (e.g. add-on checkboxes) → an HCL list literal.
            out[k] = "[" + ", ".join('"' + str(x) + '"' for x in v) + "]"
        else:
            out[k] = v
    return out


def _render_str(s: str, ctx: dict) -> str:
    return _PLACEHOLDER.sub(lambda m: str(ctx.get(m.group(1), m.group(0))), s)


def _apply_maps(bp: dict, answers: dict) -> dict:
    """Apply each question's optional value `map` (e.g. {Public: 'true'})."""
    out = dict(answers)
    for q in bp.get("questions", []):
        k = q.get("key")
        if k in out and isinstance(q.get("map"), dict):
            out[k] = q["map"].get(out[k], out[k])
    return out


def render(resource: str, answers: dict) -> dict:
    """Render the blueprint's file manifest → {path: content}."""
    bp = load(resource)
    if not bp:
        raise ValueError(f"No blueprint for '{resource}'")
    answers = _apply_maps(bp, answers)

    constants = bp.get("constants", {}) or {}
    global_keys = set(bp.get("global_keys", list(answers.keys())))
    global_ctx = {**constants, **{k: v for k, v in answers.items() if k in global_keys}}
    per_env_answers = {k: v for k, v in answers.items()
                       if k not in global_keys and v not in (None, "")}

    envs_cfg = bp.get("environments") or {}
    env_list = envs_cfg.get("list", [])
    env_defaults = envs_cfg.get("defaults", {})
    selected = answers.get("environment")

    files = {}
    for f in bp.get("files", []):
        cond = f.get("when")  # include the file only when this context key is truthy
        if f.get("foreach") == "env":
            for env in env_list:
                ectx = {**global_ctx, **env_defaults.get(env, {}), "env": env}
                if env == selected:
                    ectx.update(per_env_answers)
                    if "desired" in ectx:  # clamp scaling so min<=desired<=max
                        d = int(ectx["desired"])
                        ectx["min"] = min(int(ectx.get("min", d)), d)
                        ectx["max"] = max(int(ectx.get("max", d)), d)
                if cond and not ectx.get(cond):
                    continue
                ectx = _normalize(ectx)
                files[_render_str(f["path"], ectx)] = _render_str(f["content"], ectx)
        else:
            if cond and not global_ctx.get(cond):
                continue
            ctx = _normalize(global_ctx)
            files[_render_str(f["path"], ctx)] = _render_str(f["content"], ctx)
    return files


def apply_spec(resource: str, answers: dict) -> dict:
    """How to apply this resource — rendered run_dir / state_key / name / background."""
    bp = load(resource) or {}
    answers = _apply_maps(bp, answers)
    ctx = _normalize({**(bp.get("constants", {}) or {}), **answers})
    spec = bp.get("apply", {}) or {}
    return {
        "run_dir": _render_str(spec.get("run_dir", ""), ctx),
        "state_key": _render_str(spec.get("state_key", ""), ctx),
        "name": _render_str(spec.get("name", "{{name}}"), ctx),
        "background": bool(spec.get("background", False)),
        "region": answers.get("region", "us-east-1"),
    }
