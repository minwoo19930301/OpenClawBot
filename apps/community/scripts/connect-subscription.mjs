#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {accessSync, constants, lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {VERIFIED_OPENCLAW_AUTH} from '../subscription-connections.mjs';

const LOGINS = Object.freeze({codex: ['login', '--device-auth'], claude: ['auth', 'login'], gemini: []});
const HELP = `Usage: node apps/community/scripts/connect-subscription.mjs codex|claude|gemini [--check]
  codex --gateway local [--check]
  codex --gateway compose --project-directory /path/to/deploy
        --compose-file /path/to/compose.yml [--compose-file /path/to/override.yml]
        [--project-name community] [--service openclaw] [--check]

--check inspects CLI availability and Gateway storage without signing in.
Local Gateway uses its existing OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR.
Compose uses <project-directory>/.env.production and the existing Gateway volume.
No package installation, token copying, service restart, or model request is performed.
Claude and Gemini sign in only to their official CLI; this does not connect the app.
`;

export function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return {help: true};
  const [provider, ...rest] = args;
  if (!Object.hasOwn(LOGINS, provider ?? '')) throw new Error('Choose codex, claude, or gemini. Use --help for commands.');
  const options = {provider, check: false, gateway: null, composeFiles: [], service: 'openclaw'};
  const names = {'--gateway':'gateway', '--project-directory':'projectDirectory', '--project-name':'projectName', '--service':'service'};
  for (let i=0; i<rest.length; i++) {
    const option=rest[i];
    if (option==='--check') {options.check=true;continue;}
    if (option!=='--compose-file' && !Object.hasOwn(names,option)) throw new Error('Unknown helper option. Use --help.');
    const value=rest[++i];
    if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) throw new Error('An option requires a valid value.');
    if (option==='--compose-file') options.composeFiles.push(resolve(value));
    else {const field=names[option];if (Object.hasOwn(options,field) && field!=='gateway' && field!=='service') throw new Error('Duplicate helper option.');options[field]=value;}
  }
  if (options.gateway && !['local','compose'].includes(options.gateway)) throw new Error('Gateway must be local or compose.');
  if (options.gateway && provider!=='codex') throw new Error('Only Codex has a verified Gateway subscription connection. Use the official CLI or an API key for this provider.');
  if (options.gateway==='compose') {
    if (!options.projectDirectory || !isAbsolute(options.projectDirectory) || !options.composeFiles.length) throw new Error('Compose requires an absolute --project-directory and at least one --compose-file.');
    for (const value of [options.service, options.projectName].filter(Boolean)) if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/.test(value)) throw new Error('Invalid Compose project or service name.');
  } else if (options.projectDirectory || options.projectName || options.composeFiles.length || options.service!=='openclaw') throw new Error('Compose options require --gateway compose.');
  return options;
}

export function gatewayCommand(options, args, interactive=false) {
  if (options.gateway==='local') return {file:'openclaw', args};
  const prefix=['compose','--project-directory',options.projectDirectory,'--env-file',join(options.projectDirectory,'.env.production')];
  for (const path of options.composeFiles) prefix.push('-f',path);
  if (options.projectName) prefix.push('-p',options.projectName);
  prefix.push('exec');if (!interactive) prefix.push('-T');
  // The official image's unprivileged account owns its persistent auth directory.
  prefix.push('--user','node',options.service,'node','openclaw.mjs',...args);
  return {file:'docker',args:prefix};
}

export function checkLocalStorage(env=process.env, home=homedir()) {
  const state=env.OPENCLAW_STATE_DIR || join(home,'.openclaw');
  const config=env.OPENCLAW_CONFIG_PATH || join(state,'openclaw.json');
  const privatePath=(path,directory)=>{
    const info=lstatSync(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (info.mode&0o077)!==0) throw new Error('private-storage');
    accessSync(path,constants.W_OK);
  };
  try {privatePath(state,true);privatePath(config,false);} catch {throw new Error('Gateway needs an existing writable private state directory (0700) and config (0600). Prepare the subscription config without replacing existing auth.');}
}

// Runs inside the existing container. It examines metadata only, never auth file contents.
const STORAGE_PROBE = `const fs=require('node:fs'),p=require('node:path'),os=require('node:os');const state=process.env.OPENCLAW_STATE_DIR||p.join(os.homedir(),'.openclaw');const config=process.env.OPENCLAW_CONFIG_PATH||p.join(state,'openclaw.json');try{for(const [name,dir] of [[state,true],[config,false]]){const s=fs.lstatSync(name);if(s.isSymbolicLink()||(dir?!s.isDirectory():!s.isFile())||(s.mode&63)!==0)throw Error();fs.accessSync(name,fs.constants.W_OK);}process.stdout.write('ready');}catch{process.exit(1);}`;

export function execute(file,args,{interactive=false}={}) {
  const result=spawnSync(file,args,{shell:false,stdio:interactive?'inherit':['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:1024*1024,...(interactive?{}:{timeout:20_000})});
  if (result.error?.code==='ENOENT') throw new Error(`${file} CLI is not installed or is not on PATH. Install it using its official documentation first.`);
  if (result.error) throw new Error(`${file} readiness check could not complete.`);
  return {status:result.status ?? 1,stdout:result.stdout ?? ''};
}

export function runConnection(options,{run=execute, env=process.env, checkStorage=checkLocalStorage, isTTY=Boolean(process.stdin.isTTY&&process.stdout.isTTY), log=console.log}={}) {
  if (options.help) {log(HELP);return {help:true};}
  let login;
  if (options.gateway) {
    const versionCommand=gatewayCommand(options,['--version']);
    const result=run(versionCommand.file,versionCommand.args);
    if (result.status!==0) throw new Error('Gateway CLI is unavailable. Start the configured Gateway and check its CLI installation.');
    const version=result.stdout.match(/\b(2026\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)\b/)?.[1];
    if (!version || !Object.hasOwn(VERIFIED_OPENCLAW_AUTH,version)) throw new Error('This Gateway version has not been verified by this helper. Check its official OAuth documentation before connecting.');
    if (options.gateway==='local') checkStorage(env);
    else {
      const probe=gatewayCommand(options,[]);probe.args.splice(-1,1,'-e',STORAGE_PROBE);
      if (run(probe.file,probe.args).status!==0) throw new Error('Gateway storage is not ready. Use the subscription override with writable private config (0600) and persistent state (0700).');
    }
    login=gatewayCommand(options,['models','auth','login','--provider',VERIFIED_OPENCLAW_AUTH[version],...(version==='2026.9.5'?['--device-code']:[]),'--set-default'],true);
    log(`OpenClaw ${version}: private storage is ready for Codex OAuth.`);
  } else {
    if (run(options.provider,['--version']).status!==0) throw new Error('The official provider CLI is unavailable. Install or repair it using the official documentation.');
    login={file:options.provider,args:[...LOGINS[options.provider]]};
    log(`${options.provider}: CLI is available. Authentication stays in its existing private credential store.`);
  }
  if (options.check) {log('Readiness check only: no login started and no account connection was changed.');return {ready:true,loggedIn:false,gateway:options.gateway};}
  if (!isTTY) throw new Error('Login requires your interactive host terminal. Run this command there; do not paste credentials into the web app.');
  const previous=process.umask(0o077);
  try {if (run(login.file,login.args,{interactive:true}).status!==0) throw new Error('Login did not complete. Existing authentication has not been removed by this helper.');}
  finally {process.umask(previous);}
  log(options.gateway ? 'Gateway login finished and its recommended model was selected. Select the Gateway connection in the app; no model request was sent.' : 'CLI session finished. Its credentials were not copied into the app or Gateway.');
  return {ready:true,loginFinished:true,gateway:options.gateway};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {runConnection(parseArgs(process.argv.slice(2)));} catch (error) {console.error(error.message);process.exitCode=1;}
}
