import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAllowedCommand, CommandValidationError } from '../src/commands/catalog.js';

test('catálogo construye únicamente comandos documentados del S11L', () => {
  assert.equal(buildAllowedCommand('set_interval', { seconds: 60 }).text, 'TIMER,60#');
  assert.equal(buildAllowedCommand('set_heartbeat', { minutes: 3 }).text, 'HBT,3#');
  assert.equal(buildAllowedCommand('query_parameters').text, 'PARAM#');
  assert.equal(buildAllowedCommand('query_status').text, 'STATUS#');
  assert.equal(buildAllowedCommand('vibration_alarm', { enabled: true, mode: 1 }).text, 'SENALM,ON,1#');
  assert.equal(buildAllowedCommand('low_battery_alarm', { enabled: false }).text, 'BATALM,OFF#');
});

test('catálogo rechaza intervalos, modos y comandos arbitrarios', () => {
  assert.throws(() => buildAllowedCommand('set_interval', { seconds: 4 }), CommandValidationError);
  assert.throws(() => buildAllowedCommand('set_heartbeat', { minutes: 1441 }), CommandValidationError);
  assert.throws(() => buildAllowedCommand('vibration_alarm', { enabled: true, mode: 9 }), CommandValidationError);
  assert.throws(() => buildAllowedCommand('raw', { text: 'RESET#' }), CommandValidationError);
});
