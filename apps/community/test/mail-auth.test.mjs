import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import { verifyMail } from '../mail-auth.mjs';

const now=Date.parse('2026-10-11T03:00:00Z'),expectedFrom='owner@example.com',expectedTo='flaming@example.net';
// Ephemeral fixture key: never read an operator key or query public DNS.
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'});
const record='v=DKIM1; k=rsa; p='+pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
const resolver=async(name,type)=>{
  assert.equal(type,'TXT');assert.match(name,/^fixture\._domainkey\.(?:example\.com|attacker\.example)$/);
  return [[record]];
};
const options={expectedFrom,expectedTo,now,resolver};
const fields=['From','To','Subject','Date','Message-ID','MIME-Version','Content-Type','Content-Transfer-Encoding'];
function message({from=expectedFrom,to=expectedTo,date=new Date(now).toUTCString(),extra=[],body='Private task fixture.\r\n'}={}) {
  return [
    'From: '+from,'To: '+to,'Subject: Signed fixture subject','Date: '+date,'Message-ID: <fixture-task@example.com>',
    'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: 8bit',...extra,'',body,
  ].join('\r\n');
}
async function signed(raw=message(),{headerList=fields,signingDomain='example.com',maxBodyLength,algorithm}={}) {
  const result=await dkimSign(raw,{signTime:new Date(now),headerList,signatureData:[{
    signingDomain,selector:'fixture',privateKey,
    ...(maxBodyLength===undefined?{}:{maxBodyLength}),...(algorithm?{algorithm}:{}),
  }]});
  assert.equal(result.errors.length,0);
  return result.signatures+raw;
}

test('a real DNS-verified signature authenticates the exact sender and recipient without returning content or key material',async()=>{
  const raw=await signed(message({from:'Owner <OWNER@example.com>'}));
  const result=await verifyMail(Buffer.from(raw),options);
  assert.deepEqual(result,{
    verified:true,reason:'verified',from:expectedFrom,messageId:'<fixture-task@example.com>',
    inReplyTo:'',references:'',subject:'Signed fixture subject',date:'2026-10-11T03:00:00.000Z',
  });
  assert.ok(!JSON.stringify(result).includes('Private task fixture'));
  assert.ok(!JSON.stringify(result).includes('DKIM-Signature'));
  assert.ok(!JSON.stringify(result).includes(record));
});

test('forged Authentication-Results, another signing domain and modified bodies cannot authorize an owner task',async()=>{
  const forged='Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass\r\n'+message();
  assert.equal((await verifyMail(forged,options)).verified,false);
  const wrongDomain=await signed(message(),{signingDomain:'attacker.example'});
  const actual=await dkimVerify(wrongDomain,{resolver,strict:true,curTime:new Date(now)});
  assert.equal(actual.results[0].status.result,'pass','fixture signature really passes, but belongs to the wrong domain');
  assert.equal((await verifyMail(wrongDomain,options)).reason,'unverified_dkim');
  const tampered=(await signed()).replace('Private task fixture.','Changed command fixture.');
  assert.equal((await verifyMail(tampered,options)).verified,false);
  const unauthenticatedSender=await signed(message({from:'attacker@example.com'}));
  assert.equal((await verifyMail(unauthenticatedSender,options)).reason,'invalid_sender');
});

test('a valid DKIM l= partial-body signature cannot authorize even an unchanged or appended task',async()=>{
  const limited=await signed(message(),{maxBodyLength:7});
  for(const raw of [limited,limited+'Another command outside the signature.\r\n']){
    const actual=await dkimVerify(raw,{resolver,strict:true,curTime:new Date(now)});
    assert.equal(actual.results[0].status.result,'pass');
    assert.equal(actual.results[0].canonBodyLengthLimited,true);
    assert.equal((await verifyMail(raw,options)).reason,'unverified_full_body');
  }
});

test('subject, date, message ID, recipient and MIME interpretation must be signed',async()=>{
  for(const omitted of ['Subject','Date','Message-ID','To','MIME-Version','Content-Type','Content-Transfer-Encoding']){
    const raw=await signed(message(),{headerList:fields.filter(name=>name!==omitted)});
    const actual=await dkimVerify(raw,{resolver,strict:true,curTime:new Date(now)});
    assert.equal(actual.results[0].status.result,'pass','fixture remains valid DKIM with unsigned '+omitted);
    assert.equal((await verifyMail(raw,options)).reason,'unverified_signed_headers',omitted);
  }
  const otherRecipient=await signed(message({to:'other@example.net'}));
  assert.equal((await verifyMail(otherRecipient,options)).reason,'invalid_recipient');
});

test('duplicate critical headers and ambiguous From fields fail before any DNS query',async()=>{
  let queries=0;
  const noDns={...options,resolver:async()=>{queries++;return [[record]];}};
  const valid=await signed();
  for(const prefix of [
    'From: owner@example.com\r\n','Subject: replacement\r\n','Date: Sun, 11 Oct 2026 03:00:00 GMT\r\n',
    'Message-ID: <replacement@example.com>\r\n','Content-Type: text/html\r\n','To: other@example.net\r\n',
  ])assert.equal((await verifyMail(prefix+valid,noDns)).reason,'invalid_headers');
  for(const from of ['owner@example.com, attacker@example.com','Group: owner@example.com;','"owner@example.com" <attacker@example.com>']){
    assert.equal((await verifyMail(await signed(message({from})),noDns)).reason,'invalid_sender');
  }
  assert.equal(queries,0);
});

test('signed dates must be within seven days with at most five minutes of future clock skew',async()=>{
  for(const date of [new Date(now-8*86400000).toUTCString(),new Date(now+6*60000).toUTCString(),'not a date']){
    assert.equal((await verifyMail(await signed(message({date})),options)).reason,'invalid_date');
  }
  const nearFuture=await signed(message({date:new Date(now+4*60000).toUTCString()}));
  assert.equal((await verifyMail(nearFuture,options)).verified,true);
});

test('automatic replies, mailing lists, delivery reports and suppression requests do not start tasks',async()=>{
  for(const [header,reason] of [
    ['Auto-Submitted: auto-replied','skipped_automated'],['Auto-Submitted: auto-generated; owner-email=fixture','skipped_automated'],
    ['X-Auto-Response-Suppress: All','skipped_automated'],['List-Id: announcements.example.com','skipped_mailing_list'],
    ['Precedence: BULK','skipped_mailing_list'],['Precedence: junk','skipped_mailing_list'],['Precedence: list','skipped_mailing_list'],
    ['Return-Path: <>','skipped_delivery_report'],
  ])assert.equal((await verifyMail(await signed(message({extra:[header]})),options)).reason,reason);
  assert.equal((await verifyMail(await signed(message({extra:['Auto-Submitted: no']})),options)).verified,true);
});

test('only signed thread references can resume a session',async()=>{
  const extra=['In-Reply-To: <previous@example.com>','References: <first@example.com> <previous@example.com>'];
  const unsignedThreads=await verifyMail(await signed(message({extra})),options);
  assert.equal(unsignedThreads.verified,true);assert.equal(unsignedThreads.inReplyTo,'');assert.equal(unsignedThreads.references,'');
  const authenticatedThreads=await verifyMail(await signed(message({extra}),{headerList:[...fields,'In-Reply-To','References']}),options);
  assert.equal(authenticatedThreads.verified,true);
  assert.equal(authenticatedThreads.inReplyTo,'<previous@example.com>');
  assert.equal(authenticatedThreads.references,'<first@example.com> <previous@example.com>');
});

test('malformed inputs, excessive signatures, weak algorithms and resolver errors fail closed without leaking errors',async()=>{
  assert.equal((await verifyMail({},options)).reason,'invalid_message');
  assert.equal((await verifyMail('X: '+ 'x'.repeat(65536)+'\r\n\r\nbody',options)).reason,'invalid_headers');
  assert.equal((await verifyMail(await signed(),{...options,expectedFrom:''})).reason,'invalid_expected_sender');
  const many='DKIM-Signature: invalid\r\n'.repeat(9)+message();
  assert.equal((await verifyMail(many,options)).reason,'invalid_signature_count');
  assert.equal((await verifyMail(await signed(message(),{algorithm:'rsa-sha1'}),options)).verified,false);
  const dnsError=await verifyMail(await signed(),{...options,resolver:async()=>{throw new Error('fixture-secret-error');}});
  assert.equal(dnsError.verified,false);assert.ok(!JSON.stringify(dnsError).includes('fixture-secret-error'));
});
