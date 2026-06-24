# ─────────────────────────────────────────────────────────────────────────────
# DevOps Agent — Backend Dockerfile
# Installs Python deps + uv/uvx (for Prometheus / Grafana MCP servers)
# + Node.js / npx (for GitHub + Kubernetes MCP servers)
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim

# ── System deps ───────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gnupg \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 LTS (for npx-based MCP servers: GitHub, Kubernetes) ────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── uv / uvx (for uvx-based MCP servers: Prometheus, Grafana) ────────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# ── Python application ────────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
