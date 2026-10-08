// Acceptance-only process guard. Not loaded by the normal application.
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const instant = Date.parse('2026-10-08T00:06:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
};
Math.random = () => 0.5;
const ports = new Set((process.env.ALPHA_ALLOWED_PORTS || '').split(',').map(Number));
const deny = () => { console.error('OFFLINE_DENIED: non-fixture network attempt'); throw new Error('OFFLINE_DENIED'); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node also passes a normalized [options, callback] array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (options.path || options.host !== '127.0.0.1' || !ports.has(Number(options.port))) deny();
  return Reflect.apply(connect, this, args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !ports.has(Number(url.port || 80))) deny();
  return realFetch(input, options);
};
syncBuiltinESMExports();
