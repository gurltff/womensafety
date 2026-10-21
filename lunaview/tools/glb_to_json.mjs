// Convert a binary glTF (.glb) into JSON glTF with its buffer and images embedded as data URIs,
// so it can be served anywhere that serves .json. Usage: node tools/glb_to_json.mjs in.glb out.json
import fs from 'node:fs';
const [inp, out] = process.argv.slice(2);
const b = fs.readFileSync(inp);
let off = 12, json = null, bin = null;
while (off < b.length) {
  const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
  const chunk = b.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
  if (type === 0x004e4942) bin = chunk;
  off += 8 + len;
}
// Images stored in the buffer become data URIs of their own.
for (const img of json.images ?? []) {
  if (img.bufferView === undefined) continue;
  const v = json.bufferViews[img.bufferView];
  img.uri = `data:${img.mimeType};base64,${bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength).toString('base64')}`;
  delete img.bufferView;
  delete img.mimeType;
}
json.buffers = [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString('base64')}` }];
fs.writeFileSync(out, JSON.stringify(json));
console.log(out, fs.statSync(out).size);
