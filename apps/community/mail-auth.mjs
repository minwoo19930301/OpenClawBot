import { Resolver } from 'node:dns/promises';
import PostalMime, { addressParser } from 'postal-mime';
import { dkimVerify } from 'mailauth/lib/dkim/verify.js';

const MAX_BYTES=10*1024*1024, MAX_HEADERS=64*1024, MAX_AGE=7*86400000, FUTURE_SKEW=5*60000;
const required=['from','subject','date','message-id'];
const mimeHeaders=['content-type','content-transfer-encoding','mime-version'];
const singleHeaders=[...required,...mimeHeaders,'to','in-reply-to','references'];
const clean=(value,max)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max):'';
const normalizeAddress=value=>typeof value==='string'&&value.length<=254&&/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value.trim())?value.trim().toLowerCase():'';
const messageId=value=>typeof value==='string'&&/^<[^<>\s\x00-\x1f\x7f]{1,500}>$/.test(value.trim())?value.trim():'';
const base=()=>({verified:false,reason:'invalid_message',from:'',messageId:'',inReplyTo:'',references:'',subject:'',date:''});

/**
 * Authorize a mail task using the original bytes, not attacker-supplied
 * Authentication-Results, SMTP envelope addresses or ARC assertions.
 * A caller must still claim messageId atomically to prevent replay, enforce user
 * permissions, and treat quoted mail/attachments as untrusted task material.
 */
export async function verifyMail(raw,{expectedFrom,expectedTo,now=Date.now(),resolver}={}) {
  const result=base(),reject=reason=>({...result,verified:false,reason});
  const expected=normalizeAddress(expectedFrom),recipient=expectedTo===undefined?'':normalizeAddress(expectedTo);
  if(!expected)return reject('invalid_expected_sender');
  if(expectedTo!==undefined&&!recipient)return reject('invalid_expected_recipient');
  const timestamp=now instanceof Date?now.getTime():now;
  if(typeof timestamp!=='number'||!Number.isFinite(timestamp))return reject('invalid_clock');
  let bytes;
  if(typeof raw==='string')bytes=Buffer.from(raw);
  else if(raw instanceof ArrayBuffer)bytes=Buffer.from(raw);
  else if(raw instanceof Uint8Array)bytes=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength);
  else return reject('invalid_message');
  if(!bytes.length||bytes.length>MAX_BYTES)return reject('invalid_message_size');
  let end=bytes.indexOf('\r\n\r\n');
  if(end<0)end=bytes.indexOf('\n\n');
  if(end<0||end>MAX_HEADERS)return reject('invalid_headers');
  let parsed;
  try {parsed=await PostalMime.parse(bytes,{maxHeadersSize:MAX_HEADERS,maxNestingDepth:20,maxPartCount:100,maxRfc822NestingDepth:0});}
  catch {return reject('invalid_message');}
  const headers=parsed.headers||[],values=name=>headers.filter(h=>h.key===name).map(h=>h.value);
  if(required.some(name=>values(name).length!==1)||singleHeaders.some(name=>values(name).length>1))return reject('invalid_headers');
  const signatureHeaders=values('dkim-signature');
  if(signatureHeaders.length>8)return reject('invalid_signature_count');
  if(values('auto-submitted').some(value=>value.split(';')[0].trim().toLowerCase()!=='no')||values('x-auto-response-suppress').length)return reject('skipped_automated');
  if(values('list-id').length||values('precedence').some(value=>['bulk','junk','list'].includes(value.trim().toLowerCase())))return reject('skipped_mailing_list');
  if(values('return-path').some(value=>value.trim()==='<>')||values('content-type').some(value=>/^multipart\/report\b/i.test(value.trim())))return reject('skipped_delivery_report');
  const from=addressParser(values('from')[0]);
  if(from.length!==1||from[0].group||normalizeAddress(from[0].address)!==expected)return reject('invalid_sender');
  result.from=expected;
  result.subject=clean(parsed.subject,1000);
  result.messageId=messageId(parsed.messageId);
  if(!result.messageId)return reject('invalid_message_id');
  const sent=Date.parse(values('date')[0]);
  if(!Number.isFinite(sent)||sent<timestamp-MAX_AGE||sent>timestamp+FUTURE_SKEW)return reject('invalid_date');
  result.date=new Date(sent).toISOString();
  if(recipient){
    const to=addressParser(values('to')[0]||'');
    if(!to.some(item=>!item.group&&normalizeAddress(item.address)===recipient))return reject('invalid_recipient');
  }
  const referenceIds=(parsed.references||'').match(/<[^<>\s\x00-\x1f\x7f]{1,500}>/g)||[];
  if(referenceIds.length>100)return reject('skipped_thread_limit');
  if(!signatureHeaders.length)return reject('unverified_dkim');
  const dns=new Resolver({timeout:2000,tries:1});
  let timer,queries=0,verification;
  const lookup=async(name,type)=>{
    if(++queries>8||type!=='TXT')throw new Error('DNS lookup limit');
    return resolver?resolver(name,type):dns.resolve(name,type);
  };
  try {
    verification=await Promise.race([
      dkimVerify(bytes,{strict:true,resolver:lookup,curTime:new Date(timestamp),minBitLength:1024}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Mail authentication timeout')),5000);}),
    ]);
  } catch {return reject('unverified_dkim');}
  finally {clearTimeout(timer);dns.cancel();}
  if(verification.fromFields!==1||verification.fromSyntax!=='valid'||verification.headerFrom.length!==1||normalizeAddress(verification.headerFrom[0])!==expected)return reject('invalid_sender');
  const domain=expected.slice(expected.lastIndexOf('@')+1);
  const pass=verification.results.filter(item=>item.status?.result==='pass'&&item.signingDomain?.toLowerCase()===domain&&item.signatureTimeValid!==false&&!item.status.testing);
  if(!pass.length)return reject('unverified_dkim');
  const full=pass.filter(item=>item.canonBodyLengthLimited===false&&item.canonBodyLength===item.canonBodyLengthTotal);
  if(!full.length)return reject('unverified_full_body');
  const needed=[...required,...mimeHeaders.filter(name=>values(name).length),...(recipient?['to']:[])];
  const signature=full.find(item=>{
    const signed=new Set(item.signingHeaders?.keys?.toLowerCase().split(':').map(name=>name.trim())||[]);
    return needed.every(name=>signed.has(name));
  });
  if(!signature)return reject('unverified_signed_headers');
  const signed=new Set(signature.signingHeaders.keys.toLowerCase().split(':').map(name=>name.trim()));
  // Unsigned threading fields may have been inserted in transit; do not let them
  // select an existing agent session. A verified message can start a new thread.
  result.inReplyTo=signed.has('in-reply-to')?messageId(parsed.inReplyTo):'';
  result.references=signed.has('references')?referenceIds.join(' ').slice(0,8192):'';
  return {...result,verified:true,reason:'verified'};
}
