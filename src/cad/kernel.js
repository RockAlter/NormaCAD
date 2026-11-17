// Main-thread client for the modelling kernel worker. Calls queue in order.
let worker = null;
let seq = 1;
const pending = new Map();

function ensure() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(Object.assign(new Error(error?.message || 'kernel error'), { i18n: error?.i18n, vars: error?.vars }));
  };
  worker.onerror = (e) => {
    const err = Object.assign(new Error(e.message || 'kernel failed to start'), { i18n: 'k.start' });
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
  };
  return worker;
}

export function call(cmd, args, transfer = []) {
  const w = ensure();
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, cmd, args }, transfer);
  });
}

let ready = null;
export function startKernel() {
  if (!ready) ready = call('init').catch((e) => { ready = null; throw e; });
  return ready;
}
