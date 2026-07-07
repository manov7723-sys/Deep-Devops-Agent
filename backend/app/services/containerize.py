"""
Containerize an application repo: analyze the stack, generate a Dockerfile, and
generate a GitHub Actions workflow that builds the image and pushes it to AWS ECR
(via OIDC — no stored credentials).

Everything here is DETERMINISTIC so the agent's free-tier LLM never has to hand-write
fragile Dockerfiles or YAML — it just calls these and pushes the result to the repo.
"""
import base64
import json
import os
from typing import Optional

import httpx

GITHUB_API = "https://api.github.com"


# ── GitHub repo reading ──────────────────────────────────────────────────────
def _gh_headers() -> dict:
    token = os.getenv("GITHUB_TOKEN", "")
    h = {"Accept": "application/vnd.github+json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _get_default_branch(owner: str, repo: str) -> str:
    r = httpx.get(f"{GITHUB_API}/repos/{owner}/{repo}", headers=_gh_headers(), timeout=20)
    r.raise_for_status()
    return r.json().get("default_branch", "main")


def _list_tree(owner: str, repo: str, branch: str) -> list:
    """Return a flat list of file paths in the repo (recursive)."""
    r = httpx.get(
        f"{GITHUB_API}/repos/{owner}/{repo}/git/trees/{branch}",
        params={"recursive": "1"}, headers=_gh_headers(), timeout=30,
    )
    r.raise_for_status()
    return [n["path"] for n in r.json().get("tree", []) if n.get("type") == "blob"]


def gh_put_file(owner: str, repo: str, path: str, content: str,
                message: str, branch: str = "") -> dict:
    """Create or update a file in the repo directly (backend-side) so large file contents
    never have to round-trip through the LLM. Handles the existing-file sha automatically."""
    url = f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}"
    headers = _gh_headers()
    params = {"ref": branch} if branch else {}
    g = httpx.get(url, headers=headers, params=params, timeout=20)
    sha = g.json().get("sha") if g.status_code == 200 else None
    body = {"message": message, "content": base64.b64encode(content.encode()).decode()}
    if branch:
        body["branch"] = branch
    if sha:
        body["sha"] = sha
    r = httpx.put(url, headers=headers, json=body, timeout=30)
    r.raise_for_status()
    return {"success": True, "html_url": (r.json().get("content") or {}).get("html_url", ""), "path": path}


def gh_put_tree(owner: str, repo: str, files: dict, message: str, branch: str = "") -> dict:
    """Push MANY files to the repo in a SINGLE commit via the Git Data API. files = {path: content}."""
    headers = _gh_headers()
    base = f"{GITHUB_API}/repos/{owner}/{repo}"
    branch = branch or _get_default_branch(owner, repo)

    ref = httpx.get(f"{base}/git/ref/heads/{branch}", headers=headers, timeout=20)
    ref.raise_for_status()
    latest_sha = ref.json()["object"]["sha"]
    base_tree = httpx.get(f"{base}/git/commits/{latest_sha}", headers=headers, timeout=20).json()["tree"]["sha"]

    tree_items = [{"path": p, "mode": "100644", "type": "blob", "content": c} for p, c in files.items()]
    new_tree = httpx.post(f"{base}/git/trees", headers=headers,
                          json={"base_tree": base_tree, "tree": tree_items}, timeout=60)
    new_tree.raise_for_status()

    commit = httpx.post(f"{base}/git/commits", headers=headers,
                        json={"message": message, "tree": new_tree.json()["sha"], "parents": [latest_sha]},
                        timeout=30)
    commit.raise_for_status()
    new_commit_sha = commit.json()["sha"]

    patch = httpx.patch(f"{base}/git/refs/heads/{branch}", headers=headers,
                        json={"sha": new_commit_sha}, timeout=30)
    patch.raise_for_status()
    return {"success": True, "branch": branch, "commit_sha": new_commit_sha,
            "file_count": len(files), "tree_url": f"https://github.com/{owner}/{repo}/tree/{branch}"}


def _get_file(owner: str, repo: str, path: str, branch: str) -> Optional[str]:
    r = httpx.get(
        f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}",
        params={"ref": branch}, headers=_gh_headers(), timeout=20,
    )
    if r.status_code != 200:
        return None
    data = r.json()
    if data.get("encoding") == "base64" and data.get("content"):
        try:
            return base64.b64decode(data["content"]).decode("utf-8", errors="replace")
        except Exception:
            return None
    return None


# ── Stack detection ──────────────────────────────────────────────────────────
# Only read the handful of manifest files needed to identify the stack — never the
# whole repo (keeps token use and latency low).
_MANIFESTS = [
    "package.json", "requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "manage.py",
    "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
    "Gemfile", "composer.json", "Cargo.toml", "Dockerfile",
]

# Extension → language, used as a fallback when no manifest is found.
_EXT_LANG = {
    "py": "python", "js": "node", "jsx": "node", "ts": "node", "tsx": "node",
    "mjs": "node", "go": "go", "java": "java", "kt": "java",
}


def analyze_repo(owner: str, repo: str, branch: str = "") -> dict:
    """Detect the application's stack from its manifest files (searched anywhere in the
    repo, not just the root). Returns a profile dict consumed by build_dockerfile()."""
    try:
        branch = branch or _get_default_branch(owner, repo)
        tree = _list_tree(owner, repo, branch)

        # Find the SHALLOWEST occurrence of each manifest (handles apps in subfolders).
        def shallowest(basename):
            cands = [p for p in tree if p.rsplit("/", 1)[-1] == basename]
            return min(cands, key=lambda p: p.count("/")) if cands else None

        files, paths = {}, {}
        for m in _MANIFESTS:
            p = shallowest(m)
            if p:
                paths[m] = p
                files[m] = _get_file(owner, repo, p, branch)

        profile = _detect_stack(files, tree)
        # The app directory = folder of the manifest we keyed on (root if at top level).
        primary = paths.get({
            "node": "package.json", "python": "requirements.txt", "go": "go.mod",
            "java": "pom.xml",
        }.get(profile["language"], ""), "")
        app_dir = primary.rsplit("/", 1)[0] if primary and "/" in primary else ""
        profile.update({
            "owner": owner, "repo": repo, "branch": branch,
            "has_dockerfile": "Dockerfile" in files,
            "app_dir": app_dir,
            "file_count": len(tree),
        })
        return {"success": True, "profile": profile}
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        hint = "check the repo name and that GITHUB_TOKEN can access it" if code in (404, 403) else ""
        return {"success": False, "error": f"GitHub API {code}. {hint}".strip()}
    except Exception as e:
        return {"success": False, "error": str(e)}


# A "service" is a directory that holds one of these primary manifests. A monorepo with
# frontend/ + backend/ yields two services, each containerized independently.
_PRIMARY_MANIFESTS = [
    "package.json", "requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "manage.py",
    "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
]


def analyze_services(owner: str, repo: str, branch: str = "") -> dict:
    """Detect ALL deployable services in the repo (each manifest-bearing directory).
    Returns {services: [{name, dir, profile}, ...]} — one entry per service."""
    try:
        branch = branch or _get_default_branch(owner, repo)
        tree = _list_tree(owner, repo, branch)

        dirs = {}  # directory -> list of manifest paths in it
        for p in tree:
            base = p.rsplit("/", 1)[-1]
            if base in _PRIMARY_MANIFESTS:
                d = p.rsplit("/", 1)[0] if "/" in p else ""
                dirs.setdefault(d, []).append(p)

        # If sub-services exist, ignore a root manifest (it's usually a workspace root).
        if len(dirs) > 1 and "" in dirs:
            del dirs[""]

        services = []
        if not dirs:
            prof = _detect_from_extensions(tree)
            if prof["language"] != "unknown":
                prof["branch"] = branch
                services.append({"name": "app", "dir": "", "profile": prof})
        else:
            for d, manifest_paths in sorted(dirs.items()):
                files = {mp.rsplit("/", 1)[-1]: _get_file(owner, repo, mp, branch) for mp in manifest_paths}
                subtree = [p for p in tree if (p.startswith(d + "/") if d else True)]
                prof = _detect_stack(files, subtree)
                if prof["language"] == "unknown":
                    continue
                prof["branch"] = branch
                services.append({"name": (d.rsplit("/", 1)[-1] if d else "app"), "dir": d, "profile": prof})

        return {"success": True, "branch": branch, "services": services, "tree_count": len(tree)}
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        hint = "check the repo name and that GITHUB_TOKEN can access it" if code in (404, 403) else ""
        return {"success": False, "error": f"GitHub API {code}. {hint}".strip()}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _detect_from_extensions(tree: list) -> dict:
    """Fallback: infer the language from the most common source-file extension."""
    counts = {}
    for p in tree:
        ext = p.rsplit(".", 1)[-1].lower() if "." in p else ""
        lang = _EXT_LANG.get(ext)
        if lang:
            counts[lang] = counts.get(lang, 0) + 1
    if not counts:
        return {"language": "unknown", "package_manager": "", "version": "",
                "framework": "", "has_build": False, "start_cmd": "", "port": 8080}
    lang = max(counts, key=counts.get)
    base = {"node": {"language": "node", "package_manager": "npm", "version": "20",
                     "framework": "", "has_build": False, "start_cmd": "node index.js", "port": 3000},
            "python": {"language": "python", "package_manager": "pip", "version": "3.12",
                       "framework": "", "has_build": False, "start_cmd": "python app.py", "port": 8000},
            "go": {"language": "go", "package_manager": "go", "version": "1.22",
                   "framework": "", "has_build": True, "start_cmd": "./app", "port": 8080},
            "java": {"language": "java", "package_manager": "maven", "version": "21",
                     "framework": "", "has_build": True, "start_cmd": "java -jar app.jar", "port": 8080}}
    return base[lang]


def _detect_stack(files: dict, tree: list = None) -> dict:
    """Map manifest files → a build profile (language, commands, port…).
    Falls back to file-extension detection when no manifest is recognized."""
    tree = tree or []
    # Node.js
    if "package.json" in files and files["package.json"]:
        try:
            pkg = json.loads(files["package.json"])
        except Exception:
            pkg = {}
        scripts = pkg.get("scripts", {}) or {}
        deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
        node_ver = ((pkg.get("engines") or {}).get("node") or "20").lstrip("^>=~ ").split(".")[0] or "20"
        framework = next((f for f in ("next", "nuxt", "express", "nestjs", "@nestjs/core", "react", "vite")
                          if f in deps), "")
        port = 3000 if framework in ("next", "nuxt", "react", "vite", "express") else 3000
        return {
            "language": "node", "package_manager": "npm",
            "version": node_ver, "framework": framework,
            "has_build": "build" in scripts,
            "start_cmd": "npm start" if "start" in scripts else "node index.js",
            "port": port,
        }
    # Python (requirements/pyproject/Pipfile, or a Django/setup project)
    if any(k in files for k in ("requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "manage.py")):
        blob = " ".join(v or "" for v in files.values()).lower()
        has_manage = "manage.py" in files
        if "fastapi" in blob:
            framework, start, port = "fastapi", "uvicorn main:app --host 0.0.0.0 --port 8000", 8000
        elif "django" in blob or has_manage:
            framework, start, port = "django", "gunicorn --bind 0.0.0.0:8000 app.wsgi:application", 8000
        elif "flask" in blob:
            framework, start, port = "flask", "gunicorn --bind 0.0.0.0:8000 app:app", 8000
        else:
            framework, start, port = "", "python app.py", 8000
        return {
            "language": "python", "package_manager": "pip",
            "version": "3.12", "framework": framework,
            "has_build": False, "start_cmd": start, "port": port,
        }
    # Go
    if "go.mod" in files:
        return {
            "language": "go", "package_manager": "go",
            "version": "1.22", "framework": "",
            "has_build": True, "start_cmd": "./app", "port": 8080,
        }
    # Java
    if "pom.xml" in files or "build.gradle" in files or "build.gradle.kts" in files:
        builder = "maven" if "pom.xml" in files else "gradle"
        return {
            "language": "java", "package_manager": builder,
            "version": "21", "framework": "",
            "has_build": True, "start_cmd": "java -jar app.jar", "port": 8080,
        }
    # No recognized manifest → infer from the dominant source-file extension.
    return _detect_from_extensions(tree)


# ── Dockerfile generation ────────────────────────────────────────────────────
def build_dockerfile(profile: dict) -> dict:
    """Return a Dockerfile + .dockerignore string for the detected stack."""
    lang = profile.get("language", "unknown")
    port = int(profile.get("port", 8080))
    ver = profile.get("version", "")

    if lang == "node":
        build_step = "RUN npm run build\n" if profile.get("has_build") else ""
        start = profile.get("start_cmd", "npm start")
        cmd = json.dumps(start.split())
        dockerfile = (
            f"# syntax=docker/dockerfile:1\n"
            f"FROM node:{ver}-alpine AS build\n"
            f"WORKDIR /app\n"
            f"COPY package*.json ./\n"
            f"RUN npm ci || npm install\n"
            f"COPY . .\n"
            f"{build_step}\n"
            f"FROM node:{ver}-alpine\n"
            f"WORKDIR /app\n"
            f"ENV NODE_ENV=production\n"
            f"COPY --from=build /app .\n"
            f"EXPOSE {port}\n"
            f"CMD {cmd}\n"
        )
    elif lang == "python":
        start = profile.get("start_cmd", "python app.py")
        cmd = json.dumps(start.split())
        dockerfile = (
            f"# syntax=docker/dockerfile:1\n"
            f"FROM python:{ver}-slim\n"
            f"WORKDIR /app\n"
            f"ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1\n"
            f"COPY . .\n"
            f"RUN if [ -f requirements.txt ]; then pip install -r requirements.txt; "
            f"elif [ -f pyproject.toml ] || [ -f setup.py ]; then pip install .; fi\n"
            f"EXPOSE {port}\n"
            f"CMD {cmd}\n"
        )
    elif lang == "go":
        dockerfile = (
            f"# syntax=docker/dockerfile:1\n"
            f"FROM golang:{ver}-alpine AS build\n"
            f"WORKDIR /src\n"
            f"COPY go.* ./\n"
            f"RUN go mod download\n"
            f"COPY . .\n"
            f"RUN CGO_ENABLED=0 go build -o /app ./...\n\n"
            f"FROM gcr.io/distroless/static-debian12\n"
            f"COPY --from=build /app /app\n"
            f"EXPOSE {port}\n"
            f'CMD ["/app"]\n'
        )
    elif lang == "java":
        if profile.get("package_manager") == "gradle":
            build = "RUN ./gradlew build -x test\nRUN cp build/libs/*.jar app.jar"
        else:
            build = "RUN mvn -q -DskipTests package\nRUN cp target/*.jar app.jar"
        dockerfile = (
            f"# syntax=docker/dockerfile:1\n"
            f"FROM eclipse-temurin:{ver}-jdk AS build\n"
            f"WORKDIR /app\n"
            f"COPY . .\n"
            f"{build}\n\n"
            f"FROM eclipse-temurin:{ver}-jre\n"
            f"WORKDIR /app\n"
            f"COPY --from=build /app/app.jar app.jar\n"
            f"EXPOSE {port}\n"
            f'CMD ["java", "-jar", "app.jar"]\n'
        )
    else:
        return {"success": False,
                "error": f"Unsupported/undetected stack '{lang}'. Supported: node, python, go, java."}

    dockerignore = "\n".join([
        ".git", ".github", "node_modules", "dist", "build", "target",
        "*.log", ".env", ".env.*", "__pycache__", "*.pyc", ".venv", "venv",
        ".DS_Store", "Dockerfile", ".dockerignore",
    ]) + "\n"
    return {"success": True, "dockerfile": dockerfile, "dockerignore": dockerignore,
            "language": lang, "port": port}


# ── GitHub Actions workflow (build → push to ECR via OIDC) ────────────────────
def build_ecr_workflow(ecr_repo: str, role_arn: str, region: str = "us-east-1",
                       branch: str = "main", dockerfile_path: str = "Dockerfile",
                       build_context: str = ".") -> str:
    """Deterministic workflow YAML: build the Docker image and push it to ECR using
    GitHub OIDC (role-to-assume) — no AWS keys stored in the repo."""
    return f"""name: Build and push to ECR

on:
  push:
    branches: [ {branch} ]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: {region}
  ECR_REPOSITORY: {ecr_repo}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: {role_arn}
          aws-region: ${{{{ env.AWS_REGION }}}}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push image
        env:
          REGISTRY: ${{{{ steps.login-ecr.outputs.registry }}}}
          IMAGE_TAG: ${{{{ github.sha }}}}
        run: |
          docker build -f {dockerfile_path} -t "$REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" -t "$REGISTRY/$ECR_REPOSITORY:latest" {build_context}
          docker push "$REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
          docker push "$REGISTRY/$ECR_REPOSITORY:latest"
"""


def build_ecr_workflow_multi(services: list, role_arn: str, region: str = "us-east-1",
                             branch: str = "main") -> str:
    """Workflow that builds + pushes MULTIPLE services (monorepo) to ECR via a matrix — one
    image per service. Each service dict needs {ecr, dir, dockerfile}."""
    include = "\n".join(
        f'          - {{ ecr: "{s["ecr"]}", dir: "{s["dir"] or "."}", dockerfile: "{s["dockerfile"]}" }}'
        for s in services
    )
    return f"""name: Build and push to ECR

on:
  push:
    branches: [ {branch} ]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: {region}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
{include}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: {role_arn}
          aws-region: ${{{{ env.AWS_REGION }}}}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push ${{{{ matrix.ecr }}}}
        env:
          REGISTRY: ${{{{ steps.login-ecr.outputs.registry }}}}
          IMAGE_TAG: ${{{{ github.sha }}}}
        run: |
          docker build -f ${{{{ matrix.dockerfile }}}} -t "$REGISTRY/${{{{ matrix.ecr }}}}:$IMAGE_TAG" -t "$REGISTRY/${{{{ matrix.ecr }}}}:latest" ${{{{ matrix.dir }}}}
          docker push "$REGISTRY/${{{{ matrix.ecr }}}}:$IMAGE_TAG"
          docker push "$REGISTRY/${{{{ matrix.ecr }}}}:latest"
"""
