// 勝手にシェア ブラウザ版（iPhone 用）
// W1：ログイン、初回の参加手順（共有フォルダと顔データを選ぶ）、ホーム画面

// 公開しても問題ない値（クライアントID、プロジェクト番号、サイト専用に制限した鍵）
const CLIENT_ID = '105389208635-hchoa8luaeve7hf9bec6qf8o1krm4sns.apps.googleusercontent.com';
const APP_ID = '105389208635';
const API_KEY = 'AIzaSyCeRWLNiz-JnJl0PInXSoowZS2wYh2gyFI';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = '勝手にシェア';
const FACE_FILE = 'face-data.json';

// 設定（共有フォルダと顔データの id）は、この端末と、利用者のドライブの設定ファイルの両方に保存する。
// Safari が端末のデータを消しても、ドライブから読み戻せるようにするため。
const STORE_KEY = 'katte-ni-share-web';
const CONFIG_FILE = 'katte-ni-share-web.json';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const LINK_FOLDER = params.get('folder');
const LINK_FACE = params.get('face');

const state = {
  token: null,
  email: '',
  config: loadLocal(),
  owner: false,
  faces: 0,
  faceUpdated: '',
};
let tokenClient = null;
let pickerReady = false;

// ---------- 端末への保存 ----------

function loadLocal() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { return {}; }
}
function saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.config)); } catch (_) {}
}

// ---------- Google ドライブ ----------

async function drive(path, query = {}, init = {}) {
  const url = new URL(path.startsWith('http') ? path : API + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: 'Bearer ' + state.token, ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(res.status + ' ' + text.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/** id のファイルを、このアプリが使えるか（使えなければ null）。 */
async function tryGet(id, fields = 'id,name,mimeType,ownedByMe') {
  if (!id) return null;
  try { return await drive('/files/' + id, { fields }); } catch (_) { return null; }
}

/** ドライブの設定ファイルを読む（無ければ null）。 */
async function readDriveConfig() {
  const r = await drive('/files', {
    q: `name = '${CONFIG_FILE}' and trashed = false`,
    fields: 'files(id)',
    spaces: 'drive',
  });
  const file = (r.files || [])[0];
  if (!file) return null;
  const data = await drive('/files/' + file.id, { alt: 'media' });
  return { fileId: file.id, data };
}

/** ドライブの設定ファイルに保存する（あれば上書き、無ければ作る）。 */
async function writeDriveConfig() {
  const data = {
    folderId: state.config.folderId,
    faceId: state.config.faceId,
    updatedAt: new Date().toISOString(),
  };
  const existing = await readDriveConfig().catch(() => null);
  const body = JSON.stringify(data);
  if (existing) {
    await drive(`https://www.googleapis.com/upload/drive/v3/files/${existing.fileId}`,
      { uploadType: 'media' },
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return;
  }
  const boundary = 'katte' + Date.now();
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: CONFIG_FILE, mimeType: 'application/json' }) + '\r\n' +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n` +
    `--${boundary}--`;
  await drive('https://www.googleapis.com/upload/drive/v3/files',
    { uploadType: 'multipart', fields: 'id' },
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
}

// ---------- ログイン ----------

window.gisLoaded = () => {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) {
        $('startStatus').textContent = 'ログインできませんでした：' + resp.error;
        $('start').disabled = false;
        return;
      }
      state.token = resp.access_token;
      state.tokenAt = Date.now();
      if (state.refreshing) {
        // ログインの延長（ホーム画面から）。設定の読み直しは不要
        state.refreshing = false;
        $('message').textContent = 'ログインを延長しました。もう一度ボタンを押してください。';
        return;
      }
      afterLogin().catch((e) => {
        $('startStatus').textContent = 'エラーが発生しました：' + (e.message || e);
        $('start').disabled = false;
      });
    },
    error_callback: (err) => {
      $('startStatus').textContent = 'ログインの画面が開けませんでした：' + (err.type || err.message || err);
      $('start').disabled = false;
    },
  });
  $('start').disabled = false;
  $('startStatus').textContent = '';
};

window.gapiLoaded = () => {
  gapi.load('picker', () => { pickerReady = true; });
};

$('start').addEventListener('click', () => {
  $('start').disabled = true;
  $('startStatus').textContent = 'ログインしています…';
  tokenClient.requestAccessToken();
});

async function afterLogin() {
  $('startStatus').textContent = '設定を確かめています…';
  try {
    const about = await drive('/about', { fields: 'user(emailAddress)' });
    state.email = about.user.emailAddress;
  } catch (_) {}

  await findConfig();
  if (state.config.folderId && state.config.faceId) {
    await showHome();
  } else {
    showSetup();
  }
}

/**
 * 共有フォルダと顔データの id を、次の順に探して、使えるものを採用する。
 * 1. この端末に保存した設定  2. ドライブの設定ファイル  3. 参加リンク
 * 4. 自分が持ち主なら、名前で探す
 */
async function findConfig() {
  const candidates = [];
  candidates.push({ ...loadLocal() });
  const fromDrive = await readDriveConfig().catch(() => null);
  if (fromDrive && fromDrive.data) candidates.push(fromDrive.data);
  if (LINK_FOLDER || LINK_FACE) candidates.push({ folderId: LINK_FOLDER, faceId: LINK_FACE });

  const config = {};
  for (const c of candidates) {
    if (!config.folderId) {
      const f = await tryGet(c.folderId);
      if (f && f.mimeType === FOLDER_MIME) {
        config.folderId = f.id;
        config.folderName = f.name;
        state.owner = !!f.ownedByMe;
      }
    }
    if (!config.faceId) {
      const f = await tryGet(c.faceId);
      if (f && f.name === FACE_FILE) config.faceId = f.id;
    }
  }

  // 持ち主（Android の利用者）は、選ばなくても名前で見つけられる
  if (!config.folderId || !config.faceId) {
    try {
      if (!config.folderId) {
        const r = await drive('/files', {
          q: `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and 'me' in owners and trashed = false`,
          fields: 'files(id,name)',
          spaces: 'drive',
        });
        const f = (r.files || [])[0];
        if (f) { config.folderId = f.id; config.folderName = f.name; state.owner = true; }
      }
      if (!config.faceId && state.owner) {
        const r = await drive('/files', {
          q: `name = '${FACE_FILE}' and 'me' in owners and trashed = false`,
          fields: 'files(id)',
          spaces: 'drive',
        });
        const f = (r.files || [])[0];
        if (f) config.faceId = f.id;
      }
    } catch (_) {}
  }

  const changed = config.folderId !== state.config.folderId || config.faceId !== state.config.faceId;
  state.config = config;
  saveLocal();
  if (changed && config.folderId && config.faceId) {
    await writeDriveConfig().catch(() => {});
  }
}

// ---------- 初回の参加手順 ----------

function showSetup() {
  $('startCard').hidden = true;
  $('setupCard').hidden = false;
  $('homeCard').hidden = true;
  $('folderPicked').textContent = state.config.folderId ? '選択済み：' + state.config.folderName : '未選択';
  $('facePicked').textContent = state.config.faceId ? '選択済み' : '未選択';
  if (!LINK_FOLDER || !LINK_FACE) {
    $('pickerLog').textContent = '※ 参加リンクから開いていないため、名前で探します。見つからないときは、家族に参加リンクを送ってもらってください。';
  }
}

function openPicker(view, title, onPicked) {
  if (!pickerReady) {
    $('pickerLog').textContent = '選択画面の準備中です。少し待ってからもう一度押してください。';
    return;
  }
  $('pickerLog').textContent = '選択画面を開いています…';
  new google.picker.PickerBuilder()
    .setAppId(APP_ID)
    .setOAuthToken(state.token)
    .setDeveloperKey(API_KEY)
    .setOrigin(location.protocol + '//' + location.host)
    .setLocale('ja')
    .setTitle(title)
    .enableFeature(google.picker.Feature.NAV_HIDDEN)
    .addView(view)
    .setCallback((data) => {
      const action = data[google.picker.Response.ACTION];
      if (action !== google.picker.Action.PICKED) {
        $('pickerLog').textContent = '選択画面：' + action;
        return;
      }
      $('pickerLog').textContent = '';
      const doc = data[google.picker.Response.DOCUMENTS][0];
      onPicked(doc[google.picker.Document.ID], doc[google.picker.Document.NAME],
        doc[google.picker.Document.MIME_TYPE]);
    })
    .build()
    .setVisible(true);
}

async function afterPicked() {
  showSetup();
  if (state.config.folderId && state.config.faceId) {
    saveLocal();
    await writeDriveConfig().catch(() => {});
    await showHome();
  }
}

function onFolderPicked(id, name, mime) {
  if (mime !== FOLDER_MIME) {
    $('folderPicked').textContent = 'フォルダではありません。もう一度「勝手にシェア」を選んでください';
    return;
  }
  state.config.folderId = id;
  state.config.folderName = name;
  afterPicked();
}

function onFacePicked(id, name) {
  if (name !== FACE_FILE) {
    $('facePicked').textContent = '「face-data.json」ではありません。もう一度選んでください';
    return;
  }
  state.config.faceId = id;
  afterPicked();
}

$('pickFolder').addEventListener('click', () => {
  const view = LINK_FOLDER
    ? new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setFileIds(LINK_FOLDER)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMode(google.picker.DocsViewMode.LIST)
    : new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setSelectFolderEnabled(true)
      .setMimeTypes(FOLDER_MIME)
      .setQuery(FOLDER_NAME)
      .setMode(google.picker.DocsViewMode.LIST);
  openPicker(view, '「勝手にシェア」フォルダを選んでください', onFolderPicked);
});

$('pickFolderAlt').addEventListener('click', () => {
  const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
    .setOwnedByMe(false)
    .setMimeTypes(FOLDER_MIME)
    .setSelectFolderEnabled(true)
    .setMode(google.picker.DocsViewMode.LIST);
  openPicker(view, '「勝手にシェア」フォルダを選んでください', onFolderPicked);
});

$('pickFace').addEventListener('click', () => {
  const view = LINK_FACE
    ? new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setFileIds(LINK_FACE)
      .setMode(google.picker.DocsViewMode.LIST)
    : new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setQuery(FACE_FILE)
      .setMode(google.picker.DocsViewMode.LIST);
  openPicker(view, '「face-data.json」を選んでください', onFacePicked);
});

$('pickFaceAlt').addEventListener('click', () => {
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setQuery(FACE_FILE)
    .setMode(google.picker.DocsViewMode.LIST);
  openPicker(view, '「face-data.json」を選んでください', onFacePicked);
});

// ---------- ホーム ----------

async function showHome() {
  $('startCard').hidden = true;
  $('setupCard').hidden = true;
  $('homeCard').hidden = false;
  $('who').textContent = state.email ? 'ログイン中：' + state.email : '';

  try {
    const meta = await drive('/files/' + state.config.faceId, { fields: 'modifiedTime' });
    const data = await drive('/files/' + state.config.faceId, { alt: 'media' });
    state.faceData = data;
    const persons = (data && data.persons) || [];
    state.faces = persons.reduce((n, p) => n + ((p.faces || []).length), 0);
    const name = persons[0] ? persons[0].name : '';
    const updated = new Date(meta.modifiedTime).toLocaleString('ja-JP');
    $('faceInfo').textContent = `顔データ：${name} ${state.faces}件（${updated} 更新）`;
  } catch (e) {
    $('faceInfo').textContent = '顔データを読めませんでした：' + (e.message || e);
  }

  $('lastInfo').textContent = '前回の記録を読み込んでいます…';
  loadRecords().then(showLastInfo).catch(() => { $('lastInfo').textContent = ''; });

  if (state.owner) {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('folder', state.config.folderId);
    url.searchParams.set('face', state.config.faceId);
    $('joinLink').textContent = url.toString();
    $('joinCard').hidden = false;
  }
}

// ---------- 写真を共有する（W3） ----------

// 処理済みの記録。利用者のドライブに、このアプリが作ったファイルとして保存する。
const RECORDS_FILE = 'katte-ni-share-web-records.json';
const UPLOAD_FOLDER = 'iPhone';
/** ログインの有効期限（約1時間）より前に、延長を求める。 */
const TOKEN_MAX_AGE = 45 * 60 * 1000;

const share = { records: null, recordsFileId: null, folders: {}, running: false };

/** このアプリが作った JSON ファイルを名前で探して読む（無ければ null）。 */
async function readAppJson(name) {
  const r = await drive('/files', { q: `name = '${name}' and trashed = false`, fields: 'files(id)', spaces: 'drive' });
  const file = (r.files || [])[0];
  if (!file) return null;
  return { fileId: file.id, data: await drive('/files/' + file.id, { alt: 'media' }) };
}

/** このアプリの JSON ファイルを保存する（fileId があれば上書き、無ければ作る）。fileId を返す。 */
async function writeAppJson(name, data, fileId) {
  const body = JSON.stringify(data);
  if (fileId) {
    await drive(`https://www.googleapis.com/upload/drive/v3/files/${fileId}`, { uploadType: 'media' },
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return fileId;
  }
  const boundary = 'katte' + Date.now();
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, mimeType: 'application/json' }) + '\r\n' +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await drive('https://www.googleapis.com/upload/drive/v3/files', { uploadType: 'multipart', fields: 'id' },
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
  return r.id;
}

async function loadRecords() {
  if (share.records) return;
  const found = await readAppJson(RECORDS_FILE);
  share.records = (found && found.data) || { version: 1, records: {}, lastTaken: null };
  share.recordsFileId = found ? found.fileId : null;
}

async function saveRecords() {
  share.recordsFileId = await writeAppJson(RECORDS_FILE, share.records, share.recordsFileId);
}

function showLastInfo() {
  const last = share.records && share.records.lastTaken;
  $('lastInfo').textContent = last
    ? `前回は ${new Date(last).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })} 撮影の写真まで処理済みです。`
    : 'まだ共有していません。';
}

/**
 * 同じ写真を見分ける印。撮影日時（秒以下まで）と大きさを使う
 * （iPhone は選ぶたびにファイル名や形式が変わることがあるため）。読めなければ中身の指紋。
 */
async function photoKey(file, exif) {
  if (exif) return `exif:${exif.date}.${exif.subsec}:${exif.width}x${exif.height}`;
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return 'sha:' + Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** フォルダを探し、無ければ作る（このアプリが作ったフォルダだけが見える）。 */
async function findOrCreateFolder(name, parentId) {
  const key = parentId + '/' + name;
  if (share.folders[key]) return share.folders[key];
  const r = await drive('/files', {
    q: `name = '${name}' and '${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)',
  });
  let id = (r.files || [])[0] && r.files[0].id;
  if (!id) {
    id = (await drive('/files', { fields: 'id' }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    })).id;
  }
  share.folders[key] = id;
  return id;
}

/** 写真を元の画質のまま、共有フォルダの「iPhone/年-月」にアップロードする。 */
async function uploadPhoto(file, key, takenAt, score) {
  // 前に途中で止まったときなどに、すでに送ってあれば送らない
  const existing = await drive('/files', {
    q: `appProperties has { key='webKey' and value='${key.replace(/'/g, "\\'")}' } and trashed = false`,
    fields: 'files(id)',
  });
  if (existing.files && existing.files.length) return existing.files[0].id;

  const taken = takenAt || new Date(file.lastModified);
  const month = `${taken.getFullYear()}-${String(taken.getMonth() + 1).padStart(2, '0')}`;
  const iphoneId = await findOrCreateFolder(UPLOAD_FOLDER, state.config.folderId);
  const monthId = await findOrCreateFolder(month, iphoneId);
  const meta = {
    name: file.name || 'IMG.jpg',
    parents: [monthId],
    createdTime: taken.toISOString(),
    modifiedTime: taken.toISOString(),
    appProperties: { webKey: key, score: score === null ? '' : score.toFixed(3) },
  };
  const boundary = 'katte' + Date.now();
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${file.type || 'image/jpeg'}\r\n\r\n`,
    file,
    `\r\n--${boundary}--`,
  ]);
  const r = await drive('https://www.googleapis.com/upload/drive/v3/files', { uploadType: 'multipart', fields: 'id' },
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return r.id;
}

$('share').addEventListener('click', () => {
  if (share.running) return;
  if (Date.now() - (state.tokenAt || 0) > TOKEN_MAX_AGE) {
    // 写真を選ぶ画面はボタンを押したときにしか開けないため、延長のあとでもう一度押してもらう
    state.refreshing = true;
    $('message').textContent = 'ログインを延長しています…';
    tokenClient.requestAccessToken({ prompt: '' });
    return;
  }
  $('shareFiles').click();
});

$('shareFiles').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;
  const person = (state.faceData && state.faceData.persons || [])[0];
  if (!person || !person.faces || !person.faces.length) {
    $('message').textContent = '顔データがありません';
    return;
  }
  share.running = true;
  $('share').disabled = true;
  $('shareCard').hidden = false;
  $('reviewBox').hidden = true;
  $('reviewList').innerHTML = '';
  $('shareCard').scrollIntoView({ behavior: 'smooth' });
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}

  const counts = { uploaded: 0, review: 0, other: 0, skipped: 0, errors: 0 };
  const reviews = [];
  const errors = [];
  try {
    $('shareStatus').textContent = '前回までの記録を読み込んでいます…';
    await loadRecords();
    const face = await import('./face.js?v=w5');
    const exifMod = await import('./exif.js?v=w5');
    await face.loadFaceModels((s) => { if (s) $('shareStatus').textContent = s; });

    $('shareProgress').max = files.length;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      $('shareStatus').textContent = `処理しています… ${i + 1} / ${files.length}`;
      $('shareProgress').value = i;
      try {
        const exif = await exifMod.readExif(file).catch(() => null);
        const key = await photoKey(file, exif);
        const takenAt = exif ? exifMod.exifDate(exif.date) : null;
        const known = share.records.records[key];
        if (known && known.s !== 'r') { counts.skipped++; continue; }

        const r = await face.judgePhoto(file, person.faces);
        const category = categoryOf(r.score);
        const record = { s: 's', score: r.score, t: takenAt ? takenAt.toISOString() : null };
        if (category === 'match') {
          record.s = 'u';
          record.f = await uploadPhoto(file, key, takenAt, r.score);
          counts.uploaded++;
        } else if (category === 'review') {
          record.s = 'r';
          counts.review++;
          reviews.push({ file, key, takenAt, score: r.score, thumbnail: r.thumbnail });
        } else {
          counts.other++;
        }
        share.records.records[key] = record;
        if (takenAt && (!share.records.lastTaken || takenAt > new Date(share.records.lastTaken))) {
          share.records.lastTaken = takenAt.toISOString();
        }
        // 途中で止まっても記録が残るよう、こまめに保存する
        if ((i + 1) % 5 === 0) await saveRecords();
      } catch (err) {
        counts.errors++;
        if (errors.length < 3) errors.push(String(err.message || err));
        if (err.status === 401) {
          errors.push('ログインの有効期限が切れました。もう一度「写真を共有する」を押してください');
          break;
        }
      }
    }
    $('shareProgress').value = files.length;
    await saveRecords();
    $('shareStatus').textContent =
      `完了：共有 ${counts.uploaded}枚・要確認 ${counts.review}枚・ちがう ${counts.other}枚` +
      `・共有済みで飛ばした ${counts.skipped}枚` + (counts.errors ? `・失敗 ${counts.errors}枚` : '');
    $('shareNote').textContent = errors.length ? '失敗の理由：\n' + errors.join('\n') : '';
    showLastInfo();
    showReviews(reviews);
  } catch (err) {
    $('shareStatus').textContent = 'エラーで止まりました：' + (err.message || err);
  } finally {
    if (wakeLock) wakeLock.release().catch(() => {});
    share.running = false;
    $('share').disabled = false;
  }
});

function showReviews(reviews) {
  $('reviewList').innerHTML = '';
  $('reviewBox').hidden = reviews.length === 0;
  for (const item of reviews) {
    const row = document.createElement('div');
    row.className = 'review-item';
    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.addEventListener('click', () => showViewer({ file: item.file, faceCount: '-', score: item.score }));
    const actions = document.createElement('div');
    actions.className = 'actions';
    const text = document.createElement('div');
    text.className = 'muted';
    text.textContent = `似ている度 ${item.score === null ? '-' : Math.round(item.score * 100)}`;
    const yes = document.createElement('button');
    yes.textContent = (state.faceData.persons[0] || {}).name + 'です';
    const no = document.createElement('button');
    no.className = 'secondary';
    no.textContent = '違います';
    const decide = async (isMatch) => {
      yes.disabled = no.disabled = true;
      try {
        const record = share.records.records[item.key] || {};
        if (isMatch) {
          record.f = await uploadPhoto(item.file, item.key, item.takenAt, item.score);
          record.s = 'u';
          text.textContent = '共有しました';
        } else {
          record.s = 's';
          text.textContent = '共有しません';
        }
        share.records.records[item.key] = record;
        await saveRecords();
        yes.remove();
        no.remove();
      } catch (err) {
        text.textContent = 'できませんでした：' + (err.message || err);
        yes.disabled = no.disabled = false;
      }
    };
    yes.addEventListener('click', () => decide(true));
    no.addEventListener('click', () => decide(false));
    actions.append(text, yes, no);
    row.append(img, actions);
    $('reviewList').append(row);
  }
}

$('openFolder').addEventListener('click', () => {
  window.open('https://drive.google.com/drive/folders/' + state.config.folderId, '_blank');
});

$('copyJoin').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('joinLink').textContent);
    $('copyJoin').textContent = 'コピーしました';
  } catch (_) {
    $('copyJoin').textContent = 'コピーできませんでした（下の文字を長押しで選んでください）';
  }
});

// ---------- 判定の試験（W2。アップロードはしない） ----------

const test = { results: [], view: 'match' };

$('openTest').addEventListener('click', () => {
  $('testCard').hidden = false;
  $('testCard').scrollIntoView({ behavior: 'smooth' });
});

$('pickTest').addEventListener('click', () => $('testFiles').click());

function thresholds() {
  const d = state.faceData || {};
  return { upload: d.uploadThreshold ?? 0.55, review: d.reviewThreshold ?? 0.3 };
}

function categoryOf(score) {
  const t = thresholds();
  if (score === null || score < t.review) return 'other';
  if (score < t.upload) return 'review';
  return 'match';
}

$('testFiles').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;
  const person = (state.faceData && state.faceData.persons || [])[0];
  if (!person || !person.faces || person.faces.length === 0) {
    $('testStatus').textContent = '顔データがありません';
    return;
  }
  $('pickTest').disabled = true;
  test.results = [];
  try {
    const face = await import('./face.js?v=w5');
    await face.loadFaceModels((s) => { $('testStatus').textContent = s; });
    const started = performance.now();
    for (let i = 0; i < files.length; i++) {
      $('testStatus').textContent = `判定しています… ${i + 1} / ${files.length}`;
      try {
        const r = await face.judgePhoto(files[i], person.faces);
        test.results.push({ ...r, file: files[i] });
      } catch (err) {
        test.results.push({ score: null, faceCount: 0, thumbnail: '', file: files[i], error: String(err.message || err) });
      }
      renderTest();
    }
    const sec = (performance.now() - started) / 1000 / files.length;
    $('testStatus').textContent = `${files.length}枚を判定しました（1枚あたり ${sec.toFixed(1)}秒）`;
    renderTest(sec);
  } catch (err) {
    $('testStatus').textContent = 'エラーが発生しました：' + (err.message || err);
  } finally {
    $('pickTest').disabled = false;
  }
});

function label(r) {
  if (r.error) return '読めない';
  if (r.score === null) return '顔なし';
  return String(Math.round(r.score * 100));
}

function renderTest(secPerPhoto) {
  const names = { match: (state.faceData.persons[0] || {}).name || '娘', review: '要確認', other: 'ちがう' };
  const counts = { match: 0, review: 0, other: 0 };
  for (const r of test.results) counts[categoryOf(r.score)]++;

  $('testTabs').innerHTML = '';
  for (const key of ['match', 'review', 'other']) {
    const b = document.createElement('button');
    b.textContent = `${names[key]} ${counts[key]}枚`;
    b.className = test.view === key ? 'active' : '';
    b.addEventListener('click', () => { test.view = key; renderTest(secPerPhoto); });
    $('testTabs').append(b);
  }

  $('testGrid').innerHTML = '';
  const shown = test.results
    .filter((r) => categoryOf(r.score) === test.view)
    .sort((p, q) => (q.score ?? -1) - (p.score ?? -1));
  for (const r of shown) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    if (r.thumbnail) {
      const img = document.createElement('img');
      img.src = r.thumbnail;
      tile.append(img);
    }
    const span = document.createElement('span');
    span.textContent = label(r);
    tile.append(span);
    tile.addEventListener('click', () => showViewer(r));
    $('testGrid').append(tile);
  }

  const t = thresholds();
  $('testSummary').textContent =
    `判定の試験（ブラウザ版、${new Date().toLocaleString('ja-JP')}）\n` +
    `端末：${navigator.userAgent}\n` +
    `境目：${names.match} ${Math.round(t.upload * 100)}以上／要確認 ${Math.round(t.review * 100)}以上\n` +
    `${names.match} ${counts.match}枚・要確認 ${counts.review}枚・ちがう ${counts.other}枚` +
    (secPerPhoto ? `（1枚あたり ${secPerPhoto.toFixed(1)}秒）` : '') + '\n' +
    '点数：' + test.results.map(label).join(', ');
  $('testResult').hidden = false;
}

function showViewer(r) {
  const url = URL.createObjectURL(r.file);
  $('viewerImg').src = url;
  $('viewerImg').onload = () => URL.revokeObjectURL(url);
  $('viewerText').textContent =
    `${r.file.name}\n見つかった顔：${r.faceCount}つ・似ている度 ${label(r)}` + (r.error ? `\n${r.error}` : '');
  $('viewer').hidden = false;
}

$('viewerClose').addEventListener('click', () => { $('viewer').hidden = true; $('viewerImg').src = ''; });

$('copyTest').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('testSummary').textContent);
    $('copyTest').textContent = 'コピーしました';
  } catch (_) {
    $('copyTest').textContent = 'コピーできませんでした（下の文字を長押しで選んでください）';
  }
});

$('reset').addEventListener('click', () => {
  if (!confirm('この端末に保存した設定を消しますか？（ドライブの写真や設定は消えません）')) return;
  try { localStorage.removeItem(STORE_KEY); } catch (_) {}
  location.reload();
});
