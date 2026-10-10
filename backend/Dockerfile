# CallGuard backend (Django REST API). Build context is this folder.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DB_PATH=/data/db.sqlite3

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x docker-entrypoint.sh && mkdir -p /data

EXPOSE 8000
VOLUME /data

ENTRYPOINT ["./docker-entrypoint.sh"]
