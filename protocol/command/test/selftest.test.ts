import { describe, it, expect } from 'vitest';
import {
  SELFTEST_RESULT,
  selfTestMessage,
  parseSelfTestDiagnostics,
  describeSelfTestStatus,
  CORE_CMD,
  CONFIG_CMD,
  TLV_TYPE,
  CMD_ERROR,
} from '../src/constants';

describe('selfTestMessage', () => {
  it('reports a pass', () => {
    expect(selfTestMessage(SELFTEST_RESULT.OK)).toBe('Self-test passed');
  });

  it('asks the user to switch the dial on when unpowered', () => {
    expect(selfTestMessage(SELFTEST_RESULT.UNPOWERED)).toBe(
      'Switch the dial on and try again'
    );
  });

  it('gives each magnet fault its own actionable message', () => {
    expect(selfTestMessage(SELFTEST_RESULT.MAGNET_NOT_DETECTED)).toBe(
      'Magnet not detected'
    );
    expect(selfTestMessage(SELFTEST_RESULT.MAGNET_TOO_WEAK)).toBe(
      'Magnet too far away'
    );
    expect(selfTestMessage(SELFTEST_RESULT.MAGNET_TOO_STRONG)).toBe(
      'Magnet too close'
    );
    expect(selfTestMessage(SELFTEST_RESULT.MAGNET_ZERO_MAGNITUDE)).toBe(
      'Magnet not detected'
    );
  });

  it('collapses every bus and device fault to one message', () => {
    for (
      let code = SELFTEST_RESULT.ADDRESS_NACK;
      code <= SELFTEST_RESULT.MAGNET_MAGNITUDE_READ;
      code++
    ) {
      expect(selfTestMessage(code)).toBe('Sensor not responding');
    }
  });

  it('falls back for a code it does not know', () => {
    expect(selfTestMessage(99)).toBe('Unknown result (99)');
  });
});

describe('parseSelfTestDiagnostics', () => {
  it('decodes status, agc and little-endian magnitude', () => {
    const parsed = parseSelfTestDiagnostics(
      new Uint8Array([0x20, 61, 0x34, 0x12])
    );
    expect(parsed).toEqual({ status: 0x20, agc: 61, magnitude: 0x1234 });
  });

  it('returns null for a short payload', () => {
    expect(
      parseSelfTestDiagnostics(new Uint8Array([0x20, 61, 0x34]))
    ).toBeNull();
    expect(parseSelfTestDiagnostics(new Uint8Array())).toBeNull();
  });
});

describe('describeSelfTestStatus', () => {
  it('decodes the healthy case', () => {
    expect(describeSelfTestStatus(0x20)).toBe('detected, in range');
  });

  it('decodes both gain overflows', () => {
    expect(describeSelfTestStatus(0x30)).toBe('detected, too far');
    expect(describeSelfTestStatus(0x28)).toBe('detected, too close');
  });

  it('decodes no magnet', () => {
    expect(describeSelfTestStatus(0x00)).toBe('no magnet detected');
  });

  it('ignores reserved bits, which are not guaranteed zero', () => {
    expect(describeSelfTestStatus(0x20 | 0xc7)).toBe('detected, in range');
    expect(describeSelfTestStatus(0xc7)).toBe('no magnet detected');
  });
});

describe('not-fitted result', () => {
  it('reports a missing encoder rather than a pass', () => {
    expect(selfTestMessage(SELFTEST_RESULT.NOT_FITTED)).toBe('No encoder');
    expect(SELFTEST_RESULT.NOT_FITTED).not.toBe(SELFTEST_RESULT.OK);
  });

  it('does not fall into the bus-fault range', () => {
    expect(selfTestMessage(SELFTEST_RESULT.NOT_FITTED)).not.toBe(
      'Sensor not responding'
    );
  });
});

describe('remaining self-test messages', () => {
  it('reports poor alignment for an AGC range fault', () => {
    expect(selfTestMessage(SELFTEST_RESULT.MAGNET_AGC_RANGE)).toBe(
      'Magnet poorly aligned'
    );
  });
});

describe('parseSelfTestDiagnostics with trailing bytes', () => {
  it('reads the first four bytes and ignores the rest', () => {
    expect(
      parseSelfTestDiagnostics(new Uint8Array([0x28, 5, 0xff, 0x0f, 0xaa]))
    ).toEqual({ status: 0x28, agc: 5, magnitude: 0x0fff });
  });
});

describe('describeSelfTestStatus precedence', () => {
  it('reports too far when both gain overflow bits are set', () => {
    expect(describeSelfTestStatus(0x38)).toBe('detected, too far');
  });

  it('ignores overflow bits when no magnet is detected', () => {
    expect(describeSelfTestStatus(0x18)).toBe('no magnet detected');
  });
});

// These values are shared with the firmware by convention only, so pin them:
// a renumbering here without the matching firmware change breaks the wire format
describe('wire values', () => {
  it('pins the self-test command ID', () => {
    expect(CORE_CMD.RUN_SELFTEST).toBe(0x06);
  });

  it('pins the TLV types', () => {
    expect(TLV_TYPE).toEqual({
      FW_VERSION: 0x01,
      HW_VERSION: 0x02,
      SERIAL: 0x03,
      SELFTEST_RESULT: 0x04,
      SELFTEST_ENCODER: 0x05,
      SCROLL_MODE: 0x10,
      BUTTON_PRESS: 0x11,
      BUTTON_LONGPRESS: 0x12,
      DIRECTION: 0x13,
      SENSITIVITY: 0x14,
      MIN_SENSITIVITY: 0x15,
      MAX_SENSITIVITY: 0x16,
      BACKLASH: 0x17,
    });
  });

  it('pins the config command IDs', () => {
    expect(CONFIG_CMD).toEqual({
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
    });
  });

  it('pairs every config GET with the SET that follows it', () => {
    for (const [name, value] of Object.entries(CONFIG_CMD)) {
      if (!name.startsWith('GET_')) continue;
      const setName = name.replace('GET_', 'SET_') as keyof typeof CONFIG_CMD;
      expect(CONFIG_CMD[setName]).toBe(value + 1);
      expect(value % 2).toBe(0);
    }
  });

  it('keeps TLV types unique', () => {
    const values = Object.values(TLV_TYPE);
    expect(new Set(values).size).toBe(values.length);
  });

  it('numbers self-test results contiguously from zero', () => {
    const values = Object.values(SELFTEST_RESULT).sort((a, b) => a - b);
    expect(values).toEqual(values.map((_, i) => i));
    expect(SELFTEST_RESULT.OK).toBe(0);
    expect(SELFTEST_RESULT.MAGNET_ZERO_MAGNITUDE).toBe(19);
  });

  it('pins the command error codes', () => {
    expect(CMD_ERROR).toEqual({
      INVALID_COMMAND_ID: 0x01,
      INVALID_PAYLOAD_TYPE: 0x02,
      VALUE_OUT_OF_RANGE: 0x06,
      INTERNAL: 0x08,
    });
  });

  it('gives every defined result a message that is not the unknown fallback', () => {
    for (const code of Object.values(SELFTEST_RESULT)) {
      expect(selfTestMessage(code)).not.toMatch(/^Unknown result/);
    }
  });
});
