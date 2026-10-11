/**
 * Array packs: named typed arrays plus a JSON `meta`, in one binary blob that Python
 * writes (tools/pitcher_card/model_pack.py) and the Worker reads straight out of R2.
 *
 *   "PCK1" | uint32 header length | header: UTF-8 JSON, space-padded | array data
 *
 *   header = {"arrays": {name: {dtype, shape, offset, length}}, "meta": {...}}
 *
 * Little-endian. `offset` is in bytes from the start of the array data (byte 8 + header
 * length, a multiple of 8) and is itself a multiple of 8; `length` counts elements. So each
 * array is a view on the buffer it came in -- nothing is copied or parsed but the header.
 */

const TYPES = {
  float32: Float32Array, float64: Float64Array,
  int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array,
  int32: Int32Array, uint32: Uint32Array,
};
const MAGIC = [0x50, 0x43, 0x4b, 0x31];   // "PCK1"

/**
 * A pack from an ArrayBuffer (e.g. `await (await env.BUCKET.get(key)).arrayBuffer()`) or a
 * view of one. Returns `{ meta, arrays, shapes }`: `arrays[name]` is a typed-array view,
 * `shapes[name]` its shape (row-major). A view whose start isn't 8-aligned (a Node Buffer
 * from the shared pool, say) is copied once so the arrays can be aligned.
 */
export function readPack(data) {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("pack: big-endian host");
  let bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteOffset % 8) bytes = bytes.slice();
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("pack: not a PCK1 pack");
  const size = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + size)));
  const base = bytes.byteOffset + 8 + size;
  const end = bytes.byteOffset + bytes.byteLength;

  const arrays = Object.create(null);
  const shapes = Object.create(null);
  for (const [name, e] of Object.entries(header.arrays)) {
    const Type = TYPES[e.dtype];
    if (!Type) throw new Error(`pack: ${name} has unsupported dtype ${e.dtype}`);
    const start = base + e.offset;
    if (start + e.length * Type.BYTES_PER_ELEMENT > end) throw new Error(`pack: ${name} runs past the end`);
    arrays[name] = new Type(bytes.buffer, start, e.length);
    shapes[name] = e.shape;
  }
  return { meta: header.meta, arrays, shapes };
}
