// The runner accepts both prefixed and bare text envelopes. Normalize before
// wrapping so a model's bare JSON is not shown verbatim inside the chat bubble.
export function normalizeBotOutput(value) {
  const raw = String(value).trim();
  const payload = raw.startsWith('SendMessage:') ? raw.slice(12).trim() : raw;
  let content = raw;
  try {
    const parsed = JSON.parse(payload);
    if (parsed?.type === 'text' && typeof parsed.content === 'string') content = parsed.content;
  } catch {}
  return 'SendMessage: ' + JSON.stringify({type:'text', content:content.slice(0,4000)});
}
