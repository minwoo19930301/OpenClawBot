import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';

// No repository or working-directory discovery: forks start without operator data.
export async function loadOperatorContext(path) {
  if(path==null||path==='')return '';
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw new Error('Operator context requires an absolute private file path');
  let file;
  try {
    file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
    if(!(await file.stat()).isFile())throw new Error();
    const buffer=Buffer.alloc(65537);
    let length=0;
    while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(length>65536)throw new Error();
    return buffer.subarray(0,length).toString('utf8');
  }catch{throw new Error('Unable to load operator context; use a readable private text file of at most 64 KiB');}
  finally{await file?.close();}
}
