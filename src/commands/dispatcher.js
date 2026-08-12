import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { buildCommandFrame } from '../protocols/gt06.js';
import { createDeviceCommand, getDeviceCommand, getQueuedDeviceCommands, markDeviceCommandSent } from '../db/repo.js';

const connections = new Map(); // IMEI -> { socket, device }
let serial = crypto.randomInt(1, 65535);

export function isDeviceOnline(imei) {
  const connection = connections.get(imei);
  return Boolean(connection && !connection.socket.destroyed);
}

export async function registerDeviceConnection(device, socket) {
  connections.set(device.imei, { device, socket });
  await flushDeviceCommands(device.imei);
}

export function unregisterDeviceConnection(imei, socket) {
  const current = connections.get(imei);
  if (current?.socket === socket) connections.delete(imei);
}

export async function queueDeviceCommand({ device, command, requestedBy }) {
  const row = await createWithUniqueFlag({ device, command, requestedBy });
  if (isDeviceOnline(device.imei)) await flushDeviceCommands(device.imei);
  return { ...(await getDeviceCommand(row.id) ?? row), online: isDeviceOnline(device.imei) };
}

export async function flushDeviceCommands(imei) {
  const connection = connections.get(imei);
  if (!connection || connection.socket.destroyed) return 0;
  const pending = await getQueuedDeviceCommands(connection.device.id);
  let sent = 0;
  for (const command of pending) {
    if (connection.socket.destroyed) break;
    const frame = buildCommandFrame(command.command_text, {
      serverFlag: Number(command.server_flag), serial: nextSerial(), language: 2,
    });
    await writeSocket(connection.socket, frame);
    await markDeviceCommandSent(command.id);
    sent++;
    logger.info({ imei, command_id: command.id, tipo: command.command_type }, 'comando enviado al rastreador');
  }
  return sent;
}

async function createWithUniqueFlag({ device, command, requestedBy }) {
  for (let i = 0; i < 5; i++) {
    const serverFlag = crypto.randomInt(1, 0x100000000);
    try {
      return await createDeviceCommand({ deviceId: device.id, commandType: command.type,
        commandText: command.text, serverFlag, requestedBy });
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
  throw new Error('no se pudo reservar un identificador de comando');
}

function nextSerial() {
  serial = (serial % 65535) + 1;
  return serial;
}

function writeSocket(socket, frame) {
  return new Promise((resolve, reject) => socket.write(frame, (err) => err ? reject(err) : resolve()));
}
