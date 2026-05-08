/* =========================================================
   封入封緘タイムキーパー  メインスクリプト（Vanilla JS + Three.js）
   - 3D キャラクター表示（Three.js + GLTFLoader）
   - 作業/休憩タイマー（複数セット対応）
   - Web Speech API で音声通知
   ========================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* =========================================================
   1. 3D キャラクター表示
   ========================================================= */

// ---- DOM ----
const canvasContainer = document.getElementById('canvas-container');
const fileInput       = document.getElementById('glb-file');
const resetModelBtn   = document.getElementById('reset-model-btn');

// ---- Three.js 基本セットアップ ----
const scene = new THREE.Scene();
scene.background = null; // 透過（CSS の背景を活かす）

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 1.2, 4);
camera.lookAt(0, 0.8, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
canvasContainer.appendChild(renderer.domElement);

// ライティング（環境光 + 平行光 + 補助光）
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(3, 5, 4);
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0xfff3c4, 0.4);
fillLight.position.set(-3, 2, -2);
scene.add(fillLight);

// 床（軽い影の代わりに丸い影風プレート）
const shadowGeo = new THREE.CircleGeometry(0.9, 32);
const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.15
});
const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
shadowMesh.rotation.x = -Math.PI / 2;
shadowMesh.position.y = -0.001;
scene.add(shadowMesh);

// ---- プレースホルダーモデル（かわいいキャラ風 Box+球の組み合わせ）----
let currentModel = null;        // 現在表示中のモデル（または Group）
let mixer = null;               // GLTF アニメ用 Mixer
const clock = new THREE.Clock();

/**
 * シンプルなプレースホルダーキャラクターを作成して返す
 * （実モデル読み込み前のデフォルト表示）
 */
function createPlaceholder() {
    const group = new THREE.Group();

    // 体（青いボックス）
    const bodyGeo = new THREE.BoxGeometry(1.0, 1.0, 1.0);
    const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x60a5fa, roughness: 0.4, metalness: 0.1
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.5;
    group.add(body);

    // 頭（白い球）
    const headGeo = new THREE.SphereGeometry(0.45, 32, 32);
    const headMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.5
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.4;
    group.add(head);

    // 目（黒い球を 2 つ）
    const eyeGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.15, 1.45, 0.4);
    eyeR.position.set( 0.15, 1.45, 0.4);
    group.add(eyeL, eyeR);

    // ほっぺ（ピンクの円板）
    const cheekGeo = new THREE.CircleGeometry(0.07, 16);
    const cheekMat = new THREE.MeshStandardMaterial({
        color: 0xfca5a5, transparent: true, opacity: 0.8
    });
    const cheekL = new THREE.Mesh(cheekGeo, cheekMat);
    const cheekR = new THREE.Mesh(cheekGeo, cheekMat);
    cheekL.position.set(-0.28, 1.32, 0.42);
    cheekR.position.set( 0.28, 1.32, 0.42);
    group.add(cheekL, cheekR);

    // 「封筒」を持たせる（小さな白い箱）
    const envGeo = new THREE.BoxGeometry(0.5, 0.05, 0.35);
    const envMat = new THREE.MeshStandardMaterial({
        color: 0xfef3c7, roughness: 0.7
    });
    const env = new THREE.Mesh(envGeo, envMat);
    env.position.set(0, 0.55, 0.55);
    env.rotation.x = -0.2;
    group.add(env);

    return group;
}

/**
 * シーンから現在のモデルを取り除き、Mixer もクリアする
 */
function clearCurrentModel() {
    if (currentModel) {
        scene.remove(currentModel);
        // 簡易的なリソース解放
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

/**
 * GLTF/GLB ファイルをロードして表示する
 * @param {ArrayBuffer|string} input  ArrayBuffer または URL
 */
function loadGLB(input) {
    const loader = new GLTFLoader();
    const onLoad = (gltf) => {
        clearCurrentModel();

        const model = gltf.scene;
        // モデルをバウンディングボックスから自動でリサイズ＆中央寄せする
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        // 高さを 2.0 に正規化
        const desired = 2.0;
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = desired / maxDim;
        model.scale.setScalar(scale);

        // 中心を原点に。床に乗るように Y を持ち上げ
        model.position.x = -center.x * scale;
        model.position.z = -center.z * scale;
        model.position.y = -box.min.y * scale;

        scene.add(model);
        currentModel = model;

        // GLTF にアニメーションがあれば Mixer をセットアップして全部再生
        if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(model);
            gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
        }
    };
    const onError = (err) => {
        console.error('GLB の読み込みに失敗:', err);
        alert('モデルの読み込みに失敗しました。ファイルを確認してください。');
    };

    if (input instanceof ArrayBuffer) {
        loader.parse(input, '', onLoad, onError);
    } else {
        loader.load(input, onLoad, undefined, onError);
    }
}

// 初期化: プレースホルダー表示
function showPlaceholder() {
    clearCurrentModel();
    currentModel = createPlaceholder();
    scene.add(currentModel);
}
showPlaceholder();

// ---- リサイズ対応 ----
function resizeRenderer() {
    const rect = canvasContainer.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
const resizeObserver = new ResizeObserver(resizeRenderer);
resizeObserver.observe(canvasContainer);
resizeRenderer();

// ---- 描画ループ ----
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    // GLTF アニメ Mixer 進行
    if (mixer) mixer.update(delta);

    // モデルを自動でゆっくり回転（アイドル）
    if (currentModel) {
        currentModel.rotation.y += delta * 0.5; // 約 30度/秒
        // ふわっと上下に動く（呼吸イメージ）
        const t = clock.elapsedTime;
        currentModel.position.y += Math.sin(t * 2) * 0.0008;
    }

    renderer.render(scene, camera);
}
animate();

// ---- ファイル入力 ----
fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => loadGLB(ev.target.result);
    reader.readAsArrayBuffer(file);
});

resetModelBtn.addEventListener('click', () => {
    showPlaceholder();
    fileInput.value = '';
});

// ---- ドラッグ＆ドロップ ----
['dragenter', 'dragover'].forEach((evt) => {
    canvasContainer.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        canvasContainer.classList.add('dragover');
    });
});
['dragleave', 'drop'].forEach((evt) => {
    canvasContainer.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
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
   2. Web Speech API ラッパ
   ========================================================= */

const synth = window.speechSynthesis;
let availableVoices = [];
let preferredVoice = null;
const voiceSelect = document.getElementById('voice-select');

/**
 * 利用可能な音声を取得し、セレクトボックスを構築する
 */
function loadVoices() {
    if (!synth) return;
    availableVoices = synth.getVoices();

    // 日本語 → その他 の順で並び替え
    availableVoices.sort((a, b) => {
        const aJa = /ja/i.test(a.lang) ? 0 : 1;
        const bJa = /ja/i.test(b.lang) ? 0 : 1;
        return aJa - bJa;
    });

    voiceSelect.innerHTML = '';
    availableVoices.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceSelect.appendChild(opt);
    });

    // 既定の優先音声: 日本語があればそれ、なければ先頭
    preferredVoice = availableVoices.find(v => /ja/i.test(v.lang)) || availableVoices[0] || null;
    if (preferredVoice) {
        const idx = availableVoices.indexOf(preferredVoice);
        voiceSelect.value = String(idx);
    }
}

if (synth) {
    loadVoices();
    // Chrome 系ではここで遅延ロードされる
    synth.onvoiceschanged = loadVoices;
}

voiceSelect.addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10);
    preferredVoice = availableVoices[idx] || preferredVoice;
});

/**
 * 文章を読み上げる
 * @param {string} text
 */
function speak(text) {
    if (!synth) return; // 非対応ブラウザ
    try {
        // 連続再生時の取りこぼしを避けるため一旦キャンセル
        synth.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = preferredVoice?.lang || 'ja-JP';
        if (preferredVoice) utter.voice = preferredVoice;
        utter.rate = 1.0;
        utter.pitch = 1.05;
        utter.volume = 1.0;
        synth.speak(utter);
    } catch (err) {
        console.warn('音声合成エラー:', err);
    }
}


/* =========================================================
   3. タイマー本体
   ========================================================= */

// ---- DOM ----
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

// SVG の円周長（CSS と一致させる）
const RING_CIRC = 2 * Math.PI * 100; // ≈ 628.318

// ---- 状態 ----
const STATE = Object.freeze({
    IDLE:  'idle',
    WORK:  'work',
    BREAK: 'break',
    DONE:  'done',
});

const timerState = {
    phase: STATE.IDLE,        // 現在のフェーズ
    isRunning: false,         // 動作中？
    currentSet: 0,            // 何セット目か（1 始まり、IDLE 時は 0）
    totalSets: 3,             // 設定セット数
    workSec: 25 * 60,         // 設定: 作業秒数
    breakSec: 5 * 60,         // 設定: 休憩秒数
    remainingSec: 0,          // フェーズの残り秒
    phaseTotalSec: 0,         // 現フェーズの全体秒
    encouragedHalf: false,    // このフェーズで「半分通過」発話済みか
    encouragedFive: false,    // 「残り5分」発話済みか
    intervalId: null,         // setInterval のハンドル
};

/**
 * mm:ss 形式に整形
 */
function formatTime(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/**
 * 画面表示を更新する
 */
function updateUI() {
    // 残り時間
    timeRemainingEl.textContent = formatTime(timerState.remainingSec);

    // 残り 10 秒以下なら警告アニメ
    if (timerState.isRunning && timerState.remainingSec <= 10 && timerState.remainingSec > 0) {
        timeRemainingEl.classList.add('warning');
    } else {
        timeRemainingEl.classList.remove('warning');
    }

    // セット情報
    if (timerState.phase === STATE.IDLE) {
        setInfo.textContent = `セット 0 / ${timerState.totalSets}`;
    } else {
        setInfo.textContent = `セット ${timerState.currentSet} / ${timerState.totalSets}`;
    }

    // ステータスラベル & body class
    document.body.classList.remove('state-idle', 'state-work', 'state-break', 'state-done');
    statusLabel.classList.remove('status-idle', 'status-work', 'status-break', 'status-done');

    switch (timerState.phase) {
        case STATE.WORK:
            document.body.classList.add('state-work');
            statusLabel.classList.add('status-work');
            statusLabel.textContent = '作業中';
            phaseText.textContent = '集中していこう！';
            break;
        case STATE.BREAK:
            document.body.classList.add('state-break');
            statusLabel.classList.add('status-break');
            statusLabel.textContent = '休憩中';
            phaseText.textContent = 'ひと息つこう ☕';
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

    // 円形プログレス
    let progress = 0; // 0 → 1
    if (timerState.phaseTotalSec > 0 && timerState.phase !== STATE.IDLE && timerState.phase !== STATE.DONE) {
        progress = 1 - (timerState.remainingSec / timerState.phaseTotalSec);
        progress = Math.max(0, Math.min(1, progress));
    } else if (timerState.phase === STATE.DONE) {
        progress = 1;
    }
    progressRingFg.style.strokeDashoffset = String(RING_CIRC * (1 - progress));

    // ボタンの活性
    startBtn.disabled = timerState.isRunning || timerState.phase === STATE.DONE;
    pauseBtn.disabled = !timerState.isRunning;
    // スタートボタンの文言: 一時停止後は「再開」
    if (timerState.phase !== STATE.IDLE && timerState.phase !== STATE.DONE && !timerState.isRunning) {
        startBtn.textContent = '▶ 再開';
    } else {
        startBtn.textContent = '▶ スタート';
    }
}

/**
 * 設定値を入力欄から取り込む
 */
function readSettings() {
    const w = Math.max(1, parseInt(workInput.value, 10) || 25);
    const b = Math.max(1, parseInt(breakInput.value, 10) || 5);
    const s = Math.max(1, parseInt(setsInput.value, 10) || 3);
    timerState.workSec   = w * 60;
    timerState.breakSec  = b * 60;
    timerState.totalSets = s;
}

/**
 * 作業フェーズ開始
 */
function startWorkPhase() {
    timerState.phase = STATE.WORK;
    timerState.phaseTotalSec = timerState.workSec;
    timerState.remainingSec  = timerState.workSec;
    timerState.encouragedHalf = false;
    timerState.encouragedFive = false;
    speak(`セット ${timerState.currentSet} 、作業を開始します。がんばりましょう！`);
    updateUI();
}

/**
 * 休憩フェーズ開始
 */
function startBreakPhase() {
    timerState.phase = STATE.BREAK;
    timerState.phaseTotalSec = timerState.breakSec;
    timerState.remainingSec  = timerState.breakSec;
    timerState.encouragedHalf = false;
    timerState.encouragedFive = false;
    speak('作業終了です！休憩時間だよ！');
    updateUI();
}

/**
 * 全完了
 */
function finishAll() {
    timerState.phase = STATE.DONE;
    timerState.isRunning = false;
    timerState.remainingSec = 0;
    if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
    }
    speak('すべての作業が完了しました。お疲れ様でした！');
    updateUI();
}

/**
 * 1 秒ごとのチック処理
 */
function tick() {
    if (!timerState.isRunning) return;

    timerState.remainingSec -= 1;

    // 励ましボイス（作業中のみ）
    if (
        timerState.phase === STATE.WORK &&
        encourageToggle.checked &&
        timerState.phaseTotalSec > 0
    ) {
        // 半分経過: phaseTotal の半分を切った最初のチック
        const halfSec = Math.floor(timerState.phaseTotalSec / 2);
        if (!timerState.encouragedHalf && timerState.remainingSec === halfSec) {
            const remainMin = Math.max(1, Math.ceil(timerState.remainingSec / 60));
            speak(`折り返しだよ。あと${remainMin}分！がんばろう！`);
            timerState.encouragedHalf = true;
        }
        // 残り 5 分（フェーズが 5 分以上ある時のみ）
        if (
            !timerState.encouragedFive &&
            timerState.phaseTotalSec > 5 * 60 &&
            timerState.remainingSec === 5 * 60
        ) {
            speak('あと5分！がんばろう！');
            timerState.encouragedFive = true;
        }
    }

    // フェーズ終了判定
    if (timerState.remainingSec <= 0) {
        timerState.remainingSec = 0;

        if (timerState.phase === STATE.WORK) {
            // 作業終了
            if (timerState.currentSet >= timerState.totalSets) {
                // 最終セットの作業終了 = 全完了（最後の休憩はスキップ）
                finishAll();
                return;
            } else {
                // 休憩へ
                startBreakPhase();
            }
        } else if (timerState.phase === STATE.BREAK) {
            // 休憩終了 → 次セットの作業へ
            timerState.currentSet += 1;
            if (timerState.currentSet > timerState.totalSets) {
                finishAll();
                return;
            }
            startWorkPhase();
        }
    }

    updateUI();
}

/**
 * スタート（または再開）
 */
function onStart() {
    if (timerState.isRunning) return;

    // 完了状態だった場合はリセット扱い
    if (timerState.phase === STATE.DONE) {
        resetTimer();
    }

    // 初回スタート
    if (timerState.phase === STATE.IDLE) {
        readSettings();
        timerState.currentSet = 1;
        startWorkPhase();
    }

    // 入力欄のロック（動作中の編集を防ぐ）
    [workInput, breakInput, setsInput].forEach(el => el.disabled = true);

    timerState.isRunning = true;
    if (!timerState.intervalId) {
        timerState.intervalId = setInterval(tick, 1000);
    }
    updateUI();
}

/**
 * 一時停止
 */
function onPause() {
    if (!timerState.isRunning) return;
    timerState.isRunning = false;
    if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
    }
    // 一時停止時は読み上げも止める
    if (synth) synth.cancel();
    updateUI();
}

/**
 * リセット
 */
function resetTimer() {
    if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
    }
    if (synth) synth.cancel();

    readSettings();
    timerState.phase = STATE.IDLE;
    timerState.isRunning = false;
    timerState.currentSet = 0;
    timerState.remainingSec = 0;
    timerState.phaseTotalSec = 0;
    timerState.encouragedHalf = false;
    timerState.encouragedFive = false;

    [workInput, breakInput, setsInput].forEach(el => el.disabled = false);
    updateUI();
}

// ---- イベント ----
startBtn.addEventListener('click', onStart);
pauseBtn.addEventListener('click', onPause);
resetBtn.addEventListener('click', resetTimer);

// 入力欄の変更（待機中のみ即時反映）
[workInput, breakInput, setsInput].forEach((el) => {
    el.addEventListener('change', () => {
        if (timerState.phase === STATE.IDLE) {
            readSettings();
            updateUI();
        }
    });
});

// ---- 初期化 ----
readSettings();
resetTimer();

// 初回タップ/クリックで音声合成のロックを解除（モバイル対策）
document.addEventListener('click', () => {
    if (synth && !synth.speaking) {
        // 空の発話を一度走らせる（無音）
        const u = new SpeechSynthesisUtterance('');
        synth.speak(u);
    }
}, { once: true });
