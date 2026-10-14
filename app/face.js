// 勝手にシェア ブラウザ版：顔の判定（iPhone の中で行う。写真は外に出さない）
// 顔を見つける：YuNet（OpenCV Zoo、MIT）／顔を数値にする：SFace（OpenCV Zoo、Apache-2.0。Android と同じ）

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_BASE = 'https://huggingface.co/opencv/opencv_zoo/resolve/main/models/';
const YUNET_URL = MODEL_BASE + 'face_detection_yunet/face_detection_yunet_2023mar.onnx';
const SFACE_URL = MODEL_BASE + 'face_recognition_sface/face_recognition_sface_2021dec.onnx';
const MODEL_CACHE = 'katte-ni-share-models-v1';

/** 写真は長い辺をこの大きさに縮めてから扱う（Android と同じ）。 */
const MAX_SIDE = 1280;
/** 顔を見つけるときの入力の大きさ（正方形）。 */
const DET_SIZE = 640;
const DET_SCORE = 0.6;
const DET_NMS = 0.3;
const SIZE = 112;

/** SFace が想定する、112×112 の中での目・鼻・口の位置（画像の左の目、右の目、鼻、左の口角、右の口角）。 */
const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let ortLoading = null;
let sessions = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('読み込めませんでした：' + src));
    document.head.append(s);
  });
}

/** モデルを取得する。2回目以降は端末に残した分を使う。 */
async function fetchModel(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch (_) {}
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('判定の部品を読み込めませんでした（' + res.status + '）');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  if (cache) {
    try { await cache.put(url, new Response(bytes)); } catch (_) {}
  }
  return bytes;
}

/** 判定の部品を準備する。onStatus に進み具合の文を渡す。 */
export async function loadFaceModels(onStatus = () => {}) {
  if (sessions) return;
  if (!ortLoading) ortLoading = loadScript(ORT_BASE + 'ort.min.js');
  await ortLoading;
  /* global ort */
  ort.env.wasm.wasmPaths = ORT_BASE;
  // GitHub Pages では並列処理の設定（クロスオリジン分離）ができないため、1スレッドで動かす
  ort.env.wasm.numThreads = 1;

  onStatus('判定の部品を読み込んでいます（顔を見つける部品）…');
  const yunet = await fetchModel(YUNET_URL);
  const sface = await fetchModel(SFACE_URL, (loaded, total) => {
    const mb = (loaded / 1e6).toFixed(0);
    onStatus(total
      ? `判定の部品を読み込んでいます… ${mb} / ${(total / 1e6).toFixed(0)} MB`
      : `判定の部品を読み込んでいます… ${mb} MB`);
  });
  onStatus('判定の部品を準備しています…');
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  sessions = {
    yunet: await ort.InferenceSession.create(yunet, opts),
    sface: await ort.InferenceSession.create(sface, opts),
  };
  onStatus('');
}

/** 写真ファイルを読み込み、長い辺を MAX_SIDE 以下にしたキャンバスを返す（回転情報も反映）。 */
async function decode(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/** YuNet で顔と目・鼻・口の位置を見つける（座標は src キャンバス上）。 */
async function detectFaces(src) {
  const scale = DET_SIZE / Math.max(src.width, src.height);
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = DET_SIZE;
  canvas.height = DET_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, DET_SIZE, DET_SIZE);
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, DET_SIZE, DET_SIZE).data;

  // YuNet の入力は BGR、画素値は 0〜255 のまま（NCHW）
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = px[i * 4 + 2];
    input[plane + i] = px[i * 4 + 1];
    input[2 * plane + i] = px[i * 4];
  }
  const session = sessions.yunet;
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]) };
  const out = await session.run(feeds);

  const faces = [];
  for (const stride of [8, 16, 32]) {
    const cls = out['cls_' + stride].data;
    const obj = out['obj_' + stride].data;
    const bbox = out['bbox_' + stride].data;
    const kps = out['kps_' + stride].data;
    const cols = DET_SIZE / stride;
    const rows = DET_SIZE / stride;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const clsScore = Math.min(Math.max(cls[idx], 0), 1);
        const objScore = Math.min(Math.max(obj[idx], 0), 1);
        const score = Math.sqrt(clsScore * objScore);
        if (score < DET_SCORE) continue;
        const cx = (c + bbox[idx * 4]) * stride;
        const cy = (r + bbox[idx * 4 + 1]) * stride;
        const bw = Math.exp(bbox[idx * 4 + 2]) * stride;
        const bh = Math.exp(bbox[idx * 4 + 3]) * stride;
        const points = [];
        for (let n = 0; n < 5; n++) {
          points.push([
            ((kps[idx * 10 + 2 * n] + c) * stride) / scale,
            ((kps[idx * 10 + 2 * n + 1] + r) * stride) / scale,
          ]);
        }
        faces.push({
          score,
          box: [(cx - bw / 2) / scale, (cy - bh / 2) / scale, bw / scale, bh / scale],
          points,
        });
      }
    }
  }
  for (const t of Object.values(out)) t.dispose && t.dispose();
  return nms(faces);
}

function iou(a, b) {
  const [ax, ay, aw, ah] = a.box;
  const [bx, by, bw, bh] = b.box;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (aw * ah + bw * bh - inter);
}

function nms(faces) {
  faces.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of faces) {
    if (kept.every((k) => iou(k, f) < DET_NMS)) kept.push(f);
  }
  return kept;
}

/** 5点がテンプレートの位置に来るように切り抜いた 112×112 のキャンバス（Android と同じ相似変換）。 */
function align(src, rawPoints) {
  // テンプレートと同じ並び（画像の左側が先）にそろえる
  const eyes = [rawPoints[0], rawPoints[1]].sort((p, q) => p[0] - q[0]);
  const mouth = [rawPoints[3], rawPoints[4]].sort((p, q) => p[0] - q[0]);
  const pts = [eyes[0], eyes[1], rawPoints[2], mouth[0], mouth[1]];

  let mx = 0, my = 0, qx = 0, qy = 0;
  for (let i = 0; i < 5; i++) {
    mx += pts[i][0]; my += pts[i][1];
    qx += TEMPLATE[i][0]; qy += TEMPLATE[i][1];
  }
  mx /= 5; my /= 5; qx /= 5; qy /= 5;
  let sxx = 0, sxy = 0, norm = 0;
  for (let i = 0; i < 5; i++) {
    const ax = pts[i][0] - mx, ay = pts[i][1] - my;
    const bx = TEMPLATE[i][0] - qx, by = TEMPLATE[i][1] - qy;
    sxx += ax * bx + ay * by;
    sxy += ax * by - ay * bx;
    norm += ax * ax + ay * ay;
  }
  const a = sxx / norm, b = sxy / norm;
  const tx = qx - (a * mx - b * my);
  const ty = qy - (b * mx + a * my);

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SIZE, SIZE);
  // 写真 → 112×112：x' = a·x − b·y + tx、y' = b·x + a·y + ty
  ctx.setTransform(a, b, -b, a, tx, ty);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0);
  return canvas;
}

/** 112×112 の顔から、特徴データ（長さ1の128個の数値）を計算する。SFace の入力は RGB、0〜255 のまま。 */
async function embed(faceCanvas) {
  const px = faceCanvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = px[i * 4];
    input[plane + i] = px[i * 4 + 1];
    input[2 * plane + i] = px[i * 4 + 2];
  }
  const session = sessions.sface;
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const tensor = out[session.outputNames[0]];
  const v = Array.from(tensor.data);
  tensor.dispose && tensor.dispose();
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / len);
}

/** 登録済みの顔との似ている度合い（上位3件の平均。Android と同じ）。 */
export function scoreAgainst(faces, embedding) {
  const sims = faces.map((f) => {
    let dot = 0;
    for (let i = 0; i < embedding.length; i++) dot += f.embedding[i] * embedding[i];
    return dot;
  }).sort((p, q) => q - p);
  const top = sims.slice(0, 3);
  return top.length ? top.reduce((s, x) => s + x, 0) / top.length : null;
}

/**
 * 写真を判定する。返り値：{ score（顔が無ければ null）, faceCount, thumbnail（小さな見本画像の data URL） }
 * registered：顔データの faces（[{ embedding }]）
 */
export async function judgePhoto(file, registered) {
  const canvas = await decode(file);
  const detected = await detectFaces(canvas);
  let best = null;
  for (const face of detected) {
    const emb = await embed(align(canvas, face.points));
    const s = scoreAgainst(registered, emb);
    if (s !== null && (best === null || s > best)) best = s;
  }
  // 一覧に表示する小さな見本画像（メモリを節約するため、元の写真は持たない）
  const t = document.createElement('canvas');
  const ts = 240 / Math.max(canvas.width, canvas.height);
  t.width = Math.round(canvas.width * ts);
  t.height = Math.round(canvas.height * ts);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  const thumbnail = t.toDataURL('image/jpeg', 0.7);
  canvas.width = 0;
  canvas.height = 0;
  return { score: best, faceCount: detected.length, thumbnail };
}
