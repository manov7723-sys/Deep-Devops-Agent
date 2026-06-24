"""
Architecture composition engine.

The user describes ANY architecture ("a VPC, an EC2 in it, an RDS reachable only from the EC2,
with security groups"). The model turns that into a small structured SPEC (which components +
how they connect). This engine then deterministically renders production Terraform by composing
modules from the knowledge base (knowledge_base/modules/<type>.yaml), each backed by a proven
Terraform Registry module — so nothing is hand-written, and wiring (outputs → inputs) is automatic.

SPEC shape (produced by the agent):
{
  "name": "myapp", "environment": "dev", "region": "us-east-1",
  "components": [
    {"id": "vpc",    "type": "vpc"},
    {"id": "app_sg", "type": "security_group", "connect": {"vpc": "vpc"}},
    {"id": "db_sg",  "type": "security_group", "connect": {"vpc": "vpc", "ingress_from": "app_sg"}},
    {"id": "web",    "type": "ec2", "config": {"instance_type": "t3.small"},
                     "connect": {"vpc": "vpc", "sg": "app_sg"}},
    {"id": "db",     "type": "rds", "connect": {"vpc": "vpc", "sg": "db_sg"}}
  ]
}
"""
import os
import re

import yaml

MODULES_DIR = os.path.join(os.path.dirname(__file__), "knowledge_base", "modules")
_PLACEHOLDER = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")
_CACHE: dict = {}


def list_modules() -> list:
    if not os.path.isdir(MODULES_DIR):
        return []
    return sorted(f[:-5] for f in os.listdir(MODULES_DIR) if f.endswith(".yaml"))


def load_module(mtype: str) -> dict:
    mtype = (mtype or "").lower()
    if mtype in _CACHE:
        return _CACHE[mtype]
    path = os.path.join(MODULES_DIR, f"{mtype}.yaml")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        m = yaml.safe_load(f)
    _CACHE[mtype] = m
    return m


def _render(s: str, ctx: dict) -> str:
    return _PLACEHOLDER.sub(lambda m: str(ctx.get(m.group(1), m.group(0))), s)


def _providers(region: str) -> str:
    return (
        'terraform {\n'
        '  required_version = ">= 1.3"\n'
        '  required_providers {\n'
        '    aws = {\n'
        '      source  = "hashicorp/aws"\n'
        '      version = "~> 5.0"\n'
        '    }\n'
        '  }\n'
        '}\n\n'
        'provider "aws" {\n'
        f'  region = "{region}"\n'
        '}\n'
    )


def _backend(bucket: str, state_region: str, name: str, env: str) -> str:
    return (
        'terraform {\n'
        '  backend "s3" {\n'
        f'    bucket = "{bucket}"\n'
        f'    key    = "arch/{name}-{env}/terraform.tfstate"\n'
        f'    region = "{state_region}"\n'
        '  }\n'
        '}\n'
    )


def _provides_of(component: dict) -> dict:
    """Resolve a component's `provides` map → {logical: terraform_ref}."""
    mod = load_module(component["type"]) or {}
    ctx = {"id": component["id"]}
    return {k: _render(str(v), ctx) for k, v in (mod.get("provides") or {}).items()}


def compose(spec: dict) -> dict:
    """Render the architecture spec → {path: content} (production Terraform)."""
    name = spec.get("name", "app")
    env = spec.get("environment", "dev")
    region = spec.get("region", "us-east-1")
    components = spec.get("components", [])
    by_id = {c["id"]: c for c in components}

    data_blocks, blocks, outputs = [], [], []
    for c in components:
        mod = load_module(c["type"])
        if not mod:
            raise ValueError(f"No module in the knowledge base for type '{c['type']}'. "
                             f"Available: {list_modules()}")
        ctx = {"id": c["id"], "name": name, "region": region,
               **(mod.get("defaults") or {}), **(c.get("config") or {})}

        # Some modules need a supporting data source (e.g. an AMI lookup for an ASG).
        if mod.get("data"):
            data_blocks.append(_render(str(mod["data"]), ctx))

        # Resolve wired inputs (connected component's provides → this module's inputs).
        wired = {}
        for slot, other_id in (c.get("connect") or {}).items():
            wire = (mod.get("wires") or {}).get(slot)
            other = by_id.get(other_id)
            if not wire or not other:
                continue
            src = _provides_of(other)  # {logical: ref}
            wire_ctx = {f"source.{k}": v for k, v in src.items()}
            for wk, wtmpl in wire.items():
                wired[wk] = _render(str(wtmpl), wire_ctx).strip()

        if mod.get("raw"):
            # Raw-resource module (for services without a clean registry module). Wired values
            # become context placeholders the raw HCL can reference (e.g. {{vpc_id}}).
            blocks.append(_render(str(mod["raw"]), {**ctx, **wired}))
        else:
            lines = [f"  {k} = {_render(str(v), ctx)}" for k, v in (mod.get("config") or {}).items()]
            lines += [f"  {wk} = {wv}" for wk, wv in wired.items()]
            ver = f'  version = "{mod["version"]}"\n' if mod.get("version") else ""
            blocks.append(
                f'module "{c["id"]}" {{\n'
                f'  source  = "{mod["source"]}"\n'
                f'{ver}'
                + "\n".join(lines) + "\n}\n"
            )

        for k, v in (mod.get("outputs") or {}).items():
            outputs.append(f'output "{c["id"]}_{k}" {{\n  value = {_render(str(v), {"id": c["id"]})}\n}}\n')

    main_tf = "\n".join(data_blocks + blocks) + ("\n" + "\n".join(outputs) if outputs else "")
    base = f"terraform/environments/{env}"
    files = {
        f"{base}/main.tf": main_tf,
        f"{base}/providers.tf": _providers(region),
    }
    if spec.get("state_bucket"):
        files[f"{base}/backend.tf"] = _backend(spec["state_bucket"],
                                               spec.get("state_region", region), name, env)
    return files


def apply_spec(spec: dict) -> dict:
    env = spec.get("environment", "dev")
    return {
        "run_dir": f"terraform/environments/{env}",
        "name": f"{spec.get('name', 'app')}-{env}",
        "region": spec.get("region", "us-east-1"),
        "background": True,  # full architectures (RDS etc.) are slow → background apply
    }
