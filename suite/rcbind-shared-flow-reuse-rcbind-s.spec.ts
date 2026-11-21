import { test } from '@playwright/test';
import { Meridian } from '../shared/meridian/rt.mjs';
import { pwprobe } from '../flows/pwprobe';

test('rcbind shared flow reuse', async ({ browser }, info) => {
  const m = new Meridian({ browser, info, slug: 'rcbind-shared-flow-reuse', steps: {"0":[null,"Phase: test"],"0/s1":["default","Go to the Ownsite site"],"0/s2":["default","Shared flow pwprobe as Default"],"0/s2.f1":["default","Custom code: (async (page) => { console.log('ADMIN_BASELINE_XHJ_OK'); })(page)"]} });
  await m.phase(0, 'test', async () => {
    await m.step('0/s1', 'default', async page => {
      await page.goto(m.t('$DS_OWNSITE_URL'), { waitUntil: 'domcontentloaded' });
      await m.loaded(page);
    });
    await m.block('0/s2', () => pwprobe(m, '0/s2', 'default'));
  }, { pass: true });
  await m.end();
});
