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
const TONE_DURATION = 0.35;
const SILENCE_DURATION = 0.12;

type DetectResult = {
  key: string;
  lowFreq: number;
  highFreq: number;
  lowScore: number;
  highScore: number;
};

type SegmentResult = {
  index: number;
  key: string;
  lowFreq: number;
  highFreq: number;
  startTime: number;
  endTime: number;
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
  for (let i = 0; i < fadeLength && i < data.length; i++) {
    const gain = i / fadeLength;
    data[i] *= gain;
    data[data.length - 1 - i] *= gain;
  }

  return data;
}

function generatePhoneDTMF(
  phone: string,
  fs = FS,
  toneDuration = TONE_DURATION,
  silenceDuration = SILENCE_DURATION
): Float32Array {
  const clean = phone.replace(/[^0-9*#]/g, "");
  const toneLen = Math.floor(fs * toneDuration);
  const silenceLen = Math.floor(fs * silenceDuration);
  const totalLen = clean.length * toneLen + Math.max(0, clean.length - 1) * silenceLen;

  const output = new Float32Array(totalLen);
  let offset = 0;

  for (let i = 0; i < clean.length; i++) {
    const tone = generateDTMF(clean[i], fs, toneDuration);
    output.set(tone, offset);
    offset += toneLen;

    if (i !== clean.length - 1) {
      offset += silenceLen;
    }
  }

  return output;
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
    cut.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, cut.length);

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

function detectDTMFSequence(data: Float32Array, fs = FS): {
  sequence: string;
  segments: SegmentResult[];
} {
  if (!data || data.length === 0) {
    return { sequence: "", segments: [] };
  }

  const frameLen = Math.floor(0.02 * fs);
  const hopLen = Math.floor(0.01 * fs);
  const rmsList: number[] = [];

  for (let start = 0; start + frameLen <= data.length; start += hopLen) {
    let sum = 0;
    for (let i = start; i < start + frameLen; i++) {
      sum += data[i] * data[i];
    }
    rmsList.push(Math.sqrt(sum / frameLen));
  }

  const maxRms = Math.max(...rmsList, 0);
  const threshold = Math.max(0.01, maxRms * 0.25);

  const activeFrames = rmsList.map((rms) => rms > threshold);

  const rawSegments: { start: number; end: number }[] = [];
  let inSegment = false;
  let segStartFrame = 0;

  for (let i = 0; i < activeFrames.length; i++) {
    if (activeFrames[i] && !inSegment) {
      inSegment = true;
      segStartFrame = i;
    }

    if ((!activeFrames[i] || i === activeFrames.length - 1) && inSegment) {
      inSegment = false;
      const segEndFrame = activeFrames[i] ? i : i - 1;

      rawSegments.push({
        start: segStartFrame * hopLen,
        end: segEndFrame * hopLen + frameLen,
      });
    }
  }

  const mergedSegments: { start: number; end: number }[] = [];
  const minGap = Math.floor(0.05 * fs);

  for (const seg of rawSegments) {
    if (mergedSegments.length === 0) {
      mergedSegments.push(seg);
      continue;
    }

    const last = mergedSegments[mergedSegments.length - 1];

    if (seg.start - last.end < minGap) {
      last.end = seg.end;
    } else {
      mergedSegments.push(seg);
    }
  }

  const minToneLength = Math.floor(0.08 * fs);
  const results: SegmentResult[] = [];

  mergedSegments.forEach((seg, index) => {
    const start = Math.max(0, seg.start - Math.floor(0.01 * fs));
    const end = Math.min(data.length, seg.end + Math.floor(0.01 * fs));

    if (end - start < minToneLength) return;

    const piece = data.slice(start, end);
    const detected = detectDTMF(piece, fs);

    if (detected.key !== "Không nhận dạng" && detected.key !== "Không rõ") {
      results.push({
        index: results.length + 1,
        key: detected.key,
        lowFreq: detected.lowFreq,
        highFreq: detected.highFreq,
        startTime: start / fs,
        endTime: end / fs,
      });
    }
  });

  return {
    sequence: results.map((item) => item.key).join(""),
    segments: results,
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

    if (!data || data.length === 0) return d;

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
  const [phoneNumber, setPhoneNumber] = useState("0912345678");

  const [samples, setSamples] = useState<Float32Array>(() =>
    generateDTMF("5")
  );

  const [sourceName, setSourceName] = useState("Tín hiệu tạo từ phím 5");

  const [detected, setDetected] = useState<DetectResult>(() =>
    detectDTMF(generateDTMF("5"))
  );

  const [detectedSequence, setDetectedSequence] = useState("");
  const [segments, setSegments] = useState<SegmentResult[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);

  function createKey(key: string) {
    const data = generateDTMF(key);
    setSelectedKey(key);
    setSamples(data);
    setSourceName(`Tín hiệu tạo từ phím ${key}`);
    setDetected(detectDTMF(data));
    setDetectedSequence(key);
    setSegments([
      {
        index: 1,
        key,
        lowFreq: KEYPAD[key][0],
        highFreq: KEYPAD[key][1],
        startTime: 0,
        endTime: DURATION,
      },
    ]);
  }

  function createPhoneSignal() {
    const clean = phoneNumber.replace(/[^0-9*#]/g, "");

    if (clean.length === 0) {
      alert("Hãy nhập số điện thoại gồm các ký tự 0-9, * hoặc #.");
      return;
    }

    const data = generatePhoneDTMF(clean);
    const result = detectDTMFSequence(data);

    setSamples(data);
    setSourceName(`Tín hiệu DTMF của số: ${clean}`);
    setDetectedSequence(result.sequence);
    setSegments(result.segments);

    if (result.segments.length > 0) {
      const first = result.segments[0];
      setDetected({
        key: first.key,
        lowFreq: first.lowFreq,
        highFreq: first.highFreq,
        lowScore: 0,
        highScore: 0,
      });
    }
  }

  async function playSound() {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
  
    const ctx = audioContextRef.current || new AudioContextClass();
    audioContextRef.current = ctx;
  
    // Mở khóa âm thanh trên điện thoại
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  
    // Điện thoại thường chạy 44100 Hz hoặc 48000 Hz
    const targetFs = ctx.sampleRate;
  
    // Resample từ FS = 8000 Hz sang sampleRate thật của điện thoại
    const newLength = Math.floor((samples.length * targetFs) / FS);
    const resampled = new Float32Array(newLength);
  
    for (let i = 0; i < newLength; i++) {
      const oldIndex = i * FS / targetFs;
      const index0 = Math.floor(oldIndex);
      const index1 = Math.min(index0 + 1, samples.length - 1);
      const frac = oldIndex - index0;
  
      const s0 = samples[index0] || 0;
      const s1 = samples[index1] || 0;
  
      resampled[i] = s0 * (1 - frac) + s1 * frac;
    }
  
    const buffer = ctx.createBuffer(1, resampled.length, targetFs);
    buffer.copyToChannel(resampled, 0);
  
    const source = ctx.createBufferSource();
    source.buffer = buffer;
  
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1.0;
  
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
  
    source.start(0);
  }

  function recognizeOneTone() {
    const result = detectDTMF(samples);
    setDetected(result);
    setDetectedSequence(result.key);
    setSegments([
      {
        index: 1,
        key: result.key,
        lowFreq: result.lowFreq,
        highFreq: result.highFreq,
        startTime: 0,
        endTime: samples.length / FS,
      },
    ]);
  }

  function recognizePhoneNumber() {
    const result = detectDTMFSequence(samples);
    setDetectedSequence(result.sequence || "Không nhận dạng được");
    setSegments(result.segments);

    if (result.segments.length > 0) {
      const first = result.segments[0];
      setDetected({
        key: first.key,
        lowFreq: first.lowFreq,
        highFreq: first.highFreq,
        lowScore: 0,
        highScore: 0,
      });
    }
  }

  async function openAudio(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;

    const ctx = audioContextRef.current || new AudioContextClass();
    audioContextRef.current = ctx;

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const channel = audioBuffer.getChannelData(0);
    const srcFs = audioBuffer.sampleRate;
    const maxLen = Math.min(channel.length, Math.floor(srcFs * 20));
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

    const sequenceResult = detectDTMFSequence(data);
    const oneToneResult = detectDTMF(data);

    setSamples(data);
    setSourceName(`File âm thanh: ${file.name}`);
    setDetected(oneToneResult);
    setDetectedSequence(sequenceResult.sequence || "Không nhận dạng được");
    setSegments(sequenceResult.segments);
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
            <h1>Ứng dụng nhận dạng DTMF và số điện thoại</h1>
            <p>
              Ứng dụng tạo âm phím điện thoại, tạo âm cho cả số điện thoại,
              mở file âm thanh, tách từng đoạn DTMF và nhận dạng lại chuỗi số.
            </p>
          </div>

          <div className="resultCard">
            <div className="smallText">Chuỗi nhận dạng</div>
            <div className="bigResult" style={{ fontSize: "34px", wordBreak: "break-all" }}>
              {detectedSequence || detected.key}
            </div>
            <div className="freqResult">
              {detected.lowFreq} Hz + {detected.highFreq} Hz
            </div>
          </div>
        </div>

        <div className="grid">
          <div className="left">
            <div className="card">
              <h2>Tạo âm số điện thoại</h2>

              <input
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="Nhập số điện thoại, ví dụ 0912345678"
                style={{
                  width: "100%",
                  padding: "14px",
                  borderRadius: "14px",
                  border: "1px solid #cbd5e1",
                  fontSize: "18px",
                  fontWeight: 700,
                  marginBottom: "12px",
                }}
              />

              <button className="mainButton" onClick={createPhoneSignal}>
                Tạo âm cho số điện thoại
              </button>

              <button className="darkButton" onClick={recognizePhoneNumber}>
                Nhận dạng số điện thoại
              </button>

              <button
                className="grayButton"
                onClick={() =>
                  downloadWav(
                    samples,
                    FS,
                    `dtmf_phone_${phoneNumber.replace(/[^0-9*#]/g, "") || "number"}.wav`
                  )
                }
              >
                Tải WAV số điện thoại
              </button>
            </div>

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

              <button className="darkButton" onClick={recognizeOneTone}>
                Nhận dạng 1 phím
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
                Tải WAV hiện tại
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
              <h2>Kết quả tách và nhận dạng từng phím</h2>

              {segments.length === 0 ? (
                <p>Chưa có đoạn DTMF nào được nhận dạng.</p>
              ) : (
                <div className="table">
                  {segments.map((item) => (
                    <div className="tableRow" key={`${item.index}-${item.startTime}`}>
                      <b>
                        {item.index}. Phím {item.key}
                      </b>
                      <span>
                        {item.lowFreq} Hz + {item.highFreq} Hz |{" "}
                        {item.startTime.toFixed(2)}s - {item.endTime.toFixed(2)}s
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <h2>Nguyên lý hoạt động</h2>
              <div className="theory">
                <div>
                  <h3>1. Tạo chuỗi DTMF</h3>
                  <p>
                    Mỗi chữ số được tạo bởi hai sóng sin. Các chữ số được nối
                    với nhau bằng những khoảng im lặng ngắn.
                  </p>
                </div>

                <div>
                  <h3>2. Tách đoạn âm</h3>
                  <p>
                    Ứng dụng phân tích mức năng lượng để xác định đoạn nào là
                    âm DTMF và đoạn nào là khoảng lặng.
                  </p>
                </div>

                <div>
                  <h3>3. Nhận dạng số</h3>
                  <p>
                    Với từng đoạn âm, chương trình tìm cặp tần số mạnh nhất và
                    tra bảng để suy ra phím, sau đó ghép thành số điện thoại.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer>
          Đề tài: Ứng dụng tạo và nhận dạng tín hiệu DTMF, mở rộng nhận dạng chuỗi số điện thoại từ file âm thanh.
        </footer>
      </div>
    </div>
  );
}