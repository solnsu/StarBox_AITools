# StarBox

[English](./README.md) | [简体中文](./README.zh-CN.md)

StarBox is a locally run desktop application for managing ChatGPT/Codex accounts and DeepSeek API keys on Windows and macOS.

Use StarBox to manage credentials, inspect quotas and balances, browse available models, track requests and token usage, route model calls through local gateways, apply DeepSeek models to Codex or DeepSeek Harness, and create images. Credentials, usage records, and generated content are stored locally on your device.

## User Guide

[View the StarBox User Guide](https://rcnavw2rdmby.feishu.cn/wiki/MkwFwO2bjiJQF6kJ9tZcaNJanud?from=from_copylink)

## Features

- Manage multiple ChatGPT/Codex credentials, including browser login and imported credential files
- Inspect Codex account health, quotas, reset times, plans, and available models
- Store multiple DeepSeek API keys locally with encrypted persistence
- Inspect DeepSeek balances and model catalogs
- Route Codex Responses API and DeepSeek Responses/Chat Completions requests through local endpoints
- Apply a selected DeepSeek model to Codex or DeepSeek Harness
- Record request status, latency, token usage, and estimated cost by provider
- Create and manage image-generation sessions with connected ChatGPT/Codex accounts
- Switch between English and Simplified Chinese

## Interface Preview

### ChatGPT account

![ChatGPT account overview](./docs/images/chatgpt-account.png)

### DeepSeek account

![DeepSeek account overview](./docs/images/deepseek-account.png)

### Request logs

![Request logs](./docs/images/request-logs.png)

### Image creation

![Image creation workspace](./docs/images/image-creation.png)

## Download

[Download the latest version of StarBox](https://github.com/solnsu/StarBox_AITools/releases/latest)

- Windows: 64-bit systems
- macOS: Apple Silicon and Intel processors

## Local Development

Node.js 22 or later is required.

```bash
npm ci
npm test
npm run build
npm run dev
```

The web development server runs at `http://127.0.0.1:5173` and forwards API requests to the local service at `http://127.0.0.1:4312`.

Desktop development and packaging:

```bash
npm run dev:desktop
npm run desktop:pack
npm run desktop:dist
```

Build Windows installers on Windows and macOS installers on macOS. Packaged applications include their runtime; end users do not need Node.js.

## Local Data and Security

- Desktop data is stored under `~/Library/Application Support/StarBox/` on macOS and `%APPDATA%\\StarBox\\` on Windows.
- Imported credentials and DeepSeek API keys are encrypted at rest with a local AES-256-GCM key.
- The service listens only on `127.0.0.1`.
- Credential secrets are not returned by list or monitoring APIs and are not written to request logs.
- The local API key can be rotated from the application.

Do not commit generated credentials, API keys, the local database, or the local master key.

## Open Source

StarBox source code is licensed under the [Apache License 2.0](./LICENSE). The license permits use, modification, distribution, and commercial use, subject to its terms.

The StarBox name, logo, and official release identifiers may not be used to imply endorsement or official status. See [NOTICE](./NOTICE) for attribution and branding information and [CONTRIBUTING.md](./.github/CONTRIBUTING.md) to contribute.

## Acknowledgements

StarBox is built with the help of excellent open-source projects and technologies. See [Acknowledgements](./docs/ACKNOWLEDGEMENTS.md) and [Third-Party Notices](./docs/legal/THIRD_PARTY_NOTICES.md) for details.

Thanks to the [Linux.do](https://linux.do/) community for promoting the project and providing valuable feedback and support.

## Legal, Privacy, and Security

- [End User License Agreement (Bilingual)](./docs/legal/EULA.txt)
- [End User License Agreement (English)](./docs/legal/EULA_EN.txt)
- [Privacy Policy](./docs/legal/PRIVACY.md)
- [Security Policy and Vulnerability Reporting](./.github/SECURITY.md)

StarBox is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI or DeepSeek. OpenAI, ChatGPT, Codex, and DeepSeek are trademarks of their respective owners.

Project website: https://github.com/solnsu/StarBox_AITools
