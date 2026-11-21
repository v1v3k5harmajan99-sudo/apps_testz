// Shared flow "pwprobe"
export async function pwprobe(m, at, b) {
  await m.step(at + '.f1', b, page => (async (page) => { console.log('ADMIN_BASELINE_XHJ_OK'); })(page));
}
