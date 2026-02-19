FROM python:3.12-slim
RUN apt-get update && apt-get install -y git curl jq && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir google-genai
WORKDIR /workspace
COPY entrypoint.sh /entrypoint.sh
COPY prompt.md /agent/prompt.md
COPY generate.py /agent/generate.py
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
