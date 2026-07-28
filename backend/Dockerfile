# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Ensure the production server ("uvicorn") is present even if it's
# missing from requirements.txt — otherwise the CMD fails with
# "uvicorn: not found" at container start.
RUN pip install --no-cache-dir "uvicorn[standard]"
COPY . .
# Non-root runtime user.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser /app
USER appuser
EXPOSE 8000
# --host 0.0.0.0 is CRITICAL — uvicorn's default 127.0.0.1 accepts only
# in-container connections, so Kubernetes probes and Services can't reach
# the pod and the deployment CrashLoopBackOffs while logging the misleading
# "Uvicorn running on http://127.0.0.1:8000" right before it dies.
CMD ["uvicorn","main:app","--host","0.0.0.0","--port","8000"]
