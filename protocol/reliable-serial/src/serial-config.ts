/**
 * Serial transport settings
 *
 * Must match the UART initialisation in firmware (uart_init.c or equivalent).
 * Changing this value requires a firmware flash in addition to a web update.
 */
export const SERIAL_CONFIG = {
  /** Baud rate in bits per second. */
  BAUD_RATE: 115200,
} as const;
