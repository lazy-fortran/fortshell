const stages = ['event_age_ms', 'preparation_ms', 'model_document_ms', 'input_ms',
  'wait_to_draw_ms', 'draw_submit_ms', 'callback_to_submit_ms', 'event_to_submit_ms'];

function distribution(values) {
  values.sort((a, b) => a - b);
  const at = p => values[Math.min(values.length - 1, Math.floor(values.length * p))];
  return { median_ms: at(0.5), p95_ms: at(0.95), p99_ms: at(0.99), max_ms: at(1) };
}

export class InkLatency {
  constructor(limit = 4096) {
    this.limit = limit; this.records = []; this.pending = []; this.count = 0;
    let previous = performance.now(), quantum = Infinity;
    const start = previous;
    while (performance.now() - start < 4) {
      const now = performance.now();
      if (now > previous) quantum = Math.min(quantum, now - previous);
      previous = now;
    }
    this.quantum = Number.isFinite(quantum) ? quantum : null;
  }
  capture(event) {
    this.event = { received: performance.now(), timestamp: event.timeStamp,
      trusted: event.isTrusted };
  }
  begin(samples, pipeline) {
    const event = this.event || { received: performance.now(), timestamp: NaN, trusted: false };
    this.event = null;
    return { ...event, samples, ...pipeline, preparation_ms: 0, model_document_ms: 0 };
  }
  accept(record) {
    record.processed = performance.now();
    if (this.pending.length < this.limit) this.pending.push(record);
  }
  submitted(start) {
    const end = performance.now();
    for (const record of this.pending) {
      const age = record.received - record.timestamp;
      this.records[this.count++ % this.limit] = {
        engine: record.engine, renderer: record.renderer, scheduling: record.scheduling,
        samples: record.samples, trusted: record.trusted,
        event_age_ms: age >= 0 && age < 60000 ? age : null,
        preparation_ms: record.preparation_ms, model_document_ms: record.model_document_ms,
        input_ms: record.processed - record.received,
        wait_to_draw_ms: start - record.processed, draw_submit_ms: end - start,
        callback_to_submit_ms: end - record.received,
        event_to_submit_ms: age >= 0 && age < 60000 ? end - record.timestamp : null,
      };
    }
    this.pending = [];
  }
  report() {
    const groups = new Map();
    for (const record of this.records) {
      const key = `${record.engine}/${record.renderer}/${record.scheduling}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    return { version: 1, user_agent: navigator.userAgent, physical_latency_measured: false,
      timer_quantum_ms: this.quantum,
      measurement: 'Browser event timestamp and callback entry to drawing API return. Includes profiling overhead. Excludes GPU completion and display.',
      retained_batches: this.records.length, overwritten_batches: Math.max(0, this.count - this.limit),
      pending_batches: this.pending.length,
      policy: { denominator: 'physical input-to-display latency', acceptable_overhead: 0.01,
        unacceptable_overhead: 0.1, evaluated: false },
      pipelines: [...groups].map(([pipeline, records]) => ({ pipeline, batches: records.length,
        samples: records.reduce((sum, record) => sum + record.samples, 0),
        trusted_events: records.filter(record => record.trusted).length,
        ...Object.fromEntries(stages.map(stage => {
          const values = records.map(record => record[stage]).filter(Number.isFinite);
          return [stage, values.length ? distribution(values) : null];
        })),
      })) };
  }
}
