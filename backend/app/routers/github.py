import os
import httpx
from fastapi import APIRouter
from fastapi.responses import RedirectResponse
from urllib.parse import quote


def get_router() -> APIRouter:
    router = APIRouter()

    @router.get("/auth/github")
    def github_login(prompt: str = ""):
        client_id    = os.getenv("GITHUB_CLIENT_ID", "")
        redirect_uri = os.getenv("GITHUB_REDIRECT_URI", "http://localhost:8000/github/callback")
        scope        = "repo workflow read:org"
        oauth_url    = f"https://github.com/login/oauth/authorize?client_id={client_id}&redirect_uri={redirect_uri}&scope={scope}"

        if prompt == "login":
            # Force the GitHub login page (like "Sign in with GitHub" / account picker).
            # We redirect to GitHub's logout first, which clears the session,
            # then redirect back to the OAuth authorize URL so the user sees the login page.
            logout_url = f"https://github.com/logout?return_to={quote(oauth_url, safe='')}"
            print(f"DEBUG Prompt=login: redirecting through logout → {logout_url}")
            return RedirectResponse(logout_url)

        print(f"DEBUG Redirecting to: {oauth_url}")
        return RedirectResponse(oauth_url)

    @router.get("/github/callback")
    def github_callback(code: str):
        client_id     = os.getenv("GITHUB_CLIENT_ID", "")
        client_secret = os.getenv("GITHUB_CLIENT_SECRET", "")

        # Exchange code for token
        resp = httpx.post(
            "https://github.com/login/oauth/access_token",
            json={"client_id": client_id, "client_secret": client_secret, "code": code},
            headers={"Accept": "application/json"},
        )
        data  = resp.json()
        token = data.get("access_token", "")

        if token:
            # Get GitHub username
            user_resp = httpx.get(
                "https://api.github.com/user",
                headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
            )
            username = user_resp.json().get("login", "")

            os.environ["GITHUB_TOKEN"] = token
            os.environ["GITHUB_OWNER"] = username
            env_path = os.path.join(os.path.dirname(__file__), "../.env")
            _update_env_file(env_path, "GITHUB_TOKEN", token)
            _update_env_file(env_path, "GITHUB_OWNER", username)

            return RedirectResponse(f"http://localhost:3000?github_connected=true&owner={username}")
        else:
            print(f"DEBUG GitHub callback error: {data}")
            return RedirectResponse("http://localhost:3000?github_connected=error")

    @router.get("/github/repos")
    def get_repos():
        token = os.getenv("GITHUB_TOKEN", "")
        if not token:
            return {"repos": []}
        try:
            resp = httpx.get(
                "https://api.github.com/user/repos?per_page=100&sort=updated",
                headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
            )
            repos = resp.json()
            return {"repos": [{"name": r["name"], "full_name": r["full_name"], "private": r["private"]} for r in repos if isinstance(r, dict)]}
        except Exception as e:
            return {"repos": [], "error": str(e)}

    @router.get("/github/branches")
    def get_branches(repo: str):
        token = os.getenv("GITHUB_TOKEN", "")
        owner = os.getenv("GITHUB_OWNER", "")
        if not token or not owner:
            return {"branches": []}
        try:
            resp = httpx.get(
                f"https://api.github.com/repos/{owner}/{repo}/branches",
                headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
            )
            branches = resp.json()
            return {"branches": [b["name"] for b in branches if isinstance(b, dict)]}
        except Exception as e:
            return {"branches": [], "error": str(e)}

    return router


def _update_env_file(path: str, key: str, value: str):
    try:
        with open(path, "r") as f:
            lines = f.readlines()
        updated = False
        for i, line in enumerate(lines):
            if line.startswith(f"{key}="):
                lines[i] = f"{key}={value}\n"
                updated = True
                break
        if not updated:
            lines.append(f"{key}={value}\n")
        with open(path, "w") as f:
            f.writelines(lines)
    except Exception:
        pass