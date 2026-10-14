// 写真の撮影日時と大きさを、JPEG の EXIF から読む（同じ写真を見分けるため）。
// 読めない形式（HEIC など）や EXIF が無い写真は null を返す。

export async function readExif(file) {
  const buf = await file.slice(0, 256 * 1024).arrayBuffer();
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) return null;
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1 && offset + 10 <= view.byteLength &&
        view.getUint32(offset + 4) === 0x45786966) { // "Exif"
      return parseTiff(view, offset + 10);
    }
    if (marker === 0xffda) return null; // 画像本体が始まった
    offset += 2 + length;
  }
  return null;
}

function parseTiff(view, start) {
  if (start + 8 > view.byteLength) return null;
  const little = view.getUint16(start) === 0x4949;
  const u16 = (o) => view.getUint16(start + o, little);
  const u32 = (o) => view.getUint32(start + o, little);
  const ascii = (o, n) => {
    let s = '';
    for (let i = 0; i < n && start + o + i < view.byteLength; i++) {
      const c = view.getUint8(start + o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const readIfd = (ifdOffset) => {
    const tags = {};
    if (start + ifdOffset + 2 > view.byteLength) return tags;
    const count = u16(ifdOffset);
    for (let i = 0; i < count; i++) {
      const e = ifdOffset + 2 + i * 12;
      if (start + e + 12 > view.byteLength) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      let value;
      if (type === 2) value = ascii(n <= 4 ? e + 8 : u32(e + 8), n);
      else if (type === 3) value = u16(e + 8);
      else if (type === 4) value = u32(e + 8);
      tags[tag] = value;
    }
    return tags;
  };
  const ifd0 = readIfd(u32(4));
  const exifPtr = ifd0[0x8769];
  const exif = exifPtr ? readIfd(exifPtr) : {};
  const date = exif[0x9003] || ifd0[0x0132];
  if (!date) return null;
  return {
    date,                              // "2026:10:14 12:34:56"（撮影した場所の時刻）
    subsec: exif[0x9291] || '',
    width: exif[0xa002] || 0,
    height: exif[0xa003] || 0,
  };
}

/** EXIF の日時（"YYYY:MM:DD HH:MM:SS"）を、この端末の時刻として Date にする。 */
export function exifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
