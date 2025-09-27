import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { createLog } from '../helpers/log';

describe('createLog', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('creates log function with default options', () => {
    const log = createLog('TestLogger');

    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  test('logs messages with prefix and level', () => {
    const log = createLog('TestLogger');

    log.info('Test message');

    expect(consoleSpy).toHaveBeenCalled();
    const call = consoleSpy.mock.calls[0][0];
    expect(call).toContain('[TestLogger]');
    expect(call).toContain('[INFO]');
    expect(call).toContain('Test message');
  });

  test('respects log level', () => {
    const log = createLog('TestLogger', { level: 'warn' });

    log.debug('Debug message');
    log.info('Info message');
    log.warn('Warn message');
    log.error('Error message');

    // Should only log warn and error (2 calls)
    expect(consoleSpy).toHaveBeenCalledTimes(2);
  });

  test('includes timestamp when enabled', () => {
    const log = createLog('TestLogger', { timestamp: true });

    log.info('Test message');

    const call = consoleSpy.mock.calls[0][0];
    expect(call).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('excludes timestamp when disabled', () => {
    const log = createLog('TestLogger', { timestamp: false });

    log.info('Test message');

    const call = consoleSpy.mock.calls[0][0];
    expect(call).not.toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('applies colors when enabled', () => {
    const log = createLog('TestLogger', { colors: true });

    log.error('Error message');

    const call = consoleSpy.mock.calls[0][0];
    expect(call).toContain('\u001b[31m'); // red color for error
    expect(call).toContain('\u001b[0m'); // reset color
  });

  test('skips colors when disabled', () => {
    const log = createLog('TestLogger', { colors: false });

    log.error('Error message');

    const call = consoleSpy.mock.calls[0][0];
    expect(call).not.toContain('\u001b[');
  });

  test('handles empty prefix', () => {
    const log = createLog();

    log.info('Test message');

    const call = consoleSpy.mock.calls[0][0];
    expect(call).not.toContain('[]');
  });

  test('passes additional arguments', () => {
    const log = createLog('TestLogger');

    log.info('Test message', 'arg1', 'arg2');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Test message'),
      'arg1',
      'arg2'
    );
  });
});
