# Full Scroll Dial — Web App

A vanilla TypeScript web tool for configuring and updating firmware on a USB scroll dial device over the Web Serial API.

## Commands

```bash
npm install              # install dependencies

# Development
npm run dev              # dev server at http://localhost:5173
npm run build            # production build → dist/
npm run preview          # preview the production build locally

# Type checking
npx tsc --noEmit         # type-check without emitting files

# Tests
npm test                             # run all unit tests (Vitest, jsdom) — 532 tests, 29 files
npm test -- src/test/poller          # run a single test file by path prefix
npm test -- protocol/command/test    # run a protocol-layer test suite
npx vitest run --coverage            # run tests + generate coverage report (96.54% stmts, 85.36% branches)

# Linting & formatting
npm run lint             # ESLint check (report only)
npm run lint:fix         # ESLint check + auto-fix
npm run format           # Prettier — rewrite files in place
npm run format:check     # Prettier — check only (used in CI)
```

**CI gate** — `tsc --noEmit → lint → format:check → test → npm audit` must all pass before a build is produced (see `.github/workflows/deploy.yml`).

## Browser requirement

Web Serial API is required. Supported: Chrome 89+, Edge 89+, Opera 76+. Firefox and Safari are not supported.

## App modes

**Config mode** — connects via the custom TLV command protocol, reads device settings, and lets the user adjust direction, sensitivity, scroll mode, and button actions live with 1-second polling.

**DFU mode** — connects via SMP (Simple Management Protocol) over serial, queries the running firmware version, and uploads a new `.bin` image using chunked CBOR encoding.

The app auto-detects which mode the device is in at connect time by probing for SMP framing before trying the command protocol.

## Architecture

```
src/                     ← UI layer (vanilla TypeScript, no framework)
  main.ts                  App init, mode switching, connect/disconnect toggle
  connection.ts            SerialPort lifecycle + SMP probe + command protocol bridge
  config/                  Config panel — each file owns one field or shared utility
    index.ts               Orchestrator: injects HTML, runs syncAndBind, exposes ConfigPanel API
    field-utils.ts         FieldContext/FieldBinding interfaces, checkPoll, makeFieldCallback, class strings
    fields/
      device-info.ts       Read-only firmware/hardware/serial card (poll-driven)
      direction.ts         Direction select field
      sensitivity.ts       Sensitivity slider + min/max range fields (shared lastGoodSensitivity state)
      scroll-mode.ts       Scroll mode select field
      button-actions.ts    Button press + long-press select fields
      backlash.ts          Scroll backlash (lost motion on reversal) slider
      self-test.ts         Run-self-test action card (not poll-driven, see below)
  dfu.ts                   DFU UI: device info, file upload, progress, session control
  constants.ts             Shared timing/layout constants
  poller.ts                Periodic GET_ALL_STATES loop; gates on in-flight commands
  save-command.ts          Shared save wrapper: poller gate, status dot, error log
  run-command.ts           Shared one-shot command wrapper: like save-command but returns response data
  debounced-slider.ts      Input debounce + immediate-on-change slider binding
  field-status.ts          Status dot + label with auto-clear timer
  range-track.ts           Dual-range slider fill and thumb label positioning
  dom.ts                   getRequiredElement() — throws if an element is missing
  dfu-steps.ts             Animated 4-step DFU entry guide (SVG + CSS keyframes)

protocol/                ← Three-layer serial protocol stack
  reliable-serial/         Layer 1: COBS framing, sync, ProtocolEngine/Interface
  command/                 Layer 2: TLV command/response, sequence numbers, 1s timeout
  mcumgr/                  Layer 3: SMP header, CBOR image commands, DfuSession
  shared/                  TypedEmitter shared by all layers
```

## Protocol stack

```
Device firmware
     ↕  COBS frames over UART 115200 baud
reliable-serial      (protocol/reliable-serial/)
     ↕  GET_ALL_STATES / SET_* TLV commands
command protocol     (protocol/command/)
     ↕  SMP image/os commands (CBOR)
mcumgr / SMP         (protocol/mcumgr/)
     ↕  USB CDC-ACM (Web Serial API)
Browser
```

## Key constants

All shared timing/layout values live in `src/constants.ts`:

| Constant                  | Value   | Purpose                                               |
| ------------------------- | ------- | ----------------------------------------------------- |
| `POST_SYNC_SETTLE_MS`     | 1000 ms | Wait after protocol sync before starting config panel |
| `SENSITIVITY_DEBOUNCE_MS` | 500 ms  | Slider save debounce                                  |
| `POLL_INTERVAL_MS`        | 1000 ms | GET_ALL_STATES polling interval                       |
| `THUMB_RADIUS_PX`         | 8 px    | Range thumb radius for label positioning              |

Protocol-layer constants (baud rate, command IDs, TLV types) live in `protocol/*/src/constants.ts`.

## DFU animation

`src/styles.css` contains the 12-second CSS keyframe cycle for the DFU entry guide. The timeline is documented in a comment block above the `@keyframes dfu-step-*` rules. `src/dfu-steps.ts` renders the SVG illustration; `src/styles.css` drives the animation.

## Adding a new config field

1. Add the command/TLV IDs to `protocol/command/src/constants.ts`.
2. Create `src/config/fields/my-field.ts`:
   - Export `myFieldHtml` (the card HTML string, using `CARD`/`SELECT` from `field-utils.ts`)
   - Export `bindMyField(ctx: FieldContext): FieldBinding`
   - Wire the `<select>` `change` handler in `bindMyField` (fires once at init)
   - In `activate()`, call `makeFieldCallback(...)` and return a poll handler via `checkPoll(...)`
   - In `cleanup()`, hide the section
3. In `src/config/index.ts`:
   - Import `myFieldHtml` and `bindMyField`
   - Add `myFieldHtml` to `CARDS_HTML`
   - Call `bindMyField(ctx)` and add the result's `activate()`/`cleanup()` to `syncAndBind`/`cleanup`

## Protocol backwards compatibility

Protocol v1 is defined as firmware 0.1.4; nothing earlier is supported.
`src/test/protocol-compat-v1.test.ts` replays a frozen transcript of that firmware (`src/test/fixtures/protocol-v1.ts`)
through the real `CommandProtocol` and config panel. The bytes are checked against the firmware in
`../full-scroll-dial-fw/src/command.c`, and are literals rather than imports from
`constants.ts`, so renumbering an ID fails the suite.

- Never edit or add frames in `protocol-v1.ts`. It is a record of firmware 0.1.4, which has shipped. If this
  suite fails, the change breaks v1 devices.
- A command added in later firmware without a version bump is tested in its own field test. This suite then
  proves the app still works with 0.1.4, which doesn't have it.
- A breaking change means a new protocol version: add `protocol-v2.ts` + `protocol-compat-v2.test.ts` beside
  the v1 pair, and keep v1 passing for as long as the app supports it.

## Adding an action card (no polling)

`src/config/fields/self-test.ts` is the reference. Two things differ from a config field:

- `activate()` still has to return a poll handler, so it returns a no-op `() => {}`.
- The card must un-hide itself inside `activate()`. Every poll-driven card reveals itself from its first poll
  callback via `makeFieldCallback`, which never fires for a card with nothing to poll.

Use `makeRunner()` from `src/run-command.ts` rather than `makeSaver()` when the response payload is needed.
It holds the poller gate for the whole exchange — the reliable-serial layer allows one outstanding frame, so an
interleaved poll makes `send()` throw.
