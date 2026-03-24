FROM rust:1.94-slim-bookworm AS builder
WORKDIR /app

COPY Cargo.toml ./
COPY src ./src
COPY public ./public

RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/honki_memo ./honki_memo
COPY --from=builder /app/public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["./honki_memo"]
