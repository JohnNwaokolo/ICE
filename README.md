# J.A.R.V.I.S. — Local Windows AI Assistant

An open-source local AI assistant for Windows, powered by Whisper, Ollama, optional Gemini, and Python tooling, with voice control and carefully scoped desktop actions. The current interface uses the name **ICE**.

J.A.R.V.I.S. runs its default chat model locally through Ollama and transcribes speech on-device with Whisper. Gemini is an optional, explicitly configured hosted provider; it is not required for local chat. The browser interface and local bridge communicate on this PC.

## Quick start

1. Install [Node.js 24 or newer](https://nodejs.org/).
2. Run `Setup-Jarvis.cmd` and allow setup to download the required runtime and models. Internet access is needed for initial setup.
3. Run `Start-Jarvis.cmd` and follow the browser link it opens.
4. Use `Stop-Jarvis.cmd` to stop the local services started by the launcher.

For PowerShell, run the same `.cmd` files from the project folder. Setup uses Python for the resumable model downloader when Python is available; Python is not required for chat after setup completes.

## Providers and privacy

- The default chat provider is local Ollama. Model downloads and inference use disk space, memory, and your PC's compute.
- Local speech transcription uses Whisper. Audio is processed on the PC.
- Gemini and other hosted providers are optional. They require explicit backend-only configuration in `backend.env` and may send conversation text to the selected provider. Never put provider keys in `VITE_*` variables or commit `backend.env`.
- The bridge binds to localhost. Keep it local; do not expose its port to the network.
- Desktop actions are constrained to supported tools and user-approved resources. Arbitrary model-generated shell commands are not executed.
- Local profile, memory, and application data are stored under ignored local-data directories and are not part of the repository.

See `backend.env.example` for optional provider settings. Review each provider's current terms, quotas, and data handling before enabling it.

## Development

```bash
npm install
npm test
npm run build
npm run lint
```

This project is based on [Aditya Dewaskar's Jarvis](https://github.com/adewaskar/jarvis); see [LICENSE](LICENSE) for license terms.
