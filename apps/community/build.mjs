import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
await mkdir(new URL('./public/vendor',import.meta.url),{recursive:true});
await build({entryPoints:[require.resolve('@novnc/novnc')],outfile:new URL('./public/vendor/novnc.js',import.meta.url).pathname,bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'inline',banner:{js:'/*! noVNC 1.7.0 | Copyright the noVNC authors | MPL-2.0 | Source: https://github.com/novnc/noVNC/tree/v1.7.0 | License notices: /vendor/novnc-LICENSE.txt */'}});
const novncRoot=join(dirname(require.resolve('@novnc/novnc')),'..');
const notices=['noVNC 1.7.0 source: https://github.com/novnc/noVNC/tree/v1.7.0\nThe noVNC source is unmodified; esbuild bundles/minifies it for this application.'];
for(const name of ['LICENSE.txt','AUTHORS','docs/LICENSE.MPL-2.0','docs/LICENSE.BSD-2-Clause','docs/LICENSE.BSD-3-Clause','vendor/pako/LICENSE']) notices.push(name+'\n'+await readFile(join(novncRoot,name),'utf8'));
await writeFile(new URL('./public/vendor/novnc-LICENSE.txt',import.meta.url),notices.join('\n\n'));

await build({stdin:{contents:"export {Terminal} from '@xterm/xterm'; export {FitAddon} from '@xterm/addon-fit';",resolveDir:dirname(new URL(import.meta.url).pathname),sourcefile:'workspace-terminal-vendor.js',loader:'js'},outfile:new URL('./public/vendor/xterm.js',import.meta.url).pathname,bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'inline',banner:{js:'/*! xterm.js 6.0.0 + addon-fit 0.11.0 | MIT | Source: https://github.com/xtermjs/xterm.js | License: /vendor/xterm-LICENSE.txt */'}});
const xtermRoot=join(dirname(require.resolve('@xterm/xterm')),'..');
const fitRoot=join(dirname(require.resolve('@xterm/addon-fit')),'..');
await writeFile(new URL('./public/vendor/xterm.css',import.meta.url),await readFile(join(xtermRoot,'css/xterm.css')));
await writeFile(new URL('./public/vendor/xterm-LICENSE.txt',import.meta.url),['xterm.js 6.0.0\n'+await readFile(join(xtermRoot,'LICENSE'),'utf8'),'addon-fit 0.11.0\n'+await readFile(join(fitRoot,'LICENSE'),'utf8')].join('\n\n'));
