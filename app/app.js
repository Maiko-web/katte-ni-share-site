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
    const persons = (data && data.persons) || [];
    state.faces = persons.reduce((n, p) => n + ((p.faces || []).length), 0);
    const name = persons[0] ? persons[0].name : '';
    const updated = new Date(meta.modifiedTime).toLocaleString('ja-JP');
    $('faceInfo').textContent = `顔データ：${name} ${state.faces}件（${updated} 更新）`;
  } catch (e) {
    $('faceInfo').textContent = '顔データを読めませんでした：' + (e.message || e);
  }

  if (state.owner) {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('folder', state.config.folderId);
    url.searchParams.set('face', state.config.faceId);
    $('joinLink').textContent = url.toString();
    $('joinCard').hidden = false;
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

$('reset').addEventListener('click', () => {
  if (!confirm('この端末に保存した設定を消しますか？（ドライブの写真や設定は消えません）')) return;
  try { localStorage.removeItem(STORE_KEY); } catch (_) {}
  location.reload();
});
