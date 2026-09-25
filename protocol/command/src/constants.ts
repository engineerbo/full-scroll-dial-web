/**
 * Command Protocol Constants — v1
 *
 * Wire format:
 *   Request:  [group: u8][cmd: u8][payload: 0-N TLV bytes]
 *   Response: [status: u8][group: u8][cmd: u8][data: 0-N TLV bytes]
 *
 * Exceptions (not TLV):
 *   GET_PROTOCOL_VERSION (0x00, 0x00): raw u16 LE payload and response data
 *   GET_ALL_STATES (0x00, 0x01): [group][cmd][len][value...] entry format
 *
 * Multi-byte integers are little-endian (LSB first).
 */

// ─── Command groups ───────────────────────────────────────────────────────────

export const GROUP = {
  CORE: 0x00,
  CONFIG: 0x01,
} as const;

// ─── Core group (0x00) command IDs ───────────────────────────────────────────

export const CORE_CMD = {
  GET_PROTOCOL_VERSION: 0x00,
  GET_ALL_STATES: 0x01,
  GET_FW_VERSION: 0x02,
  GET_HW_VERSION: 0x03,
  GET_SERIAL: 0x04,
  RESET_DEFAULTS: 0x05,
  RUN_SELFTEST: 0x06,
} as const;

// ─── Config group (0x01) command IDs ─────────────────────────────────────────

export const CONFIG_CMD = {
  GET_SCROLL_MODE: 0x00,
  SET_SCROLL_MODE: 0x01,
  GET_BUTTON_PRESS: 0x02,
  SET_BUTTON_PRESS: 0x03,
  GET_BUTTON_LONGPRESS: 0x04,
  SET_BUTTON_LONGPRESS: 0x05,
  GET_DIRECTION: 0x06,
  SET_DIRECTION: 0x07,
  GET_SENSITIVITY: 0x08,
  SET_SENSITIVITY: 0x09,
  GET_MIN_SENSITIVITY: 0x0a,
  SET_MIN_SENSITIVITY: 0x0b,
  GET_MAX_SENSITIVITY: 0x0c,
  SET_MAX_SENSITIVITY: 0x0d,
  GET_BACKLASH: 0x0e,
  SET_BACKLASH: 0x0f,
} as const;

// ─── TLV types ────────────────────────────────────────────────────────────────

export const TLV_TYPE = {
  // Core types first so that the config types stay contiguous as they grow
  FW_VERSION: 0x01,
  HW_VERSION: 0x02,
  SERIAL: 0x03,
  SELFTEST_RESULT: 0x04,
  SELFTEST_ENCODER: 0x05,
  // 0x06 - 0x0f reserved for further self-test entries

  SCROLL_MODE: 0x10,
  BUTTON_PRESS: 0x11,
  BUTTON_LONGPRESS: 0x12,
  DIRECTION: 0x13,
  SENSITIVITY: 0x14,
  MIN_SENSITIVITY: 0x15,
  MAX_SENSITIVITY: 0x16,
  BACKLASH: 0x17,
} as const;

// ─── Enumerated values ────────────────────────────────────────────────────────

export const SCROLL_MODE = {
  STANDARD: 0x00,
  HIGH_RES: 0x01,
} as const;

export const BUTTON_ACTION = {
  CYCLE_SENSITIVITY: 0x00,
  TOGGLE_DIRECTION: 0x01,
  TOGGLE_SCROLL_MODE: 0x02,
  DISABLED: 0xff,
} as const;

export const DIRECTION = {
  NORMAL: 0x00,
  INVERTED: 0x01,
} as const;

// ─── Self-test result codes ──────────────────────────────────────────────────

/**
 * Verdict returned in TLV_TYPE.SELFTEST_RESULT. Mirrors selftest_encoder_err_t in
 * the firmware's inc/selftest_encoder.h, which is the source of truth — there is no
 * shared definition between the two repos.
 */
export const SELFTEST_RESULT = {
  OK: 0,

  NOT_FITTED: 1,
  UNPOWERED: 2,

  ADDRESS_NACK: 3,
  ZMCO_READ: 4,
  ANGLE_READ: 5,
  ANGLE_SIGNATURE: 6,
  CONF_READ: 7,
  CONF_WRITE: 8,
  CONF_READBACK: 9,
  CONF_MISMATCH: 10,
  CONF_RESTORE: 11,

  MAGNET_STATUS_READ: 12,
  MAGNET_AGC_READ: 13,
  MAGNET_MAGNITUDE_READ: 14,
  MAGNET_NOT_DETECTED: 15,
  MAGNET_TOO_WEAK: 16,
  MAGNET_TOO_STRONG: 17,
  MAGNET_AGC_RANGE: 18,
  MAGNET_ZERO_MAGNITUDE: 19,
} as const;

/**
 * Codes 2-15 all mean the sensor or bus is faulty and differ only in which check
 * caught it, so they collapse to one message. The raw code is still surfaced for
 * support. Only the magnet cases and UNPOWERED are user-actionable.
 */
const SELFTEST_MESSAGE: Record<number, string> = {
  [SELFTEST_RESULT.OK]: 'Self-test passed',
  [SELFTEST_RESULT.UNPOWERED]: 'Switch the dial on and try again',
  [SELFTEST_RESULT.MAGNET_NOT_DETECTED]: 'Magnet not detected',
  [SELFTEST_RESULT.MAGNET_TOO_WEAK]: 'Magnet too far away',
  [SELFTEST_RESULT.MAGNET_TOO_STRONG]: 'Magnet too close',
  [SELFTEST_RESULT.MAGNET_AGC_RANGE]: 'Magnet poorly aligned',
  [SELFTEST_RESULT.MAGNET_ZERO_MAGNITUDE]: 'Magnet not detected',
  [SELFTEST_RESULT.NOT_FITTED]: 'No encoder',
};

export function selfTestMessage(code: number): string {
  const known = SELFTEST_MESSAGE[code];
  if (known !== undefined) return known;
  if (
    code >= SELFTEST_RESULT.ADDRESS_NACK &&
    code <= SELFTEST_RESULT.MAGNET_MAGNITUDE_READ
  ) {
    return 'Sensor not responding';
  }
  return `Unknown result (${code})`;
}

/** Decoded TLV_TYPE.SELFTEST_ENCODER payload: raw AS5600 diagnostics. */
export interface SelfTestDiagnostics {
  /** STATUS register: bit 5 MD (detected), bit 4 ML (too weak), bit 3 MH (too strong). */
  status: number;
  /**
   * Automatic gain control, 0-128 at 3.3V. This is compensation, not strength: the
   * sensor raises gain for a weaker field, so the value FALLS as the magnet gets
   * closer. Mid-scale is ideal, leaving headroom before either gain overflow.
   */
  agc: number;
  /** CORDIC magnitude, 12-bit. */
  magnitude: number;
}

/**
 * AS5600 STATUS register bits. Bits 7:6 and 2:0 are reserved and are NOT guaranteed
 * to read zero on real silicon, so always mask before interpreting.
 */
export const SELFTEST_STATUS_BIT = {
  /** MH: gain hit its minimum and there is still too much signal - magnet too close. */
  TOO_STRONG: 0x08,
  /** ML: gain hit its maximum and there is still too little signal - magnet too far. */
  TOO_WEAK: 0x10,
  /** MD: a magnet was detected. */
  DETECTED: 0x20,
} as const;

const STATUS_MEANINGFUL_BITS = 0x38;

/** AGC full scale at the 3.3V supply this board uses. */
export const SELFTEST_AGC_FULL_SCALE = 128;

/** Human-readable decode of the AS5600 STATUS byte. */
export function describeSelfTestStatus(status: number): string {
  const bits = status & STATUS_MEANINGFUL_BITS;
  if ((bits & SELFTEST_STATUS_BIT.DETECTED) === 0) return 'no magnet detected';
  if (bits & SELFTEST_STATUS_BIT.TOO_WEAK) return 'detected, too far';
  if (bits & SELFTEST_STATUS_BIT.TOO_STRONG) return 'detected, too close';
  return 'detected, in range';
}

/** Returns null when the payload is not the expected 4 bytes. */
export function parseSelfTestDiagnostics(
  data: Uint8Array
): SelfTestDiagnostics | null {
  if (data.length < 4) return null;
  return {
    status: data[0]!,
    agc: data[1]!,
    // Little-endian, per this protocol's integer convention
    magnitude: data[2]! | (data[3]! << 8),
  };
}

// ─── Response status codes ────────────────────────────────────────────────────

export const RESPONSE_STATUS = {
  SUCCESS: 0x00,
  ERROR: 0xff,
} as const;

// ─── Command error codes ──────────────────────────────────────────────────────

/** Mirrors cmd_error_t in the firmware's src/command.c. Carried in the error payload. */
export const CMD_ERROR = {
  INVALID_COMMAND_ID: 0x01,
  INVALID_PAYLOAD_TYPE: 0x02,
  VALUE_OUT_OF_RANGE: 0x06,
  INTERNAL: 0x08,
} as const;

// ─── Protocol version ─────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1;
