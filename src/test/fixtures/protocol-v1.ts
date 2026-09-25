/**
 * Command protocol v1 — frozen wire transcript.
 *
 * Protocol v1 is defined as firmware 0.1.4 (../full-scroll-dial-fw/src/command.c);
 * nothing earlier is supported. Every byte here is what that firmware sends or accepts,
 * written as literals on purpose: importing GROUP / CONFIG_CMD / TLV_TYPE would let a
 * renumbering in constants.ts pass silently. protocol-compat-v1.test.ts replays this against the real config panel.
 *
 * DO NOT EDIT or add frames — this is a record of firmware 0.1.4, which is shipped and
 * cannot change. A later firmware that adds commands while still reporting v1 is tested
 * elsewhere; this suite then proves the app still works with 0.1.4, which lacks them.
 * A breaking change gets protocol-v2.ts beside this file, and this suite keeps passing
 * for as long as the app claims v1 support.
 *
 * Frame layout (after reliable-serial framing is stripped):
 *   Request:  [group][cmd][payload…]
 *   Response: [status][group][cmd][data…]
 */

export type Frame = readonly number[];

export interface Exchange {
  readonly request: Frame;
  readonly response: Frame;
}

/**
 * The payload is the app's highest supported version, so only the [group][cmd] header
 * and the u16 length are frozen. The firmware answers min(host, 1), so a v1 device
 * answers 1 whatever the app offers.
 */
export const HANDSHAKE: Exchange = {
  request: [0x00, 0x00, 0x01, 0x00],
  response: [0x00, 0x00, 0x00, 0x01, 0x00],
};

export const GET_ALL_STATES_REQUEST: Frame = [0x00, 0x01];

/**
 * GET_ALL_STATES data entries are [group][cmd][len][value…], not TLV.
 *
 * Exactly what firmware 0.1.4 sends, in its order. HW version and serial
 * are left out because no firmware sends them yet (info_get_hw_version and
 * info_get_serial are TODO stubs), so their byte format isn't settled.
 */
export const FULL_STATES: Exchange = {
  request: GET_ALL_STATES_REQUEST,
  // prettier-ignore
  response: [
    0x00, 0x00, 0x01,
    // Firmware version, binary major.minor.patch
    0x00, 0x02, 0x03, 0x00, 0x01, 0x04,
    // Scroll mode: high-res
    0x01, 0x00, 0x01, 0x01,
    // Button press: toggle scroll mode
    0x01, 0x02, 0x01, 0x02,
    // Button long-press: disabled
    0x01, 0x04, 0x01, 0xff,
    // Direction: inverted
    0x01, 0x06, 0x01, 0x01,
    // Sensitivity 40, range 10–200
    0x01, 0x08, 0x01, 0x28,
    0x01, 0x0a, 0x01, 0x0a,
    0x01, 0x0c, 0x01, 0xc8,
    // Backlash: 15 tenths of a degree
    0x01, 0x0e, 0x01, 0x0f,
  ],
};

/** What the UI must show after FULL_STATES. */
export const FULL_STATES_EXPECTED = {
  fwVersion: 'v0.1.4',
  scrollMode: '1',
  buttonPress: '2',
  buttonLongpress: '255',
  direction: '1',
  sensitivity: '40',
  minSensitivity: '10',
  maxSensitivity: '200',
  backlash: '1.5°',
} as const;

/**
 * A later firmware still on v1 may report entries this app has never heard of. They sit
 * between known entries here so a parser that stops at the first unknown fails.
 */
export const STATES_WITH_UNKNOWN_ENTRIES: Exchange = {
  request: GET_ALL_STATES_REQUEST,
  // prettier-ignore
  response: [
    0x00, 0x00, 0x01,
    0x7f, 0x7f, 0x03, 0xaa, 0xbb, 0xcc,
    0x01, 0x06, 0x01, 0x01,
    0x01, 0x7e, 0x00,
    0x01, 0x08, 0x01, 0x28,
  ],
};

/** Every SET_* takes one TLV: [type][len][value]. Success responses carry no data. */
export const SET = {
  scrollMode: {
    request: [0x01, 0x01, 0x10, 0x01, 0x00],
    response: [0x00, 0x01, 0x01],
  },
  buttonPress: {
    request: [0x01, 0x03, 0x11, 0x01, 0x01],
    response: [0x00, 0x01, 0x03],
  },
  buttonLongpress: {
    request: [0x01, 0x05, 0x12, 0x01, 0x00],
    response: [0x00, 0x01, 0x05],
  },
  direction: {
    request: [0x01, 0x07, 0x13, 0x01, 0x00],
    response: [0x00, 0x01, 0x07],
  },
  sensitivity: {
    request: [0x01, 0x09, 0x14, 0x01, 0x32],
    response: [0x00, 0x01, 0x09],
  },
  minSensitivity: {
    request: [0x01, 0x0b, 0x15, 0x01, 0x14],
    response: [0x00, 0x01, 0x0b],
  },
  maxSensitivity: {
    request: [0x01, 0x0d, 0x16, 0x01, 0x96],
    response: [0x00, 0x01, 0x0d],
  },
  backlash: {
    request: [0x01, 0x0f, 0x17, 0x01, 0x05],
    response: [0x00, 0x01, 0x0f],
  },
} as const satisfies Record<string, Exchange>;

/**
 * Error responses carry the cmd_error_t code as the payload. 0x06 = value out of range:
 * the firmware refuses a min above the current sensitivity, which the button can lower
 * between polls, so a save the app thought was valid can still be rejected.
 */
export const SET_MIN_SENSITIVITY_REJECTED: Exchange = {
  request: SET.minSensitivity.request,
  response: [0xff, 0x01, 0x0b, 0x06],
};

/** Result TLV 0x04, then encoder diagnostics TLV 0x05: [status][agc][magnitude u16 LE]. */
export const SELFTEST_PASS: Exchange = {
  request: [0x00, 0x06],
  // prettier-ignore
  response: [
    0x00, 0x00, 0x06,
    0x04, 0x01, 0x00,
    0x05, 0x04, 0x20, 0x40, 0x00, 0x08,
  ],
};

export const SELFTEST_MAGNET_TOO_WEAK: Exchange = {
  request: [0x00, 0x06],
  // prettier-ignore
  response: [
    0x00, 0x00, 0x06,
    0x04, 0x01, 0x10,
    0x05, 0x04, 0x30, 0x80, 0x10, 0x00,
  ],
};
