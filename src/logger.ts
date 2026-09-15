import pino from 'pino';
import { CFG } from './config.js';

export const log = pino({
  level: CFG.logLevel,
  base: undefined,
  transport: process.stdout.isTTY
    ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
    : undefined,
});
