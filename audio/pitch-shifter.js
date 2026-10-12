class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "semitones",
        defaultValue: -5,
        minValue: -12,
        maxValue: 12,
        automationRate: "k-rate"
      },
      {
        name: "character",
        defaultValue: 0.55,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate"
      },
      {
        name: "metallic",
        defaultValue: 0.12,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate"
      }
    ];
  }

  constructor() {
    super();

    this.windowSize = Math.max(
      256,
      Math.round(sampleRate * 0.055)
    );

    this.size = 1 << 15;
    this.mask = this.size - 1;

    this.buffers = [];
    this.low = [];
    this.high = [];

    this.channels = 0;
    this.writeIndex = 0;

    this.phase = 0;
    this.ratio = 1;

    this.modPhase = 0;
    this.modValue = 0;

    this.port.onmessage = ({ data }) => {
      if (data?.type === "reset") {
        this.reset();
      }
    };
  }

  reset() {
    this.buffers = [];
    this.low = [];
    this.high = [];
    this.channels = 0;
    this.writeIndex = 0;
    this.phase = 0;
    this.ratio = 1;
    this.modPhase = 0;
    this.modValue = 0;
  }

  ensureChannels(count) {
    if (count === this.channels) return;

    this.channels = count;

    this.buffers = Array.from(
      { length: count },
      () => new Float32Array(this.size)
    );

    this.low = new Float32Array(count);
    this.high = new Float32Array(count);

    this.writeIndex = 0;
    this.phase = 0;
  }

  read(buffer, delay) {
    const position = this.writeIndex - 1 - delay;
    const index = Math.floor(position);
    const fraction = position - index;

    const a = buffer[index & this.mask];
    const b = buffer[(index + 1) & this.mask];

    return a + (b - a) * fraction;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!output?.length) return true;

    const frames = output[0].length;

    if (!input?.length || !input[0]?.length) {
      for (const channel of output) {
        channel.fill(0);
      }
      return true;
    }

    const count = Math.min(input.length, output.length);
    this.ensureChannels(count);

    const targetRatio = Math.pow(
      2,
      parameters.semitones[0] / 12
    );

    const character = parameters.character[0];
    const metallic = parameters.metallic[0];

    const W = this.windowSize;

    // Lissage des changements de hauteur.
    const pitchSmoothing = 1 - Math.exp(
      -1 / (sampleRate * 0.025)
    );

    // Coloration spectrale.
    const lowCut = 120 + character * 300;
    const highCut = 7000 - character * 2800;

    const lowAlpha = 1 - Math.exp(
      -2 * Math.PI * lowCut / sampleRate
    );

    const highAlpha = 1 - Math.exp(
      -2 * Math.PI * highCut / sampleRate
    );

    // Modulation lente pour modifier la texture vocale.
    const modFrequency = 32 + character * 43;
    const modIncrement = 2 * Math.PI *
      modFrequency / sampleRate;

    for (let n = 0; n < frames; n++) {
      this.ratio +=
        (targetRatio - this.ratio) * pitchSmoothing;

      // Écriture de tous les canaux avant la lecture.
      for (let ch = 0; ch < count; ch++) {
        this.buffers[ch][this.writeIndex & this.mask] =
          input[ch][n] || 0;
      }

      // Deux têtes de lecture déphasées de 180°.
      const p1 = this.phase;
      const p2 = (p1 + 0.5) % 1;

      // Une petite latence minimale évite de lire
      // directement sur le point d'écriture.
      const minDelay = 4;

      const d1 = minDelay + p1 * W;
      const d2 = minDelay + p2 * W;

      // Fenêtres sinusoïdales complémentaires.
      const s1 = Math.sin(Math.PI * p1);
      const s2 = Math.sin(Math.PI * p2);

      const w1 = s1 * s1;
      const w2 = s2 * s2;

      const norm = Math.max(0.0001, w1 + w2);

      // Modulation commune pour conserver la cohérence
      // entre les canaux stéréo.
      const carrier = Math.sin(this.modPhase);

      for (let ch = 0; ch < count; ch++) {
        const buffer = this.buffers[ch];

        const a = this.read(buffer, d1);
        const b = this.read(buffer, d2);

        let sample = (w1 * a + w2 * b) / norm;

        // Coloration du timbre par égalisation.
        this.low[ch] += lowAlpha *
          (sample - this.low[ch]);

        this.high[ch] += highAlpha *
          (sample - this.high[ch]);

        const lowComponent = this.low[ch];
        const highComponent = sample - this.high[ch];

        sample =
          sample * (1 - character * 0.24) +
          lowComponent * character * 0.35 +
          highComponent * character * 0.22;

        // Modulation en anneau dosée.
        // Une intensité excessive nuit à l'intelligibilité.
        const ring = sample * carrier;

        sample = sample * (1 - metallic * 0.65) +
          ring * metallic * 0.65;

        // Saturation douce avec gain compensé.
        const drive = 1 + character * 1.5;

        sample = Math.tanh(sample * drive) /
          Math.tanh(drive);

        output[ch][n] = sample;
      }

      // Rapport de lecture : ratio > 1 = lecture plus rapide.
      this.phase += (1 - this.ratio) / W;
      this.phase = (
        (this.phase % 1) + 1
      ) % 1;

      this.modPhase += modIncrement;

      if (this.modPhase >= 2 * Math.PI) {
        this.modPhase -= 2 * Math.PI;
      }

      this.writeIndex++;
    }

    // Remplir les éventuels canaux supplémentaires.
    for (let ch = count; ch < output.length; ch++) {
      output[ch].fill(0);
    }

    return true;
  }
}

registerProcessor("pitch-shifter", PitchShifter);