/* =========================================================
   封入封緘タイムキーパー  メインスクリプト（Vanilla JS + Three.js）
   - 3D キャラクター表示（Three.js + GLTFLoader）
     * 起動時は assets/character.glb を自動ロード
     * ファイル選択 / D&D で差し替え可能
   - タイマー
     * モード1: 時間指定（作業X分・休憩Y分・Nセット）
     * モード2: 時刻指定（08:30-09:50, 10:00-10:50 ... 等を任意行追加）
   - Web Speech API
     * 音声モデル選択 / 話速・音高調整 / 試し再生
     * セリフは UI から編集可能（プレースホルダ {set}/{total}/{remain}/{end} 対応）
   - 設定は localStorage に永続化
   ========================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* =========================================================
   0. 定数 / 既定値
   ========================================================= */

const DEFAULT_GLB_URL = 'assets/character.glb'; // リポジトリ同梱のデフォルト

/** セリフの初期値（プレースホルダ対応）*/
const DEFAULT_SCRIPTS = {
    workStart:      'セット{set}、作業を開始します。終了予定は{end}。集中していこう！',
    breakStart:     'セット{set}、お疲れ様！ここで一息つきましょう。',
    allDone:        'すべての作業が完了しました。本当にお疲れ様でした！',
    encourageHalf:  '折り返し地点だよ。あと{remain}分、ペースを保っていこう！',
    encourageFive: 'あと5分！ラストスパート、がんばろう！',
};

const STORAGE_KEY = 'envelope-timekeeper:v2';

/* =========================================================
   1. 設定の読み込み・保存
   ========================================================= */

/** 既定の設定オブジェクト */
function defaultSettings() {
    return {
        mode: 'duration', // 'duration' | 'schedule'
        workMinutes: 25,
        breakMinutes: 5,
        totalSets: 3,
        // schedule: [{start:'08:30', end:'09:50'}, ...] （break は次行 start との差で算出）
        schedule: [
            { start: '08:30', end: '09:50' },
            { start: '10:00', end: '10:50' },
            { start: '11:00', end: '11:50' },
        ],
        encourage: true,
        voiceName: '',         // 選択された音声名（保存・復元用）
        voiceLang: '',
        voiceRate: 1.0,
        voicePitch: 1.05,
        scripts: { ...DEFAULT_SCRIPTS },
    };
}

/** localStorage から設定を読み込み（壊れていたら既定値）*/
function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return defaultSettings();
        const parsed = JSON.parse(raw);
        // 旧バージョン互換のため既定値とマージ
        const merged = { ...defaultSettings(), ...parsed };
        merged.scripts = { ...DEFAULT_SCRIPTS, ...(parsed.scripts || {}) };
        if (!Array.isArray(merged.schedule) || merged.schedule.length === 0) {
            merged.schedule = defaultSettings().schedule;
        }
        return merged;
    } catch (e) {
        console.warn('設定の読み込みに失敗、既定値を使用します:', e);
        return defaultSettings();
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('設定の保存に失敗:', e);
    }
}

const settings = loadSettings();


/* =========================================================
   2. 3D キャラクター表示（Three.js）
   ========================================================= */

const canvasContainer = document.getElementById('canvas-container');
const fileInput       = document.getElementById('glb-file');
const resetModelBtn   = document.getElementById('reset-model-btn');
const loadingOverlay  = document.getElementById('loading-overlay');

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 1.2, 4);
camera.lookAt(0, 0.8, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
canvasContainer.appendChild(renderer.domElement);

// ライティング
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(3, 5, 4);
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0xfff3c4, 0.4);
fillLight.position.set(-3, 2, -2);
scene.add(fillLight);

// 影風プレート
const shadowMesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.9, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 })
);
shadowMesh.rotation.x = -Math.PI / 2;
shadowMesh.position.y = -0.001;
scene.add(shadowMesh);

let currentModel = null;
let mixer = null;
const clock = new THREE.Clock();

/** プレースホルダー（GLB読み込み失敗時のフォールバック） */
function createPlaceholder() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.0, 1.0, 1.0),
        new THREE.MeshStandardMaterial({ color: 0x60a5fa, roughness: 0.4, metalness: 0.1 })
    );
    body.position.y = 0.5; group.add(body);

    const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 32, 32),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })
    );
    head.position.y = 1.4; group.add(head);

    const eyeGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.15, 1.45, 0.4);
    eyeR.position.set( 0.15, 1.45, 0.4);
    group.add(eyeL, eyeR);

    const cheekGeo = new THREE.CircleGeometry(0.07, 16);
    const cheekMat = new THREE.MeshStandardMaterial({ color: 0xfca5a5, transparent: true, opacity: 0.8 });
    const cheekL = new THREE.Mesh(cheekGeo, cheekMat);
    const cheekR = new THREE.Mesh(cheekGeo, cheekMat);
    cheekL.position.set(-0.28, 1.32, 0.42);
    cheekR.position.set( 0.28, 1.32, 0.42);
    group.add(cheekL, cheekR);

    const env = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.05, 0.35),
        new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.7 })
    );
    env.position.set(0, 0.55, 0.55);
    env.rotation.x = -0.2;
    group.add(env);

    return group;
}

function clearCurrentModel() {
    if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse?.((obj) => {
            if (obj.geometry) obj.geometry.dispose?.();
            if (obj.material) {
                if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose?.());
                else obj.material.dispose?.();
            }
        });
        currentModel = null;
    }
    mixer = null;
}

/** モデルをシーンに配置（自動正規化）*/
function placeModel(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const desired = 2.0;
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = desired / maxDim;
    model.scale.setScalar(scale);
    model.position.x = -center.x * scale;
    model.position.z = -center.z * scale;
    model.position.y = -box.min.y * scale;
    scene.add(model);
    currentModel = model;
}

/** GLB の ArrayBuffer / URL からロード */
function loadGLB(input) {
    const loader = new GLTFLoader();
    showLoading(true);

    const onLoad = (gltf) => {
        clearCurrentModel();
        const model = gltf.scene;
        placeModel(model);
        if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(model);
            gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
        }
        showLoading(false);
    };
    const onError = (err) => {
        console.warn('GLB の読み込みに失敗、プレースホルダーを表示します:', err);
        showPlaceholder();
        showLoading(false);
    };

    if (input instanceof ArrayBuffer) {
        loader.parse(input, '', onLoad, onError);
    } else {
        loader.load(input, onLoad, undefined, onError);
    }
}

function showPlaceholder() {
    clearCurrentModel();
    currentModel = createPlaceholder();
    scene.add(currentModel);
}

function showLoading(visible) {
    loadingOverlay.classList.toggle('visible', visible);
}

/** デフォルトGLB（リポジトリ同梱）を読み込む。失敗時はプレースホルダー */
function loadDefaultModel() {
    showLoading(true);
    // HEAD で存在確認 → 無ければプレースホルダー
    fetch(DEFAULT_GLB_URL, { method: 'HEAD' })
        .then((res) => {
            if (res.ok) {
                loadGLB(DEFAULT_GLB_URL);
            } else {
                showPlaceholder();
                showLoading(false);
            }
        })
        .catch(() => {
            showPlaceholder();
            showLoading(false);
        });
}

// 初期化
loadDefaultModel();

// リサイズ
function resizeRenderer() {
    const rect = canvasContainer.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
new ResizeObserver(resizeRenderer).observe(canvasContainer);
resizeRenderer();

// 描画ループ
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);
    if (currentModel) {
        currentModel.rotation.y += delta * 0.5;
        const t = clock.elapsedTime;
        currentModel.position.y += Math.sin(t * 2) * 0.0008;
    }
    renderer.render(scene, camera);
}
animate();

// ファイル入力
fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => loadGLB(ev.target.result);
    reader.readAsArrayBuffer(file);
});
resetModelBtn.addEventListener('click', () => {
    fileInput.value = '';
    loadDefaultModel();
});

// D&D
['dragenter', 'dragover'].forEach((evt) => {
    canvasContainer.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        canvasContainer.classList.add('dragover');
    });
});
['dragleave', 'drop'].forEach((evt) => {
    canvasContainer.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        canvasContainer.classList.remove('dragover');
    });
});
canvasContainer.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(glb|gltf)$/i.test(file.name)) {
        alert('.glb または .gltf ファイルをドロップしてください。');
        return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => loadGLB(ev.target.result);
    reader.readAsArrayBuffer(file);
});


/* =========================================================
   3. Web Speech API
   ========================================================= */

const synth = window.speechSynthesis;
let availableVoices = [];
let preferredVoice = null;
const voiceSelect = document.getElementById('voice-select');
const voiceRate   = document.getElementById('voice-rate');
const voicePitch  = document.getElementById('voice-pitch');
const voiceRateVal  = document.getElementById('voice-rate-val');
const voicePitchVal = document.getElementById('voice-pitch-val');
const previewBtn    = document.getElementById('voice-preview-btn');
const stopBtn       = document.getElementById('voice-stop-btn');

function loadVoices() {
    if (!synth) return;
    availableVoices = synth.getVoices();
    // 日本語優先
    availableVoices.sort((a, b) => {
        const aJa = /ja/i.test(a.lang) ? 0 : 1;
        const bJa = /ja/i.test(b.lang) ? 0 : 1;
        if (aJa !== bJa) return aJa - bJa;
        return a.name.localeCompare(b.name);
    });

    voiceSelect.innerHTML = '';
    if (availableVoices.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = '(利用可能な音声がありません)';
        opt.disabled = true;
        voiceSelect.appendChild(opt);
        return;
    }

    availableVoices.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceSelect.appendChild(opt);
    });

    // 保存済みの音声を復元、なければ日本語、最後の砦は先頭
    let restored = null;
    if (settings.voiceName) {
        restored = availableVoices.find(v => v.name === settings.voiceName && v.lang === settings.voiceLang)
                || availableVoices.find(v => v.name === settings.voiceName);
    }
    preferredVoice = restored
                  || availableVoices.find(v => /ja/i.test(v.lang))
                  || availableVoices[0];
    if (preferredVoice) {
        voiceSelect.value = String(availableVoices.indexOf(preferredVoice));
    }
}

if (synth) {
    loadVoices();
    synth.onvoiceschanged = loadVoices;
}

voiceSelect.addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10);
    preferredVoice = availableVoices[idx] || preferredVoice;
    if (preferredVoice) {
        settings.voiceName = preferredVoice.name;
        settings.voiceLang = preferredVoice.lang;
        saveSettings();
    }
});

voiceRate.addEventListener('input', () => {
    voiceRateVal.textContent = parseFloat(voiceRate.value).toFixed(2);
    settings.voiceRate = parseFloat(voiceRate.value);
    saveSettings();
});
voicePitch.addEventListener('input', () => {
    voicePitchVal.textContent = parseFloat(voicePitch.value).toFixed(2);
    settings.voicePitch = parseFloat(voicePitch.value);
    saveSettings();
});

/** 文章を読み上げる */
function speak(text) {
    if (!synth || !text) return;
    try {
        synth.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = preferredVoice?.lang || 'ja-JP';
        if (preferredVoice) utter.voice = preferredVoice;
        utter.rate = settings.voiceRate || 1.0;
        utter.pitch = settings.voicePitch || 1.05;
        utter.volume = 1.0;
        synth.speak(utter);
    } catch (err) {
        console.warn('音声合成エラー:', err);
    }
}

previewBtn.addEventListener('click', () => {
    speak('これは音声プレビューです。話速や音の高さの確認にどうぞ。');
});
stopBtn.addEventListener('click', () => {
    if (synth) synth.cancel();
});

/** {set}/{total}/{remain}/{end} を埋め込む */
function fillTemplate(tpl, ctx) {
    return (tpl || '')
        .replaceAll('{set}',    String(ctx.set ?? ''))
        .replaceAll('{total}',  String(ctx.total ?? ''))
        .replaceAll('{remain}', String(ctx.remain ?? ''))
        .replaceAll('{end}',    String(ctx.end ?? ''));
}


/* =========================================================
   4. セリフ編集 UI
   ========================================================= */

const scriptInputs = {
    workStart:     document.getElementById('script-work-start'),
    breakStart:    document.getElementById('script-break-start'),
    allDone:       document.getElementById('script-all-done'),
    encourageHalf: document.getElementById('script-encourage-half'),
    encourageFive: document.getElementById('script-encourage-five'),
};
const scriptResetBtn = document.getElementById('script-reset-btn');

function renderScripts() {
    for (const key of Object.keys(scriptInputs)) {
        scriptInputs[key].value = settings.scripts[key] ?? DEFAULT_SCRIPTS[key];
    }
}
function bindScriptInputs() {
    for (const key of Object.keys(scriptInputs)) {
        scriptInputs[key].addEventListener('input', () => {
            settings.scripts[key] = scriptInputs[key].value;
            saveSettings();
        });
    }
}
scriptResetBtn.addEventListener('click', () => {
    settings.scripts = { ...DEFAULT_SCRIPTS };
    renderScripts();
    saveSettings();
});


/* =========================================================
   5. タイマー本体（時間指定 / 時刻指定 両対応）
   ========================================================= */

const startBtn        = document.getElementById('start-btn');
const pauseBtn        = document.getElementById('pause-btn');
const resetBtn        = document.getElementById('reset-btn');
const workInput       = document.getElementById('work-minutes');
const breakInput      = document.getElementById('break-minutes');
const setsInput       = document.getElementById('total-sets');
const encourageToggle = document.getElementById('encourage-toggle');

const statusLabel     = document.getElementById('status-label');
const setInfo         = document.getElementById('set-info');
const timeRemainingEl = document.getElementById('time-remaining');
const phaseText       = document.getElementById('phase-text');
const progressRingFg  = document.getElementById('progress-ring-fg');

const modeTabs        = document.querySelectorAll('.mode-tab');
const modePanes = {
    duration: document.getElementById('mode-duration'),
    schedule: document.getElementById('mode-schedule'),
};
const scheduleList    = document.getElementById('schedule-list');
const addScheduleBtn  = document.getElementById('add-schedule-btn');
const presetScheduleBtn = document.getElementById('preset-schedule-btn');

const RING_CIRC = 2 * Math.PI * 100;

const STATE = Object.freeze({ IDLE: 'idle', WORK: 'work', BREAK: 'break', DONE: 'done' });

const timerState = {
    phase: STATE.IDLE,
    isRunning: false,
    plan: [],          // 実行プラン: [{type:'work'|'break', sec:Number, setNo:Number?, endHHMM:String?}]
    planIndex: 0,
    currentSet: 0,
    totalSets: 0,
    remainingSec: 0,
    phaseTotalSec: 0,
    phaseEndHHMM: '',  // 現フェーズの終了時刻表示用
    encouragedHalf: false,
    encouragedFive: false,
    intervalId: null,
};

function formatTime(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** Date を HH:MM 文字列に */
function toHHMM(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

/** "HH:MM" を本日の Date に変換（過去なら翌日扱いはしない、null許容）*/
function parseHHMMToDate(hhmm, base = new Date()) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return null;
    const d = new Date(base);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    return d;
}

/* ---------- モード切替 ---------- */

function setMode(mode) {
    settings.mode = mode;
    saveSettings();
    modeTabs.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    Object.entries(modePanes).forEach(([k, el]) => el.classList.toggle('active', k === mode));
}
modeTabs.forEach(btn => {
    btn.addEventListener('click', () => {
        if (timerState.isRunning) {
            alert('動作中はモードを切り替えできません。');
            return;
        }
        setMode(btn.dataset.mode);
        renderScheduleSkippedFlags(); // 経過済表示更新
    });
});

/* ---------- duration モード入力 ---------- */

function bindDurationInputs() {
    const sync = () => {
        settings.workMinutes  = Math.max(1, parseInt(workInput.value, 10) || 1);
        settings.breakMinutes = Math.max(0, parseInt(breakInput.value, 10) || 0);
        settings.totalSets    = Math.max(1, parseInt(setsInput.value, 10) || 1);
        saveSettings();
    };
    [workInput, breakInput, setsInput].forEach(el => el.addEventListener('change', sync));
}

/* ---------- schedule モード（行管理） ---------- */

/** スケジュールリストの再描画 */
function renderScheduleList() {
    scheduleList.innerHTML = '';
    settings.schedule.forEach((row, idx) => {
        const div = document.createElement('div');
        div.className = 'schedule-row';
        div.dataset.idx = idx;
        div.innerHTML = `
            <span class="row-num">${idx + 1}</span>
            <input type="time" class="row-start" value="${row.start || ''}">
            <span class="row-tilde">〜</span>
            <input type="time" class="row-end" value="${row.end || ''}">
            <button class="row-remove" title="この行を削除" aria-label="削除">×</button>
        `;
        // 入力変更
        div.querySelector('.row-start').addEventListener('change', (e) => {
            settings.schedule[idx].start = e.target.value;
            saveSettings();
            renderScheduleSkippedFlags();
        });
        div.querySelector('.row-end').addEventListener('change', (e) => {
            settings.schedule[idx].end = e.target.value;
            saveSettings();
            renderScheduleSkippedFlags();
        });
        // 削除
        div.querySelector('.row-remove').addEventListener('click', () => {
            if (settings.schedule.length <= 1) {
                alert('最低 1 行は必要です。');
                return;
            }
            settings.schedule.splice(idx, 1);
            saveSettings();
            renderScheduleList();
        });
        scheduleList.appendChild(div);
    });
    renderScheduleSkippedFlags();
}

/** 既に過ぎた行に skipped クラスを付与（視覚的表示） */
function renderScheduleSkippedFlags() {
    const now = new Date();
    [...scheduleList.children].forEach((div, idx) => {
        const row = settings.schedule[idx];
        const end = parseHHMMToDate(row.end, now);
        div.classList.toggle('skipped', !!(end && end <= now));
    });
}

addScheduleBtn.addEventListener('click', () => {
    // 直前の行の終了時刻 +10分 を新規 start にする提案
    const last = settings.schedule[settings.schedule.length - 1];
    let nextStart = '13:00', nextEnd = '13:50';
    if (last && last.end) {
        const ed = parseHHMMToDate(last.end);
        if (ed) {
            ed.setMinutes(ed.getMinutes() + 10);
            nextStart = toHHMM(ed);
            ed.setMinutes(ed.getMinutes() + 50);
            nextEnd = toHHMM(ed);
        }
    }
    settings.schedule.push({ start: nextStart, end: nextEnd });
    saveSettings();
    renderScheduleList();
});

presetScheduleBtn.addEventListener('click', () => {
    settings.schedule = [
        { start: '08:30', end: '09:50' },
        { start: '10:00', end: '10:50' },
        { start: '11:00', end: '11:50' },
        { start: '13:00', end: '14:50' },
        { start: '15:00', end: '16:50' },
    ];
    saveSettings();
    renderScheduleList();
});

/* ---------- プラン構築 ---------- */

/** duration モード から実行プランを作る */
function buildPlanFromDuration() {
    const plan = [];
    const total = settings.totalSets;
    for (let i = 1; i <= total; i++) {
        plan.push({ type: 'work', sec: settings.workMinutes * 60, setNo: i });
        if (i < total && settings.breakMinutes > 0) {
            plan.push({ type: 'break', sec: settings.breakMinutes * 60, setNo: i });
        }
    }
    return plan;
}

/** schedule モード から実行プランを作る（現在時刻以降のセットのみ） */
function buildPlanFromSchedule() {
    const now = new Date();
    // バリデーション + 経過済除外 + 並び替え
    const valid = settings.schedule
        .map((r, i) => {
            const s = parseHHMMToDate(r.start, now);
            const e = parseHHMMToDate(r.end, now);
            return { idx: i, start: s, end: e };
        })
        .filter(x => x.start && x.end && x.end > x.start)
        .sort((a, b) => a.start - b.start);

    if (valid.length === 0) {
        alert('有効な時刻スケジュールがありません。開始<終了 で1行以上入力してください。');
        return null;
    }

    // 経過済（現在時刻 >= end）はスキップ
    const upcoming = valid.filter(x => x.end > now);
    if (upcoming.length === 0) {
        alert('すべてのセットの終了時刻が経過しています。スケジュールを更新してください。');
        return null;
    }

    const plan = [];
    upcoming.forEach((entry, i) => {
        // 1セット目で開始がまだ先 → そのまま開始まで待つのは複雑なので、
        // 「今すぐ作業開始 〜 entry.end」とする
        const startAt = new Date(Math.max(now.getTime(), entry.start.getTime()));
        const sec = Math.max(1, Math.round((entry.end - startAt) / 1000));
        plan.push({
            type: 'work',
            sec,
            setNo: i + 1,
            endHHMM: toHHMM(entry.end),
        });
        // 次の作業との間 = 休憩
        const next = upcoming[i + 1];
        if (next) {
            const breakSec = Math.max(0, Math.round((next.start - entry.end) / 1000));
            if (breakSec > 0) {
                plan.push({
                    type: 'break',
                    sec: breakSec,
                    setNo: i + 1,
                    endHHMM: toHHMM(next.start),
                });
            }
        }
    });
    return plan;
}

/* ---------- フェーズ進行 ---------- */

function startPhase(phaseObj) {
    timerState.phase         = phaseObj.type === 'work' ? STATE.WORK : STATE.BREAK;
    timerState.phaseTotalSec = phaseObj.sec;
    timerState.remainingSec  = phaseObj.sec;
    timerState.phaseEndHHMM  = phaseObj.endHHMM || calcEndHHMM(phaseObj.sec);
    timerState.currentSet    = phaseObj.setNo || timerState.currentSet;
    timerState.encouragedHalf = false;
    timerState.encouragedFive = false;

    const ctx = {
        set:    timerState.currentSet,
        total:  timerState.totalSets,
        remain: Math.ceil(phaseObj.sec / 60),
        end:    timerState.phaseEndHHMM,
    };
    if (phaseObj.type === 'work') {
        speak(fillTemplate(settings.scripts.workStart, ctx));
    } else {
        speak(fillTemplate(settings.scripts.breakStart, ctx));
    }
    updateUI();
}

/** 現在時刻 + sec の HH:MM 文字列 */
function calcEndHHMM(sec) {
    const d = new Date(Date.now() + sec * 1000);
    return toHHMM(d);
}

function finishAll() {
    timerState.phase = STATE.DONE;
    timerState.isRunning = false;
    timerState.remainingSec = 0;
    if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
    }
    const ctx = {
        set: timerState.currentSet,
        total: timerState.totalSets,
        remain: 0,
        end: toHHMM(new Date()),
    };
    speak(fillTemplate(settings.scripts.allDone, ctx));
    updateUI();
}

function tick() {
    if (!timerState.isRunning) return;

    timerState.remainingSec -= 1;

    // 励まし（作業中のみ）
    if (
        timerState.phase === STATE.WORK &&
        encourageToggle.checked &&
        timerState.phaseTotalSec > 0
    ) {
        const halfSec = Math.floor(timerState.phaseTotalSec / 2);
        if (!timerState.encouragedHalf && timerState.remainingSec === halfSec && halfSec > 0) {
            const remainMin = Math.max(1, Math.ceil(timerState.remainingSec / 60));
            speak(fillTemplate(settings.scripts.encourageHalf, {
                set: timerState.currentSet,
                total: timerState.totalSets,
                remain: remainMin,
                end: timerState.phaseEndHHMM,
            }));
            timerState.encouragedHalf = true;
        }
        if (
            !timerState.encouragedFive &&
            timerState.phaseTotalSec > 5 * 60 &&
            timerState.remainingSec === 5 * 60
        ) {
            speak(fillTemplate(settings.scripts.encourageFive, {
                set: timerState.currentSet,
                total: timerState.totalSets,
                remain: 5,
                end: timerState.phaseEndHHMM,
            }));
            timerState.encouragedFive = true;
        }
    }

    if (timerState.remainingSec <= 0) {
        timerState.remainingSec = 0;
        timerState.planIndex += 1;
        if (timerState.planIndex >= timerState.plan.length) {
            finishAll();
            return;
        }
        startPhase(timerState.plan[timerState.planIndex]);
        return;
    }
    updateUI();
}

/* ---------- 操作 ---------- */

function onStart() {
    if (timerState.isRunning) return;

    if (timerState.phase === STATE.DONE) resetTimer();

    if (timerState.phase === STATE.IDLE) {
        const plan = (settings.mode === 'schedule')
            ? buildPlanFromSchedule()
            : buildPlanFromDuration();
        if (!plan || plan.length === 0) return;

        timerState.plan = plan;
        timerState.planIndex = 0;
        timerState.totalSets = plan.filter(p => p.type === 'work').length;
        timerState.currentSet = 0;

        startPhase(plan[0]);
    }

    [workInput, breakInput, setsInput].forEach(el => el.disabled = true);
    setScheduleInputsDisabled(true);

    timerState.isRunning = true;
    if (!timerState.intervalId) {
        timerState.intervalId = setInterval(tick, 1000);
    }
    updateUI();
}

function onPause() {
    if (!timerState.isRunning) return;
    timerState.isRunning = false;
    if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
    }
    if (synth) synth.cancel();
    updateUI();
}

function resetTimer() {
    if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
    }
    if (synth) synth.cancel();

    timerState.phase = STATE.IDLE;
    timerState.isRunning = false;
    timerState.plan = [];
    timerState.planIndex = 0;
    timerState.currentSet = 0;
    timerState.totalSets = 0;
    timerState.remainingSec = 0;
    timerState.phaseTotalSec = 0;
    timerState.phaseEndHHMM = '';
    timerState.encouragedHalf = false;
    timerState.encouragedFive = false;

    [workInput, breakInput, setsInput].forEach(el => el.disabled = false);
    setScheduleInputsDisabled(false);
    renderScheduleSkippedFlags();
    updateUI();
}

function setScheduleInputsDisabled(disabled) {
    scheduleList.querySelectorAll('input,button').forEach(el => el.disabled = disabled);
    addScheduleBtn.disabled = disabled;
    presetScheduleBtn.disabled = disabled;
}

/* ---------- UI 更新 ---------- */

function updateUI() {
    timeRemainingEl.textContent = formatTime(timerState.remainingSec);

    if (timerState.isRunning && timerState.remainingSec <= 10 && timerState.remainingSec > 0) {
        timeRemainingEl.classList.add('warning');
    } else {
        timeRemainingEl.classList.remove('warning');
    }

    if (timerState.phase === STATE.IDLE) {
        setInfo.textContent = `セット 0 / ${guessTotalSetsForDisplay()}`;
    } else {
        setInfo.textContent = `セット ${timerState.currentSet} / ${timerState.totalSets}`;
    }

    document.body.classList.remove('state-idle', 'state-work', 'state-break', 'state-done');
    statusLabel.classList.remove('status-idle', 'status-work', 'status-break', 'status-done');

    switch (timerState.phase) {
        case STATE.WORK:
            document.body.classList.add('state-work');
            statusLabel.classList.add('status-work');
            statusLabel.textContent = '作業中';
            phaseText.textContent = timerState.phaseEndHHMM
                ? `終了予定 ${timerState.phaseEndHHMM}`
                : '集中していこう！';
            break;
        case STATE.BREAK:
            document.body.classList.add('state-break');
            statusLabel.classList.add('status-break');
            statusLabel.textContent = '休憩中';
            phaseText.textContent = timerState.phaseEndHHMM
                ? `次の作業 ${timerState.phaseEndHHMM} から`
                : 'ひと息つこう ☕';
            break;
        case STATE.DONE:
            document.body.classList.add('state-done');
            statusLabel.classList.add('status-done');
            statusLabel.textContent = '完了';
            phaseText.textContent = 'お疲れ様でした！';
            break;
        case STATE.IDLE:
        default:
            document.body.classList.add('state-idle');
            statusLabel.classList.add('status-idle');
            statusLabel.textContent = '待機中';
            phaseText.textContent = 'スタートを押してね';
            break;
    }

    let progress = 0;
    if (timerState.phaseTotalSec > 0 && timerState.phase !== STATE.IDLE && timerState.phase !== STATE.DONE) {
        progress = 1 - (timerState.remainingSec / timerState.phaseTotalSec);
        progress = Math.max(0, Math.min(1, progress));
    } else if (timerState.phase === STATE.DONE) {
        progress = 1;
    }
    progressRingFg.style.strokeDashoffset = String(RING_CIRC * (1 - progress));

    startBtn.disabled = timerState.isRunning || timerState.phase === STATE.DONE;
    pauseBtn.disabled = !timerState.isRunning;
    if (timerState.phase !== STATE.IDLE && timerState.phase !== STATE.DONE && !timerState.isRunning) {
        startBtn.textContent = '▶ 再開';
    } else {
        startBtn.textContent = '▶ スタート';
    }
}

/** IDLE 表示用の「総セット数」推定 */
function guessTotalSetsForDisplay() {
    if (settings.mode === 'duration') return settings.totalSets;
    // schedule: 未経過セット数
    const now = new Date();
    return settings.schedule.filter(r => {
        const e = parseHHMMToDate(r.end, now);
        const s = parseHHMMToDate(r.start, now);
        return s && e && e > s && e > now;
    }).length;
}

/* ---------- イベント ---------- */

startBtn.addEventListener('click', onStart);
pauseBtn.addEventListener('click', onPause);
resetBtn.addEventListener('click', resetTimer);

encourageToggle.addEventListener('change', () => {
    settings.encourage = encourageToggle.checked;
    saveSettings();
});

/* =========================================================
   6. 初期化
   ========================================================= */

function applySettingsToUI() {
    // モード
    setMode(settings.mode);
    // duration 入力
    workInput.value  = settings.workMinutes;
    breakInput.value = settings.breakMinutes;
    setsInput.value  = settings.totalSets;
    // 励まし
    encourageToggle.checked = settings.encourage;
    // 音声
    voiceRate.value  = settings.voiceRate;
    voicePitch.value = settings.voicePitch;
    voiceRateVal.textContent  = settings.voiceRate.toFixed(2);
    voicePitchVal.textContent = settings.voicePitch.toFixed(2);
    // セリフ
    renderScripts();
    // スケジュール
    renderScheduleList();
}

bindDurationInputs();
bindScriptInputs();
applySettingsToUI();
resetTimer();

// 経過済表示を 30 秒ごとに更新
setInterval(() => {
    if (timerState.phase === STATE.IDLE) renderScheduleSkippedFlags();
}, 30 * 1000);

// 初回タップで音声合成のロックを解除（モバイル対策）
document.addEventListener('click', () => {
    if (synth && !synth.speaking) {
        const u = new SpeechSynthesisUtterance('');
        synth.speak(u);
    }
}, { once: true });
