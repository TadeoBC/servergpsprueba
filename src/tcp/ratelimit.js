/**
 * Rate limit por IP para el puerto de ingesta.
 *
 * Dos controles independientes:
 *   1. conexiones SIMULTÁNEAS por IP  (maxConcurrent)
 *   2. conexiones NUEVAS por ventana  (maxPerWindow / windowMs)
 *
 * Un equipo real mantiene una sola conexión y reconecta de vez en cuando. Los
 * valores por defecto solo estorban a quien barre puertos.
 */
export class ConnectionLimiter {
  constructor({ maxConcurrent = 20, maxPerWindow = 60, windowMs = 60000 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    /** ip -> { activas: number, intentos: number[] (timestamps) } */
    this.state = new Map();
  }

  /** @returns {{allowed: boolean, reason?: string}} */
  tryAcquire(ip, now = Date.now()) {
    let s = this.state.get(ip);
    if (!s) {
      s = { activas: 0, intentos: [] };
      this.state.set(ip, s);
    }

    const desde = now - this.windowMs;
    s.intentos = s.intentos.filter((t) => t > desde);

    if (s.activas >= this.maxConcurrent) {
      return { allowed: false, reason: `límite de ${this.maxConcurrent} conexiones simultáneas por IP` };
    }
    if (s.intentos.length >= this.maxPerWindow) {
      return {
        allowed: false,
        reason: `límite de ${this.maxPerWindow} conexiones nuevas por ${Math.round(this.windowMs / 1000)}s`,
      };
    }

    s.intentos.push(now);
    s.activas++;
    return { allowed: true };
  }

  release(ip) {
    const s = this.state.get(ip);
    if (!s) return;
    s.activas = Math.max(0, s.activas - 1);
    if (s.activas === 0 && s.intentos.length === 0) this.state.delete(ip);
  }

  /** Limpieza periódica de IPs inactivas para que el Map no crezca sin fin. */
  sweep(now = Date.now()) {
    const desde = now - this.windowMs;
    for (const [ip, s] of this.state) {
      s.intentos = s.intentos.filter((t) => t > desde);
      if (s.activas === 0 && s.intentos.length === 0) this.state.delete(ip);
    }
  }

  get size() {
    return this.state.size;
  }
}
