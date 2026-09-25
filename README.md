# Full Scroll Dial

Web-based configuration and firmware update tool for the Full Scroll Dial device. Runs entirely in the browser using the Web Serial API — no drivers or native apps required.

## Browser support

| Browser | Minimum version |
| ------- | --------------- |
| Chrome  | 89              |
| Edge    | 89              |
| Opera   | 76              |

Firefox and Safari do not support Web Serial and cannot run this app.

## Quickstart

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in a supported browser, plug in your device over USB, and click **Connect**.

## Features

### Configuration mode

Read and write device settings live over USB:

- **Direction** — Normal or Inverted scroll
- **Sensitivity** — Adjustable value (1–255) with debounced slider
- **Sensitivity range** — Clamp the slider to a min/max window
- **Scroll mode** — Standard or High-Resolution
- **Button press / long-press** — Cycle sensitivity, toggle direction, toggle scroll mode, or disabled

Settings are polled every second and reflect any changes made on the device itself.

### DFU mode (firmware update)

1. Switch to DFU mode using the pill toggle
2. Follow the animated guide to enter bootloader mode (hold button → plug in USB → release)
3. Select a `.bin` firmware file
4. Click **Start Update** and wait for the progress bar

If the device is already in bootloader mode when you connect, the app detects it automatically and switches to DFU mode.

## Development

```bash
npm run dev          # Vite dev server with hot reload
npm test             # Vitest unit tests
npm run build        # Production build → dist/
npm run lint         # ESLint
npm run format       # Prettier
```

## Deployment

Pushes to any git tag trigger the GitHub Actions workflow, which lints, tests, builds, and deploys to GitHub Pages.
