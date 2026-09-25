/**
 * SMP protocol constants.
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_protocol.html}
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_groups/smp_group_1.html}
 */

// ---------------------------------------------------------------------------
// Op codes
// ---------------------------------------------------------------------------

/**
 * Op codes occupy byte 0 of the SMP header (v0 format, Ver=0b00).
 *
 * From the SMP protocol specification header table:
 * > "OP – Determines whether the information is a read or write and
 * >  whether the packet is a request or a response."
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_protocol.html}
 */
export const Op = {
  /** Read request sent by the client. */
  READ: 0,
  /** Read response sent by the device. */
  READ_RSP: 1,
  /** Write request sent by the client. */
  WRITE: 2,
  /** Write response sent by the device. */
  WRITE_RSP: 3,
} as const;

export type Op = (typeof Op)[keyof typeof Op];

// ---------------------------------------------------------------------------
// Management group IDs
// ---------------------------------------------------------------------------

/**
 * Management group IDs occupy bytes 4–5 of the SMP header (16-bit big-endian).
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_protocol.html}
 */
export const Group = {
  OS: 0,
  IMAGE: 1,
  STAT: 2,
  CONFIG: 3,
  LOG: 4,
  CRASH: 5,
  SPLIT: 6,
  RUN: 7,
  FS: 8,
  SHELL: 9,
} as const;

export type Group = (typeof Group)[keyof typeof Group];

// ---------------------------------------------------------------------------
// OS group command IDs
// ---------------------------------------------------------------------------

/**
 * Command IDs for the OS management group (`Group.OS = 0`).
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_groups/smp_group_0.html}
 */
export const OsCmd = {
  ECHO: 0,
  CONS_ECHO_CTRL: 1,
  TASKSTAT: 2,
  MPSTAT: 3,
  DATETIME_STR: 4,
  RESET: 5,
} as const;

export type OsCmd = (typeof OsCmd)[keyof typeof OsCmd];

// ---------------------------------------------------------------------------
// Image Management group command IDs
// ---------------------------------------------------------------------------

/**
 * Command IDs for the Image Management group (`Group.IMAGE = 1`).
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_groups/smp_group_1.html}
 */
export const ImgCmd = {
  /**
   * Get or set image state (slot list, pending, confirmed flags).
   * Op.READ → list; Op.WRITE → set test/confirm.
   */
  STATE: 0,
  /** Upload a firmware image in chunks. Op.WRITE only. */
  UPLOAD: 1,
  /** Erase an image slot. Op.WRITE only. */
  ERASE: 5,
  /** Slot info — list physical slots regardless of whether they contain valid images. Op.READ only. */
  SLOT_INFO: 6,
} as const;

export type ImgCmd = (typeof ImgCmd)[keyof typeof ImgCmd];

// ---------------------------------------------------------------------------
// MCUmgr return codes (SMP v0 `rc` field)
// ---------------------------------------------------------------------------

/**
 * Return codes that appear in the `rc` field of SMP v0 CBOR response maps.
 *
 * From the SMP protocol specification:
 * > "SMP Version 1 Response: {"rc": (int)}"
 * > "Success is indicated by an empty map or absent error fields."
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_protocol.html}
 */
export const Rc = {
  OK: 0,
  UNKNOWN: 1,
  NO_MEM: 2,
  IN_VAL: 3,
  TIMEOUT: 4,
  NO_ENTRY: 5,
  /** Bad state — e.g. erase on a slot marked for next boot. */
  BAD_STATE: 6,
  BUF_TOO_LONG: 7,
  NO_EXEC: 8,
  OS: 9,
  ENOENT: 10,
} as const;

export type Rc = (typeof Rc)[keyof typeof Rc];
