"""
Run `terraform apply` in the BACKGROUND (for slow infra like EKS, ~15 min) so it never
blocks the chat request. Status is tracked in-process and polled via get_status(job_id).
"""
import os
import subprocess
import tempfile
import threading
import uuid

# job_id -> {status, name, output, region, returncode}
_JOBS: dict = {}

# macOS gives GUI/IDE-launched processes a minimal PATH (/usr/bin:/bin:…) that omits Homebrew,
# so a bare `terraform` (installed at /opt/homebrew/bin or /usr/local/bin) isn't found. Make sure
# the standard install locations are on PATH for every terraform subprocess we spawn.
_TF_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]


def _with_tf_path(env: dict) -> dict:
    env = dict(env)
    parts = (env.get("PATH") or os.environ.get("PATH", "")).split(os.pathsep)
    parts += [d for d in _TF_BIN_DIRS if d not in parts]
    env["PATH"] = os.pathsep.join(p for p in parts if p)
    return env


def _backend_snippet(state_key: str, region: str) -> str:
    bucket = os.getenv("TF_STATE_BUCKET", "")
    if not bucket:
        return ""
    s3_region = os.getenv("TF_STATE_REGION", region)
    return (
        f'  backend "s3" {{\n'
        f'    bucket = "{bucket}"\n'
        f'    key    = "{state_key}/terraform.tfstate"\n'
        f'    region = "{s3_region}"\n'
        f'  }}\n'
    )


def _inject_backend(tf: str, snippet: str) -> str:
    if not snippet:
        return tf
    if "terraform {" in tf:
        return tf.replace("terraform {", "terraform {\n" + snippet, 1)
    return "terraform {\n" + snippet + "}\n\n" + tf


def _run(job_id: str, tf: str, creds: dict, region: str):
    job = _JOBS[job_id]
    try:
        env = _with_tf_path({
            **os.environ,
            "AWS_ACCESS_KEY_ID": creds.get("aws_access_key_id", ""),
            "AWS_SECRET_ACCESS_KEY": creds.get("aws_secret_access_key", ""),
            "AWS_DEFAULT_REGION": region,
        })
        if creds.get("aws_session_token"):
            env["AWS_SESSION_TOKEN"] = creds["aws_session_token"]

        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "main.tf"), "w") as f:
                f.write(tf)

            job["status"] = "initializing"
            init = subprocess.run(["terraform", "init", "-no-color"], cwd=d, env=env,
                                  capture_output=True, text=True, timeout=300)
            job["output"] += init.stdout + init.stderr
            if init.returncode != 0:
                job["status"] = "failed"
                job["returncode"] = init.returncode
                return

            job["status"] = "applying"
            apply = subprocess.run(["terraform", "apply", "-auto-approve", "-no-color"], cwd=d, env=env,
                                   capture_output=True, text=True, timeout=1800)
            job["output"] += apply.stdout + apply.stderr
            job["returncode"] = apply.returncode
            job["status"] = "succeeded" if apply.returncode == 0 else "failed"
    except FileNotFoundError:
        job["status"] = "failed"
        job["output"] += "\n[error] terraform binary not found on the server."
    except subprocess.TimeoutExpired:
        job["status"] = "failed"
        job["output"] += "\n[error] terraform timed out (30 min)."
    except Exception as e:  # noqa: BLE001
        job["status"] = "failed"
        job["output"] += f"\n[error] {e}"


def fmt_files(files: dict) -> dict:
    """Run `terraform fmt` over a {path: content} tree so the HCL pushed to GitHub is clean
    (aligned `=`, consistent indentation). Falls back to the original files if terraform is absent."""
    try:
        with tempfile.TemporaryDirectory() as d:
            for path, content in files.items():
                full = os.path.join(d, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w") as f:
                    f.write(content)
            subprocess.run(["terraform", "fmt", "-recursive", d],
                           capture_output=True, text=True, timeout=60,
                           env=_with_tf_path(dict(os.environ)))
            out = {}
            for path in files:
                with open(os.path.join(d, path)) as f:
                    out[path] = f.read()
            return out
    except Exception:
        return files


def _creds_env(creds: dict, region: str) -> dict:
    env = _with_tf_path({**os.environ, "AWS_DEFAULT_REGION": region, "AWS_REGION": region})
    for k in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN"):
        if not env.get(k):
            env.pop(k, None)
    if creds.get("aws_access_key_id"):
        env["AWS_ACCESS_KEY_ID"] = creds["aws_access_key_id"]
        env["AWS_SECRET_ACCESS_KEY"] = creds["aws_secret_access_key"]
        if creds.get("aws_session_token"):
            env["AWS_SESSION_TOKEN"] = creds["aws_session_token"]
    return env


def apply_tree_sync(files: dict, run_subdir: str, creds: dict, region: str) -> dict:
    """Apply a Terraform file tree synchronously (for FAST resources like S3/EC2). Returns
    {success, output}. Blocks until terraform finishes."""
    env = _creds_env(creds, region)
    out = []
    try:
        with tempfile.TemporaryDirectory() as d:
            for path, content in files.items():
                full = os.path.join(d, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w") as f:
                    f.write(content)
            run_dir = os.path.join(d, run_subdir)
            init = subprocess.run(["terraform", "init", "-no-color"], cwd=run_dir, env=env,
                                  capture_output=True, text=True, timeout=600)
            out.append(init.stdout + init.stderr)
            if init.returncode != 0:
                return {"success": False, "output": "".join(out)[-2500:]}
            apply = subprocess.run(["terraform", "apply", "-auto-approve", "-no-color"], cwd=run_dir, env=env,
                                   capture_output=True, text=True, timeout=600)
            out.append(apply.stdout + apply.stderr)
            return {"success": apply.returncode == 0, "output": "".join(out)[-2500:]}
    except FileNotFoundError:
        return {"success": False, "error": "terraform binary not found on the server."}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "terraform timed out (10 min)."}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e)}


def _new_stages() -> list:
    """The Jenkins-style pipeline shown in the UI: init → plan → apply."""
    return [
        {"name": "init", "status": "pending", "output": ""},
        {"name": "plan", "status": "pending", "output": ""},
        {"name": "apply", "status": "pending", "output": ""},
    ]


def _run_tree(job_id: str, files: dict, run_subdir: str, creds: dict, region: str):
    """Write a whole Terraform file tree to a temp dir and run init → plan → apply from
    run_subdir (e.g. environments/dev), tracking each stage's status for the UI stage view."""
    job = _JOBS[job_id]
    stages = {s["name"]: s for s in job["stages"]}

    def run_stage(name: str, cmd: list, run_dir: str, env: dict, timeout: int, running_status: str) -> int:
        st = stages[name]
        st["status"] = "running"
        job["status"] = running_status
        proc = subprocess.run(cmd, cwd=run_dir, env=env, capture_output=True, text=True, timeout=timeout)
        st["output"] = (proc.stdout + proc.stderr)[-6000:]
        job["output"] += proc.stdout + proc.stderr
        st["status"] = "succeeded" if proc.returncode == 0 else "failed"
        return proc.returncode

    try:
        env = _with_tf_path({
            **os.environ,
            "AWS_ACCESS_KEY_ID": creds.get("aws_access_key_id", ""),
            "AWS_SECRET_ACCESS_KEY": creds.get("aws_secret_access_key", ""),
            "AWS_DEFAULT_REGION": region,
        })
        if creds.get("aws_session_token"):
            env["AWS_SESSION_TOKEN"] = creds["aws_session_token"]

        with tempfile.TemporaryDirectory() as d:
            for path, content in files.items():
                full = os.path.join(d, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w") as f:
                    f.write(content)
            run_dir = os.path.join(d, run_subdir)

            if run_stage("init", ["terraform", "init", "-no-color"], run_dir, env, 600, "initializing") != 0:
                job["status"] = "failed"
                job["returncode"] = 1
                return
            if run_stage("plan", ["terraform", "plan", "-no-color", "-input=false"], run_dir, env, 600, "planning") != 0:
                job["status"] = "failed"
                job["returncode"] = 1
                return
            rc = run_stage("apply", ["terraform", "apply", "-auto-approve", "-no-color"], run_dir, env, 1800, "applying")
            job["returncode"] = rc
            job["status"] = "succeeded" if rc == 0 else "failed"
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception) as e:  # noqa: BLE001
        msg = ("terraform binary not found on the server." if isinstance(e, FileNotFoundError)
               else "terraform timed out." if isinstance(e, subprocess.TimeoutExpired) else str(e))
        # Mark whichever stage was running as failed.
        for st in job["stages"]:
            if st["status"] == "running":
                st["status"] = "failed"
                st["output"] += f"\n[error] {msg}"
        job["status"] = "failed"
        job["output"] += f"\n[error] {msg}"


def start_apply_tree(files: dict, run_subdir: str, creds: dict, region: str, name: str) -> str:
    """Launch a background apply over a multi-file Terraform tree; returns a job_id."""
    job_id = uuid.uuid4().hex[:8]
    _JOBS[job_id] = {"status": "queued", "name": name, "output": "", "region": region,
                     "returncode": None, "stages": _new_stages()}
    threading.Thread(target=_run_tree, args=(job_id, files, run_subdir, creds, region), daemon=True).start()
    return job_id


def start_apply(tf: str, creds: dict, region: str, name: str, state_key: str) -> str:
    """Launch a background terraform apply; returns a job_id for polling."""
    job_id = uuid.uuid4().hex[:8]
    tf2 = _inject_backend(tf, _backend_snippet(state_key, region))
    _JOBS[job_id] = {"status": "queued", "name": name, "output": "", "region": region, "returncode": None}
    threading.Thread(target=_run, args=(job_id, tf2, creds, region), daemon=True).start()
    return job_id


def get_status(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if not job:
        return {"found": False, "error": f"No job '{job_id}'."}
    return {
        "found": True,
        "job_id": job_id,
        "name": job["name"],
        "status": job["status"],          # queued | initializing | planning | applying | succeeded | failed
        "stages": job.get("stages", []),  # [{name, status, output}] for the UI stage view
        "output_tail": job["output"][-2000:],
    }
