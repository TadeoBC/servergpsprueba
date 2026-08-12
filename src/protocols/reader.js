/**
 * Lector de campos con registro de offsets.
 *
 * El objetivo es que NINGÚN decoder calcule offsets a mano: se piden los bytes
 * en orden y el lector lleva la cuenta. Además va armando la lista `fields`,
 * que es exactamente lo que muestra el panel de depuración de la interfaz:
 * qué bytes de la trama corresponden a qué campo y qué valor salió de ellos.
 *
 * Si sobran bytes al final, `unmapped()` los deja registrados con un TODO en
 * lugar de que el decoder se los invente.
 */
export class FieldReader {
  /**
   * @param {Buffer} buf     bytes a leer (normalmente el payload)
   * @param {number} base    offset absoluto de buf dentro de la trama completa,
   *                         para que los offsets reportados sirvan al depurar
   */
  constructor(buf, base = 0) {
    this.buf = buf;
    this.base = base;
    this.off = 0;
    this.fields = [];
  }

  get remaining() {
    return this.buf.length - this.off;
  }

  get consumed() {
    return this.off;
  }

  has(n) {
    return this.remaining >= n;
  }

  /** Avanza n bytes sin registrar campo. */
  skip(n) {
    this.off += n;
  }

  /**
   * Lee n bytes, registra el campo y devuelve el valor que produzca `fn`.
   * Si no hay suficientes bytes lanza RangeError con un mensaje claro.
   */
  field(nombre, n, fn = (b) => b.toString('hex'), nota) {
    if (this.remaining < n) {
      throw new RangeError(
        `campo "${nombre}" necesita ${n} byte(s) y solo quedan ${this.remaining} en offset ${this.base + this.off}`,
      );
    }
    const slice = this.buf.subarray(this.off, this.off + n);
    const offsetAbs = this.base + this.off;
    this.off += n;
    const valor = fn(slice);
    this.fields.push({
      nombre,
      offset: offsetAbs,
      len: n,
      hex: slice.toString('hex').toUpperCase(),
      valor: normalizeValue(valor),
      ...(nota ? { nota } : {}),
    });
    return valor;
  }

  /** Registra un campo derivado (no consume bytes). Útil para flags. */
  derived(nombre, valor, nota) {
    this.fields.push({ nombre, offset: null, len: 0, hex: '', valor: normalizeValue(valor), derivado: true, ...(nota ? { nota } : {}) });
    return valor;
  }

  /** Devuelve lo que quede sin consumir, sin registrarlo. */
  rest() {
    const slice = this.buf.subarray(this.off);
    this.off = this.buf.length;
    return slice;
  }

  /**
   * Marca los bytes restantes como NO mapeados. Devuelve el objeto que va a
   * `attributes.unmapped`, o null si no sobró nada.
   */
  unmapped(nota = 'TODO: bytes no mapeados con certeza. Confirmar contra la documentación del firmware antes de darles significado.') {
    if (this.remaining <= 0) return null;
    const slice = this.buf.subarray(this.off);
    const offsetAbs = this.base + this.off;
    this.off = this.buf.length;
    const entry = { offset: offsetAbs, len: slice.length, hex: slice.toString('hex').toUpperCase(), nota };
    this.fields.push({
      nombre: 'unmapped',
      offset: offsetAbs,
      len: slice.length,
      hex: entry.hex,
      valor: 'TODO — sin mapear',
      nota,
    });
    return entry;
  }
}

function normalizeValue(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString('hex').toUpperCase();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  return v;
}
