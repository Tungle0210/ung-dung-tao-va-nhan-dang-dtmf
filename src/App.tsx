import React, { useMemo, useRef, useState } from "react";
import "./tailwind.css";

const LOW_FREQS = [697, 770, 852, 941];
const HIGH_FREQS = [1209, 1336, 1477];

const KEYPAD: Record<string, [number, number]> = {
  "1": [697, 1209],
  "2": [697, 1336],
  "3": [697, 1477],
  "4": [770, 1209],
  "5": [770, 1336],
  "6": [770, 1477],
  "7": [852, 1209],
  "8": [852, 1336],
  "9": [852, 1477],
  "*": [941, 1209],
  "0": [941, 1336],
  "#": [941, 1477],
};

const REVERSE_KEYPAD: Record<string, string> = {};
Object.entries(KEYPAD).forEach(([key, value]) => {
  REVERSE_KEYPAD[value.join("-")] = key;
});

const FS = 8000;
const DURATION = 0.6;

type DetectResult = {
  key: string;
  lowFreq: number;
  highFreq: number;
  lowScore: number;
  highScore: number;
};

function generateDTMF(key: string, fs = FS, duration = DURATION): Float32Array {
  const [f1, f2] = KEYPAD[key];
  const n = Math.floor(fs * duration);
  const data = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const t = i / fs;
    data[i] =
      0.45 *
      (Math.sin(2 * Math.PI * f1 * t) +
        Math.sin(2 * Math.PI * f2 * t));
  }

  const fadeLength = Math.floor(0.01 * fs);
  for (let i = 0; i < fadeLength; i++) {
    const gain = i / fadeLength;
    data[i] *= gain;
    data[data.length - 1 - i] *= gain;
  }

  return data;
}

function toneEnergy(data: Float32Array, fs: number, freq: number): number {
  let real = 0;
  let imag = 0;
  const step = (2 * Math.PI * freq) / fs;

  for (let i = 0; i < data.length; i++) {
    real += data[i] * Math.cos(step * i);
    imag -= data[i] * Math.sin(step * i);
  }

  return Math.sqrt(real * real + imag * imag) / data.length;
}

function detectDTMF(data: Float32Array, fs = FS): DetectResult {
  const maxLen = Math.min(data.length, Math.floor(fs * 0.8));
  const cut = data.slice(0, maxLen);

  const lowList = LOW_FREQS.map((freq) => ({
    freq,
    score: toneEnergy(cut, fs, freq),
  }));

  const highList = HIGH_FREQS.map((freq) => ({
    freq,
    score: toneEnergy(cut, fs, freq),
  }));

  const low = lowList.reduce((a, b) => (b.score > a.score ? b : a));
  const high = highList.reduce((a, b) => (b.score > a.score ? b : a));

  const average =
    cut.reduce((sum, value) => sum + Math.abs(value), 0) / cut.length;

  let key = REVERSE_KEYPAD[`${low.freq}-${high.freq}`] || "Không rõ";

  if (average < 0.005 || low.score < 0.015 || high.score < 0.015) {
    key = "Không nhận dạng";
  }

  return {
    key,
    lowFreq: low.freq,
    highFreq: high.freq,
    lowScore: low.score,
    highScore: high.score,
  };
}

function makeSpectrum(data: Float32Array): { freq: number; score: number }[] {
  const allFreqs = [...LOW_FREQS, ...HIGH_FREQS];
  return allFreqs.map((freq) => ({
    freq,
    score: toneEnergy(data, FS, freq),
  }));
}

function downloadWav(samples: Float32Array, fs: number, filename: string) {
  const length = samples.length;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, text: string) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, fs, true);
  view.setUint32(28, fs * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (let i = 0; i < length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  const blob = new Blob([view], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Waveform({ data }: { data: Float32Array }) {
  const path = useMemo(() => {
    const width = 760;
    const height = 190;
    const mid = height / 2;
    const maxPoint = 700;
    let d = "";

    for (let i = 0; i < maxPoint; i++) {
      const index = Math.floor((i / maxPoint) * data.length);
      const x = (i / (maxPoint - 1)) * width;
      const y = mid - data[index] * 80;

      if (i === 0) {
        d += `M ${x} ${y}`;
      } else {
        d += ` L ${x} ${y}`;
      }
    }

    return d;
  }, [data]);

  return (
    <svg className="wavebox" viewBox="0 0 760 190">
      <line x1="0" y1="95" x2="760" y2="95" stroke="#cbd5e1" />
      <path d={path} fill="none" stroke="#2563eb" strokeWidth="2" />
    </svg>
  );
}

function Spectrum({
  data,
  detected,
}: {
  data: Float32Array;
  detected: DetectResult;
}) {
  const spectrum = useMemo(() => makeSpectrum(data), [data]);
  const max = Math.max(...spectrum.map((item) => item.score), 0.001);

  return (
    <div className="spectrum">
      {spectrum.map((item) => {
        const height = Math.max(10, (item.score / max) * 170);
        const active =
          item.freq === detected.lowFreq || item.freq === detected.highFreq;

        return (
          <div className="barItem" key={item.freq}>
            <div
              className={active ? "bar active" : "bar"}
              style={{ height: `${height}px` }}
            ></div>
            <div className="freqText">{item.freq}</div>
            <div className="hzText">Hz</div>
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [selectedKey, setSelectedKey] = useState("5");
  const [samples, setSamples] = useState<Float32Array>(() =>
    generateDTMF("5")
  );
  const [sourceName, setSourceName] = useState("Tín hiệu tạo từ phím 5");
  const [detected, setDetected] = useState<DetectResult>(() =>
    detectDTMF(generateDTMF("5"))
  );

  const audioContextRef = useRef<AudioContext | null>(null);

  function createKey(key: string) {
    const data = generateDTMF(key);
    setSelectedKey(key);
    setSamples(data);
    setSourceName(`Tín hiệu tạo từ phím ${key}`);
    setDetected(detectDTMF(data));
  }

  async function playSound() {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;

    const ctx =
      audioContextRef.current || new AudioContextClass();

    audioContextRef.current = ctx;

    const buffer = ctx.createBuffer(1, samples.length, FS);
    buffer.copyToChannel(samples, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  }

  function recognize() {
    setDetected(detectDTMF(samples));
  }

  async function openAudio(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;

    const ctx =
      audioContextRef.current || new AudioContextClass();

    audioContextRef.current = ctx;

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const channel = audioBuffer.getChannelData(0);
    const srcFs = audioBuffer.sampleRate;
    const maxLen = Math.min(channel.length, Math.floor(srcFs * 0.8));
    const raw = channel.slice(0, maxLen);

    let data: Float32Array;

    if (srcFs === FS) {
      data = new Float32Array(raw);
    } else {
      const newLen = Math.floor((raw.length * FS) / srcFs);
      data = new Float32Array(newLen);

      for (let i = 0; i < newLen; i++) {
        const oldIndex = Math.floor((i * srcFs) / FS);
        data[i] = raw[oldIndex] || 0;
      }
    }

    setSamples(data);
    setSourceName(`File âm thanh: ${file.name}`);
    setDetected(detectDTMF(data));
  }

  const keyRows = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["*", "0", "#"],
  ];

  return (
    <div className="page">
      <div className="container">
        <div className="header">
          <div>
            <div className="badge">Đề tài 11 - DTMF</div>
            <h1>Ứng dụng tạo và nhận dạng DTMF</h1>
            <p>
              Ứng dụng tạo âm phím điện thoại, phát âm thanh, vẽ dạng sóng,
              phân tích phổ tần số và nhận dạng phím bằng xử lý tín hiệu số.
            </p>
          </div>

          <div className="resultCard">
            <div className="smallText">Kết quả nhận dạng</div>
            <div className="bigResult">{detected.key}</div>
            <div className="freqResult">
              {detected.lowFreq} Hz + {detected.highFreq} Hz
            </div>
          </div>
        </div>

        <div className="grid">
          <div className="left">
            <div className="card">
              <h2>Bàn phím DTMF</h2>
              <div className="keypad">
                {keyRows.flat().map((key) => (
                  <button
                    key={key}
                    className={selectedKey === key ? "key activeKey" : "key"}
                    onClick={() => createKey(key)}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>

            <div className="card">
              <h2>Chức năng</h2>

              <button className="mainButton" onClick={playSound}>
                Phát âm
              </button>

              <button className="darkButton" onClick={recognize}>
                Nhận dạng
              </button>

              <label className="grayButton">
                Mở file âm thanh
                <input
                  type="file"
                  accept="audio/*,.wav"
                  onChange={openAudio}
                  hidden
                />
              </label>

              <button
                className="grayButton"
                onClick={() => downloadWav(samples, FS, `dtmf_${selectedKey}.wav`)}
              >
                Tải file WAV
              </button>
            </div>

            <div className="card">
              <h2>Bảng tần số DTMF</h2>
              <div className="table">
                {Object.entries(KEYPAD).map(([key, [f1, f2]]) => (
                  <div className="tableRow" key={key}>
                    <b>Phím {key}</b>
                    <span>
                      {f1} Hz + {f2} Hz
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="right">
            <div className="card">
              <div className="cardTop">
                <h2>Tín hiệu miền thời gian</h2>
                <span>{sourceName}</span>
              </div>
              <Waveform data={samples} />
            </div>

            <div className="card">
              <div className="cardTop">
                <h2>Phổ tần số DTMF</h2>
                <span>fs = {FS} Hz</span>
              </div>
              <Spectrum data={samples} detected={detected} />
            </div>

            <div className="card">
              <h2>Nguyên lý hoạt động</h2>
              <div className="theory">
                <div>
                  <h3>1. Tạo tín hiệu</h3>
                  <p>
                    Mỗi phím DTMF là tổng của hai sóng sin: một tần số thấp
                    và một tần số cao.
                  </p>
                </div>

                <div>
                  <h3>2. Phân tích phổ</h3>
                  <p>
                    Ứng dụng đo năng lượng tại 7 tần số chuẩn của DTMF:
                    697, 770, 852, 941, 1209, 1336, 1477 Hz.
                  </p>
                </div>

                <div>
                  <h3>3. Nhận dạng</h3>
                  <p>
                    Tần số thấp mạnh nhất và tần số cao mạnh nhất được ghép
                    lại để suy ra phím đã bấm.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer>
          Đề tài: Xây dựng ứng dụng tạo và nhận dạng tín hiệu DTMF bằng xử lý tín hiệu số.
        </footer>
      </div>
    </div>
  );
}