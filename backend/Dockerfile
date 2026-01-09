FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git openssh-client \
    build-essential pkg-config \
    python3 python3-pip python3-venv \
    openjdk-17-jdk \
    nodejs npm \
    bash tini \
  && rm -rf /var/lib/apt/lists/*

# Create an unprivileged user
RUN useradd -m -u 1000 -s /bin/bash sandbox \
  && mkdir -p /workspace \
  && chown -R sandbox:sandbox /workspace

WORKDIR /workspace
USER sandbox

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "-l"]
