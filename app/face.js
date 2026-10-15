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
/** 顔を見つけるときの入力の大きさ（正方形。YuNet は 640 で固定）。 */
const DET_SIZE = 640;
/** これより小さい顔（縮小後の写真の上の大きさ）は、周りを拡大して探し直す。 */
const SMALL_FACE = 120;
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

/**
 * YuNet で顔と目・鼻・口の位置を見つける（座標は src キャンバス上）。
 * region（{x, y, size}）を指定すると、その正方形の範囲を拡大して探す。
 */
async function detectFaces(src, region = null) {
  const rx = region ? region.x : 0;
  const ry = region ? region.y : 0;
  const rsize = region ? region.size : Math.max(src.width, src.height);
  const scale = DET_SIZE / rsize;
  const canvas = document.createElement('canvas');
  canvas.width = DET_SIZE;
  canvas.height = DET_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, DET_SIZE, DET_SIZE);
  ctx.setTransform(scale, 0, 0, scale, -rx * scale, -ry * scale);
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
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
            ((kps[idx * 10 + 2 * n] + c) * stride) / scale + rx,
            ((kps[idx * 10 + 2 * n + 1] + r) * stride) / scale + ry,
          ]);
        }
        faces.push({
          score,
          box: [(cx - bw / 2) / scale + rx, (cy - bh / 2) / scale + ry, bw / scale, bh / scale],
          points,
        });
      }
    }
  }
  for (const t of Object.values(out)) t.dispose && t.dispose();
  return nms(faces);
}

/**
 * 小さい顔（全身写真など）は、その周りを拡大して探し直し、目・鼻・口の位置を正確にする。
 * YuNet の入力は 640 で固定のため、写真全体だと小さい顔の位置がずれやすい。
 */
async function refineSmallFaces(src, faces) {
  const result = [];
  for (const face of faces) {
    const [x, y, w, h] = face.box;
    const side = Math.max(w, h);
    if (side >= SMALL_FACE) {
      result.push(face);
      continue;
    }
    // 顔の大きさの約5倍の正方形を、640 に拡大して探す
    const size = Math.max(side * 5, 160);
    const region = { x: x + w / 2 - size / 2, y: y + h / 2 - size / 2, size };
    const found = await detectFaces(src, region);
    let best = null;
    for (const f of found) {
      const overlap = iou(f, face);
      if (overlap > 0.3 && (!best || overlap > best.overlap)) best = { f, overlap };
    }
    result.push(best ? best.f : face);
  }
  return result;
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
  const { score, faceCount } = await judgeCanvas(canvas, registered);
  const thumbnail = makeThumbnail(canvas);
  canvas.width = 0;
  canvas.height = 0;
  return { score, faceCount, thumbnail };
}

/** キャンバスの中の顔を判定する（いちばん似ている顔の点数と、顔の数）。 */
async function judgeCanvas(canvas, registered) {
  const detected = await refineSmallFaces(canvas, await detectFaces(canvas));
  let best = null;
  for (const face of detected) {
    const emb = await embed(align(canvas, face.points));
    const s = scoreAgainst(registered, emb);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return { score: best, faceCount: detected.length };
}

/** 一覧に表示する小さな見本画像（メモリを節約するため、元の写真は持たない）。 */
function makeThumbnail(canvas) {
  const t = document.createElement('canvas');
  const ts = 240 / Math.max(canvas.width, canvas.height);
  t.width = Math.round(canvas.width * ts);
  t.height = Math.round(canvas.height * ts);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

/** 動画の長さと大きさだけを読む（同じ動画を見分けるため）。 */
/**
 * 動画を開く。iPhone の Safari は、画面に置いていない動画や、一度も再生していない動画は
 * 中身を読み込まないため、見えない小さな形で画面に置き、音を消して一瞬だけ再生して止める。
 */
async function openVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.preload = 'auto';
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
  document.body.append(video);
  video.src = url;
  const close = () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  };
  try {
    await waitFor(video, 'loadedmetadata', 30000);
    try {
      await video.play();
      video.pause();
    } catch (_) {
      // 再生できなくても、読み込みが進むことがあるので続ける
    }
    return { video, close };
  } catch (err) {
    close();
    throw err;
  }
}

/** 指定の時刻に移動して、画像を描ける状態になるまで待つ。 */
async function seekTo(video, time) {
  const seeked = waitFor(video, 'seeked', 20000);
  video.currentTime = time;
  await seeked;
  if (video.readyState < 2) await waitFor(video, 'canplay', 10000);
}

/** 動画の長さと大きさだけを読む（同じ動画を見分けるため）。 */
export async function videoInfo(file) {
  const { video, close } = await openVideo(file);
  try {
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  } finally {
    close();
  }
}

/** これより長い動画は、娘が写っていても自動では共有せず「要確認」にする（Android と同じ）。 */
export const MAX_AUTO_VIDEO_SEC = 180;

function waitFor(el, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('動画の読み込みに時間がかかりすぎました')); }, timeoutMs);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('動画を読み込めませんでした')); };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
    };
    el.addEventListener(event, onOk);
    el.addEventListener('error', onErr);
  });
}

/**
 * 動画を判定する。動画全体から均等に最大30枚（2秒に1枚まで）の画像を取り出して判定し、
 * はっきり写っている場面が見つかれば、そこで終える（Android と同じ）。
 * 返り値：{ score, duration, width, height, tooLong, thumbnail, framesChecked, framesWithFace }
 */
export async function judgeVideo(file, registered, uploadThreshold, { stopEarly = true } = {}) {
  const { video, close } = await openVideo(file);
  try {
    const duration = video.duration;
    const tooLong = duration > MAX_AUTO_VIDEO_SEC;
    const count = Math.max(1, Math.min(30, Math.ceil(duration / 2)));
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');

    let best = null;
    let checked = 0;
    let withFace = 0;
    let thumbnail = '';
    for (let i = 0; i < count; i++) {
      await seekTo(video, Math.min(duration * (i + 0.5) / count, Math.max(duration - 0.05, 0)));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (!thumbnail) thumbnail = makeThumbnail(canvas);
      const r = await judgeCanvas(canvas, registered);
      checked++;
      if (r.faceCount > 0) withFace++;
      if (r.score !== null && (best === null || r.score > best)) best = r.score;
      if (stopEarly && !tooLong && best !== null && best >= uploadThreshold) break;
    }
    const result = {
      score: best, duration, width: video.videoWidth, height: video.videoHeight,
      tooLong, thumbnail, framesChecked: checked, framesWithFace: withFace,
    };
    canvas.width = 0;
    canvas.height = 0;
    return result;
  } finally {
    close();
  }
}
