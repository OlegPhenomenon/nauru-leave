FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.98.0-slim-bookworm AS backend
WORKDIR /app/backend
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 nauru && useradd --uid 10001 --gid 10001 --no-create-home nauru \
    && mkdir -p /var/lib/nauru-leave && chown 10001:10001 /var/lib/nauru-leave
COPY --from=backend /app/backend/target/release/nauru-leave /usr/local/bin/nauru-leave
USER 10001:10001
VOLUME ["/var/lib/nauru-leave"]
ENV NLD_BIND=0.0.0.0:8080 NLD_DATA_DIR=/var/lib/nauru-leave
EXPOSE 8080
ENTRYPOINT ["nauru-leave"]
CMD ["serve"]
