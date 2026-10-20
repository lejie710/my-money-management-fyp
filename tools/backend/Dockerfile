# Build from the repository root. Building downloads these upstream images/packages.
FROM node:24.22.0-bookworm-slim AS node-runtime
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY tools/backend/requirements-python312.txt /app/tools/backend/requirements-python312.txt
RUN python -m pip install --no-cache-dir --only-binary=:all: -r /app/tools/backend/requirements-python312.txt
COPY tools/backend /app/tools/backend
COPY tools/forecast /app/tools/forecast
COPY scripts/companion /app/scripts/companion
COPY src /app/src
COPY LICENSE /app/LICENSE
RUN useradd --uid 10001 --create-home app && mkdir /data && chown app:app /data
USER app
ENV LISTEN_HOST=0.0.0.0 PORT=8080 BACKEND_DATA_DIR=/data PROPHET_PYTHON=/usr/local/bin/python
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "tools/backend/main.cjs"]
