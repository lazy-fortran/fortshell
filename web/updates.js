export async function installUpdates(button, prepare, fail) {
  if (!('serviceWorker' in navigator)) return;
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled) button.textContent = 'Update ready';
    controlled = true;
  });
  const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  button.hidden = false;
  button.onclick = async () => {
    button.disabled = true;
    try {
      await registration.update();
      const worker = registration.installing || registration.waiting;
      if (worker && worker.state !== 'activated') await new Promise((resolve, reject) => {
        const changed = () => {
          if (worker.state === 'activated') { worker.removeEventListener('statechange', changed); resolve(); }
          if (worker.state === 'redundant') { worker.removeEventListener('statechange', changed); reject(new Error('App update failed')); }
        };
        worker.addEventListener('statechange', changed); changed();
      });
      if (await prepare()) location.reload();
    } catch (e) { fail(e); }
    finally { button.disabled = false; }
  };
}
