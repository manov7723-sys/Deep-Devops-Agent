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
CMD ["uvicorn","main:app"]
